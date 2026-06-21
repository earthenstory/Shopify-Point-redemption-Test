import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { authenticateAppProxyRequest } from "../app/loyalty/app-proxy";

describe("app proxy authentication", () => {
  const previousSecret = process.env.SHOPIFY_API_SECRET;

  afterEach(() => {
    process.env.SHOPIFY_API_SECRET = previousSecret;
  });

  it("accepts a signed Shopify app proxy request", () => {
    process.env.SHOPIFY_API_SECRET = "test-secret";
    const params = new URLSearchParams({
      logged_in_customer_id: "123",
      path_prefix: "/apps/loyalty",
      shop: "701031-e7.myshopify.com",
      timestamp: "1782032984",
    });
    const signature = createHmac("sha256", "test-secret")
      .update(
        Array.from(params.entries())
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}=${value}`)
          .join(""),
      )
      .digest("hex");
    params.set("signature", signature);

    const context = authenticateAppProxyRequest(
      new Request(`https://app.example.com/apps/loyalty/customer?${params}`),
    );

    expect(context).toEqual({
      shop: "701031-e7.myshopify.com",
      loggedInCustomerId: "123",
    });
  });

  it("rejects unsigned app proxy requests", () => {
    process.env.SHOPIFY_API_SECRET = "test-secret";

    expect(() =>
      authenticateAppProxyRequest(
        new Request(
          "https://app.example.com/apps/loyalty/customer?shop=701031-e7.myshopify.com&signature=bad",
        ),
      ),
    ).toThrow();
  });
});
