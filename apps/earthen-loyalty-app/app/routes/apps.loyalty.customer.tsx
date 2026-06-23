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
import { getLoyaltyRuntimeSettings } from "../loyalty/settings";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const settings = await getLoyaltyRuntimeSettings({
      db,
      shopDomain: context.shop,
    });

    if (!context.loggedInCustomerId) {
      return jsonResponse({
        ok: true,
        loggedIn: false,
        programName: settings.program.programName,
        pointName: settings.program.pointName,
        programStatus: settings.program.status,
        widget: {
          homepageEnabled: settings.widget.homepageEnabled,
          productEnabled: settings.widget.productEnabled,
          cartEnabled: settings.widget.cartEnabled,
          accountEnabled: settings.widget.accountEnabled,
          primaryColor: settings.widget.primaryColor,
          accentColor: settings.widget.accentColor,
          backgroundColor: settings.widget.backgroundColor,
        },
        message: settings.widget.loggedOutMessage,
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
      availableValue: pointsToMoney(snapshot.availablePoints, settings.rules),
      lifetimeEarnedPoints: snapshot.lifetimeEarnedPoints,
      lifetimeRedeemedPoints: snapshot.lifetimeRedeemedPoints,
      currency: settings.rules.currency,
      // Redemption rules are returned so the storefront can compute the cart
      // slider maximum locally and avoid a per-cart-change cart-preview round
      // trip. This is preview-only; real enforcement stays in /redeem.
      redemption: {
        enabled: settings.redemptionEnabled,
        minRedeemPoints: settings.rules.minRedeemPoints,
        redeemIncrementPoints: settings.rules.redeemIncrementPoints,
        maxRedeemPercentOfCart: settings.rules.maxRedeemPercentOfCart,
        maxRedeemPointsPerOrder: settings.rules.maxRedeemPointsPerOrder,
        currencyValuePerPoint: settings.rules.currencyValuePerPoint,
      },
      programName: settings.program.programName,
      pointName: settings.program.pointName,
      programStatus: settings.program.status,
      widget: {
        homepageEnabled: settings.widget.homepageEnabled,
        productEnabled: settings.widget.productEnabled,
        cartEnabled: settings.widget.cartEnabled,
        accountEnabled: settings.widget.accountEnabled,
        primaryColor: settings.widget.primaryColor,
        accentColor: settings.widget.accentColor,
        backgroundColor: settings.widget.backgroundColor,
      },
      message: getCustomerLoyaltyMessage(
        snapshot,
        settings.widget.zeroPointsMessage,
      ),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError("Could not load loyalty points", 500);
  }
};
