import { z } from "zod";

export const loyaltyRuleSchema = z.object({
  currency: z.string().default("INR"),
  signupRewardPoints: z.number().int().min(0),
  pointsPerSpendAmount: z.number().positive(),
  spendAmountForEarnPoints: z.number().positive(),
  currencyValuePerPoint: z.number().positive(),
  minRedeemPoints: z.number().int().positive(),
  redeemIncrementPoints: z.number().int().positive(),
  maxRedeemPercentOfCart: z.number().min(0).max(100),
  maxRedeemPointsPerOrder: z.number().int().positive().nullable(),
  allowDiscountStacking: z.boolean(),
  awardOnStatus: z.enum(["paid", "fulfilled", "delivered"]),
  returnRedeemedPointsOnRefund: z.boolean(),
  reverseEarnedPointsOnRefund: z.boolean(),
});

export type LoyaltyRules = z.infer<typeof loyaltyRuleSchema>;

export const confirmedBonDefaults: LoyaltyRules = loyaltyRuleSchema.parse({
  currency: "INR",
  signupRewardPoints: 250,
  pointsPerSpendAmount: 2,
  spendAmountForEarnPoints: 100,
  currencyValuePerPoint: 1,
  minRedeemPoints: 10,
  redeemIncrementPoints: 10,
  maxRedeemPercentOfCart: 100,
  maxRedeemPointsPerOrder: null,
  allowDiscountStacking: true,
  awardOnStatus: "fulfilled",
  returnRedeemedPointsOnRefund: true,
  reverseEarnedPointsOnRefund: true,
});

export function calculateOrderEarnPoints(
  orderSubtotal: number,
  rules: LoyaltyRules,
): number {
  if (orderSubtotal <= 0) return 0;

  const rawPoints =
    (orderSubtotal / rules.spendAmountForEarnPoints) *
    rules.pointsPerSpendAmount;
  return Math.floor(rawPoints);
}

export function normalizeRedeemPoints(
  requestedPoints: number,
  rules: LoyaltyRules,
): number {
  if (requestedPoints < rules.minRedeemPoints) return 0;

  return (
    Math.floor(requestedPoints / rules.redeemIncrementPoints) *
    rules.redeemIncrementPoints
  );
}

export function calculateMaxRedeemablePoints(input: {
  availablePoints: number;
  eligibleCartSubtotal: number;
  rules: LoyaltyRules;
}): number {
  const { availablePoints, eligibleCartSubtotal, rules } = input;

  if (availablePoints < rules.minRedeemPoints || eligibleCartSubtotal <= 0) {
    return 0;
  }

  const cartValueCap = Math.floor(
    (eligibleCartSubtotal * (rules.maxRedeemPercentOfCart / 100)) /
      rules.currencyValuePerPoint,
  );
  const orderCap = rules.maxRedeemPointsPerOrder ?? Number.MAX_SAFE_INTEGER;
  const cappedPoints = Math.min(availablePoints, cartValueCap, orderCap);

  return normalizeRedeemPoints(cappedPoints, rules);
}

export function calculateDiscountAmount(
  points: number,
  rules: LoyaltyRules,
): number {
  const normalizedPoints = normalizeRedeemPoints(points, rules);
  return normalizedPoints * rules.currencyValuePerPoint;
}

export function calculateMinimumSubtotalForDiscount(
  points: number,
  rules: LoyaltyRules,
): number {
  const discountAmount = calculateDiscountAmount(points, rules);
  if (discountAmount === 0 || rules.maxRedeemPercentOfCart === 0) return 0;

  return Math.ceil(discountAmount / (rules.maxRedeemPercentOfCart / 100));
}
