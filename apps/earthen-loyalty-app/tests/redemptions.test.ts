import { describe, expect, it, vi } from "vitest";
import {
  createRedemption,
  previewRedemption,
  releaseRedemption,
} from "../app/loyalty/redemptions";

function settingsModels() {
  return {
    loyaltyProgramSettings: {
      upsert: vi.fn().mockResolvedValue({
        status: "active",
        programName: "Earthen Loyalty",
        pointName: "Earthen Points",
      }),
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
        allowDiscountStacking: false,
        discountCodeTtlMinutes: 60,
        awardOnStatus: "fulfilled",
        returnRedeemedPointsOnRefund: true,
        reverseEarnedPointsOnRefund: true,
      }),
    },
    loyaltyWidgetSettings: {
      upsert: vi.fn().mockResolvedValue({
        homepageEnabled: true,
        productEnabled: true,
        cartEnabled: true,
        accountEnabled: true,
      }),
    },
    loyaltyMilestoneRule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

describe("redemption preview", () => {
  it("returns zero when the customer has no migrated points", () => {
    expect(
      previewRedemption({
        availablePoints: 0,
        cart: { subtotal: 1000 },
      }),
    ).toEqual({
      maxRedeemablePoints: 0,
      discountAmount: 0,
      minimumSubtotal: 0,
      currency: "INR",
    });
  });

  it("allows full wallet redemption up to the cart subtotal", () => {
    expect(
      previewRedemption({
        availablePoints: 900,
        cart: { subtotal: 1000 },
      }),
    ).toMatchObject({
      maxRedeemablePoints: 900,
      discountAmount: 900,
      minimumSubtotal: 900,
    });
  });

  it("releases a prior active reservation and re-reserves when applying again", async () => {
    const releaseTx = {
      wallet: { update: vi.fn().mockResolvedValue({}) },
      redemptionSession: { update: vi.fn().mockResolvedValue({}) },
      ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    const reserveTx = {
      wallet: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      redemptionSession: { create: vi.fn().mockResolvedValue({ id: "new-session" }) },
      ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    let txCall = 0;
    const db = {
      loyaltyCustomer: {
        findUnique: vi.fn().mockResolvedValue({
          id: "customer-1",
          wallet: { id: "wallet-1", availablePoints: 500 },
        }),
      },
      wallet: {
        findUnique: vi.fn().mockResolvedValue({ availablePoints: 500 }),
      },
      redemptionSession: {
        // A stale reservation is still active for this customer.
        findMany: vi.fn().mockResolvedValue([{ id: "old-session" }]),
        findFirst: vi.fn().mockResolvedValue({
          id: "old-session",
          customerId: "customer-1",
          pointsReserved: 50,
          pointsConsumed: 0,
          discountAmount: 50,
          currency: "INR",
          shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/old",
          customer: { wallet: { id: "wallet-1" } },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn().mockImplementation((callback: (tx: unknown) => unknown) => {
        txCall += 1;
        return callback(txCall === 1 ? releaseTx : reserveTx);
      }),
      ...settingsModels(),
    };
    const admin = {
      graphql: vi.fn().mockImplementation((query: string) => ({
        json: async () =>
          String(query).includes("discountCodeBasicCreate")
            ? {
                data: {
                  discountCodeBasicCreate: {
                    codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/new" },
                    userErrors: [],
                  },
                },
              }
            : {
                data: {
                  discountCodeDeactivate: {
                    codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/old" },
                    userErrors: [],
                  },
                },
              },
      })),
    };

    const result = await createRedemption({
      db: db as never,
      admin: admin as never,
      shopDomain: "701031-e7.myshopify.com",
      shopifyCustomerId: "8584673591392",
      requestedPoints: 100,
      cart: { token: "cart-1", subtotal: 1000 },
    });

    // The prior reservation is released (points returned) instead of throwing.
    expect(db.redemptionSession.findMany).toHaveBeenCalled();
    expect(releaseTx.wallet.update).toHaveBeenCalledWith({
      where: { id: "wallet-1" },
      data: { availablePoints: { increment: 50 }, pendingPoints: { decrement: 50 } },
    });
    // A fresh reservation + discount is then created.
    expect(reserveTx.redemptionSession.create).toHaveBeenCalled();
    expect(admin.graphql).toHaveBeenCalledWith(
      expect.stringContaining("discountCodeBasicCreate"),
      expect.anything(),
    );
    expect(result).toMatchObject({ sessionId: "new-session", pointsReserved: 100 });
  });

  it("returns a safe error when a Shopify customer has no wallet yet", async () => {
    const db = {
      loyaltyCustomer: {
        findUnique: vi.fn().mockResolvedValue({
          id: "customer-1",
          wallet: null,
        }),
      },
      redemptionSession: {
        findFirst: vi.fn(),
      },
    };

    await expect(
      createRedemption({
        db: db as never,
        admin: { graphql: vi.fn() } as never,
        shopDomain: "701031-e7.myshopify.com",
        shopifyCustomerId: "8584673591392",
        requestedPoints: 100,
        cart: { token: "cart-1", subtotal: 1000 },
      }),
    ).rejects.toThrow("points are still being prepared");

    expect(db.redemptionSession.findFirst).not.toHaveBeenCalled();
  });

  it("deactivates the Shopify discount when releasing an applied redemption", async () => {
    const tx = {
      wallet: { update: vi.fn().mockResolvedValue({}) },
      redemptionSession: { update: vi.fn().mockResolvedValue({}) },
      ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      redemptionSession: {
        findFirst: vi.fn().mockResolvedValue({
          id: "session-1",
          customerId: "customer-1",
          pointsReserved: 100,
          pointsConsumed: 0,
          discountAmount: 100,
          currency: "INR",
          shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/123",
          customer: {
            wallet: { id: "wallet-1" },
          },
        }),
      },
      $transaction: vi
        .fn()
        .mockImplementation((callback: (transaction: typeof tx) => unknown) =>
          callback(tx),
        ),
    };
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => ({
          data: {
            discountCodeDeactivate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/123",
              },
              userErrors: [],
            },
          },
        }),
      }),
    };

    await expect(
      releaseRedemption({
        db: db as never,
        admin: admin as never,
        shopDomain: "701031-e7.myshopify.com",
        shopifyCustomerId: "8584673591392",
        sessionId: "session-1",
      }),
    ).resolves.toEqual({ released: true });

    expect(admin.graphql).toHaveBeenCalledWith(
      expect.stringContaining("discountCodeDeactivate"),
      {
        variables: {
          id: "gid://shopify/DiscountCodeNode/123",
        },
      },
    );
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: "wallet-1" },
      data: {
        availablePoints: { increment: 100 },
        pendingPoints: { decrement: 100 },
      },
    });
  });
});
