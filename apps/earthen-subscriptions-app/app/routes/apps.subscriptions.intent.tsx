import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateAppProxyRequest, jsonError, jsonResponse } from "../subscriptions/app-proxy";
import { createSubscriptionIntent, intentInputSchema } from "../subscriptions/intents";
import { unauthenticated } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const context = authenticateAppProxyRequest(request);
  try {
    const payload = intentInputSchema.parse(await request.json());
    const { admin } = await unauthenticated.admin(context.shop);
    const intent = await createSubscriptionIntent({
      db,
      shopDomain: context.shop,
      intervalCode: payload.intervalCode,
      lines: payload.lines,
      graphql: admin.graphql,
    });
    return jsonResponse({
      ok: true,
      intentId: intent.id,
      signedCartReference: intent.signedCartReference,
      expiresAt: intent.expiresAt,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not create subscription basket", 400);
  }
};
