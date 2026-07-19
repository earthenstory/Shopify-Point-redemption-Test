import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturePaidOrderIntent } from "../../app/subscriptions/intents";
import { signPayload } from "../../app/subscriptions/crypto";

beforeEach(() => { process.env.SUBSCRIPTION_SIGNING_SECRET = "integration-secret"; });

describe("paid Shopify order to mandate-pending intent", () => {
  it("ignores an order until Shopify reports it paid", async () => {
    const db = { subscriptionIntent: { findUnique: vi.fn() } };
    const result = await capturePaidOrderIntent({
      db: db as never,
      shopDomain: "shop.myshopify.com",
      order: { id: 99, financial_status: "pending", line_items: [] },
    });
    expect(result).toEqual([]);
    expect(db.subscriptionIntent.findUnique).not.toHaveBeenCalled();
  });

  it("matches signed private line properties and captures order PII once", async () => {
    const reference = signPayload({ intentId: "intent-1", shop: "shop.myshopify.com", exp: 2_000_000_000 });
    const row: Record<string, unknown> & {
      id: string; shopDomain: string; signedCartReference: string;
      requestedLines: Array<Record<string, unknown>>; status: string; expiresAt: Date;
      shopifyOrderId?: string;
    } = {
      id: "intent-1", shopDomain: "shop.myshopify.com", signedCartReference: reference,
      requestedLines: [{ productId: "10", variantId: "20", productTitle: "Honey", quantity: 2, unitPricePaise: 12_500 }],
      status: "cart", expiresAt: new Date("2030-01-01"),
    };
    const update = vi.fn(async ({ data }) => Object.assign(row, data));
    const db = {
      subscriptionIntent: { findUnique: vi.fn(async () => row), update },
      subscriptionSettings: { findUniqueOrThrow: vi.fn(async () => ({ activationTtlHours: 48 })) },
    };
    const result = await capturePaidOrderIntent({
      db: db as never,
      shopDomain: "shop.myshopify.com",
      now: new Date("2026-07-19"),
      order: {
        id: 99,
        financial_status: "paid",
        contact_email: "buyer@example.com",
        customer: { id: 7, first_name: "Asha", last_name: "Rao", phone: "+919999999999" },
        shipping_address: { address1: "1 Market Road", city: "Bengaluru", zip: "560001", firstName: "Asha", lastName: "Rao" },
        line_items: [{
          product_id: 10, variant_id: 20, quantity: 3, price: "125.00",
          properties: [{ name: "_earthen_subscription_intent", value: reference }],
        }],
      },
    });
    expect(result).toHaveLength(1);
    expect(update).toHaveBeenCalledOnce();
    expect(row.status).toBe("pending_mandate");
    expect(row.shopifyOrderId).toBe("gid://shopify/Order/99");
    expect((row as unknown as { customerSnapshot: { customerEmail: string } }).customerSnapshot.customerEmail).toBe("buyer@example.com");
    expect((row.requestedLines as Array<{ quantity: number }>)[0].quantity).toBe(3);
  });

  it("rejects an order that does not contain the requested quantity", async () => {
    const reference = signPayload({ intentId: "intent-1", shop: "shop.myshopify.com", exp: 2_000_000_000 });
    const db = { subscriptionIntent: { findUnique: vi.fn(async () => ({
      id: "intent-1", signedCartReference: reference,
      requestedLines: [{ productId: "10", variantId: "20", productTitle: "Honey", quantity: 2, unitPricePaise: 12_500 }],
      status: "cart", expiresAt: new Date("2030-01-01"),
    })) }, subscriptionSettings: { findUniqueOrThrow: vi.fn(async () => ({ activationTtlHours: 48 })) } };
    await expect(capturePaidOrderIntent({
      db: db as never, shopDomain: "shop.myshopify.com", now: new Date("2026-07-19"),
      order: { id: 99, financial_status: "paid", shipping_address: { address1: "x", city: "x", zip: "1" }, line_items: [{ variant_id: 20, quantity: 1, properties: [{ name: "_earthen_subscription_intent", value: reference }] }] },
    })).rejects.toThrow(/does not contain/i);
  });
});
