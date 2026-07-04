import { z } from "zod";
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import {
  authenticateAppProxyRequest,
  jsonError,
  jsonResponse,
  readJsonBody,
} from "../loyalty/app-proxy";
import { claimEarnAction } from "../loyalty/earn-actions";

const requestSchema = z.object({
  actionId: z.string().min(1),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const body = await readJsonBody(request, requestSchema);

    if (!context.loggedInCustomerId) {
      return jsonError("Sign in to earn points", 401);
    }

    const result = await claimEarnAction({
      db,
      shopDomain: context.shop,
      shopifyCustomerId: context.loggedInCustomerId,
      actionId: body.actionId,
    });

    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError(
      error instanceof Error ? error.message : "Could not claim points",
      400,
    );
  }
};
