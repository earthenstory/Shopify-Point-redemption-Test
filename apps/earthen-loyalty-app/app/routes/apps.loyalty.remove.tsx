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
import { releaseRedemption } from "../loyalty/redemptions";

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
    const result = await releaseRedemption({
      db,
      admin,
      shopDomain: context.shop,
      shopifyCustomerId: context.loggedInCustomerId,
      sessionId: body.sessionId,
      discountCode: body.discountCode,
    });

    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError("Could not remove loyalty redemption", 400);
  }
};
