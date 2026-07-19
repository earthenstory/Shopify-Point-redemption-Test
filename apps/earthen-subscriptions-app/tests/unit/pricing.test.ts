import { describe, expect, it } from "vitest";
import { computeRenewalQuote, mandateHeadroomPaise, tierForQuantity } from "../../app/subscriptions/pricing";
import type { RenewalLineInput } from "../../app/subscriptions/types";

const tiers = [
  { minimumQuantity: 2, additionalDiscountBps: 100 },
  { minimumQuantity: 3, additionalDiscountBps: 300 },
  { minimumQuantity: 5, additionalDiscountBps: 500 },
];

function line(overrides: Partial<RenewalLineInput> = {}): RenewalLineInput {
  return {
    subscriptionLineId: "line-1", variantId: "1", productId: "p1", sku: "SKU-1",
    productTitle: "Honey", variantTitle: "500 g", currentUnitPricePaise: 10_000,
    availableQuantity: 100, taxable: true, active: true, requestedQuantity: 1,
    ...overrides,
  };
}

describe("quantity tier renewal pricing", () => {
  it("applies the 2% base discount to one unit", () => {
    const quote = computeRenewalQuote({ lines: [line()], baseDiscountBps: 200, tiers, freeShippingThresholdPaise: 0, shippingFeePaise: 0 });
    expect(quote.effectiveDiscountBps).toBe(200);
    expect(quote.chargeAmountPaise).toBe(9_800);
  });

  it("counts quantity of the same SKU and applies the 3-unit 5% effective tier", () => {
    const quote = computeRenewalQuote({ lines: [line({ requestedQuantity: 3 })], baseDiscountBps: 200, tiers, freeShippingThresholdPaise: 0, shippingFeePaise: 0 });
    expect(quote.qualificationQuantity).toBe(3);
    expect(quote.tierBonusBps).toBe(300);
    expect(quote.chargeAmountPaise).toBe(28_500);
  });

  it("counts different products and uses the same total-unit tiers", () => {
    const quote = computeRenewalQuote({
      lines: [line({ requestedQuantity: 2 }), line({ subscriptionLineId: "line-2", variantId: "2", productId: "p2", requestedQuantity: 1 })],
      baseDiscountBps: 200, tiers, freeShippingThresholdPaise: 0, shippingFeePaise: 0,
    });
    expect(quote.qualificationQuantity).toBe(3);
    expect(quote.effectiveDiscountBps).toBe(500);
  });

  it("protects the qualified discount when stock drops after qualification", () => {
    const quote = computeRenewalQuote({
      lines: [line({ requestedQuantity: 3, availableQuantity: 1 })],
      baseDiscountBps: 200, tiers, freeShippingThresholdPaise: 20_000, shippingFeePaise: 4_900,
    });
    expect(quote.effectiveDiscountBps).toBe(500);
    expect(quote.lines[0].unavailableQuantity).toBe(2);
    expect(quote.merchandisePaise).toBe(9_500);
    expect(quote.shippingPaise).toBe(4_900);
  });

  it("skips a completely unavailable delivery without a charge", () => {
    const quote = computeRenewalQuote({ lines: [line({ availableQuantity: 0 })], baseDiscountBps: 200, tiers, freeShippingThresholdPaise: 0, shippingFeePaise: 4_900 });
    expect(quote.status).toBe("skipped_oos");
    expect(quote.chargeAmountPaise).toBe(0);
  });

  it("uses the highest matching tier and validates headroom", () => {
    expect(tierForQuantity(tiers, 8)?.minimumQuantity).toBe(5);
    expect(mandateHeadroomPaise(31_234)).toBe(70_000);
    expect(mandateHeadroomPaise(900_000)).toBe(1_500_000);
  });

  it("rejects discounts of 100% or more", () => {
    expect(() => computeRenewalQuote({ lines: [line({ requestedQuantity: 3 })], baseDiscountBps: 9_800, tiers, freeShippingThresholdPaise: 0, shippingFeePaise: 0 })).toThrow(/below|99.99|between/i);
  });
});
