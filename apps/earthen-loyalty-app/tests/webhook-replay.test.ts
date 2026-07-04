import { describe, expect, it, vi } from "vitest";
import { recordWebhookEvent } from "../app/loyalty/webhooks";
import {
  buildCustomerWebhookPayload,
  buildOrderWebhookPayload,
  extractNumericResourceId,
  normalizeWebhookTopic,
} from "../app/loyalty/webhook-replay";

describe("webhook duplicate-delivery race", () => {
  it("returns duplicate instead of crashing when concurrent create hits the unique constraint", async () => {
    const db = {
      webhookEvent: {
        // First check sees nothing (both racers passed it), create loses the
        // race with P2002, the re-check finds the winner's row.
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "winner-event" }),
        create: vi.fn().mockRejectedValue(
          Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          }),
        ),
      },
    };

    const result = await recordWebhookEvent(db as never, {
      shop: "701031-e7.myshopify.com",
      topic: "ORDERS_FULFILLED",
      webhookId: "wh-123",
      payload: { id: 1 },
    });

    expect(result).toEqual({ status: "duplicate", eventId: "winner-event" });
  });

  it("rethrows non-constraint errors", async () => {
    const db = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(new Error("connection reset")),
      },
    };

    await expect(
      recordWebhookEvent(db as never, {
        shop: "701031-e7.myshopify.com",
        topic: "ORDERS_PAID",
        webhookId: "wh-456",
        payload: { id: 2 },
      }),
    ).rejects.toThrow("connection reset");
  });
});

describe("webhook replay helpers", () => {
  it("normalizes Shopify topic formats", () => {
    expect(normalizeWebhookTopic("ORDERS_FULFILLED")).toBe("orders/fulfilled");
    expect(normalizeWebhookTopic("customers/create")).toBe("customers/create");
    expect(normalizeWebhookTopic("REFUNDS_CREATE")).toBe("refunds/create");
  });

  it("extracts numeric ids from both gid and numeric resource ids", () => {
    expect(extractNumericResourceId("gid://shopify/Order/6448135897312")).toBe(
      "6448135897312",
    );
    expect(extractNumericResourceId("6448135897312")).toBe("6448135897312");
    expect(extractNumericResourceId(null)).toBeNull();
    expect(extractNumericResourceId("gid://shopify/Order/")).toBeNull();
  });

  it("builds an order payload shaped like a REST webhook", () => {
    const payload = buildOrderWebhookPayload({
      legacyResourceId: "1001",
      currentSubtotal: "2878.00",
      subtotal: "2878.00",
      discountCodes: ["ESPOINTS-1-A-B", "ES10"],
      customer: {
        legacyResourceId: "7024197173344",
        email: "c@x.com",
        phone: null,
        firstName: "E",
        lastName: "S",
      },
    });

    expect(payload).toMatchObject({
      id: 1001,
      admin_graphql_api_id: "gid://shopify/Order/1001",
      current_subtotal_price: "2878.00",
      discount_codes: [{ code: "ESPOINTS-1-A-B" }, { code: "ES10" }],
      customer: {
        id: 7024197173344,
        email: "c@x.com",
        first_name: "E",
      },
    });
  });

  it("builds a customer payload shaped like a REST webhook", () => {
    expect(
      buildCustomerWebhookPayload({
        legacyResourceId: "42",
        email: "a@b.c",
        phone: "+91",
        firstName: "A",
        lastName: "B",
      }),
    ).toMatchObject({ id: 42, email: "a@b.c", first_name: "A" });
  });
});
