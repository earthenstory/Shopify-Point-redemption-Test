import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  markWebhookProcessed,
  processCustomerDelete,
  recordWebhookEvent,
} from "../loyalty/webhooks";

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhook = await authenticate.webhook(request);
  const record = await recordWebhookEvent(db, webhook);
  if (record.status === "duplicate") return new Response();

  try {
    const status = await processCustomerDelete(db, webhook);
    await markWebhookProcessed(db, record.eventId, status);
  } catch (error) {
    await markWebhookProcessed(db, record.eventId, "failed", error);
    throw error;
  }

  return new Response();
};
