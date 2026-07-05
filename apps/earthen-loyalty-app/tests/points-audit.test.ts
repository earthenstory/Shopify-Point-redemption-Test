import { beforeEach, describe, expect, it, vi } from "vitest";
import { reverseReferralForCancelledOrder } from "../app/loyalty/referrals";
import { invalidateLoyaltyRuntimeSettings } from "../app/loyalty/settings";
import {
  processOrderDelivered,
  processRefundCreated,
} from "../app/loyalty/webhooks";

const SHOP = "701031-e7.myshopify.com";

beforeEach(() => invalidateLoyaltyRuntimeSettings(SHOP));

function settingsModels(milestones: unknown[] = []) {
  return {
    loyaltyProgramSettings: {
      upsert: vi.fn().mockResolvedValue({ status: "active" }),
    },
    rewardRule: {
      upsert: vi.fn().mockResolvedValue({
        earningEnabled: true,
        redemptionEnabled: true,
        signupRewardPoints: 250,
        pointsPerSpendAmount: 2,
        spendAmountForEarnPoints: 100,
        currencyValuePerPoint: 1,
        minRedeemPoints: 10,
        redeemIncrementPoints: 10,
        maxRedeemPercentOfCart: 100,
        maxRedeemPointsPerOrder: null,
        allowDiscountStacking: true,
        discountCodeTtlMinutes: 60,
        awardOnStatus: "delivered",
        returnRedeemedPointsOnRefund: true,
        reverseEarnedPointsOnRefund: true,
      }),
    },
    loyaltyWidgetSettings: { upsert: vi.fn().mockResolvedValue({}) },
    loyaltyMilestoneRule: { findMany: vi.fn().mockResolvedValue(milestones) },
  };
}

describe("referral clawback on cancelled order", () => {
  it("reverses both payouts exactly once via the rewarded->blocked transition", async () => {
    const walletUpdates: unknown[] = [];
    const tx = {
      referralAttribution: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      wallet: {
        update: vi.fn().mockImplementation((input: unknown) => {
          walletUpdates.push(input);
          return Promise.resolve({});
        }),
      },
      ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      referralAttribution: {
        findFirst: vi.fn().mockResolvedValue({ id: "attr-1" }),
      },
      ledgerEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pay-1",
            customerId: "referrer-1",
            walletId: "wallet-r",
            pointsDelta: 200,
            currency: "INR",
            customer: { wallet: { id: "wallet-r" } },
          },
          {
            id: "pay-2",
            customerId: "referee-1",
            walletId: "wallet-e",
            pointsDelta: 100,
            currency: "INR",
            customer: { wallet: { id: "wallet-e" } },
          },
        ]),
      },
      $transaction: vi
        .fn()
        .mockImplementation((callback: (t: typeof tx) => unknown) =>
          callback(tx),
        ),
    };

    const result = await reverseReferralForCancelledOrder({
      db: db as never,
      shopDomain: SHOP,
      orderId: "9100",
    });
    expect(result.reversed).toBe(true);
    expect(walletUpdates).toHaveLength(2);
    expect(walletUpdates[0]).toMatchObject({
      data: { availablePoints: { decrement: 200 } },
    });
    expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(2);
  });

  it("does nothing when another webhook already clawed it back", async () => {
    const tx = {
      referralAttribution: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      wallet: { update: vi.fn() },
      ledgerEntry: { create: vi.fn() },
    };
    const db = {
      referralAttribution: {
        findFirst: vi.fn().mockResolvedValue({ id: "attr-1" }),
      },
      ledgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi
        .fn()
        .mockImplementation((callback: (t: typeof tx) => unknown) =>
          callback(tx),
        ),
    };
    const result = await reverseReferralForCancelledOrder({
      db: db as never,
      shopDomain: SHOP,
      orderId: "9100",
    });
    expect(result.reversed).toBe(false);
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });
});

describe("milestone awards on earned orders", () => {
  function milestoneDb(milestones: unknown[], earnEntriesAfterAward: unknown[]) {
    const awardTx = {
      loyaltyCustomer: {
        upsert: vi.fn().mockResolvedValue({
          id: "customer-1",
          wallet: { id: "wallet-1" },
        }),
      },
      wallet: { update: vi.fn().mockResolvedValue({}) },
      ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    const milestoneOps: unknown[] = [];
    const db = {
      ledgerEntry: {
        // 1st: existingEarn dedupe (none). Later: milestone engine reads earn
        // entries; once-guard lookups return null.
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue(earnEntriesAfterAward),
        create: vi.fn().mockResolvedValue({}),
      },
      loyaltyCustomer: {
        upsert: vi.fn().mockResolvedValue({
          id: "customer-1",
          wallet: { id: "wallet-1", lifetimeEarnedPoints: 0 },
        }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      vipTier: { findMany: vi.fn().mockResolvedValue([]) },
      pointsCampaign: { findFirst: vi.fn().mockResolvedValue(null) },
      referralAttribution: { findUnique: vi.fn().mockResolvedValue(null) },
      wallet: { update: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (Array.isArray(arg)) {
          milestoneOps.push(arg);
          return Promise.all(arg as Promise<unknown>[]);
        }
        return (arg as (t: typeof awardTx) => unknown)(awardTx);
      }),
      ...settingsModels(milestones),
    };
    return { db, milestoneOps };
  }

  const context = {
    shop: SHOP,
    topic: "orders/delivered",
    webhookId: "wh-m-1",
    payload: {
      id: 8001,
      customer: { id: 42 },
      subtotal_price: "1000.00",
    },
  };

  it("awards a first_order milestone on the first earned order", async () => {
    const { db, milestoneOps } = milestoneDb(
      [
        {
          id: "rule-first",
          type: "first_order",
          title: "First order bonus",
          enabled: true,
          points: 100,
          repeatable: false,
          thresholdAmount: null,
          thresholdOrderCount: null,
        },
      ],
      [{ metadata: { orderSubtotal: 1000 } }], // exactly one earned order
    );

    await expect(processOrderDelivered(db as never, context)).resolves.toBe(
      "processed",
    );
    expect(milestoneOps).toHaveLength(1);
  });

  it("does not award order_count milestones before the threshold", async () => {
    const { db, milestoneOps } = milestoneDb(
      [
        {
          id: "rule-count",
          type: "order_count",
          title: "5 orders club",
          enabled: true,
          points: 150,
          repeatable: false,
          thresholdAmount: null,
          thresholdOrderCount: 5,
        },
      ],
      [
        { metadata: { orderSubtotal: 1000 } },
        { metadata: { orderSubtotal: 500 } },
      ], // only 2 orders so far
    );

    await processOrderDelivered(db as never, context);
    expect(milestoneOps).toHaveLength(0);
  });

  it("awards spend_amount milestone when cumulative spend crosses the threshold", async () => {
    const { db, milestoneOps } = milestoneDb(
      [
        {
          id: "rule-spend",
          type: "spend_amount",
          title: "₹5,000 spender",
          enabled: true,
          points: 200,
          repeatable: false,
          thresholdAmount: 5000,
          thresholdOrderCount: null,
        },
      ],
      // prior spend 4,500 + this order 1,000 = 5,500 crosses 5,000
      [
        { metadata: { orderSubtotal: 4500 } },
        { metadata: { orderSubtotal: 1000 } },
      ],
    );

    await processOrderDelivered(db as never, context);
    expect(milestoneOps).toHaveLength(1);
  });
});

describe("multiplier-aware refund reversal", () => {
  it("reverses proportionally to the boosted earn, not the base rate", async () => {
    // Order ₹1,000 earned 50 pts (2.5x campaign). Refund of ₹500 must reverse
    // 25 pts (half of the actual earn), not the base-rate 10 pts.
    const reversals: unknown[] = [];
    const db = {
      ...settingsModels(),
      ledgerEntry: {
        findFirst: vi.fn().mockResolvedValue({
          pointsDelta: 50,
          metadata: { orderSubtotal: 1000 },
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "earn-1",
            pointsDelta: 50,
            customerId: "customer-1",
            walletId: "wallet-1",
            currency: "INR",
            customer: { wallet: { id: "wallet-1" } },
          },
        ]),
        aggregate: vi.fn().mockResolvedValue({ _sum: { pointsDelta: 0 } }),
        create: vi.fn().mockImplementation((input: unknown) => {
          reversals.push(input);
          return Promise.resolve({});
        }),
      },
      redemptionSession: { findMany: vi.fn().mockResolvedValue([]) },
      wallet: { update: vi.fn().mockResolvedValue({}) },
      $transaction: vi
        .fn()
        .mockImplementation((callback: (t: unknown) => unknown) =>
          callback(db),
        ),
    };

    await processRefundCreated(db as never, {
      shop: SHOP,
      topic: "refunds/create",
      webhookId: "wh-r-1",
      payload: {
        id: 9500,
        order_id: 8001,
        refund_line_items: [{ subtotal: "500.00" }],
      },
    });

    expect(reversals[0]).toMatchObject({
      data: { pointsDelta: -25, type: "refund_reversal" },
    });
  });
});
