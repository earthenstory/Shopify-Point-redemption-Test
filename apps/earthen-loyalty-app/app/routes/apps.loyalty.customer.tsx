import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import {
  authenticateAppProxyRequest,
  jsonError,
  jsonResponse,
} from "../loyalty/app-proxy";
import {
  getCustomerLoyaltyMessage,
  getCustomerSnapshot,
  pointsToMoney,
} from "../loyalty/customers";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);

    if (!context.loggedInCustomerId) {
      return jsonResponse({
        ok: true,
        loggedIn: false,
        message: "Sign in to see and use your Earthen points.",
      });
    }

    const snapshot = await getCustomerSnapshot({
      db,
      shopDomain: context.shop,
      shopifyCustomerId: context.loggedInCustomerId,
    });

    return jsonResponse({
      ok: true,
      loggedIn: true,
      migrated: snapshot.migrated,
      hasLedgerEntries: snapshot.hasLedgerEntries,
      availablePoints: snapshot.availablePoints,
      pendingPoints: snapshot.pendingPoints,
      availableValue: pointsToMoney(snapshot.availablePoints),
      lifetimeEarnedPoints: snapshot.lifetimeEarnedPoints,
      lifetimeRedeemedPoints: snapshot.lifetimeRedeemedPoints,
      currency: "INR",
      message: getCustomerLoyaltyMessage(snapshot),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError("Could not load loyalty points", 500);
  }
};
