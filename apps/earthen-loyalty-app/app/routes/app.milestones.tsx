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
  upsertMilestoneRule,
} from "../loyalty/settings";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: session.shop,
  });

  return {
    milestones: settings.milestones.map((rule) => ({
      id: rule.id,
      type: rule.type,
      title: rule.title,
      enabled: rule.enabled,
      points: rule.points,
      thresholdAmount: rule.thresholdAmount ? Number(rule.thresholdAmount) : null,
      thresholdOrderCount: rule.thresholdOrderCount,
      repeatable: rule.repeatable,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    await upsertMilestoneRule({
      db,
      shopDomain: session.shop,
      adminUser: session.id,
      data: {
        id: String(form.get("id") || "") || undefined,
        type: String(form.get("type")) as
          | "signup"
          | "first_order"
          | "order_count"
          | "spend_amount"
          | "birthday",
        title: String(form.get("title")),
        enabled: formBoolean(form.get("enabled")),
        points: formNumber(form.get("points")),
        thresholdAmount: formNullablePositiveInt(form.get("thresholdAmount")),
        thresholdOrderCount: formNullablePositiveInt(
          form.get("thresholdOrderCount"),
        ),
        repeatable: formBoolean(form.get("repeatable")),
      },
    });
    return { ok: true, message: "Milestone saved." };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Could not save milestone.",
    };
  }
};

export default function MilestonesPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const TYPE_LABEL: Record<string, string> = {
    signup: "Signup",
    first_order: "First order",
    order_count: "Order count",
    spend_amount: "Spend amount",
    birthday: "Birthday",
  };

  return (
    <s-page heading="Milestones">
      <s-stack direction="block" gap="large-100">
        {actionData?.message ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}

        <s-section heading="Configured milestones">
          {data.milestones.length > 0 ? (
            <s-stack direction="block" gap="small-100">
              {data.milestones.map((rule) => (
                <s-box
                  key={rule.id}
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
                      <s-text type="strong">{rule.title}</s-text>
                      <s-text color="subdued">
                        ID: {rule.id}
                      </s-text>
                    </s-stack>
                    <s-badge tone="info">
                      {TYPE_LABEL[rule.type] ?? rule.type}
                    </s-badge>
                    <s-text>+{rule.points} pts</s-text>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-badge tone={rule.enabled ? "success" : "neutral"}>
                        {rule.enabled ? "On" : "Off"}
                      </s-badge>
                      <s-text color="subdued">
                        {rule.thresholdAmount
                          ? `₹${rule.thresholdAmount}`
                          : rule.thresholdOrderCount
                            ? `${rule.thresholdOrderCount} orders`
                            : ""}
                      </s-text>
                    </s-stack>
                  </s-grid>
                </s-box>
              ))}
            </s-stack>
          ) : (
            <s-paragraph>
              No milestones yet. Add one below to reward customers for signing up,
              their first order, reaching an order count, hitting a spend total, or
              their birthday.
            </s-paragraph>
          )}
        </s-section>

        <s-section heading="Add or update a milestone">
          <Form method="post">
            <s-stack direction="block" gap="base">
              <s-text-field
                name="id"
                label="Existing milestone ID"
                details="Leave blank to create a new milestone; paste an ID above to edit it."
              />
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-select name="type" label="Type" value="first_order">
                  <s-option value="signup">Signup</s-option>
                  <s-option value="first_order">First order</s-option>
                  <s-option value="order_count">Order count</s-option>
                  <s-option value="spend_amount">Spend amount</s-option>
                  <s-option value="birthday">Birthday</s-option>
                </s-select>
                <s-text-field name="title" label="Title" />
              </s-grid>
              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-number-field name="points" label="Points" defaultValue="0" min={0} />
                <s-number-field
                  name="thresholdAmount"
                  label="Spend threshold (₹)"
                  min={1}
                  placeholder="—"
                />
                <s-number-field
                  name="thresholdOrderCount"
                  label="Order-count threshold"
                  min={1}
                  placeholder="—"
                />
              </s-grid>
              <s-stack direction="inline" gap="large-100">
                <s-checkbox name="enabled" value="true" label="Enabled" />
                <s-checkbox name="repeatable" value="true" label="Repeatable" />
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" type="submit">
                  Save milestone
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
