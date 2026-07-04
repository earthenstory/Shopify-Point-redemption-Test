import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { formatDateTime } from "../components/loyalty-admin-ui";
import db from "../db.server";
import { formBoolean } from "../loyalty/settings";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const now = new Date();
  const campaigns = await db.pointsCampaign.findMany({
    where: { shopDomain: session.shop },
    orderBy: { startsAt: "desc" },
    take: 20,
  });

  return {
    campaigns: campaigns.map((campaign) => ({
      id: campaign.id,
      title: campaign.title,
      multiplier: Number(campaign.multiplier),
      startsAt: campaign.startsAt.toISOString(),
      endsAt: campaign.endsAt.toISOString(),
      enabled: campaign.enabled,
      live:
        campaign.enabled && campaign.startsAt <= now && campaign.endsAt >= now,
    })),
  };
};

function parseDateInput(value: FormDataEntryValue | null, endOfDay: boolean) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error("Dates must be in YYYY-MM-DD format.");
  }
  // Interpreted in IST (the store's timezone).
  return new Date(`${text}T${endOfDay ? "23:59:59" : "00:00:00"}+05:30`);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    const id = String(form.get("id") || "").trim();
    const multiplier = Number(String(form.get("multiplier") || "2"));
    if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
      throw new Error("Multiplier must be between 1 and 10.");
    }
    const startsAt = parseDateInput(form.get("startsAt"), false);
    const endsAt = parseDateInput(form.get("endsAt"), true);
    if (endsAt <= startsAt) {
      throw new Error("End date must be after the start date.");
    }
    const data = {
      shopDomain: session.shop,
      title: String(form.get("title")).trim(),
      multiplier,
      startsAt,
      endsAt,
      enabled: formBoolean(form.get("enabled")),
    };
    if (!data.title) throw new Error("Campaign title is required.");
    if (id) {
      await db.pointsCampaign.update({ where: { id }, data });
    } else {
      await db.pointsCampaign.create({ data });
    }
    return { ok: true, message: "Campaign saved." };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Could not save campaign.",
    };
  }
};

export default function CampaignsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Limited-time point offers">
      <s-stack direction="block" gap="large-100">
        {actionData?.message ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}

        <s-section heading="How it works">
          <s-paragraph>
            Run bonus-point windows (e.g. "2x points this weekend"). While a
            campaign is live, every order's earned points are multiplied; the
            launcher advertises it automatically. Overlapping campaigns use the
            highest multiplier — they don't stack.
          </s-paragraph>
        </s-section>

        <s-section heading="Campaigns">
          {data.campaigns.length > 0 ? (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Campaign</s-table-header>
                <s-table-header>Multiplier</s-table-header>
                <s-table-header>Starts</s-table-header>
                <s-table-header>Ends</s-table-header>
                <s-table-header>Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.campaigns.map((campaign) => (
                  <s-table-row key={campaign.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text type="strong">{campaign.title}</s-text>
                        <s-text color="subdued">ID: {campaign.id}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{campaign.multiplier}x</s-table-cell>
                    <s-table-cell>{formatDateTime(campaign.startsAt)}</s-table-cell>
                    <s-table-cell>{formatDateTime(campaign.endsAt)}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          campaign.live
                            ? "success"
                            : campaign.enabled
                              ? "info"
                              : "neutral"
                        }
                      >
                        {campaign.live
                          ? "Live"
                          : campaign.enabled
                            ? "Scheduled/ended"
                            : "Off"}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          ) : (
            <s-paragraph>No campaigns yet — schedule one below.</s-paragraph>
          )}
        </s-section>

        <s-section heading="Add or update a campaign">
          <Form method="post">
            <s-stack direction="block" gap="base">
              <s-text-field
                name="id"
                label="Existing campaign ID"
                details="Leave blank to create; paste an ID above to edit."
              />
              <s-grid gridTemplateColumns="2fr 1fr" gap="base">
                <s-text-field name="title" label="Title" />
                <s-number-field
                  name="multiplier"
                  label="Multiplier"
                  defaultValue="2"
                  min={1}
                  max={10}
                  step={0.5}
                />
              </s-grid>
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-text-field
                  name="startsAt"
                  label="Start date"
                  placeholder="YYYY-MM-DD"
                  details="Starts 00:00 IST"
                />
                <s-text-field
                  name="endsAt"
                  label="End date"
                  placeholder="YYYY-MM-DD"
                  details="Ends 23:59 IST"
                />
              </s-grid>
              <s-checkbox name="enabled" value="true" label="Enabled" defaultChecked />
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" type="submit">
                  Save campaign
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
