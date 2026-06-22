import { describe, expect, it } from "vitest";
import {
  extractWebhookResourceId,
  hashWebhookPayload,
  isCustomerCreateTopic,
  processOrderFulfilled,
  processOrderPaid,
} from "../app/loyalty/webhooks";

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
      $transaction: async (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
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

  it("consumes only the actual paid discount and releases unused reserved points", async () => {
    const tx = {
      wallet: { update: async (input: unknown) => input },
      redemptionSession: { update: async (input: unknown) => input },
      ledgerEntry: {
        create: async (input: unknown) => input,
      },
    };
    const walletUpdates: unknown[] = [];
    const sessionUpdates: unknown[] = [];
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
          pointsReserved: 200,
          pointsConsumed: 0,
          pointsReleased: 0,
          discountAmount: 200,
          currency: "INR",
          customer: {
            wallet: { id: "wallet-1" },
          },
        }),
      },
      $transaction: async (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
    };

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

  it("does not consume points twice for a duplicate paid-order delivery", async () => {
    const db = {
      redemptionSession: {
        findFirst: async () => ({
          id: "session-1",
          customerId: "customer-1",
          pointsReserved: 200,
          pointsConsumed: 200,
          pointsReleased: 0,
          discountAmount: 200,
          currency: "INR",
          customer: {
            wallet: { id: "wallet-1" },
          },
        }),
      },
      $transaction: () => {
        throw new Error("duplicate consume should not open a transaction");
      },
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
});
