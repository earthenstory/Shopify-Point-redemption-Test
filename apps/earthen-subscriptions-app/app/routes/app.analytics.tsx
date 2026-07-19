import type { LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getAnalyticsDashboard } from "../subscriptions/admin-analytics";
import { AdminStyles, MetricCard, formatMoney, percent } from "../components/admin-ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request); const url = new URL(request.url);
  const days = [7, 30, 90, 365].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const to = new Date(); const from = new Date(to.getTime() - days * 86_400_000);
  return { analytics: await getAnalyticsDashboard(db, session.shop, { from, to }), days };
};

export default function AnalyticsPage() { const { analytics, days } = useLoaderData<typeof loader>(); const maxProductUnits = Math.max(1, ...analytics.products.map((product) => product.units)); return <s-page heading="Analytics"><AdminStyles/><s-stack direction="block" gap="base">
  <Form method="get"><div className="es-actions"><s-select name="days" label="Reporting period" value={String(days)}><s-option value="7">Last 7 days</s-option><s-option value="30">Last 30 days</s-option><s-option value="90">Last 90 days</s-option><s-option value="365">Last 365 days</s-option></s-select><s-button type="submit">Apply</s-button></div></Form>
  <s-banner tone="info">All figures below are calculated from this store’s real subscriptions, billing cycles and payment attempts. Empty stores remain empty.</s-banner>
  <div className="es-admin-grid"><MetricCard label="Active subscriptions" value={analytics.summary.active} detail={`${analytics.summary.newSubscriptions} new in period`}/><MetricCard label="Collected renewal revenue" value={formatMoney(analytics.summary.collectedRevenuePaise)} detail={`${formatMoney(analytics.summary.scheduledRevenuePaise)} scheduled`}/><MetricCard label="Payment success rate" value={percent(analytics.summary.paymentSuccessRate)}/><MetricCard label="Churn rate" value={percent(analytics.summary.churnRate)} detail={`${analytics.summary.cancelledInPeriod} cancelled`}/></div>
  <div className="es-admin-grid"><MetricCard label="Average renewal" value={formatMoney(analytics.summary.averageRenewalRevenuePaise)}/><MetricCard label="Average per renewing customer" value={formatMoney(analytics.summary.averageRenewalRevenuePerCustomerPaise)}/><MetricCard label="Unresolved revenue" value={formatMoney(analytics.summary.unresolvedRevenuePaise)}/><MetricCard label="Growth rate" value={percent(analytics.summary.growthRate)}/></div>
  <s-section heading="Subscription status"><div className="es-admin-grid">{Object.entries(analytics.statusCounts).length ? Object.entries(analytics.statusCounts).map(([status,count]) => <MetricCard key={status} label={status.replaceAll("_", " ")} value={count}/>) : <s-paragraph>No subscription data yet.</s-paragraph>}</div></s-section>
  <s-section heading="Products and variants">{analytics.products.length ? analytics.products.map((product) => <div className="es-bar-row" key={product.variantId}><span>{product.title}<br/><span className="es-muted">{product.sku}</span></span><div className="es-bar"><span style={{width: `${product.units / maxProductUnits * 100}%`}}/></div><strong>{product.units} units</strong></div>) : <s-paragraph>No active products in subscriptions.</s-paragraph>}</s-section>
  <s-section heading="Payment outcomes"><div className="es-admin-grid">{Object.entries(analytics.payments.statuses).length ? Object.entries(analytics.payments.statuses).map(([status,count]) => <MetricCard key={status} label={status.replaceAll("_", " ")} value={count}/>) : <s-paragraph>No payment attempts in this period.</s-paragraph>}</div>{Object.keys(analytics.payments.failureReasons).length ? <div className="es-table-wrap"><table className="es-table"><thead><tr><th>Failure reason</th><th>Attempts</th></tr></thead><tbody>{Object.entries(analytics.payments.failureReasons).map(([reason,count]) => <tr key={reason}><td>{reason}</td><td>{count}</td></tr>)}</tbody></table></div> : null}</s-section>
  <s-section heading="Cancellation and retention">{analytics.cancellationReasons.length ? <div className="es-table-wrap"><table className="es-table"><thead><tr><th>Reason</th><th>Flow starts</th><th>Cancelled</th><th>Retained</th></tr></thead><tbody>{analytics.cancellationReasons.map((reason) => <tr key={reason.reasonCode}><td>{reason.reasonCode.replaceAll("_", " ")}</td><td>{reason.attempts}</td><td>{reason.cancelled}</td><td>{reason.retained}</td></tr>)}</tbody></table></div> : <s-paragraph>No cancellation-flow responses in this period.</s-paragraph>}</s-section>
</s-stack></s-page>; }
