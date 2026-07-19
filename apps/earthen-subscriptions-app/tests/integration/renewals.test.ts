import { describe, expect, it, vi } from "vitest";
import { prepareRenewal } from "../../app/subscriptions/renewals";

describe("renewal lifecycle safeguards", () => {
  it("lets a cycle-end cancellation win a scheduler race without a debit", async () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    const group = {
      id: "group-1", shopDomain: "shop.myshopify.com", status: "active",
      nextChargeAt: now, cancelAtCycleEnd: true, razorpayTokenId: "token-1",
      lines: [], pricingPolicy: { baseDiscountBps: 200, tiers: [] }, cycles: [],
    };
    const update = vi.fn(async ({ data }) => ({ ...group, ...data }));
    const db = {
      subscriptionGroup: { findUniqueOrThrow: vi.fn(async () => group), update },
    };
    const razorpay = { cancelToken: vi.fn(), createRecurringPayment: vi.fn() };
    const result = await prepareRenewal({
      db: db as never,
      razorpay: razorpay as never,
      graphql: vi.fn() as never,
      groupId: group.id,
      now,
    });
    expect(result.status).toBe("cancelled");
    expect(razorpay.cancelToken).toHaveBeenCalledWith("token-1");
    expect(razorpay.createRecurringPayment).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "cancelled", nextChargeAt: null }),
    }));
  });
});
