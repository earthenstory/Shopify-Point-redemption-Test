import { describe, expect, it } from "vitest";
import { signPayload, verifyPayload } from "../../app/subscriptions/crypto";
import { computeRenewalQuote, mandateHeadroomPaise } from "../../app/subscriptions/pricing";
import { addDurationMonths, nextOccurrence } from "../../app/subscriptions/schedule";

describe("subscription workflow smoke", () => {
  it("takes a signed signup intent through a dynamic three-unit renewal quote", () => {
    const secret = "smoke-secret";
    const token = signPayload({ intentId: "intent-1", shop: "shop.myshopify.com", exp: 2_000_000_000 }, secret);
    expect(verifyPayload<{ intentId: string; shop: string; exp: number }>(token, secret).shop).toBe("shop.myshopify.com");
    const quote = computeRenewalQuote({
      lines: [{
        subscriptionLineId: "line-1", variantId: "20", productId: "10", productTitle: "Honey",
        currentUnitPricePaise: 16_000, availableQuantity: 3, taxable: true, active: true, requestedQuantity: 3,
      }],
      baseDiscountBps: 200,
      tiers: [{ minimumQuantity: 2, additionalDiscountBps: 100 }, { minimumQuantity: 3, additionalDiscountBps: 300 }],
      freeShippingThresholdPaise: 34_900,
      shippingFeePaise: 4_900,
    });
    expect(quote.effectiveDiscountBps).toBe(500);
    expect(quote.chargeAmountPaise).toBe(45_600);
    expect(mandateHeadroomPaise(quote.chargeAmountPaise)).toBe(100_000);
    const activatedAt = new Date("2026-07-19T00:00:00.000Z");
    expect(nextOccurrence(activatedAt, "monthly").toISOString()).toContain("2026-08-19");
    expect(addDurationMonths(activatedAt, 24).toISOString()).toContain("2028-07-19");
  });
});
