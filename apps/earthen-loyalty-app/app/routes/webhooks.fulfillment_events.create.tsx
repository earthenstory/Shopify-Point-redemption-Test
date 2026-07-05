import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { fetchOrderPayloadForReplay } from "../loyalty/webhook-replay";
import {
  markWebhookProcessed,
  processOrderDelivered,
  recordWebhookEvent,
} from "../loyalty/webhooks";

// Carrier tracking events (pushed by Shiprocket & co). We only care about
// "delivered": when awardOnStatus === "delivered", that's the earn trigger.
export const action = async ({ request }: ActionFunctionArgs) => {
  const webhook = await authenticate.webhook(request);
  const record = await recordWebhookEvent(db, webhook);
  if (record.status === "duplicate") return new Response();

  try {
    const eventStatus = String(
      (webhook.payload as { status?: unknown }).status ?? "",
    ).toLowerCase();
    const orderId = String(
      (webhook.payload as { order_id?: unknown }).order_id ?? "",
    ).replace(/\D/g, "");

    if (eventStatus !== "delivered" || !orderId) {
      await markWebhookProcessed(db, record.eventId, "ignored");
      return new Response();
    }

    // The event payload has no order details; rebuild an order payload from
    // the Admin API and run the delivered award.
    const { admin } = await unauthenticated.admin(webhook.shop);
    const orderPayload = await fetchOrderPayloadForReplay(admin, orderId);
    if (!orderPayload) {
      await markWebhookProcessed(db, record.eventId, "ignored");
      return new Response();
    }

    const status = await processOrderDelivered(db, {
      shop: webhook.shop,
      topic: "orders/delivered",
      webhookId: webhook.webhookId,
      payload: orderPayload,
    });
    await markWebhookProcessed(db, record.eventId, status);
  } catch (error) {
    await markWebhookProcessed(db, record.eventId, "failed", error);
    throw error;
  }

  return new Response();
};
