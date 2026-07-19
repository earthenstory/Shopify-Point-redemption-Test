import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { runDunning } from "../subscriptions/dunning";
import { authenticateJob } from "../subscriptions/jobs";
import { notifyBoth } from "../subscriptions/notifications";
import { applyCycleEndCancellations, createPortalToken, expireEndedGroups } from "../subscriptions/portal";
import { RazorpayHttpGateway } from "../subscriptions/razorpay";
import { unauthenticated } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  authenticateJob(request);
  const razorpay = new RazorpayHttpGateway();
  const now = new Date();
  await db.subscriptionIntent.updateMany({
    where: { status: { in: ["cart", "ordered", "pending_mandate"] }, expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  await db.subscriptionGroup.updateMany({
    where: {
      status: "pending_mandate",
      activationIntent: { is: { expiresAt: { lte: now }, status: "expired" } },
    },
    data: { status: "expired", cancelledAt: now },
  });
  const [dunning, cancellations, expirations] = await Promise.all([
    runDunning({
      db, razorpay, now,
      graphqlForShop: async (shop) => (await unauthenticated.admin(shop)).admin.graphql,
    }),
    applyCycleEndCancellations({ db, razorpay, now }),
    expireEndedGroups({ db, razorpay, now }),
  ]);
  const groups = await db.subscriptionGroup.findMany({
    where: { status: "active", endAt: { gt: now, lte: new Date(now.getTime() + 31 * 86_400_000) } },
  });
  for (const group of groups) {
    const settings = await db.subscriptionSettings.findUniqueOrThrow({ where: { shopDomain: group.shopDomain } });
    const reminderAt = new Date(group.endAt.getTime() - settings.expiryReminderDays * 86_400_000);
    if (reminderAt <= now) {
      const token = createPortalToken({ shopDomain: group.shopDomain, groupId: group.id, ttlMinutes: 7 * 24 * 60 });
      const portalUrl = `https://${group.shopDomain}/apps/subscriptions/reauthorize?token=${encodeURIComponent(token)}`;
      await notifyBoth({
        db, shopDomain: group.shopDomain, email: group.customerEmail, phone: group.customerPhone,
        template: "subscription_expiry_reminder", idempotencyKey: `group:${group.id}:expiry:${group.endAt.toISOString()}`,
        variables: { groupId: group.id, expiryDate: group.endAt.toISOString(), portalUrl },
      });
    }
  }
  return Response.json({ ok: true, dunning, cancellations, expirations, expiryReminders: groups.length });
};
