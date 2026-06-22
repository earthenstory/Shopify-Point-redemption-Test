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

  return (
    <s-page heading="Milestones and rewards">
      <s-section heading="Configured milestones">
        {data.milestones.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Status</th>
                <th>Points</th>
                <th>Threshold</th>
              </tr>
            </thead>
            <tbody>
              {data.milestones.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.title}</td>
                  <td>{rule.type}</td>
                  <td>{rule.enabled ? "Enabled" : "Disabled"}</td>
                  <td>{rule.points}</td>
                  <td>
                    {rule.thresholdAmount
                      ? `INR ${rule.thresholdAmount}`
                      : rule.thresholdOrderCount
                        ? `${rule.thresholdOrderCount} orders`
                        : "None"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <s-paragraph>No milestone rules have been configured yet.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Add or update milestone">
        {actionData?.message ? (
          <s-paragraph>{actionData.message}</s-paragraph>
        ) : null}
        <Form method="post">
          <div style={{ display: "grid", gap: 14, maxWidth: 720 }}>
            <label>
              Existing milestone ID
              <input name="id" placeholder="Leave blank to create" />
            </label>
            <label>
              Type
              <select name="type" defaultValue="first_order">
                <option value="signup">Signup</option>
                <option value="first_order">First order</option>
                <option value="order_count">Order count</option>
                <option value="spend_amount">Spend amount</option>
                <option value="birthday">Birthday</option>
              </select>
            </label>
            <label>
              Title
              <input name="title" required maxLength={120} />
            </label>
            <label>
              Points
              <input type="number" name="points" min={0} defaultValue={0} />
            </label>
            <label>
              Spend threshold INR
              <input type="number" name="thresholdAmount" min={1} />
            </label>
            <label>
              Order-count threshold
              <input type="number" name="thresholdOrderCount" min={1} />
            </label>
            <label>
              <input type="checkbox" name="enabled" /> Enabled
            </label>
            <label>
              <input type="checkbox" name="repeatable" /> Repeatable
            </label>
            <s-button type="submit">Save milestone</s-button>
          </div>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
