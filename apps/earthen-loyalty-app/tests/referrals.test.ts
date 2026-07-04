import { describe, expect, it, vi } from "vitest";
import {
  attachReferral,
  rewardReferralForOrder,
} from "../app/loyalty/referrals";

const SHOP = "701031-e7.myshopify.com";

function settingsUpsert(overrides: Record<string, unknown> = {}) {
  return {
    referralProgramSettings: {
      upsert: vi.fn().mockResolvedValue({
        enabled: true,
        referrerPoints: 200,
        refereePoints: 100,
        minOrderSubtotal: null,
        ...overrides,
      }),
    },
  };
}

describe("referral attach guards", () => {
  it("blocks self-referral by customer id", async () => {
    const db = {
      ...settingsUpsert(),
      referralCode: {
        findUnique: vi.fn().mockResolvedValue({
          code: "ESR-AAAA1111",
          customerId: "customer-1",
        }),
      },
      loyaltyCustomer: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: "customer-1", email: "a@b.c" }),
      },
    };

    const result = await attachReferral({
      db: db as never,
      shopDomain: SHOP,
      refereeShopifyCustomerId: "111",
      code: "ESR-AAAA1111",
    });
    expect(result).toEqual({
      attached: false,
      reason: "You cannot refer yourself.",
    });
  });

  it("blocks referrals for customers with prior order activity", async () => {
    const db = {
      ...settingsUpsert(),
      referralCode: {
        findUnique: vi.fn().mockResolvedValue({
          code: "ESR-AAAA1111",
          customerId: "referrer-1",
        }),
      },
      loyaltyCustomer: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: "referee-1", email: "new@x.com" })
          .mockResolvedValueOnce({
            id: "referrer-1",
            email: "old@x.com",
            shopDomain: SHOP,
          }),
      },
      ledgerEntry: {
        findFirst: vi.fn().mockResolvedValue({ id: "earn-1" }),
      },
    };

    const result = await attachReferral({
      db: db as never,
      shopDomain: SHOP,
      refereeShopifyCustomerId: "222",
      code: "esr-aaaa1111",
    });
    expect(result.attached).toBe(false);
    expect(result.reason).toContain("first-time customers");
  });

  it("treats a duplicate attribution (P2002) as already linked", async () => {
    const db = {
      ...settingsUpsert(),
      referralCode: {
        findUnique: vi.fn().mockResolvedValue({
          code: "ESR-AAAA1111",
          customerId: "referrer-1",
        }),
      },
      loyaltyCustomer: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: "referee-1", email: "new@x.com" })
          .mockResolvedValueOnce({
            id: "referrer-1",
            email: "old@x.com",
            shopDomain: SHOP,
          }),
      },
      ledgerEntry: { findFirst: vi.fn().mockResolvedValue(null) },
      referralAttribution: {
        create: vi.fn().mockRejectedValue(
          Object.assign(new Error("unique"), { code: "P2002" }),
        ),
      },
    };

    const result = await attachReferral({
      db: db as never,
      shopDomain: SHOP,
      refereeShopifyCustomerId: "222",
      code: "ESR-AAAA1111",
    });
    expect(result).toEqual({
      attached: false,
      reason: "A referral is already linked.",
    });
  });
});

describe("referral payout", () => {
  function payoutDb(claimCount: number) {
    const tx = {
      referralAttribution: {
        updateMany: vi.fn().mockResolvedValue({ count: claimCount }),
      },
      wallet: { update: vi.fn().mockResolvedValue({}) },
      ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      ...settingsUpsert(),
      referralAttribution: {
        findUnique: vi.fn().mockResolvedValue({
          id: "attr-1",
          status: "pending",
          referrerCustomerId: "referrer-1",
          refereeCustomerId: "referee-1",
        }),
      },
      loyaltyCustomer: {
        findUnique: vi.fn().mockImplementation(({ where }: never) =>
          Promise.resolve({
            id: (where as { id: string }).id,
            wallet: { id: `wallet-${(where as { id: string }).id}` },
          }),
        ),
      },
      $transaction: vi
        .fn()
        .mockImplementation((callback: (transaction: typeof tx) => unknown) =>
          callback(tx),
        ),
    };
    return { db, tx };
  }

  it("pays both sides exactly once", async () => {
    const { db, tx } = payoutDb(1);
    const result = await rewardReferralForOrder({
      db: db as never,
      shopDomain: SHOP,
      refereeCustomerId: "referee-1",
      orderId: "9001",
      orderSubtotal: 500,
    });
    expect(result.rewarded).toBe(true);
    expect(tx.wallet.update).toHaveBeenCalledTimes(2);
    expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(2);
  });

  it("does not pay when another webhook already claimed the attribution", async () => {
    const { db, tx } = payoutDb(0);
    const result = await rewardReferralForOrder({
      db: db as never,
      shopDomain: SHOP,
      refereeCustomerId: "referee-1",
      orderId: "9001",
      orderSubtotal: 500,
    });
    expect(result.rewarded).toBe(false);
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });

  it("respects the minimum first-order subtotal", async () => {
    const db = {
      ...settingsUpsert({ minOrderSubtotal: 1000 }),
      referralAttribution: {
        findUnique: vi.fn().mockResolvedValue({
          id: "attr-1",
          status: "pending",
          referrerCustomerId: "referrer-1",
          refereeCustomerId: "referee-1",
        }),
      },
    };
    const result = await rewardReferralForOrder({
      db: db as never,
      shopDomain: SHOP,
      refereeCustomerId: "referee-1",
      orderId: "9001",
      orderSubtotal: 500,
    });
    expect(result.rewarded).toBe(false);
  });
});
