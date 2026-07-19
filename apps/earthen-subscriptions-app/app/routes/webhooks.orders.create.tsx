import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { capturePaidOrderIntent } from "../subscriptions/intents";
import { notifyBoth } from "../subscriptions/notifications";
import { finishWebhook, recordWebhook } from "../subscriptions/webhooks";

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhook = await authenticate.webhook(request);
  const rawBody = JSON.stringify(webhook.payload);
  const record = await recordWebhook({
    db,
    source: "shopify",
    eventId: webhook.webhookId,
    topic: String(webhook.topic),
    rawBody,
  });
  if (record.duplicate) return new Response();
  try {
    const intents = await capturePaidOrderIntent({
      db,
      shopDomain: webhook.shop,
      order: webhook.payload as never,
    });
    for (const intent of intents) {
      const customer = intent.customerSnapshot as { customerEmail?: string; customerPhone?: string } | null;
      const orderId = intent.shopifyOrderId?.split("/").pop() ?? "";
      const activationUrl = `https://${webhook.shop}/apps/subscriptions/activate?order_id=${encodeURIComponent(orderId)}`;
      await notifyBoth({
        db,
        shopDomain: webhook.shop,
        email: customer?.customerEmail ?? "",
        phone: customer?.customerPhone ?? "",
        template: "subscription_activation",
        idempotencyKey: `intent:${intent.id}:activation`,
        variables: { activationUrl, expiresAt: intent.expiresAt.toISOString() },
      });
    }
    await finishWebhook(db, record.event.id, intents.length ? "processed" : "ignored");
  } catch (error) {
    await finishWebhook(db, record.event.id, "failed", error);
    throw error;
  }
  return new Response();
};
