import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { formBoolean, formNumber } from "../loyalty/settings";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const tiers = await db.vipTier.findMany({
    where: { shopDomain: session.shop },
    orderBy: { thresholdPoints: "asc" },
  });

  return {
    tiers: tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      thresholdPoints: tier.thresholdPoints,
      earnMultiplier: Number(tier.earnMultiplier),
      enabled: tier.enabled,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    const id = String(form.get("id") || "").trim();
    const multiplier = Number(String(form.get("earnMultiplier") || "1"));
    if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
      throw new Error("Earn multiplier must be between 1 and 10.");
    }
    const data = {
      shopDomain: session.shop,
      name: String(form.get("name")).trim(),
      thresholdPoints: formNumber(form.get("thresholdPoints")),
      earnMultiplier: multiplier,
      enabled: formBoolean(form.get("enabled")),
    };
    if (!data.name) throw new Error("Tier name is required.");
    if (data.thresholdPoints < 0) {
      throw new Error("Threshold must be zero or positive.");
    }
    if (id) {
      await db.vipTier.update({ where: { id }, data });
    } else {
      await db.vipTier.create({ data });
    }
    return { ok: true, message: "VIP tier saved." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save tier.",
    };
  }
};

export default function VipPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="VIP tiers">
      <s-stack direction="block" gap="large-100">
        {actionData?.message ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}

        <s-section heading="How it works">
          <s-paragraph>
            Customers reach a tier once their lifetime earned points pass its
            threshold; the highest tier they qualify for applies automatically.
            The tier's earn multiplier boosts every order's points — no manual
            assignment needed.
          </s-paragraph>
        </s-section>

        <s-section heading="Tiers">
          {data.tiers.length > 0 ? (
            <s-stack direction="block" gap="small-100">
              {data.tiers.map((tier) => (
                <s-box
                  key={tier.id}
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
                      <s-text type="strong">{tier.name}</s-text>
                      <s-text color="subdued">ID: {tier.id}</s-text>
                    </s-stack>
                    <s-text>
                      {tier.thresholdPoints.toLocaleString("en-IN")}+ pts
                    </s-text>
                    <s-badge tone="info">{tier.earnMultiplier}x earn</s-badge>
                    <s-badge tone={tier.enabled ? "success" : "neutral"}>
                      {tier.enabled ? "On" : "Off"}
                    </s-badge>
                  </s-grid>
                </s-box>
              ))}
            </s-stack>
          ) : (
            <s-paragraph>No tiers yet — add the first one below.</s-paragraph>
          )}
        </s-section>

        <s-section heading="Add or update a tier">
          <Form method="post">
            <s-stack direction="block" gap="base">
              <s-text-field
                name="id"
                label="Existing tier ID"
                details="Leave blank to create; paste an ID above to edit."
              />
              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-text-field name="name" label="Tier name" />
                <s-number-field
                  name="thresholdPoints"
                  label="Lifetime points threshold"
                  min={0}
                />
                <s-number-field
                  name="earnMultiplier"
                  label="Earn multiplier"
                  min={1}
                  max={10}
                  step={0.05}
                  details="e.g. 1.5 = 50% bonus points"
                />
              </s-grid>
              <s-checkbox name="enabled" value="true" label="Enabled" defaultChecked />
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" type="submit">
                  Save tier
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
