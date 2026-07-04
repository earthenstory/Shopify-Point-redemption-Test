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
} from "../loyalty/settings";
import { authenticate } from "../shopify.server";

const REWARD_TYPE_LABEL: Record<string, string> = {
  fixed_amount: "Amount off",
  percent_off: "% off",
  free_shipping: "Free shipping",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [rewards, earnActions] = await Promise.all([
    db.rewardDefinition.findMany({
      where: { shopDomain: session.shop },
      orderBy: [{ sortOrder: "asc" }, { pointsCost: "asc" }],
    }),
    db.earnAction.findMany({
      where: { shopDomain: session.shop },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  return {
    rewards: rewards.map((reward) => ({
      id: reward.id,
      title: reward.title,
      type: reward.type,
      pointsCost: reward.pointsCost,
      value: reward.value ? Number(reward.value) : null,
      minSubtotal: reward.minSubtotal ? Number(reward.minSubtotal) : null,
      enabled: reward.enabled,
    })),
    earnActions: earnActions.map((action) => ({
      id: action.id,
      title: action.title,
      url: action.url,
      points: action.points,
      enabled: action.enabled,
      oncePerCustomer: action.oncePerCustomer,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "reward") {
      const id = String(form.get("id") || "").trim();
      const type = String(form.get("type")) as
        | "fixed_amount"
        | "percent_off"
        | "free_shipping";
      const value = formNullablePositiveInt(form.get("value"));
      if (type !== "free_shipping" && (!value || value <= 0)) {
        throw new Error("Amount/percent rewards need a positive value.");
      }
      const data = {
        shopDomain: session.shop,
        title: String(form.get("title")).trim(),
        type,
        pointsCost: formNumber(form.get("pointsCost")),
        value: type === "free_shipping" ? null : value,
        minSubtotal: formNullablePositiveInt(form.get("minSubtotal")),
        enabled: formBoolean(form.get("enabled")),
      };
      if (!data.title) throw new Error("Reward title is required.");
      if (data.pointsCost <= 0) throw new Error("Points cost must be positive.");
      if (id) {
        await db.rewardDefinition.update({ where: { id }, data });
      } else {
        await db.rewardDefinition.create({ data });
      }
      return { ok: true, message: "Reward saved." };
    }

    if (intent === "earnAction") {
      const id = String(form.get("id") || "").trim();
      const data = {
        shopDomain: session.shop,
        title: String(form.get("title")).trim(),
        url: String(form.get("url") || "").trim() || null,
        points: formNumber(form.get("points")),
        enabled: formBoolean(form.get("enabled")),
        oncePerCustomer: formBoolean(form.get("oncePerCustomer")),
      };
      if (!data.title) throw new Error("Action title is required.");
      if (data.points <= 0) throw new Error("Points must be positive.");
      if (id) {
        await db.earnAction.update({ where: { id }, data });
      } else {
        await db.earnAction.create({ data });
      }
      return { ok: true, message: "Earning action saved." };
    }

    throw new Error("Unknown action.");
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save.",
    };
  }
};

export default function RewardsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Rewards & ways to earn">
      <s-stack direction="block" gap="large-100">
        {actionData?.message ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}

        <s-section heading="Reward catalog">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Fixed-price rewards customers can claim with points from the rewards
              launcher — amount off, percent off, or free shipping.
            </s-paragraph>
            {data.rewards.length > 0 ? (
              <s-stack direction="block" gap="small-100">
                {data.rewards.map((reward) => (
                  <s-box
                    key={reward.id}
                    padding="base"
                    background="subdued"
                    borderRadius="base"
                  >
                    <s-grid
                      gridTemplateColumns="2fr 1fr 1fr 1fr"
                      gap="base"
                      alignItems="center"
                    >
                      <s-stack direction="block" gap="none">
                        <s-text type="strong">{reward.title}</s-text>
                        <s-text color="subdued">ID: {reward.id}</s-text>
                      </s-stack>
                      <s-badge tone="info">
                        {REWARD_TYPE_LABEL[reward.type] ?? reward.type}
                        {reward.type === "fixed_amount" && reward.value
                          ? ` ₹${reward.value}`
                          : reward.type === "percent_off" && reward.value
                            ? ` ${reward.value}%`
                            : ""}
                      </s-badge>
                      <s-text>{reward.pointsCost} pts</s-text>
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-badge tone={reward.enabled ? "success" : "neutral"}>
                          {reward.enabled ? "On" : "Off"}
                        </s-badge>
                        {reward.minSubtotal ? (
                          <s-text color="subdued">min ₹{reward.minSubtotal}</s-text>
                        ) : null}
                      </s-stack>
                    </s-grid>
                  </s-box>
                ))}
              </s-stack>
            ) : (
              <s-paragraph>No rewards yet — add the first one below.</s-paragraph>
            )}
          </s-stack>
        </s-section>

        <s-section heading="Add or update a reward">
          <Form method="post">
            <input type="hidden" name="intent" value="reward" />
            <s-stack direction="block" gap="base">
              <s-text-field
                name="id"
                label="Existing reward ID"
                details="Leave blank to create; paste an ID above to edit."
              />
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-text-field name="title" label="Title" />
                <s-select name="type" label="Type" value="fixed_amount">
                  <s-option value="fixed_amount">Amount off (₹)</s-option>
                  <s-option value="percent_off">Percent off (%)</s-option>
                  <s-option value="free_shipping">Free shipping</s-option>
                </s-select>
              </s-grid>
              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-number-field name="pointsCost" label="Points cost" min={1} />
                <s-number-field
                  name="value"
                  label="Value (₹ or %)"
                  min={1}
                  placeholder="—"
                  details="Ignored for free shipping."
                />
                <s-number-field
                  name="minSubtotal"
                  label="Min cart subtotal (₹)"
                  min={1}
                  placeholder="No minimum"
                />
              </s-grid>
              <s-checkbox name="enabled" value="true" label="Enabled" defaultChecked />
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" type="submit">
                  Save reward
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
        </s-section>

        <s-section heading="Ways to earn">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Actions customers can claim points for once (e.g. follow on
              Instagram). Shown in the rewards launcher with a claim button.
            </s-paragraph>
            {data.earnActions.length > 0 ? (
              <s-stack direction="block" gap="small-100">
                {data.earnActions.map((earnAction) => (
                  <s-box
                    key={earnAction.id}
                    padding="base"
                    background="subdued"
                    borderRadius="base"
                  >
                    <s-grid
                      gridTemplateColumns="2fr 2fr 1fr 1fr"
                      gap="base"
                      alignItems="center"
                    >
                      <s-stack direction="block" gap="none">
                        <s-text type="strong">{earnAction.title}</s-text>
                        <s-text color="subdued">ID: {earnAction.id}</s-text>
                      </s-stack>
                      <s-text color="subdued">{earnAction.url ?? "No link"}</s-text>
                      <s-text>+{earnAction.points} pts</s-text>
                      <s-stack direction="inline" gap="small">
                        <s-badge tone={earnAction.enabled ? "success" : "neutral"}>
                          {earnAction.enabled ? "On" : "Off"}
                        </s-badge>
                        {earnAction.oncePerCustomer ? (
                          <s-badge tone="info">Once</s-badge>
                        ) : null}
                      </s-stack>
                    </s-grid>
                  </s-box>
                ))}
              </s-stack>
            ) : (
              <s-paragraph>No earning actions yet.</s-paragraph>
            )}
          </s-stack>
        </s-section>

        <s-section heading="Add or update an earning action">
          <Form method="post">
            <input type="hidden" name="intent" value="earnAction" />
            <s-stack direction="block" gap="base">
              <s-text-field
                name="id"
                label="Existing action ID"
                details="Leave blank to create; paste an ID above to edit."
              />
              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-text-field name="title" label="Title" />
                <s-text-field
                  name="url"
                  label="Link (optional)"
                  details="e.g. your Instagram page"
                />
                <s-number-field name="points" label="Points" min={1} />
              </s-grid>
              <s-stack direction="inline" gap="large-100">
                <s-checkbox name="enabled" value="true" label="Enabled" defaultChecked />
                <s-checkbox
                  name="oncePerCustomer"
                  value="true"
                  label="Once per customer"
                  defaultChecked
                />
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" type="submit">
                  Save earning action
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
