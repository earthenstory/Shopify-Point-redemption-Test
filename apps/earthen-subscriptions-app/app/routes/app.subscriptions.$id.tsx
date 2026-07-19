import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { RazorpayHttpGateway } from "../subscriptions/razorpay";
import { nextOccurrence } from "../subscriptions/schedule";
import type { IntervalCode } from "../subscriptions/types";
import { AdminStyles, MetricCard, StatusBadge, formatMoney } from "../components/admin-ui";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const group = await db.subscriptionGroup.findFirst({
    where: { id: params.id, shopDomain: session.shop },
    include: {
      lines: { orderBy: { createdAt: "asc" } }, pricingPolicy: { include: { tiers: true } },
      cycles: { orderBy: { seq: "desc" }, take: 50, include: { paymentAttempts: { orderBy: { attemptedAt: "desc" } } } },
    },
  });
  if (!group) throw new Response("Subscription not found", { status: 404 });
  const events = await db.eventLog.findMany({ where: { shopDomain: session.shop, entityId: group.id }, orderBy: { createdAt: "desc" }, take: 50 });
  return { group, events, shop: session.shop };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const group = await db.subscriptionGroup.findFirst({ where: { id: params.id, shopDomain: session.shop }, include: { lines: { where: { status: "active" } } } });
  if (!group) return { ok: false, message: "Subscription not found." };
  const now = new Date();
  try {
    if (intent === "pause" && group.status === "active") await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "paused" } });
    else if (intent === "resume" && group.status === "paused") {
      let next = group.nextChargeAt ?? now;
      while (next <= now) next = nextOccurrence(next, group.intervalCode as IntervalCode);
      await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "active", nextChargeAt: next } });
    } else if (intent === "skip" && group.nextChargeAt) await db.subscriptionGroup.update({ where: { id: group.id }, data: { nextChargeAt: nextOccurrence(group.nextChargeAt, group.intervalCode as IntervalCode) } });
    else if (intent === "reschedule") {
      const date = new Date(String(form.get("nextChargeAt")));
      if (Number.isNaN(date.getTime()) || date <= now) throw new Error("Select a future renewal date.");
      await db.subscriptionGroup.update({ where: { id: group.id }, data: { nextChargeAt: date } });
    } else if (intent === "cancel_end") await db.subscriptionGroup.update({ where: { id: group.id }, data: { cancelAtCycleEnd: true } });
    else if (intent === "cancel_now") {
      if (group.razorpayTokenId) await new RazorpayHttpGateway().cancelToken(group.razorpayTokenId);
      await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "cancelled", cancelledAt: now } });
    } else if (intent === "remove_line") {
      const lineId = String(form.get("lineId"));
      if (!group.lines.some((line) => line.id === lineId)) throw new Error("Active SKU not found.");
      await db.subscriptionLine.update({ where: { id: lineId }, data: { status: "removed", removedAt: now } });
      if (group.lines.length === 1) {
        if (group.razorpayTokenId) await new RazorpayHttpGateway().cancelToken(group.razorpayTokenId);
        await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "cancelled", cancelledAt: now } });
      }
    } else throw new Error("That action is not available for the current subscription state.");
    await db.eventLog.create({ data: { shopDomain: session.shop, entityType: "subscription_group", entityId: group.id, eventType: `admin_${intent}`, maskedPayload: {} } });
    return { ok: true, message: "Subscription updated." };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Update failed." }; }
};

export default function SubscriptionDetail() {
  const { group, events, shop } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const activeLines = group.lines.filter((line) => line.status === "active");
  return <s-page heading={`Subscription ${group.id.slice(-8)}`}>
    <AdminStyles />
    <s-stack direction="block" gap="base">
      <s-link href="/app/subscriptions">← Back to subscriptions</s-link>
      {result ? <s-banner tone={result.ok ? "success" : "critical"}>{result.message}</s-banner> : null}
      <div className="es-admin-grid"><MetricCard label="Status" value={<StatusBadge status={group.status} />} /><MetricCard label="Next renewal" value={group.nextChargeAt?.toLocaleDateString("en-IN") ?? "—"} /><MetricCard label="Active units" value={activeLines.reduce((sum, line) => sum + line.quantity, 0)} /><MetricCard label="Mandate maximum" value={formatMoney(group.mandateMaxPaise)} /></div>
      <s-section heading="Actions"><Form method="post"><div className="es-actions">
        {group.status === "active" ? <button name="intent" value="pause">Pause</button> : null}
        {group.status === "paused" ? <button name="intent" value="resume">Resume</button> : null}
        {group.status === "active" ? <button name="intent" value="skip">Skip next delivery</button> : null}
        {!group.cancelAtCycleEnd && !["cancelled", "expired"].includes(group.status) ? <button name="intent" value="cancel_end">Cancel after current cycle</button> : null}
        {!["cancelled", "expired"].includes(group.status) ? <button name="intent" value="cancel_now">Cancel now</button> : null}
      </div></Form><Form method="post"><div className="es-actions" style={{marginTop: 12}}><input type="date" name="nextChargeAt" required/><button name="intent" value="reschedule">Reschedule</button></div></Form></s-section>
      <s-section heading="Customer and schedule"><s-paragraph>{group.customerName} · {group.customerEmail} · {group.customerPhone}</s-paragraph><s-paragraph>{group.intervalCode.replaceAll("_", " ")} · ends {group.endAt.toLocaleDateString("en-IN")} · pricing policy v{group.pricingPolicy.version}</s-paragraph></s-section>
      <s-section heading="Subscription items"><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Product / SKU</th><th>Quantity</th><th>Signup price</th><th>Latest charged price</th><th>Status</th><th></th></tr></thead><tbody>{group.lines.map((line) => <tr key={line.id}><td>{line.productTitle}{line.variantTitle ? ` — ${line.variantTitle}` : ""}<br/><span className="es-code">{line.sku ?? line.shopifyVariantId}</span></td><td>{line.quantity}</td><td>{formatMoney(line.signupUnitPricePaise)}</td><td>{formatMoney(line.lastChargedUnitPricePaise)}</td><td><StatusBadge status={line.status}/></td><td>{line.status === "active" && !["cancelled", "expired"].includes(group.status) ? <Form method="post"><input type="hidden" name="lineId" value={line.id}/><button name="intent" value="remove_line">Remove SKU</button></Form> : null}</td></tr>)}</tbody></table></div></s-section>
      <s-section heading="Billing history"><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Cycle</th><th>Scheduled</th><th>Status</th><th>Total</th><th>Discount</th><th>References</th></tr></thead><tbody>{group.cycles.length ? group.cycles.map((cycle) => <tr key={cycle.id}><td>#{cycle.seq}</td><td>{cycle.scheduledAt.toLocaleString("en-IN")}</td><td><StatusBadge status={cycle.status}/>{cycle.failureMessage ? <><br/><span className="es-muted">{cycle.failureMessage}</span></> : null}</td><td>{formatMoney(cycle.chargeAmountPaise)}</td><td>{(cycle.baseDiscountBps + cycle.tierBonusBps) / 100}%</td><td>{cycle.shopifyOrderId ? <s-link href={shopifyOrderUrl(shop, cycle.shopifyOrderId)} target="_blank">Order</s-link> : "—"}{cycle.razorpayPaymentId ? <> · <s-link href={`https://dashboard.razorpay.com/app/payments/${cycle.razorpayPaymentId}`} target="_blank">Payment</s-link></> : null}</td></tr>) : <tr><td colSpan={6}>No billing cycles yet.</td></tr>}</tbody></table></div></s-section>
      <s-section heading="Activity"><s-stack direction="block" gap="small-100">{events.length ? events.map((event) => <s-paragraph key={event.id}>{event.createdAt.toLocaleString("en-IN")} — {event.eventType.replaceAll("_", " ")}</s-paragraph>) : <s-paragraph>No recorded activity.</s-paragraph>}</s-stack></s-section>
    </s-stack>
  </s-page>;
}

function shopifyOrderUrl(shop: string, orderId: string) { return `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/orders/${orderId.split("/").pop()}`; }
