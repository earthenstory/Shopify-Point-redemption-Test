import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [failedWebhooks, paymentOrderGaps, invalidTokens, recentRuns, failedNotifications, privacyRequests] = await Promise.all([
    db.webhookEvent.count({ where: { status: "failed" } }),
    db.billingCycle.count({ where: { status: { in: ["manual_review", "order_creating"] }, group: { shopDomain: session.shop } } }),
    db.subscriptionGroup.count({ where: { shopDomain: session.shop, status: "active", OR: [{ razorpayTokenId: null }, { nextChargeAt: null }] } }),
    db.cronRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    db.notificationLog.count({ where: { shopDomain: session.shop, status: "failed" } }),
    db.eventLog.findMany({
      where: { shopDomain: session.shop, eventType: "customer_data_export_requested" },
      orderBy: { createdAt: "desc" }, take: 20,
    }),
  ]);
  return { failedWebhooks, paymentOrderGaps, invalidTokens, recentRuns, failedNotifications, privacyRequests };
};

export default function HealthPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <s-page heading="Subscription health">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="repeat(4, 1fr)" gap="base">
          <s-box padding="base" borderWidth="base">Failed webhooks: {data.failedWebhooks}</s-box>
          <s-box padding="base" borderWidth="base">Payment/order gaps: {data.paymentOrderGaps}</s-box>
          <s-box padding="base" borderWidth="base">Invalid active groups: {data.invalidTokens}</s-box>
          <s-box padding="base" borderWidth="base">Failed notifications: {data.failedNotifications}</s-box>
        </s-grid>
        <s-section heading="Recent scheduled jobs">
          {data.recentRuns.map((run) => <s-paragraph key={run.id}>{run.job}: {run.status} — {run.startedAt.toLocaleString()} ({run.processedCount} processed, {run.errorCount} errors)</s-paragraph>)}
        </s-section>
        <s-section heading="Customer privacy export requests">
          {data.privacyRequests.length === 0 ? <s-paragraph>No pending export records.</s-paragraph> : data.privacyRequests.map((event) => (
            <s-paragraph key={event.id}>
              {event.createdAt.toLocaleString('en-IN')} — customer {event.entityId} — <s-link href={`/app/privacy-export?customer_id=${encodeURIComponent(event.entityId)}`}>Download subscription data</s-link>
            </s-paragraph>
          ))}
        </s-section>
      </s-stack>
    </s-page>
  );
}
