import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.$transaction([
      db.subscriptionGroup.updateMany({
        where: { shopDomain: shop, status: { in: ["active", "halted", "pending_mandate"] } },
        data: { status: "paused" },
      }),
      db.eventLog.create({
        data: {
          shopDomain: shop,
          entityType: "shop",
          entityId: shop,
          eventType: "app_uninstalled_billing_paused",
          maskedPayload: {},
        },
      }),
    ]);
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
