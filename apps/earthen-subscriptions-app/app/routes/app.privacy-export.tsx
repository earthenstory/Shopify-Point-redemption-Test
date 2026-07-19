import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const customerId = new URL(request.url).searchParams.get("customer_id") || "";
  if (!customerId) throw new Response("customer_id is required", { status: 400 });
  const gid = customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
  const groups = await db.subscriptionGroup.findMany({
    where: { shopDomain: session.shop, shopifyCustomerId: gid },
    select: {
      id: true, status: true, shopifyCustomerId: true, customerName: true,
      customerEmail: true, customerPhone: true, addressJson: true,
      intervalCode: true, anchorDate: true, nextChargeAt: true, endAt: true,
      mandateMaxPaise: true, cancelAtCycleEnd: true, cancelledAt: true,
      createdAt: true, updatedAt: true,
      pricingPolicy: { select: { version: true, baseDiscountBps: true, tiers: true } },
      lines: true,
      cycles: { include: { paymentAttempts: true }, orderBy: { seq: "asc" } },
    },
  });
  return new Response(JSON.stringify({ shop: session.shop, customerId: gid, subscriptions: groups }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="subscription-customer-${customerId.split("/").pop()}.json"`,
      "Cache-Control": "no-store",
    },
  });
};
