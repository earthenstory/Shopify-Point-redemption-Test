import { describe, expect, it } from "vitest";
import {
  calculateDiscountAmount,
  calculateMaxRedeemablePoints,
  calculateMinimumSubtotalForDiscount,
  calculateOrderEarnPoints,
  confirmedBonDefaults,
  normalizeRedeemPoints,
} from "../app/loyalty/rules";

describe("loyalty rules", () => {
  it("matches the confirmed BON earning rate", () => {
    expect(calculateOrderEarnPoints(100, confirmedBonDefaults)).toBe(2);
    expect(calculateOrderEarnPoints(999, confirmedBonDefaults)).toBe(19);
    expect(calculateOrderEarnPoints(0, confirmedBonDefaults)).toBe(0);
  });

  it("uses the confirmed BON point value for discounts", () => {
    expect(calculateDiscountAmount(10, confirmedBonDefaults)).toBe(10);
    expect(calculateDiscountAmount(250, confirmedBonDefaults)).toBe(250);
  });

  it("normalizes redemptions to the configured minimum and increment", () => {
    expect(normalizeRedeemPoints(9, confirmedBonDefaults)).toBe(0);
    expect(normalizeRedeemPoints(10, confirmedBonDefaults)).toBe(10);
    expect(normalizeRedeemPoints(19, confirmedBonDefaults)).toBe(10);
    expect(normalizeRedeemPoints(20, confirmedBonDefaults)).toBe(20);
  });

  it("allows full wallet redemption up to cart subtotal and increment", () => {
    expect(
      calculateMaxRedeemablePoints({
        availablePoints: 500,
        eligibleCartSubtotal: 1000,
        rules: confirmedBonDefaults,
      }),
    ).toBe(500);

    expect(
      calculateMaxRedeemablePoints({
        availablePoints: 95,
        eligibleCartSubtotal: 1000,
        rules: confirmedBonDefaults,
      }),
    ).toBe(90);

    expect(
      calculateMaxRedeemablePoints({
        availablePoints: 200,
        eligibleCartSubtotal: 848,
        rules: confirmedBonDefaults,
      }),
    ).toBe(200);
  });

  it("calculates Shopify minimum subtotal protection from redemption amount", () => {
    expect(calculateMinimumSubtotalForDiscount(200, confirmedBonDefaults)).toBe(
      200,
    );
  });
});
