import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateJob } from "../subscriptions/jobs";

export const action = async ({ request }: ActionFunctionArgs) => {
  authenticateJob(request);
  const now = new Date();
  const [paymentWithoutOrder, stuckPayments, invalidGroups, overdueGroups, failedWebhooks] = await Promise.all([
    db.billingCycle.findMany({
      where: { status: { in: ["order_creating", "manual_review"] }, razorpayPaymentId: { not: null }, shopifyOrderId: null },
      select: { id: true, subscriptionGroupId: true, razorpayPaymentId: true, failureMessage: true }, take: 200,
    }),
    db.billingCycle.findMany({
      where: { status: "payment_pending", updatedAt: { lt: new Date(now.getTime() - 2 * 3_600_000) } },
      select: { id: true, razorpayOrderId: true }, take: 200,
    }),
    db.subscriptionGroup.findMany({
      where: { status: "active", OR: [{ razorpayTokenId: null }, { razorpayCustomerId: null }, { nextChargeAt: null }] },
      select: { id: true, shopDomain: true }, take: 200,
    }),
    db.subscriptionGroup.findMany({
      where: { status: "active", nextChargeAt: { lt: new Date(now.getTime() - 2 * 86_400_000) } },
      select: { id: true, nextChargeAt: true }, take: 200,
    }),
    db.webhookEvent.findMany({ where: { status: "failed" }, select: { id: true, source: true, topic: true, error: true }, take: 200 }),
  ]);
  const result = { paymentWithoutOrder, stuckPayments, invalidGroups, overdueGroups, failedWebhooks };
  return Response.json({ ok: Object.values(result).every((items) => items.length === 0), ...result });
};
