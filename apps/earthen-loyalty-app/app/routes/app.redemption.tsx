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
          | "fulfilled"
          | "delivered",
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
    <s-page heading="Earning & redemption rules">
      <s-stack direction="block" gap="large-100">
        {actionData?.message ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}

        <s-section heading="How it works">
          <s-stack direction="block" gap="small">
            <s-paragraph>
              On a ₹1,000 order a customer earns about{" "}
              <s-text type="strong">{Math.floor(sampleEarn)} points</s-text>.
            </s-paragraph>
            <s-paragraph>
              On a ₹1,000 cart they can redeem up to{" "}
              <s-text type="strong">{Math.floor(sampleRedeem)} points</s-text>{" "}
              (before increment/caps), worth {Math.floor(sampleRedeem) * data.currencyValuePerPoint} INR off.
            </s-paragraph>
          </s-stack>
        </s-section>

        <Form method="post">
          <s-stack direction="block" gap="large-100">
            <s-section heading="Earning">
              <s-stack direction="block" gap="base">
                <s-checkbox
                  name="earningEnabled"
                  value="true"
                  defaultChecked={data.earningEnabled}
                  label="Customers earn points on purchases"
                />
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-number-field
                    name="pointsPerSpendAmount"
                    label="Points earned"
                    defaultValue={String(data.pointsPerSpendAmount)}
                    min={0}
                    step={0.01}
                  />
                  <s-number-field
                    name="spendAmountForEarnPoints"
                    label="Per amount spent (₹)"
                    defaultValue={String(data.spendAmountForEarnPoints)}
                    min={0.01}
                    step={0.01}
                    details={`Currently ${data.pointsPerSpendAmount} pts per ₹${data.spendAmountForEarnPoints}.`}
                  />
                </s-grid>
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-select
                    name="awardOnStatus"
                    label="Award points when"
                    value={data.awardOnStatus}
                  >
                    <s-option value="delivered">Order delivered (carrier event)</s-option>
                    <s-option value="fulfilled">Order fulfilled (shipped)</s-option>
                    <s-option value="paid">Order paid</s-option>
                  </s-select>
                  <s-number-field
                    name="signupRewardPoints"
                    label="Signup bonus points"
                    defaultValue={String(data.signupRewardPoints)}
                    min={0}
                    details="Points granted when a customer creates an account."
                  />
                </s-grid>
              </s-stack>
            </s-section>

            <s-section heading="Redemption">
              <s-stack direction="block" gap="base">
                <s-checkbox
                  name="redemptionEnabled"
                  value="true"
                  defaultChecked={data.redemptionEnabled}
                  label="Customers can redeem points at checkout"
                />
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-number-field
                    name="currencyValuePerPoint"
                    label="Value per point (₹)"
                    defaultValue={String(data.currencyValuePerPoint)}
                    min={0.01}
                    step={0.01}
                  />
                  <s-number-field
                    name="maxRedeemPercentOfCart"
                    label="Max % of cart redeemable"
                    defaultValue={String(data.maxRedeemPercentOfCart)}
                    min={0}
                    max={100}
                    step={0.01}
                  />
                </s-grid>
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-number-field
                    name="minRedeemPoints"
                    label="Minimum redemption points"
                    defaultValue={String(data.minRedeemPoints)}
                    min={1}
                  />
                  <s-number-field
                    name="redeemIncrementPoints"
                    label="Redemption increment"
                    defaultValue={String(data.redeemIncrementPoints)}
                    min={1}
                  />
                </s-grid>
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-number-field
                    name="maxRedeemPointsPerOrder"
                    label="Max points per order"
                    defaultValue={
                      data.maxRedeemPointsPerOrder != null
                        ? String(data.maxRedeemPointsPerOrder)
                        : ""
                    }
                    min={1}
                    placeholder="No cap"
                    details="Leave blank for no cap."
                  />
                  <s-number-field
                    name="discountCodeTtlMinutes"
                    label="Discount hold expiry (minutes)"
                    defaultValue={String(data.discountCodeTtlMinutes)}
                    min={5}
                    details="How long a reserved redemption stays valid."
                  />
                </s-grid>
                <s-checkbox
                  name="allowDiscountStacking"
                  value="true"
                  defaultChecked={data.allowDiscountStacking}
                  label="Allow loyalty discounts to combine with other coupons"
                  details="Required for points + a product-class coupon to stack."
                />
              </s-stack>
            </s-section>

            <s-section heading="Expiry & refunds">
              <s-stack direction="block" gap="base">
                <s-number-field
                  name="pointsExpiryDays"
                  label="Points expiry (days)"
                  defaultValue={
                    data.pointsExpiryDays != null
                      ? String(data.pointsExpiryDays)
                      : ""
                  }
                  min={1}
                  placeholder="No expiry"
                  details="Leave blank for points that never expire."
                />
                <s-checkbox
                  name="returnRedeemedPointsOnRefund"
                  value="true"
                  defaultChecked={data.returnRedeemedPointsOnRefund}
                  label="Return redeemed points when an order is refunded or cancelled"
                />
                <s-checkbox
                  name="reverseEarnedPointsOnRefund"
                  value="true"
                  defaultChecked={data.reverseEarnedPointsOnRefund}
                  label="Reverse earned points when an order is refunded or cancelled"
                />
              </s-stack>
            </s-section>

            <s-stack direction="inline" gap="base">
              <s-button variant="primary" type="submit">
                Save rules
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
