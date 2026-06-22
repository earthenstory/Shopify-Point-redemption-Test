import { describe, expect, it } from "vitest";
import {
  programSettingsSchema,
  rewardRuleToRules,
  rewardSettingsSchema,
  widgetSettingsSchema,
} from "../app/loyalty/settings";

describe("loyalty settings", () => {
  it("rejects invalid program status", () => {
    expect(() =>
      programSettingsSchema.parse({
        status: "live",
        programName: "Earthen Loyalty",
        pointName: "Earthen Points",
        bonWidgetDisabled: false,
        standardCheckoutTested: false,
        expressCheckoutTested: false,
      }),
    ).toThrow();
  });

  it("rejects unsafe redemption percentages and invalid increments", () => {
    expect(() =>
      rewardSettingsSchema.parse({
        earningEnabled: true,
        redemptionEnabled: true,
        signupRewardPoints: 250,
        pointsPerSpendAmount: 2,
        spendAmountForEarnPoints: 100,
        currencyValuePerPoint: 1,
        minRedeemPoints: 10,
        redeemIncrementPoints: 10,
        maxRedeemPercentOfCart: 101,
        maxRedeemPointsPerOrder: null,
        allowDiscountStacking: false,
        discountCodeTtlMinutes: 60,
        awardOnStatus: "fulfilled",
        pointsExpiryDays: null,
        returnRedeemedPointsOnRefund: true,
        reverseEarnedPointsOnRefund: true,
      }),
    ).toThrow();
  });

  it("requires valid widget hex colors", () => {
    expect(() =>
      widgetSettingsSchema.parse({
        homepageEnabled: true,
        productEnabled: true,
        cartEnabled: true,
        accountEnabled: true,
        loggedOutMessage: "Sign in",
        zeroPointsMessage: "Earn points",
        primaryColor: "green",
        accentColor: "#b8841e",
        backgroundColor: "#fffaf0",
      }),
    ).toThrow();
  });

  it("maps database reward rules into runtime loyalty rules", () => {
    expect(
      rewardRuleToRules({
        signupRewardPoints: 100,
        pointsPerSpendAmount: 5,
        spendAmountForEarnPoints: 200,
        currencyValuePerPoint: 2,
        minRedeemPoints: 20,
        redeemIncrementPoints: 5,
        maxRedeemPercentOfCart: 25,
        maxRedeemPointsPerOrder: 500,
        allowDiscountStacking: true,
        awardOnStatus: "paid",
        returnRedeemedPointsOnRefund: false,
        reverseEarnedPointsOnRefund: true,
      } as never),
    ).toMatchObject({
      signupRewardPoints: 100,
      pointsPerSpendAmount: 5,
      spendAmountForEarnPoints: 200,
      currencyValuePerPoint: 2,
      minRedeemPoints: 20,
      redeemIncrementPoints: 5,
      maxRedeemPercentOfCart: 25,
      maxRedeemPointsPerOrder: 500,
      allowDiscountStacking: true,
      awardOnStatus: "paid",
      returnRedeemedPointsOnRefund: false,
      reverseEarnedPointsOnRefund: true,
    });
  });
});
