import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  formBoolean,
  formNullablePositiveInt,
  formNumber,
  getLoyaltyRuntimeSettings,
  updateRewardSettings,
} from "../loyalty/settings";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: session.shop,
  });
  const rule = settings.rewardRule;

  return {
    earningEnabled: rule.earningEnabled,
    redemptionEnabled: rule.redemptionEnabled,
    signupRewardPoints: rule.signupRewardPoints,
    pointsPerSpendAmount: Number(rule.pointsPerSpendAmount),
    spendAmountForEarnPoints: Number(rule.spendAmountForEarnPoints),
    currencyValuePerPoint: Number(rule.currencyValuePerPoint),
    minRedeemPoints: rule.minRedeemPoints,
    redeemIncrementPoints: rule.redeemIncrementPoints,
    maxRedeemPercentOfCart: Number(rule.maxRedeemPercentOfCart),
    maxRedeemPointsPerOrder: rule.maxRedeemPointsPerOrder,
    allowDiscountStacking: rule.allowDiscountStacking,
    discountCodeTtlMinutes: rule.discountCodeTtlMinutes,
    awardOnStatus: rule.awardOnStatus,
    pointsExpiryDays: rule.pointsExpiryDays,
    returnRedeemedPointsOnRefund: rule.returnRedeemedPointsOnRefund,
    reverseEarnedPointsOnRefund: rule.reverseEarnedPointsOnRefund,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    await updateRewardSettings({
      db,
      shopDomain: session.shop,
      adminUser: session.id,
      data: {
        earningEnabled: formBoolean(form.get("earningEnabled")),
        redemptionEnabled: formBoolean(form.get("redemptionEnabled")),
        signupRewardPoints: formNumber(form.get("signupRewardPoints")),
        pointsPerSpendAmount: formNumber(form.get("pointsPerSpendAmount")),
        spendAmountForEarnPoints: formNumber(form.get("spendAmountForEarnPoints")),
        currencyValuePerPoint: formNumber(form.get("currencyValuePerPoint")),
        minRedeemPoints: formNumber(form.get("minRedeemPoints")),
        redeemIncrementPoints: formNumber(form.get("redeemIncrementPoints")),
        maxRedeemPercentOfCart: formNumber(form.get("maxRedeemPercentOfCart")),
        maxRedeemPointsPerOrder: formNullablePositiveInt(
          form.get("maxRedeemPointsPerOrder"),
        ),
        allowDiscountStacking: formBoolean(form.get("allowDiscountStacking")),
        discountCodeTtlMinutes: formNumber(form.get("discountCodeTtlMinutes")),
        awardOnStatus: String(form.get("awardOnStatus")) as
          | "paid"
          | "fulfilled",
        pointsExpiryDays: formNullablePositiveInt(form.get("pointsExpiryDays")),
        returnRedeemedPointsOnRefund: formBoolean(
          form.get("returnRedeemedPointsOnRefund"),
        ),
        reverseEarnedPointsOnRefund: formBoolean(
          form.get("reverseEarnedPointsOnRefund"),
        ),
      },
    });
    return { ok: true, message: "Earning and redemption rules saved." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save rules.",
    };
  }
};

export default function RedemptionPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const sampleEarn =
    (1000 / data.spendAmountForEarnPoints) * data.pointsPerSpendAmount;
  const sampleRedeem = Math.floor(
    (1000 * (data.maxRedeemPercentOfCart / 100)) / data.currencyValuePerPoint,
  );

  return (
    <s-page heading="Redemption and earning rules">
      <s-section heading="Rule editor">
        {actionData?.message ? (
          <s-paragraph>{actionData.message}</s-paragraph>
        ) : null}
        <Form method="post">
          <div style={{ display: "grid", gap: 14, maxWidth: 760 }}>
            <label>
              <input
                type="checkbox"
                name="earningEnabled"
                defaultChecked={data.earningEnabled}
              />{" "}
              Earning enabled
            </label>
            <label>
              <input
                type="checkbox"
                name="redemptionEnabled"
                defaultChecked={data.redemptionEnabled}
              />{" "}
              Redemption enabled
            </label>
            <label>
              Signup bonus points
              <input
                type="number"
                name="signupRewardPoints"
                defaultValue={data.signupRewardPoints}
                min={0}
              />
            </label>
            <label>
              Points earned
              <input
                type="number"
                name="pointsPerSpendAmount"
                defaultValue={data.pointsPerSpendAmount}
                min={0.01}
                step="0.01"
              />
            </label>
            <label>
              Per spend amount INR
              <input
                type="number"
                name="spendAmountForEarnPoints"
                defaultValue={data.spendAmountForEarnPoints}
                min={0.01}
                step="0.01"
              />
            </label>
            <label>
              Award points when
              <select name="awardOnStatus" defaultValue={data.awardOnStatus}>
                <option value="fulfilled">Order fulfilled</option>
                <option value="paid">Order paid</option>
              </select>
            </label>
            <label>
              INR value per point
              <input
                type="number"
                name="currencyValuePerPoint"
                defaultValue={data.currencyValuePerPoint}
                min={0.01}
                step="0.01"
              />
            </label>
            <label>
              Minimum redemption points
              <input
                type="number"
                name="minRedeemPoints"
                defaultValue={data.minRedeemPoints}
                min={1}
              />
            </label>
            <label>
              Redemption increment points
              <input
                type="number"
                name="redeemIncrementPoints"
                defaultValue={data.redeemIncrementPoints}
                min={1}
              />
            </label>
            <label>
              Max redeem percent of cart
              <input
                type="number"
                name="maxRedeemPercentOfCart"
                defaultValue={data.maxRedeemPercentOfCart}
                min={0}
                max={100}
                step="0.01"
              />
            </label>
            <label>
              Max points per order
              <input
                type="number"
                name="maxRedeemPointsPerOrder"
                defaultValue={data.maxRedeemPointsPerOrder ?? ""}
                min={1}
                placeholder="No cap"
              />
            </label>
            <label>
              Discount code expiry minutes
              <input
                type="number"
                name="discountCodeTtlMinutes"
                defaultValue={data.discountCodeTtlMinutes}
                min={5}
              />
            </label>
            <label>
              Points expiry days
              <input
                type="number"
                name="pointsExpiryDays"
                defaultValue={data.pointsExpiryDays ?? ""}
                min={1}
                placeholder="No expiry"
              />
            </label>
            <label>
              <input
                type="checkbox"
                name="allowDiscountStacking"
                defaultChecked={data.allowDiscountStacking}
              />{" "}
              Allow loyalty discounts to combine with other discounts
            </label>
            <label>
              <input
                type="checkbox"
                name="returnRedeemedPointsOnRefund"
                defaultChecked={data.returnRedeemedPointsOnRefund}
              />{" "}
              Return redeemed points on refund/cancel
            </label>
            <label>
              <input
                type="checkbox"
                name="reverseEarnedPointsOnRefund"
                defaultChecked={data.reverseEarnedPointsOnRefund}
              />{" "}
              Reverse earned points on refund/cancel
            </label>
            <s-button type="submit">Save rules</s-button>
          </div>
        </Form>
      </s-section>

      <s-section heading="Preview">
        <s-paragraph>
          On a INR 1,000 order, the customer earns approximately{" "}
          {Math.floor(sampleEarn)} points.
        </s-paragraph>
        <s-paragraph>
          On a INR 1,000 cart, the max redemption before increment/caps is{" "}
          {Math.floor(sampleRedeem)} points.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
