import { describe, expect, it, vi } from "vitest";
import {
  applyEarnMultiplier,
  getEarnMultiplierContext,
  resolveTier,
} from "../app/loyalty/multipliers";

const tiers = [
  { id: "t1", name: "Bronze", thresholdPoints: 0, earnMultiplier: 1 },
  { id: "t2", name: "Silver", thresholdPoints: 2000, earnMultiplier: 1.25 },
  { id: "t3", name: "Gold", thresholdPoints: 10000, earnMultiplier: 1.5 },
] as never[];

describe("VIP tier resolution", () => {
  it("picks the highest tier at or below lifetime points", () => {
    expect(resolveTier(tiers, 0).currentTier?.name).toBe("Bronze");
    expect(resolveTier(tiers, 1999).currentTier?.name).toBe("Bronze");
    expect(resolveTier(tiers, 2000).currentTier?.name).toBe("Silver");
    expect(resolveTier(tiers, 50000).currentTier?.name).toBe("Gold");
  });

  it("reports the next tier for progress display", () => {
    expect(resolveTier(tiers, 500).nextTier?.name).toBe("Silver");
    expect(resolveTier(tiers, 2000).nextTier?.name).toBe("Gold");
    expect(resolveTier(tiers, 10000).nextTier).toBeNull();
  });
});

describe("earn multiplier math", () => {
  it("floors multiplied points and never goes negative", () => {
    expect(applyEarnMultiplier(20, 1)).toBe(20);
    expect(applyEarnMultiplier(20, 1.25)).toBe(25);
    expect(applyEarnMultiplier(21, 1.25)).toBe(26); // 26.25 -> 26
    expect(applyEarnMultiplier(0, 2)).toBe(0);
    expect(applyEarnMultiplier(-5, 2)).toBe(0);
  });

  it("combines tier and live-campaign multipliers", async () => {
    const now = new Date("2026-07-04T10:00:00Z");
    const db = {
      vipTier: {
        findMany: vi.fn().mockResolvedValue([
          { name: "Silver", thresholdPoints: 2000, earnMultiplier: 1.25 },
        ]),
      },
      pointsCampaign: {
        findFirst: vi.fn().mockResolvedValue({
          title: "Weekend 2x",
          multiplier: 2,
          startsAt: new Date("2026-07-03T00:00:00Z"),
          endsAt: new Date("2026-07-06T00:00:00Z"),
        }),
      },
    };

    const context = await getEarnMultiplierContext({
      db: db as never,
      shopDomain: "701031-e7.myshopify.com",
      lifetimeEarnedPoints: 3000,
      now,
    });

    expect(context.vipMultiplier).toBe(1.25);
    expect(context.campaignMultiplier).toBe(2);
    expect(context.totalMultiplier).toBe(2.5);
    expect(applyEarnMultiplier(20, context.totalMultiplier)).toBe(50);
  });

  it("uses 1x when no tier or campaign applies", async () => {
    const db = {
      vipTier: { findMany: vi.fn().mockResolvedValue([]) },
      pointsCampaign: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const context = await getEarnMultiplierContext({
      db: db as never,
      shopDomain: "701031-e7.myshopify.com",
      lifetimeEarnedPoints: 100,
    });
    expect(context.totalMultiplier).toBe(1);
  });
});
