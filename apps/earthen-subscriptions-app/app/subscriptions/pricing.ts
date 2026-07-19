import type { RenewalLineInput } from "./types";

export type Tier = { minimumQuantity: number; additionalDiscountBps: number };

export type ComputedRenewalLine = RenewalLineInput & {
  fulfilledQuantity: number;
  unavailableQuantity: number;
  netAmountPaise: number;
};

export type RenewalQuote = {
  status: "payable" | "skipped_oos";
  qualificationQuantity: number;
  baseDiscountBps: number;
  tierBonusBps: number;
  effectiveDiscountBps: number;
  merchandisePaise: number;
  shippingPaise: number;
  chargeAmountPaise: number;
  taxPaise: number;
  taxesIncluded: boolean;
  taxLines: Array<{ title: string; rate: number; pricePaise: number }>;
  lines: ComputedRenewalLine[];
};

export function tierForQuantity(tiers: Tier[], quantity: number): Tier | null {
  return [...tiers]
    .sort((a, b) => b.minimumQuantity - a.minimumQuantity)
    .find((tier) => quantity >= tier.minimumQuantity) ?? null;
}

export function computeRenewalQuote(input: {
  lines: RenewalLineInput[];
  baseDiscountBps: number;
  tiers: Tier[];
  freeShippingThresholdPaise: number;
  shippingFeePaise: number;
}): RenewalQuote {
  const active = input.lines.filter((line) => line.active && line.requestedQuantity > 0);
  const qualificationQuantity = active.reduce(
    (sum, line) => sum + line.requestedQuantity,
    0,
  );
  const tier = tierForQuantity(input.tiers, qualificationQuantity);
  const tierBonusBps = tier?.additionalDiscountBps ?? 0;
  const effectiveDiscountBps = input.baseDiscountBps + tierBonusBps;
  if (effectiveDiscountBps < 0 || effectiveDiscountBps >= 10_000) {
    throw new Error("Effective subscription discount must be between 0% and 99.99%");
  }

  const lines = active.map((line) => {
    const fulfilledQuantity = Math.min(
      line.requestedQuantity,
      Math.max(0, line.availableQuantity),
    );
    const discountedUnitPaise = Math.round(
      line.currentUnitPricePaise * (10_000 - effectiveDiscountBps) / 10_000,
    );
    return {
      ...line,
      fulfilledQuantity,
      unavailableQuantity: line.requestedQuantity - fulfilledQuantity,
      netAmountPaise: discountedUnitPaise * fulfilledQuantity,
    };
  });
  const merchandisePaise = lines.reduce((sum, line) => sum + line.netAmountPaise, 0);
  const status = merchandisePaise > 0 ? "payable" : "skipped_oos";
  const shippingPaise = status === "payable" &&
    merchandisePaise < input.freeShippingThresholdPaise
    ? input.shippingFeePaise
    : 0;

  return {
    status,
    qualificationQuantity,
    baseDiscountBps: input.baseDiscountBps,
    tierBonusBps,
    effectiveDiscountBps,
    merchandisePaise,
    shippingPaise,
    chargeAmountPaise: merchandisePaise + shippingPaise,
    taxPaise: 0,
    taxesIncluded: false,
    taxLines: [],
    lines,
  };
}

export function mandateHeadroomPaise(expectedRenewalPaise: number): number {
  const doubled = expectedRenewalPaise * 2;
  const roundedToHundredRupees = Math.ceil(doubled / 10_000) * 10_000;
  return Math.min(1_500_000, roundedToHundredRupees);
}
