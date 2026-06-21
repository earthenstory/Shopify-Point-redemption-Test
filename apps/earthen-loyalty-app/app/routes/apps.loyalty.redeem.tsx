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
import { createRedemption } from "../loyalty/redemptions";

const requestSchema = z.object({
  cartToken: z.string().optional().nullable(),
  subtotal: z.number().min(0),
  points: z.number().int().positive(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const body = await readJsonBody(request, requestSchema);

    if (!context.loggedInCustomerId) {
      return jsonError("Sign in to redeem Earthen points", 401);
    }

    const { admin } = await unauthenticated.admin(context.shop);
    const redemption = await createRedemption({
      db,
      admin,
      shopDomain: context.shop,
      shopifyCustomerId: context.loggedInCustomerId,
      requestedPoints: body.points,
      cart: {
        token: body.cartToken,
        subtotal: body.subtotal,
      },
    });

    return jsonResponse({ ok: true, ...redemption });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError(
      error instanceof Error ? error.message : "Could not redeem points",
      400,
    );
  }
};
