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
import { claimReward } from "../loyalty/redemptions";

const requestSchema = z.object({
  rewardId: z.string().min(1),
  cartToken: z.string().optional().nullable(),
  subtotal: z.number().min(0),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const body = await readJsonBody(request, requestSchema);

    if (!context.loggedInCustomerId) {
      return jsonError("Sign in to redeem rewards", 401);
    }

    const { admin } = await unauthenticated.admin(context.shop);
    const claim = await claimReward({
      db,
      admin,
      shopDomain: context.shop,
      shopifyCustomerId: context.loggedInCustomerId,
      rewardId: body.rewardId,
      cart: { token: body.cartToken, subtotal: body.subtotal },
    });

    return jsonResponse({ ok: true, ...claim });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError(
      error instanceof Error ? error.message : "Could not claim reward",
      400,
    );
  }
};
