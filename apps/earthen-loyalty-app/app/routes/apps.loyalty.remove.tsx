import { z } from "zod";
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  authenticateAppProxyRequest,
  jsonError,
  jsonResponse,
  readJsonBody,
} from "../loyalty/app-proxy";
import {
  releaseActiveRedemptions,
  releaseRedemption,
} from "../loyalty/redemptions";

const requestSchema = z.object({
  sessionId: z.string().optional().nullable(),
  discountCode: z.string().optional().nullable(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const body = await readJsonBody(request, requestSchema);

    if (!context.loggedInCustomerId) {
      return jsonError("Sign in to manage Earthen points", 401);
    }

    const { admin } = await unauthenticated.admin(context.shop);

    // With a specific target, release just that reservation (the Remove button).
    // With no target, release every active reservation for the customer — this is
    // the orphan-recovery path the cart widget uses when the cart carries no loyalty
    // discount but points are still held.
    if (body.sessionId || body.discountCode) {
      const result = await releaseRedemption({
        db,
        admin,
        shopDomain: context.shop,
        shopifyCustomerId: context.loggedInCustomerId,
        sessionId: body.sessionId,
        discountCode: body.discountCode,
      });
      return jsonResponse({ ok: true, released: result.released });
    }

    const result = await releaseActiveRedemptions({
      db,
      admin,
      shopDomain: context.shop,
      shopifyCustomerId: context.loggedInCustomerId,
      reason: "Released orphaned reservation",
    });
    return jsonResponse({ ok: true, released: result.released > 0 });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError("Could not remove loyalty redemption", 400);
  }
};
