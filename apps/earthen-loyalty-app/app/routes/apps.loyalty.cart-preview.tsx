import { z } from "zod";
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import {
  authenticateAppProxyRequest,
  jsonError,
  jsonResponse,
  readJsonBody,
} from "../loyalty/app-proxy";
import { getCustomerSnapshot } from "../loyalty/customers";
import { previewRedemption } from "../loyalty/redemptions";

const requestSchema = z.object({
  cartToken: z.string().optional().nullable(),
  subtotal: z.number().min(0),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const body = await readJsonBody(request, requestSchema);

    if (!context.loggedInCustomerId) {
      return jsonResponse({
        ok: true,
        loggedIn: false,
        maxRedeemablePoints: 0,
        discountAmount: 0,
        minimumSubtotal: 0,
        currency: "INR",
      });
    }

    const snapshot = await getCustomerSnapshot({
      db,
      shopDomain: context.shop,
      shopifyCustomerId: context.loggedInCustomerId,
    });
    const preview = previewRedemption({
      availablePoints: snapshot.availablePoints,
      cart: {
        token: body.cartToken,
        subtotal: body.subtotal,
      },
    });

    return jsonResponse({
      ok: true,
      loggedIn: true,
      migrated: snapshot.migrated,
      ...preview,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError("Could not preview loyalty points", 500);
  }
};
