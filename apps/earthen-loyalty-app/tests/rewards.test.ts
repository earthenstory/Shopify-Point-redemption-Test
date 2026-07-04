import { describe, expect, it, vi } from "vitest";
import { claimReward } from "../app/loyalty/redemptions";
import { claimEarnAction } from "../app/loyalty/earn-actions";

function settingsModels() {
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
        awardOnStatus: "fulfilled",
        returnRedeemedPointsOnRefund: true,
        reverseEarnedPointsOnRefund: true,
      }),
    },
    loyaltyWidgetSettings: { upsert: vi.fn().mockResolvedValue({}) },
    loyaltyMilestoneRule: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

function baseDb(overrides: Record<string, unknown> = {}) {
  return {
    rewardDefinition: {
      findFirst: vi.fn().mockResolvedValue({
        id: "reward-1",
        shopDomain: "701031-e7.myshopify.com",
        title: "₹100 off",
        type: "fixed_amount",
        pointsCost: 100,
        value: 100,
        minSubtotal: null,
        enabled: true,
      }),
    },
    loyaltyCustomer: {
      findUnique: vi.fn().mockResolvedValue({
        id: "customer-1",
        wallet: { id: "wallet-1", availablePoints: 110 },
      }),
    },
    wallet: {
      findUnique: vi.fn().mockResolvedValue({ availablePoints: 110 }),
    },
    redemptionSession: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation((callback: (tx: unknown) => unknown) =>
      callback({
        wallet: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        redemptionSession: {
          create: vi.fn().mockResolvedValue({ id: "session-1" }),
        },
        ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
      }),
    ),
    ...settingsModels(),
    ...overrides,
  };
}

function adminReturning(mutationResponses: Record<string, unknown>) {
  return {
    graphql: vi.fn().mockImplementation((query: string) => ({
      json: async () => {
        for (const [needle, response] of Object.entries(mutationResponses)) {
          if (String(query).includes(needle)) return response;
        }
        return { data: {} };
      },
    })),
  };
}

const basicCreateOk = {
  data: {
    discountCodeBasicCreate: {
      codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/new" },
      userErrors: [],
    },
  },
};
const freeShippingOk = {
  data: {
    discountCodeFreeShippingCreate: {
      codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/ship" },
      userErrors: [],
    },
  },
};

describe("reward catalog claims", () => {
  it("claims a fixed-amount reward and reserves its points cost", async () => {
    const db = baseDb();
    const admin = adminReturning({ discountCodeBasicCreate: basicCreateOk });

    const claim = await claimReward({
      db: db as never,
      admin: admin as never,
      shopDomain: "701031-e7.myshopify.com",
      shopifyCustomerId: "7024197173344",
      rewardId: "reward-1",
      cart: { token: "cart-1", subtotal: 1000 },
    });

    expect(claim).toMatchObject({
      sessionId: "session-1",
      pointsReserved: 100,
      discountAmount: 100,
      rewardType: "fixed_amount",
    });
  });

  it("rejects a claim when the customer lacks points", async () => {
    const db = baseDb({
      wallet: { findUnique: vi.fn().mockResolvedValue({ availablePoints: 50 }) },
    });
    const admin = adminReturning({});

    await expect(
      claimReward({
        db: db as never,
        admin: admin as never,
        shopDomain: "701031-e7.myshopify.com",
        shopifyCustomerId: "7024197173344",
        rewardId: "reward-1",
        cart: { token: "cart-1", subtotal: 1000 },
      }),
    ).rejects.toThrow("need 100 points");
  });

  it("enforces the reward's minimum subtotal", async () => {
    const db = baseDb({
      rewardDefinition: {
        findFirst: vi.fn().mockResolvedValue({
          id: "reward-2",
          title: "15% off",
          type: "percent_off",
          pointsCost: 200,
          value: 15,
          minSubtotal: 3000,
          enabled: true,
        }),
      },
    });
    const admin = adminReturning({});

    await expect(
      claimReward({
        db: db as never,
        admin: admin as never,
        shopDomain: "701031-e7.myshopify.com",
        shopifyCustomerId: "7024197173344",
        rewardId: "reward-2",
        cart: { token: "cart-1", subtotal: 1000 },
      }),
    ).rejects.toThrow("at least INR 3000");
  });

  it("creates a free-shipping code for free_shipping rewards", async () => {
    const db = baseDb({
      rewardDefinition: {
        findFirst: vi.fn().mockResolvedValue({
          id: "reward-3",
          title: "Free shipping",
          type: "free_shipping",
          pointsCost: 50,
          value: null,
          minSubtotal: null,
          enabled: true,
        }),
      },
    });
    const admin = adminReturning({
      discountCodeFreeShippingCreate: freeShippingOk,
    });

    const claim = await claimReward({
      db: db as never,
      admin: admin as never,
      shopDomain: "701031-e7.myshopify.com",
      shopifyCustomerId: "7024197173344",
      rewardId: "reward-3",
      cart: { token: "cart-1", subtotal: 500 },
    });

    expect(claim.rewardType).toBe("free_shipping");
    expect(admin.graphql).toHaveBeenCalledWith(
      expect.stringContaining("discountCodeFreeShippingCreate"),
      expect.anything(),
    );
  });
});

describe("earn action claims", () => {
  const customer = {
    id: "customer-1",
    wallet: { id: "wallet-1", availablePoints: 10 },
  };

  it("awards points once and reports duplicates", async () => {
    const db = {
      earnAction: {
        findFirst: vi.fn().mockResolvedValue({
          id: "action-1",
          title: "Follow on Instagram",
          points: 50,
          enabled: true,
          oncePerCustomer: true,
        }),
      },
      loyaltyCustomer: { findUnique: vi.fn().mockResolvedValue(customer) },
      earnActionClaim: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "claim-1" }),
      },
      $transaction: vi.fn().mockImplementation((callback: (tx: unknown) => unknown) =>
        callback({
          earnActionClaim: { create: vi.fn().mockResolvedValue({}) },
          wallet: { update: vi.fn().mockResolvedValue({}) },
          ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
        }),
      ),
    };

    const first = await claimEarnAction({
      db: db as never,
      shopDomain: "701031-e7.myshopify.com",
      shopifyCustomerId: "7024197173344",
      actionId: "action-1",
    });
    expect(first).toEqual({ awarded: 50, alreadyClaimed: false });

    const second = await claimEarnAction({
      db: db as never,
      shopDomain: "701031-e7.myshopify.com",
      shopifyCustomerId: "7024197173344",
      actionId: "action-1",
    });
    expect(second).toEqual({ awarded: 0, alreadyClaimed: true });
  });

  it("treats a concurrent duplicate claim (P2002) as already claimed", async () => {
    const db = {
      earnAction: {
        findFirst: vi.fn().mockResolvedValue({
          id: "action-1",
          title: "Follow on Instagram",
          points: 50,
          enabled: true,
          oncePerCustomer: true,
        }),
      },
      loyaltyCustomer: { findUnique: vi.fn().mockResolvedValue(customer) },
      earnActionClaim: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      ),
    };

    const result = await claimEarnAction({
      db: db as never,
      shopDomain: "701031-e7.myshopify.com",
      shopifyCustomerId: "7024197173344",
      actionId: "action-1",
    });
    expect(result).toEqual({ awarded: 0, alreadyClaimed: true });
  });
});
