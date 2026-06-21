import { describe, expect, it } from "vitest";
import {
  extractWebhookResourceId,
  hashWebhookPayload,
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
});
