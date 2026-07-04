import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { formatDateTime } from "../components/loyalty-admin-ui";
import db from "../db.server";
import { getReferralSettings } from "../loyalty/referrals";
import { formBoolean, formNullablePositiveInt, formNumber } from "../loyalty/settings";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getReferralSettings(db, session.shop);

  const [attributions, rewardedCount, pendingCount] = await Promise.all([
    db.referralAttribution.findMany({
      where: { shopDomain: session.shop },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.referralAttribution.count({
      where: { shopDomain: session.shop, status: "rewarded" },
    }),
    db.referralAttribution.count({
      where: { shopDomain: session.shop, status: "pending" },
    }),
  ]);

  const customerIds = [
    ...new Set(
      attributions.flatMap((row) => [row.referrerCustomerId, row.refereeCustomerId]),
    ),
  ];
  const customers = await db.loyaltyCustomer.findMany({
    where: { id: { in: customerIds } },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  const customerLabel = new Map(
    customers.map((customer) => [
      customer.id,
      [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
        customer.email ||
        customer.id,
    ]),
  );

  return {
    settings: {
      enabled: settings.enabled,
      referrerPoints: settings.referrerPoints,
      refereePoints: settings.refereePoints,
      minOrderSubtotal: settings.minOrderSubtotal
        ? Number(settings.minOrderSubtotal)
        : null,
    },
    rewardedCount,
    pendingCount,
    attributions: attributions.map((row) => ({
      id: row.id,
      code: row.code,
      referrer: customerLabel.get(row.referrerCustomerId) ?? row.referrerCustomerId,
      referee: customerLabel.get(row.refereeCustomerId) ?? row.refereeCustomerId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    await getReferralSettings(db, session.shop);
    await db.referralProgramSettings.update({
      where: { shopDomain: session.shop },
      data: {
        enabled: formBoolean(form.get("enabled")),
        referrerPoints: formNumber(form.get("referrerPoints")),
        refereePoints: formNumber(form.get("refereePoints")),
        minOrderSubtotal: formNullablePositiveInt(form.get("minOrderSubtotal")),
      },
    });
    return { ok: true, message: "Referral settings saved." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save settings.",
    };
  }
};

export default function ReferralsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Referral program">
      <s-stack direction="block" gap="large-100">
        {actionData?.message ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}

        <s-section heading="How it works">
          <s-paragraph>
            Customers share a personal link from the rewards launcher. When a
            referred friend creates an account and places their first qualifying
            order, both sides are rewarded automatically. Fraud guards: one
            referral per customer, self-referrals blocked, first-time customers
            only, single payout per referral.
          </s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-badge tone="success">{data.rewardedCount} rewarded</s-badge>
            <s-badge tone="info">{data.pendingCount} pending</s-badge>
          </s-stack>
        </s-section>

        <Form method="post">
          <s-section heading="Settings">
            <s-stack direction="block" gap="base">
              <s-checkbox
                name="enabled"
                value="true"
                defaultChecked={data.settings.enabled}
                label="Referral program enabled"
              />
              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-number-field
                  name="referrerPoints"
                  label="Referrer reward (points)"
                  defaultValue={String(data.settings.referrerPoints)}
                  min={0}
                />
                <s-number-field
                  name="refereePoints"
                  label="Friend reward (points)"
                  defaultValue={String(data.settings.refereePoints)}
                  min={0}
                />
                <s-number-field
                  name="minOrderSubtotal"
                  label="Min first-order subtotal (₹)"
                  defaultValue={
                    data.settings.minOrderSubtotal != null
                      ? String(data.settings.minOrderSubtotal)
                      : ""
                  }
                  min={1}
                  placeholder="No minimum"
                />
              </s-grid>
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" type="submit">
                  Save referral settings
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        </Form>

        <s-section heading="Recent referrals">
          {data.attributions.length > 0 ? (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">When</s-table-header>
                <s-table-header>Referrer</s-table-header>
                <s-table-header>Friend</s-table-header>
                <s-table-header>Code</s-table-header>
                <s-table-header>Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.attributions.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>{formatDateTime(row.createdAt)}</s-table-cell>
                    <s-table-cell>{row.referrer}</s-table-cell>
                    <s-table-cell>{row.referee}</s-table-cell>
                    <s-table-cell>{row.code}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          row.status === "rewarded"
                            ? "success"
                            : row.status === "pending"
                              ? "info"
                              : "critical"
                        }
                      >
                        {row.status}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          ) : (
            <s-paragraph>
              No referrals yet. Once customers share their links, activity shows up
              here.
            </s-paragraph>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
