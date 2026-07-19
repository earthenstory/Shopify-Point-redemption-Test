import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { AdminStyles, MetricCard, ModuleCard, StatusBadge, formatMoney } from "../components/admin-ui";
import db from "../db.server";
import { getAdminConfiguration, readinessReport } from "../subscriptions/admin-config";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { settings, modules } = await getAdminConfiguration(db, session.shop);
  const now = new Date();
  const next30 = new Date(now.getTime() + 30 * 86_400_000);
  const [statusCounts, dueGroups, recentEvents, recentRuns, recentCycles, failedNotifications] = await Promise.all([
    db.subscriptionGroup.groupBy({ by: ["status"], where: { shopDomain: session.shop }, _count: true }),
    db.subscriptionGroup.findMany({
      where: { shopDomain: session.shop, status: "active", nextChargeAt: { gte: now, lte: next30 } },
      include: { lines: { where: { status: "active" } } }, orderBy: { nextChargeAt: "asc" }, take: 12,
    }),
    db.eventLog.findMany({ where: { shopDomain: session.shop }, orderBy: { createdAt: "desc" }, take: 12 }),
    db.cronRun.findMany({ orderBy: { startedAt: "desc" }, take: 5 }),
    db.billingCycle.findMany({
      where: { group: { shopDomain: session.shop }, createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
      orderBy: { createdAt: "desc" }, take: 100,
    }),
    db.notificationLog.count({ where: { shopDomain: session.shop, status: "failed" } }),
  ]);
  const counts = Object.fromEntries(statusCounts.map((item) => [item.status, item._count]));
  const readiness = readinessReport(settings, modules.installation);
  const collectedPaise = recentCycles
    .filter((cycle) => ["order_created", "partially_skipped"].includes(cycle.status))
    .reduce((sum, cycle) => sum + (cycle.chargeAmountPaise ?? 0), 0);
  return { settings, modules, readiness, counts, dueGroups, recentEvents, recentRuns, failedNotifications, collectedPaise };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const { settings, modules } = await getAdminConfiguration(db, session.shop);
  if (intent === "toggle") {
    const nextEnabled = !settings.widgetEnabled;
    if (nextEnabled) {
      const readiness = readinessReport(settings, modules.installation);
      if (!readiness.launchReady) {
        return { ok: false, message: "Subscriptions cannot be enabled until every required launch-readiness check passes." };
      }
    }
    await db.subscriptionSettings.update({ where: { shopDomain: session.shop }, data: { widgetEnabled: nextEnabled } });
    await db.eventLog.create({
      data: { shopDomain: session.shop, entityType: "settings", entityId: session.shop, eventType: nextEnabled ? "signup_enabled" : "signup_disabled" },
    });
    return { ok: true, message: `Subscription signup is now ${nextEnabled ? "ON" : "OFF"}.` };
  }
  return { ok: false, message: "Unknown dashboard action." };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const active = data.counts.active ?? 0;
  const total = Object.values(data.counts).reduce((sum, value) => sum + Number(value), 0);
  return <s-page heading="Dashboard">
    <AdminStyles />
    <s-stack direction="block" gap="large-100">
      {result ? <s-banner tone={result.ok ? "success" : "critical"}>{result.message}</s-banner> : null}

      <s-section heading="Master control">
        <s-stack direction="block" gap="base">
          <s-banner tone={data.settings.widgetEnabled ? "success" : "warning"}>
            Subscription signup is currently {data.settings.widgetEnabled ? "ON" : "OFF"}. Existing active subscriptions continue when new signup is off.
          </s-banner>
          <div className="es-actions">
            <Form method="post"><input type="hidden" name="intent" value="toggle" />
              <s-button type="submit" variant={data.settings.widgetEnabled ? undefined : "primary"} tone={data.settings.widgetEnabled ? "critical" : undefined}>
                Turn subscriptions {data.settings.widgetEnabled ? "off" : "on"}
              </s-button>
            </Form>
            {!data.readiness.launchReady ? <span className="es-muted">The enable action is locked until required checks pass.</span> : null}
          </div>
        </s-stack>
      </s-section>

      <s-section heading="Get started with Earthen Subscriptions">
        <div className="es-progress"><span style={{ width: `${Math.round(data.readiness.completed / data.readiness.total * 100)}%` }} /></div>
        <s-paragraph>{data.readiness.completed} of {data.readiness.total} setup checks complete</s-paragraph>
        <div>
          {data.readiness.checks.map((check) => <div className="es-check" key={check.key}>
            <span className="es-check-dot" data-ready={check.ready}>{check.ready ? "✓" : "!"}</span>
            <div><strong>{check.label}</strong>{check.optional ? <div className="es-muted">This is the final customer-facing launch switch.</div> : null}</div>
          </div>)}
        </div>
      </s-section>

      <div className="es-admin-grid">
        <MetricCard label="Total subscriptions" value={total} />
        <MetricCard label="Active subscriptions" value={active} />
        <MetricCard label="Deliveries due in 30 days" value={data.dueGroups.length} />
        <MetricCard label="Renewal revenue, last 30 days" value={formatMoney(data.collectedPaise)} />
        <MetricCard label="Failed notifications" value={data.failedNotifications} />
      </div>

      <s-section heading="Manage your subscription program">
        <div className="es-admin-grid">
          <ModuleCard href="/app/subscriptions" title="Subscriptions" description="Search, filter, inspect and operate every subscription and billing attempt." />
          <ModuleCard href="/app/plans" title="Products & plans" description="Choose products, intervals, duration, discounts, tiers and shipping." />
          <ModuleCard href="/app/customers" title="Customer portal" description="Configure customer controls, cancellation flow and communication." />
          <ModuleCard href="/app/automations" title="Automations" description="Product actions, interval flows, loyalty, upsells and bulk operations." />
          <ModuleCard href="/app/operations" title="Operations" description="Calendar, inventory forecast, jobs, reconciliation and imports." />
          <ModuleCard href="/app/analytics" title="Analytics" description="Revenue, payments, retention, products and cancellation reasons." />
          <ModuleCard href="/app/settings" title="Settings" description="Widget, notifications, integrations, API, installation and advanced controls." />
        </div>
      </s-section>

      <s-section heading="Upcoming delivery groups">
        {data.dueGroups.length === 0 ? <s-paragraph>No active deliveries are scheduled in the next 30 days.</s-paragraph> :
          <div className="es-table-wrap"><table className="es-table"><thead><tr><th>Date</th><th>Customer</th><th>Items</th><th>Status</th></tr></thead><tbody>
            {data.dueGroups.map((group) => <tr key={group.id}><td>{group.nextChargeAt?.toLocaleDateString("en-IN")}</td><td>{group.customerName}</td><td>{group.lines.reduce((sum, line) => sum + line.quantity, 0)} units</td><td><StatusBadge status={group.status} /></td></tr>)}
          </tbody></table></div>}
      </s-section>

      <s-section heading="Recent activity">
        {data.recentEvents.length === 0 ? <s-paragraph>No subscription activity yet.</s-paragraph> : data.recentEvents.map((event) =>
          <s-paragraph key={event.id}>{event.createdAt.toLocaleString("en-IN")} — {event.eventType.replaceAll("_", " ")}</s-paragraph>)}
      </s-section>

      <s-section heading="Scheduled jobs">
        {data.recentRuns.length === 0 ? <s-paragraph>No scheduled job has run yet.</s-paragraph> : data.recentRuns.map((run) =>
          <s-paragraph key={run.id}>{run.job}: <StatusBadge status={run.status} /> — {run.processedCount} processed, {run.errorCount} errors</s-paragraph>)}
      </s-section>
    </s-stack>
  </s-page>;
}
