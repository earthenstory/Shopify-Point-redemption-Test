import { describe, expect, it } from "vitest";
import { previewRedemption } from "../app/loyalty/redemptions";

describe("redemption preview", () => {
  it("returns zero when the customer has no migrated points", () => {
    expect(
      previewRedemption({
        availablePoints: 0,
        cart: { subtotal: 1000 },
      }),
    ).toEqual({
      maxRedeemablePoints: 0,
      discountAmount: 0,
      minimumSubtotal: 0,
      currency: "INR",
    });
  });

  it("caps redemptions to 20 percent of cart value", () => {
    expect(
      previewRedemption({
        availablePoints: 900,
        cart: { subtotal: 1000 },
      }),
    ).toMatchObject({
      maxRedeemablePoints: 200,
      discountAmount: 200,
      minimumSubtotal: 1000,
    });
  });
});
