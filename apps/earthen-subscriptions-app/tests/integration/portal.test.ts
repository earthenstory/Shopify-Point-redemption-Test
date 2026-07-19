import { describe, expect, it, vi } from "vitest";
import { performPortalAction } from "../../app/subscriptions/portal";

const access = { shopDomain: "shop.myshopify.com", customerId: "7" };
const group = {
  id: "group-1",
  shopDomain: "shop.myshopify.com",
  shopifyCustomerId: "gid://shopify/Customer/7",
  status: "active",
  intervalCode: "monthly",
  nextChargeAt: new Date("2026-08-19T00:00:00.000Z"),
  lines: [{ id: "line-1", status: "active" }],
};

describe("customer subscription portal", () => {
  it("validates and stores an Indian renewal delivery address", async () => {
    const update = vi.fn(async ({ data }) => ({ ...group, ...data }));
    const findFirst = vi.fn(async () => group);
    const db = {
      subscriptionGroup: { findFirst, update },
    };
    const result = await performPortalAction({
      db: db as never,
      razorpay: { cancelToken: vi.fn() } as never,
      access,
      groupId: group.id,
      payload: {
        action: "update_address",
        address: {
          firstName: "Asha", lastName: "Rao", address1: "1 Market Road",
          city: "Bengaluru", province: "Karnataka", country: "India",
          countryCode: "IN", zip: "560001", phone: "+919999999999",
        },
      },
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: group.id },
      data: { addressJson: expect.objectContaining({ zip: "560001", countryCode: "IN" }) },
    }));
    expect((result.addressJson as { zip: string }).zip).toBe("560001");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ shopifyCustomerId: "gid://shopify/Customer/7" }),
    }));
  });

  it("rejects an invalid PIN code before changing the subscription", async () => {
    const update = vi.fn();
    const db = { subscriptionGroup: { findFirst: vi.fn(async () => group), update } };
    await expect(performPortalAction({
      db: db as never,
      razorpay: { cancelToken: vi.fn() } as never,
      access,
      groupId: group.id,
      payload: { action: "update_address", address: { address1: "x", city: "x", countryCode: "IN", zip: "123" } },
    })).rejects.toThrow(/PIN code/i);
    expect(update).not.toHaveBeenCalled();
  });
});
