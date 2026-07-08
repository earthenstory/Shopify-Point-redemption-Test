import { describe, expect, it } from "vitest";
import {
  extractWebhookResourceId,
  hashWebhookPayload,
  isCustomerCreateTopic,
  processOrderCreated,
  processOrderFulfilled,
  processOrderPaid,
} from "../app/loyalty/webhooks";

function settingsModels() {
  return {
    loyaltyProgramSettings: {
      upsert: async () => ({
        status: "active",
        programName: "Earthen Loyalty",
        pointName: "Earthen Points",
      }),
    },
    rewardRule: {
      upsert: async () => ({
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
        allowDiscountStacking: false,
        discountCodeTtlMinutes: 60,
        awardOnStatus: "fulfilled",
        returnRedeemedPointsOnRefund: true,
        reverseEarnedPointsOnRefund: true,
      }),
    },
    loyaltyWidgetSettings: {
      upsert: async () => ({
        homepageEnabled: true,
        productEnabled: true,
        cartEnabled: true,
        accountEnabled: true,
      }),
    },
    loyaltyMilestoneRule: {
      findMany: async () => [],
    },
  };
}

describe("loyalty webhook helpers", () => {
  it("hashes payloads independently from object key order", () => {
    expect(hashWebhookPayload({ id: 1, nested: { b: 2, a: 1 } })).toBe(
      hashWebhookPayload({ nested: { a: 1, b: 2 }, id: 1 }),
    );
  });

  it("prefers Shopify GraphQL IDs when present", () => {
    expect(
      extractWebhookResourceId({
        id: 123,
        admin_graphql_api_id: "gid://shopify/Order/123",
      }),
    ).toBe("gid://shopify/Order/123");
  });

  it("falls back to numeric REST IDs", () => {
    expect(extractWebhookResourceId({ order_id: 987 })).toBe("987");
  });

  it("recognizes customer-create topics from literal and enum-style values", () => {
    expect(isCustomerCreateTopic("customers/create")).toBe(true);
    expect(isCustomerCreateTopic("CUSTOMERS_CREATE")).toBe(true);
    expect(isCustomerCreateTopic("customers/update")).toBe(false);
  });

  it("awards fulfilled-order points once and ignores duplicate fulfilled delivery", async () => {
    const tx = {
      loyaltyCustomer: {
        upsert: async () => ({
          id: "customer-1",
          wallet: { id: "wallet-1" },
        }),
      },
      wallet: { update: async (input: unknown) => input },
      ledgerEntry: { create: async (input: unknown) => input },
    };
    const walletUpdates: unknown[] = [];
    const ledgerCreates: unknown[] = [];
    tx.wallet.update = async (input) => {
      walletUpdates.push(input);
      return input;
    };
    tx.ledgerEntry.create = async (input) => {
      ledgerCreates.push(input);
      return input;
    };

    const db = {
      ledgerEntry: {
        findFirst: async () => null,
      },
      loyaltyCustomer: {
        upsert: async () => ({
          id: "customer-1",
          wallet: { id: "wallet-1", lifetimeEarnedPoints: 0 },
        }),
      },
      vipTier: { findMany: async () => [] },
      pointsCampaign: { findFirst: async () => null },
      referralAttribution: { findUnique: async () => null },
      $transaction: async (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ...settingsModels(),
    };

    await expect(
      processOrderFulfilled(db as never, {
        shop: "701031-e7.myshopify.com",
        topic: "orders/fulfilled",
        webhookId: "webhook-fulfilled-1",
        payload: {
          id: 123,
          customer: { id: 8584673591392 },
          subtotal_price: "1000.00",
        },
      }),
    ).resolves.toBe("processed");

    expect(walletUpdates).toEqual([
      {
        where: { id: "wallet-1" },
        data: {
          availablePoints: { increment: 20 },
          lifetimeEarnedPoints: { increment: 20 },
        },
      },
    ]);
    expect(ledgerCreates).toHaveLength(1);
    expect(ledgerCreates[0]).toMatchObject({
      data: {
        shopifyOrderId: "123",
        type: "order_earn",
        pointsDelta: 20,
      },
    });

    const duplicateDb = {
      ledgerEntry: {
        findFirst: async () => ({ id: "earn-1" }),
      },
      $transaction: () => {
        throw new Error("duplicate fulfilled delivery should not transact");
      },
      ...settingsModels(),
    };

    await expect(
      processOrderFulfilled(duplicateDb as never, {
        shop: "701031-e7.myshopify.com",
        topic: "orders/fulfilled",
        webhookId: "webhook-fulfilled-duplicate",
        payload: {
          id: 123,
          customer: { id: 8584673591392 },
          subtotal_price: "1000.00",
        },
      }),
    ).resolves.toBe("processed");
  });

  function consumableSessionDb(overrides?: {
    session?: Record<string, unknown>;
  }) {
    const tx = {
      wallet: { update: async (input: unknown) => input },
      redemptionSession: { update: async (input: unknown) => input },
      ledgerEntry: {
        create: async (input: unknown) => input,
      },
    };
    const walletUpdates: unknown[] = [];
    const sessionUpdates: unknown[] = [];
    const pinUpdates: unknown[] = [];
    const ledgerCreates: unknown[] = [];
    tx.wallet.update = async (input) => {
      walletUpdates.push(input);
      return input;
    };
    tx.redemptionSession.update = async (input) => {
      sessionUpdates.push(input);
      return input;
    };
    tx.ledgerEntry.create = async (input) => {
      ledgerCreates.push(input);
      return input;
    };

    const db = {
      redemptionSession: {
        findFirst: async () => ({
          id: "session-1",
          customerId: "customer-1",
          status: "applied",
          rewardType: null,
          pointsReserved: 200,
          pointsConsumed: 0,
          pointsReleased: 0,
          discountAmount: 200,
          currency: "INR",
          customer: {
            wallet: { id: "wallet-1" },
          },
          ...overrides?.session,
        }),
        // The order gets pinned onto the session before the consume
        // transaction runs.
        update: async (input: unknown) => {
          pinUpdates.push(input);
          return input;
        },
      },
      $transaction: async (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ...settingsModels(),
    };

    return { db, walletUpdates, sessionUpdates, pinUpdates, ledgerCreates };
  }

  it("consumes only the actual paid discount and releases unused reserved points", async () => {
    const { db, walletUpdates, sessionUpdates, pinUpdates, ledgerCreates } =
      consumableSessionDb();

    await expect(
      processOrderPaid(db as never, {
        shop: "701031-e7.myshopify.com",
        topic: "orders/paid",
        webhookId: "webhook-paid-1",
        payload: {
          id: 123,
          subtotal_price: "1000.00",
          discount_codes: [{ code: "ESPOINTS-QA", amount: "120.00" }],
        },
      }),
    ).resolves.toBe("processed");

    expect(pinUpdates).toHaveLength(1);
    expect(pinUpdates[0]).toMatchObject({
      where: { id: "session-1" },
      data: { shopifyOrderId: "123" },
    });
    expect(walletUpdates).toEqual([
      {
        where: { id: "wallet-1" },
        data: {
          availablePoints: { increment: 80 },
          pendingPoints: { decrement: 200 },
          lifetimeRedeemedPoints: { increment: 120 },
        },
      },
    ]);
    expect(sessionUpdates).toEqual([
      {
        where: { id: "session-1" },
        data: {
          pointsConsumed: { increment: 120 },
          pointsReleased: { increment: 80 },
          actualDiscountAmount: 120,
          shopifyOrderId: "123",
          status: "consumed",
        },
      },
    ]);
    expect(ledgerCreates).toHaveLength(2);
    expect(ledgerCreates[0]).toMatchObject({
      data: {
        type: "redeem_consume",
        moneyValue: 120,
      },
    });
    expect(ledgerCreates[1]).toMatchObject({
      data: {
        type: "redeem_release",
        pointsDelta: 80,
        moneyValue: 80,
      },
    });
  });

  it("consumes the reservation at orders/create — Razorpay-created orders never fire orders/paid", async () => {
    const { db, walletUpdates, sessionUpdates } = consumableSessionDb();

    await expect(
      processOrderCreated(db as never, {
        shop: "701031-e7.myshopify.com",
        topic: "orders/create",
        webhookId: "webhook-create-1",
        payload: {
          id: 456,
          // Created already paid by the channel: no paid transition will follow.
          financial_status: "paid",
          subtotal_price: "2798.00",
          discount_codes: [{ code: "ESPOINTS-QA", amount: "200.00" }],
        },
      }),
    ).resolves.toBe("processed");

    expect(walletUpdates).toEqual([
      {
        where: { id: "wallet-1" },
        data: {
          pendingPoints: { decrement: 200 },
          lifetimeRedeemedPoints: { increment: 200 },
        },
      },
    ]);
    expect(sessionUpdates).toEqual([
      {
        where: { id: "session-1" },
        data: {
          pointsConsumed: { increment: 200 },
          pointsReleased: { increment: 0 },
          actualDiscountAmount: 200,
          shopifyOrderId: "456",
          status: "consumed",
        },
      },
    ]);
  });

  it("does not consume points twice when orders/paid follows an already-consumed orders/create", async () => {
    const { db } = consumableSessionDb({
      session: { pointsConsumed: 200 },
    });
    (db as { $transaction: unknown }).$transaction = () => {
      throw new Error("duplicate consume should not open a transaction");
    };

    await expect(
      processOrderPaid(db as never, {
        shop: "701031-e7.myshopify.com",
        topic: "orders/paid",
        webhookId: "webhook-paid-duplicate",
        payload: {
          id: 123,
          subtotal_price: "1000.00",
          discount_codes: [{ code: "ESPOINTS-QA", amount: "200.00" }],
        },
      }),
    ).resolves.toBe("processed");
  });

  it("reclaims a released hold out of the wallet when the code was still used on the order", async () => {
    const { db, walletUpdates, sessionUpdates } = consumableSessionDb({
      session: { status: "released", pointsReleased: 200 },
    });
    const walletUpdateManys: unknown[] = [];
    (db as Record<string, unknown>).wallet = {
      updateMany: async (input: unknown) => {
        walletUpdateManys.push(input);
        return { count: 1 };
      },
    };

    await expect(
      processOrderCreated(db as never, {
        shop: "701031-e7.myshopify.com",
        topic: "orders/create",
        webhookId: "webhook-create-reclaim",
        payload: {
          id: 789,
          financial_status: "paid",
          subtotal_price: "1000.00",
          discount_codes: [{ code: "ESPOINTS-QA", amount: "200.00" }],
        },
      }),
    ).resolves.toBe("processed");

    // The wrongly-returned points come back out of the available balance
    // (guarded against overdraft)…
    expect(walletUpdateManys).toEqual([
      {
        where: { id: "wallet-1", availablePoints: { gte: 200 } },
        data: { availablePoints: { decrement: 200 } },
      },
    ]);
    // …and are consumed: no pending hold is left, so only the lifetime
    // counter moves inside the transaction.
    expect(walletUpdates).toEqual([
      {
        where: { id: "wallet-1" },
        data: {
          lifetimeRedeemedPoints: { increment: 200 },
        },
      },
    ]);
    expect(sessionUpdates).toEqual([
      {
        where: { id: "session-1" },
        data: {
          pointsConsumed: { increment: 200 },
          pointsReleased: { increment: -200 },
          actualDiscountAmount: 200,
          shopifyOrderId: "789",
          status: "consumed",
        },
      },
    ]);
  });

  it("repairs a mis-settled session that consumed 0 and released everything", async () => {
    // State left by a settle that saw no discount amount: status consumed,
    // pointsConsumed 0, pointsReleased = full reservation. The deficit-driven
    // settle must pull the points back and consume them.
    const { db, walletUpdates, sessionUpdates } = consumableSessionDb({
      session: { status: "consumed", pointsConsumed: 0, pointsReleased: 200 },
    });
    const walletUpdateManys: unknown[] = [];
    (db as Record<string, unknown>).wallet = {
      updateMany: async (input: unknown) => {
        walletUpdateManys.push(input);
        return { count: 1 };
      },
    };

    await expect(
      processOrderCreated(db as never, {
        shop: "701031-e7.myshopify.com",
        topic: "orders/create",
        webhookId: "webhook-create-repair",
        payload: {
          id: 790,
          financial_status: "paid",
          subtotal_price: "1000.00",
          discount_codes: [{ code: "ESPOINTS-QA", amount: "200.00" }],
        },
      }),
    ).resolves.toBe("processed");

    expect(walletUpdateManys).toEqual([
      {
        where: { id: "wallet-1", availablePoints: { gte: 200 } },
        data: { availablePoints: { decrement: 200 } },
      },
    ]);
    expect(walletUpdates).toEqual([
      {
        where: { id: "wallet-1" },
        data: {
          lifetimeRedeemedPoints: { increment: 200 },
        },
      },
    ]);
    expect(sessionUpdates).toEqual([
      {
        where: { id: "session-1" },
        data: {
          pointsConsumed: { increment: 200 },
          pointsReleased: { increment: -200 },
          actualDiscountAmount: 200,
          shopifyOrderId: "790",
          status: "consumed",
        },
      },
    ]);
  });

  it("ignores settle for cancelled orders (reconcile passes cancelled_at)", async () => {
    const { db } = consumableSessionDb({
      session: { status: "released", pointsReleased: 200 },
    });
    (db as { $transaction: unknown }).$transaction = () => {
      throw new Error("cancelled order must not settle");
    };

    await expect(
      processOrderCreated(db as never, {
        shop: "701031-e7.myshopify.com",
        topic: "orders/create",
        webhookId: "webhook-create-cancelled",
        payload: {
          id: 791,
          cancelled_at: "2026-07-08T10:00:00Z",
          subtotal_price: "1000.00",
          discount_codes: [{ code: "ESPOINTS-QA", amount: "200.00" }],
        },
      }),
    ).resolves.toBe("ignored");
  });
});
