import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { RazorpayHttpGateway } from "../subscriptions/razorpay";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const groups = await db.subscriptionGroup.findMany({
    where: {
      shopDomain: session.shop,
      ...(status ? { status } : {}),
      ...(search ? {
        OR: [
          { customerName: { contains: search, mode: "insensitive" as const } },
          { customerEmail: { contains: search, mode: "insensitive" as const } },
          { customerPhone: { contains: search } },
          { lines: { some: { OR: [
            { sku: { contains: search, mode: "insensitive" as const } },
            { productTitle: { contains: search, mode: "insensitive" as const } },
          ] } } },
        ],
      } : {}),
    },
    include: {
      lines: { where: { status: "active" } },
      cycles: { orderBy: { seq: "desc" }, take: 10, include: { paymentAttempts: { orderBy: { attemptedAt: "desc" } } } },
      pricingPolicy: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return { groups, search, status, shop: session.shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const group = await db.subscriptionGroup.findFirst({
    where: { id: String(form.get("groupId")), shopDomain: session.shop },
  });
  if (!group) return { ok: false, message: "Subscription not found." };
  const action = String(form.get("intent"));
  if (action === "pause" && group.status === "active") {
    await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "paused" } });
  } else if (action === "resume" && group.status === "paused") {
    await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "active" } });
  } else if (action === "cancel") {
    if (group.razorpayTokenId) await new RazorpayHttpGateway().cancelToken(group.razorpayTokenId);
    await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "cancelled", cancelledAt: new Date() } });
  }
  return { ok: true, message: "Subscription updated." };
};

export default function SubscriptionsPage() {
  const { groups, search, status, shop } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <s-page heading="Subscriptions">
      <s-stack direction="block" gap="base">
        {result ? <s-banner tone={result.ok ? "success" : "critical"}>{result.message}</s-banner> : null}
        <Form method="get">
          <s-grid gridTemplateColumns="2fr 1fr auto" gap="base">
            <s-text-field name="search" label="Customer, product or SKU" defaultValue={search} />
            <s-select name="status" label="Status" value={status}>
              <s-option value="">All statuses</s-option>
              {['pending_mandate', 'active', 'paused', 'halted', 'reauthorization_required', 'cancelled', 'expired'].map((value) => (
                <s-option key={value} value={value}>{value.replaceAll('_', ' ')}</s-option>
              ))}
            </s-select>
            <s-button type="submit" variant="primary">Filter</s-button>
          </s-grid>
        </Form>
        {groups.length === 0 ? <s-banner tone="info">No subscriptions yet.</s-banner> : groups.map((group) => (
          <s-section key={group.id} heading={`${group.customerName} — ${group.status}`}>
            <s-stack direction="block" gap="small-100">
              <s-paragraph>{group.lines.map((line) => `${line.quantity}× ${line.productTitle}${line.variantTitle ? ` (${line.variantTitle})` : ""}`).join(", ")}</s-paragraph>
              <s-paragraph>Frequency: {group.intervalCode}; next charge: {group.nextChargeAt?.toLocaleDateString() ?? "—"}; mandate maximum: ₹{((group.mandateMaxPaise ?? 0) / 100).toFixed(2)}</s-paragraph>
              <s-paragraph>Discount policy: version {group.pricingPolicy.version} ({group.pricingPolicy.baseDiscountBps / 100}% base)</s-paragraph>
              <Form method="post">
                <input type="hidden" name="groupId" value={group.id} />
                <s-stack direction="inline" gap="base">
                  {group.status === "active" ? <button type="submit" name="intent" value="pause">Pause</button> : null}
                  {group.status === "paused" ? <button type="submit" name="intent" value="resume">Resume</button> : null}
                  {!['cancelled', 'expired'].includes(group.status) ? <button type="submit" name="intent" value="cancel">Cancel now</button> : null}
                </s-stack>
              </Form>
              {group.cycles.length ? (
                <s-box padding="base" borderWidth="base" borderRadius="base">
                  <s-text type="strong">Recent billing cycles</s-text>
                  {group.cycles.map((cycle) => (
                    <s-paragraph key={cycle.id}>
                      #{cycle.seq} {cycle.status} — {cycle.scheduledAt.toLocaleDateString('en-IN')} — ₹{((cycle.chargeAmountPaise ?? 0) / 100).toFixed(2)}
                      {cycle.shopifyOrderId ? <> — <s-link href={shopifyOrderUrl(shop, cycle.shopifyOrderId)} target="_blank">Shopify order</s-link></> : null}
                      {cycle.razorpayPaymentId ? <> — <s-link href={`https://dashboard.razorpay.com/app/payments/${cycle.razorpayPaymentId}`} target="_blank">Razorpay payment</s-link></> : null}
                    </s-paragraph>
                  ))}
                </s-box>
              ) : null}
            </s-stack>
          </s-section>
        ))}
      </s-stack>
    </s-page>
  );
}

function shopifyOrderUrl(shop: string, orderId: string) {
  const store = shop.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${store}/orders/${orderId.split("/").pop()}`;
}
