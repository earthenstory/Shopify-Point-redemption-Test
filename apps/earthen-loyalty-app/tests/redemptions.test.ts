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

  it("rejects a replay redemption when the same cart already has an active session", async () => {
    const db = {
      loyaltyCustomer: {
        findUnique: vi.fn().mockResolvedValue({
          id: "customer-1",
          wallet: {
            id: "wallet-1",
            availablePoints: 500,
          },
        }),
      },
      redemptionSession: {
        findFirst: vi.fn().mockResolvedValue({ id: "session-1" }),
      },
      $transaction: vi.fn(),
      ...settingsModels(),
    };
    const admin = { graphql: vi.fn() };

    await expect(
      createRedemption({
        db: db as never,
        admin: admin as never,
        shopDomain: "701031-e7.myshopify.com",
        shopifyCustomerId: "8584673591392",
        requestedPoints: 100,
        cart: { token: "cart-1", subtotal: 1000 },
      }),
    ).rejects.toThrow("already have points applied");

    expect(db.redemptionSession.findFirst).toHaveBeenCalledWith({
      where: {
        customerId: "customer-1",
        cartToken: "cart-1",
        status: { in: ["pending", "applied"] },
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(admin.graphql).not.toHaveBeenCalled();
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
