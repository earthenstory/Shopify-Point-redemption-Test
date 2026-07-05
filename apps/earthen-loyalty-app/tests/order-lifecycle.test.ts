import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateLoyaltyRuntimeSettings } from "../app/loyalty/settings";
import {
  processOrderCancelled,
  processOrderCreated,
  processOrderDelivered,
} from "../app/loyalty/webhooks";

const SHOP = "701031-e7.myshopify.com";

// getLoyaltyRuntimeSettings caches per shop for 60s; reset between tests so
// each test's mocked awardOnStatus takes effect.
beforeEach(() => invalidateLoyaltyRuntimeSettings(SHOP));

function settingsModels(awardOnStatus: string) {
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
        awardOnStatus,
        returnRedeemedPointsOnRefund: true,
        reverseEarnedPointsOnRefund: true,
      }),
    },
    loyaltyWidgetSettings: { upsert: vi.fn().mockResolvedValue({}) },
    loyaltyMilestoneRule: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

const orderContext = {
  shop: SHOP,
  topic: "orders/delivered",
  webhookId: "wh-del-1",
  payload: {
    id: 5001,
    customer: { id: 8584673591392 },
    subtotal_price: "1000.00",
  },
};

describe("delivery-based earning", () => {
  function awardDb(awardOnStatus: string) {
    const tx = {
      loyaltyCustomer: {
        upsert: vi.fn().mockResolvedValue({
          id: "customer-1",
          wallet: { id: "wallet-1" },
        }),
      },
      wallet: { update: vi.fn().mockResolvedValue({}) },
      ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      ledgerEntry: { findFirst: vi.fn().mockResolvedValue(null) },
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
      $transaction: vi
        .fn()
        .mockImplementation((callback: (t: typeof tx) => unknown) =>
          callback(tx),
        ),
      ...settingsModels(awardOnStatus),
    };
    return { db, tx };
  }

  it("awards on the delivered event when awardOnStatus is delivered", async () => {
    const { db, tx } = awardDb("delivered");
    await expect(
      processOrderDelivered(db as never, orderContext),
    ).resolves.toBe("processed");
    expect(tx.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availablePoints: { increment: 20 },
        }),
      }),
    );
  });

  it("ignores delivered events when awarding at fulfillment", async () => {
    const { db, tx } = awardDb("fulfilled");
    await expect(
      processOrderDelivered(db as never, orderContext),
    ).resolves.toBe("ignored");
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });
});

describe("order-created reservation pinning", () => {
  const basePayload = {
    id: 6001,
    discount_codes: [{ code: "ESPOINTS-1-A-B" }],
  };

  it("pins an active reservation to the order and extends its expiry", async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
      redemptionSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          status: "applied",
          pointsReserved: 100,
          customer: { wallet: { id: "wallet-1" } },
        }),
        update,
      },
    };

    await expect(
      processOrderCreated(db as never, {
        shop: SHOP,
        topic: "orders/create",
        webhookId: "wh-oc-1",
        payload: basePayload,
      }),
    ).resolves.toBe("processed");

    const call = update.mock.calls[0][0];
    expect(call.data.shopifyOrderId).toBe("6001");
    expect(call.data.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    );
  });

  it("re-reserves a released hold when the code was still used at checkout", async () => {
    const db = {
      redemptionSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          status: "released",
          pointsReserved: 100,
          discountAmount: 100,
          currency: "INR",
          customerId: "customer-1",
          customer: { wallet: { id: "wallet-1" } },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      wallet: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn().mockImplementation((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    };

    await expect(
      processOrderCreated(db as never, {
        shop: SHOP,
        topic: "orders/create",
        webhookId: "wh-oc-2",
        payload: basePayload,
      }),
    ).resolves.toBe("processed");
    expect(db.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          availablePoints: { decrement: 100 },
          pendingPoints: { increment: 100 },
        },
      }),
    );
  });

  it("flags manual review when the released points were already spent", async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
      redemptionSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          status: "released",
          pointsReserved: 100,
          customerId: "customer-1",
          customer: { wallet: { id: "wallet-1" } },
        }),
        update,
      },
      wallet: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };

    await processOrderCreated(db as never, {
      shop: SHOP,
      topic: "orders/create",
      webhookId: "wh-oc-3",
      payload: basePayload,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "manual_review" }),
      }),
    );
  });
});

describe("cancelled orders return reserved points", () => {
  it("releases an unconsumed reservation linked to the cancelled order", async () => {
    const walletUpdate = vi.fn().mockResolvedValue({});
    const db = {
      ...settingsModels("delivered"),
      redemptionSession: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "session-1",
              pointsReserved: 80,
              pointsConsumed: 0,
              pointsReleased: 0,
              discountAmount: 80,
              currency: "INR",
              customerId: "customer-1",
              customer: { wallet: { id: "wallet-1" } },
            },
          ])
          // returnRedeemedPointsForOrder scan (consumed sessions): none
          .mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
      },
      wallet: { update: walletUpdate },
      ledgerEntry: {
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _sum: { pointsDelta: 0 } }),
      },
      $transaction: vi.fn().mockImplementation((ops: unknown) =>
        Array.isArray(ops)
          ? Promise.all(ops as Promise<unknown>[])
          : (ops as (tx: unknown) => unknown)(db),
      ),
    };

    await expect(
      processOrderCancelled(db as never, {
        shop: SHOP,
        topic: "orders/cancelled",
        webhookId: "wh-can-1",
        payload: { id: 7001 },
      }),
    ).resolves.toBe("processed");

    expect(walletUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          availablePoints: { increment: 80 },
          pendingPoints: { decrement: 80 },
        },
      }),
    );
  });
});
