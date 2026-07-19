import { beforeEach, describe, expect, it } from "vitest";
import { signPayload, verifyPayload } from "../../app/subscriptions/crypto";
import { isProductEligible } from "../../app/subscriptions/settings";

beforeEach(() => { process.env.SUBSCRIPTION_SIGNING_SECRET = "test-secret-with-enough-entropy"; });

describe("signed customer state", () => {
  it("round-trips valid claims and rejects tampering", () => {
    const token = signPayload({ intentId: "i1", exp: 2_000_000_000 });
    expect(verifyPayload<{ intentId: string; exp: number }>(token).intentId).toBe("i1");
    expect(() => verifyPayload(`${token.slice(0, -1)}x`)).toThrow(/invalid/i);
  });

  it("rejects expired claims", () => {
    const token = signPayload({ intentId: "i1", exp: 1 });
    expect(() => verifyPayload(token)).toThrow(/expired/i);
  });
});

describe("product eligibility and master switch", () => {
  const base = { widgetEnabled: true, selectedProductIds: ["gid://shopify/Product/10"], excludedProductIds: [] };
  it("keeps every product disabled when the master switch is off", () => {
    expect(isProductEligible({ ...base, widgetEnabled: false, enrollmentMode: "all", productId: "10" })).toBe(false);
  });
  it("supports none, selected, all, and exclusions", () => {
    expect(isProductEligible({ ...base, enrollmentMode: "none", productId: "gid://shopify/Product/10" })).toBe(false);
    expect(isProductEligible({ ...base, enrollmentMode: "selected", productId: "gid://shopify/Product/10" })).toBe(true);
    expect(isProductEligible({ ...base, enrollmentMode: "selected", productId: "10" })).toBe(true);
    expect(isProductEligible({ ...base, enrollmentMode: "selected", productId: "gid://shopify/Product/11" })).toBe(false);
    expect(isProductEligible({ ...base, enrollmentMode: "all", excludedProductIds: ["gid://shopify/Product/11"], productId: "gid://shopify/Product/11" })).toBe(false);
  });
});
