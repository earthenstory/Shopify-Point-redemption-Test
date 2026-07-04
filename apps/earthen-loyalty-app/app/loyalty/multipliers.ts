import type { PointsCampaign, PrismaClient, VipTier } from "@prisma/client";

// VIP tiers + limited-time point campaigns both act as earn multipliers.
// Tier membership is computed from the wallet's lifetimeEarnedPoints at award
// time (highest enabled tier at or below the total), so there is no stored
// assignment to drift out of sync.

export type EarnMultiplierContext = {
  currentTier: VipTier | null;
  nextTier: VipTier | null;
  vipMultiplier: number;
  campaign: PointsCampaign | null;
  campaignMultiplier: number;
  totalMultiplier: number;
};

export function resolveTier(
  tiers: VipTier[],
  lifetimeEarnedPoints: number,
): { currentTier: VipTier | null; nextTier: VipTier | null } {
  let currentTier: VipTier | null = null;
  let nextTier: VipTier | null = null;
  const sorted = [...tiers].sort(
    (left, right) => left.thresholdPoints - right.thresholdPoints,
  );
  for (const tier of sorted) {
    if (lifetimeEarnedPoints >= tier.thresholdPoints) {
      currentTier = tier;
    } else {
      nextTier = tier;
      break;
    }
  }
  return { currentTier, nextTier };
}

export function applyEarnMultiplier(
  basePoints: number,
  totalMultiplier: number,
): number {
  if (basePoints <= 0) return 0;
  return Math.max(0, Math.floor(basePoints * totalMultiplier));
}

export async function getEarnMultiplierContext(input: {
  db: PrismaClient;
  shopDomain: string;
  lifetimeEarnedPoints: number;
  now?: Date;
}): Promise<EarnMultiplierContext> {
  const now = input.now ?? new Date();
  const [tiers, campaign] = await Promise.all([
    input.db.vipTier.findMany({
      where: { shopDomain: input.shopDomain, enabled: true },
      orderBy: { thresholdPoints: "asc" },
    }),
    input.db.pointsCampaign.findFirst({
      where: {
        shopDomain: input.shopDomain,
        enabled: true,
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      orderBy: { multiplier: "desc" },
    }),
  ]);

  const { currentTier, nextTier } = resolveTier(
    tiers,
    input.lifetimeEarnedPoints,
  );
  const vipMultiplier = currentTier ? Number(currentTier.earnMultiplier) : 1;
  const campaignMultiplier = campaign ? Number(campaign.multiplier) : 1;

  return {
    currentTier,
    nextTier,
    vipMultiplier,
    campaign,
    campaignMultiplier,
    totalMultiplier: vipMultiplier * campaignMultiplier,
  };
}
