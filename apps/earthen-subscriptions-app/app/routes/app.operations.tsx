import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getAnalyticsDashboard } from "../subscriptions/admin-analytics";
import { AdminStyles, MetricCard, StatusBadge } from "../components/admin-ui";
import { nextOccurrence } from "../subscriptions/schedule";
import type { IntervalCode } from "../subscriptions/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request); const url = new URL(request.url); const section = url.searchParams.get("section") || "overview";
  const [analytics, operations, imports, jobs, webhooks] = await Promise.all([
    getAnalyticsDashboard(db, session.shop),
    db.bulkOperation.findMany({ where: { shopDomain: session.shop }, orderBy: { createdAt: "desc" }, take: 25 }),
    db.subscriptionImport.findMany({ where: { shopDomain: session.shop }, orderBy: { createdAt: "desc" }, take: 25 }),
    db.cronRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    db.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 25 }),
  ]);
  return { analytics, operations, imports, jobs, webhooks, section };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request); const form = await request.formData(); const intent = String(form.get("intent"));
  try {
    if (intent === "bulk") {
      const kind = String(form.get("kind")); const sourceStatus = String(form.get("sourceStatus"));
      if (!["pause", "resume", "cancel_at_cycle_end"].includes(kind)) throw new Error("Unsupported bulk action.");
      const operation = await db.bulkOperation.create({ data: { shopDomain: session.shop, kind, status: "running", requestedBy: "shopify-admin", selection: { sourceStatus }, startedAt: new Date() } });
      const where = { shopDomain: session.shop, ...(sourceStatus ? { status: sourceStatus } : {}) };
      let updated = 0;
      if (kind === "resume") {
        const groups = await db.subscriptionGroup.findMany({ where, select: { id: true, nextChargeAt: true, intervalCode: true } });
        const now = new Date();
        for (const group of groups) {
          let next = group.nextChargeAt ?? now;
          while (next <= now) next = nextOccurrence(next, group.intervalCode as IntervalCode);
          await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "active", nextChargeAt: next } });
          updated += 1;
        }
      } else {
        const result = await db.subscriptionGroup.updateMany({ where, data: kind === "pause" ? { status: "paused" } : { cancelAtCycleEnd: true } });
        updated = result.count;
      }
      await db.bulkOperation.update({ where: { id: operation.id }, data: { status: "completed", processedCount: updated, completedAt: new Date(), result: { updated } } });
    } else if (intent === "import") {
      const source = String(form.get("source")); const fileName = String(form.get("fileName") || "");
      if (!["seal", "shopify", "csv", "other"].includes(source)) throw new Error("Choose a supported source.");
      await db.subscriptionImport.create({ data: { shopDomain: session.shop, source, fileName: fileName || null, status: "awaiting_file", expiresAt: new Date(Date.now() + 7 * 86_400_000), summary: { note: "Upload and field mapping must be completed before any customer mandate is migrated." } } });
    } else throw new Error("Unknown operation.");
    return { ok: true, message: intent === "bulk" ? "Bulk operation completed." : "Import workspace created." };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Operation failed." }; }
};

export default function OperationsPage() { const data = useLoaderData<typeof loader>(); const result = useActionData<typeof action>(); return <s-page heading="Operations"><AdminStyles/><s-stack direction="block" gap="base">
  {result ? <s-banner tone={result.ok ? "success" : "critical"}>{result.message}</s-banner> : null}
  <div className="es-tabs">{[["overview","Overview"],["calendar","Delivery calendar"],["inventory","Inventory"],["bulk","Bulk actions"],["imports","Imports"],["jobs","Jobs & webhooks"]].map(([value,label]) => <a key={value} href={`/app/operations?section=${value}`} aria-current={data.section === value ? "page" : undefined}>{label}</a>)}</div>
  {data.section === "overview" ? <><div className="es-admin-grid"><MetricCard label="Upcoming groups" value={data.analytics.upcoming.length}/><MetricCard label="Units forecast (30 days)" value={data.analytics.inventoryForecast.days30.reduce((sum,row) => sum + row.units, 0)}/><MetricCard label="Queued bulk jobs" value={data.operations.filter((operation) => operation.status === "queued").length}/><MetricCard label="Failed recent webhooks" value={data.webhooks.filter((event) => event.status === "failed").length}/></div><div className="es-admin-grid"><a className="es-admin-card" href="/app/calendar"><h3>Full 90-day calendar</h3><p>Inspect combined delivery groups by date.</p></a><a className="es-admin-card" href="/app/health"><h3>System health</h3><p>Payment/order gaps, invalid mandates, notifications and privacy requests.</p></a></div></> : null}
  {data.section === "calendar" ? <s-section heading="Upcoming combined deliveries"><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Date</th><th>Customer</th><th>Units</th><th>Subscription</th></tr></thead><tbody>{data.analytics.upcoming.length ? data.analytics.upcoming.map((group) => <tr key={group.id}><td>{group.nextChargeAt?.toLocaleDateString("en-IN")}</td><td>{group.customerName}</td><td>{group.units}</td><td><s-link href={`/app/subscriptions/${group.id}`}>{group.id.slice(-8)}</s-link></td></tr>) : <tr><td colSpan={4}>No upcoming deliveries.</td></tr>}</tbody></table></div></s-section> : null}
  {data.section === "inventory" ? <s-section heading="Inventory forecast"><s-banner tone="info">Forecast quantities are based on currently active subscription units and each group’s next renewal/frequency. Stock is revalidated before payment; unavailable lines are skipped and the customer is notified.</s-banner><div className="es-admin-grid">{[[7,data.analytics.inventoryForecast.days7],[30,data.analytics.inventoryForecast.days30],[90,data.analytics.inventoryForecast.days90]].map(([days,rows]) => <MetricCard key={String(days)} label={`${days}-day unit demand`} value={(rows as typeof data.analytics.inventoryForecast.days7).reduce((sum,row) => sum + row.units, 0)}/>)}</div><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Product</th><th>SKU</th><th>Active units</th><th>Subscriptions</th></tr></thead><tbody>{data.analytics.products.map((product) => <tr key={product.variantId}><td>{product.title}</td><td>{product.sku || "—"}</td><td>{product.units}</td><td>{product.subscriptions}</td></tr>)}</tbody></table></div></s-section> : null}
  {data.section === "bulk" ? <><s-section heading="Run bulk action"><s-banner tone="warning">Bulk changes apply immediately to every subscription matching the selected status. Cancellation is scheduled at cycle end; mandates are not cancelled here.</s-banner><Form method="post"><input type="hidden" name="intent" value="bulk"/><div className="es-form-grid"><label>Action<br/><select name="kind"><option value="pause">Pause</option><option value="resume">Resume</option><option value="cancel_at_cycle_end">Cancel at cycle end</option></select></label><label>Current status<br/><select name="sourceStatus"><option value="active">Active</option><option value="paused">Paused</option><option value="halted">Halted</option></select></label></div><p><s-button type="submit" variant="primary">Run bulk action</s-button></p></Form></s-section><OperationTable operations={data.operations}/></> : null}
  {data.section === "imports" ? <><s-section heading="Create import workspace"><s-banner tone="info">This creates a seven-day migration workspace. Actual rows require source export mapping and mandate portability validation before import; no customer or payment data is changed at this stage.</s-banner><Form method="post"><input type="hidden" name="intent" value="import"/><div className="es-form-grid"><label>Source<br/><select name="source"><option value="seal">Seal Subscriptions</option><option value="shopify">Shopify subscriptions</option><option value="csv">CSV</option><option value="other">Other</option></select></label><label>File name or migration label<br/><input name="fileName"/></label></div><p><s-button type="submit" variant="primary">Create workspace</s-button></p></Form></s-section><s-section heading="Import history"><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Created</th><th>Source</th><th>File</th><th>Status</th><th>Imported / errors</th></tr></thead><tbody>{data.imports.length ? data.imports.map((item) => <tr key={item.id}><td>{item.createdAt.toLocaleString("en-IN")}</td><td>{item.source}</td><td>{item.fileName ?? "—"}</td><td><StatusBadge status={item.status}/></td><td>{item.importedCount} / {item.errorCount}</td></tr>) : <tr><td colSpan={5}>No imports.</td></tr>}</tbody></table></div></s-section></> : null}
  {data.section === "jobs" ? <><s-section heading="Scheduled jobs"><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Started</th><th>Job</th><th>Status</th><th>Processed</th><th>Errors</th></tr></thead><tbody>{data.jobs.map((job) => <tr key={job.id}><td>{job.startedAt.toLocaleString("en-IN")}</td><td>{job.job}</td><td><StatusBadge status={job.status}/></td><td>{job.processedCount}</td><td>{job.errorCount}</td></tr>)}</tbody></table></div></s-section><s-section heading="Webhook events"><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Received</th><th>Source</th><th>Topic</th><th>Status</th><th>Error</th></tr></thead><tbody>{data.webhooks.map((event) => <tr key={event.id}><td>{event.receivedAt.toLocaleString("en-IN")}</td><td>{event.source}</td><td>{event.topic}</td><td><StatusBadge status={event.status}/></td><td>{event.error ?? "—"}</td></tr>)}</tbody></table></div></s-section></> : null}
</s-stack></s-page>; }

function OperationTable({ operations }: { operations: Array<{id:string;kind:string;status:string;createdAt:Date;processedCount:number;errorCount:number}> }) { return <s-section heading="Bulk operation history"><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Created</th><th>Action</th><th>Status</th><th>Processed</th><th>Errors</th></tr></thead><tbody>{operations.length ? operations.map((operation) => <tr key={operation.id}><td>{operation.createdAt.toLocaleString("en-IN")}</td><td>{operation.kind.replaceAll("_", " ")}</td><td><StatusBadge status={operation.status}/></td><td>{operation.processedCount}</td><td>{operation.errorCount}</td></tr>) : <tr><td colSpan={5}>No bulk operations.</td></tr>}</tbody></table></div></s-section>; }
