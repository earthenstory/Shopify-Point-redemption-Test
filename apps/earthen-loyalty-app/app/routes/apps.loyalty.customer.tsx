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
import { listEarnActions } from "../loyalty/earn-actions";
import { getEarnMultiplierContext } from "../loyalty/multipliers";
import { getLoyaltyRuntimeSettings } from "../loyalty/settings";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const settings = await getLoyaltyRuntimeSettings({
      db,
      shopDomain: context.shop,
    });

    // Catalog rewards (fixed points cost) shown in the rewards launcher.
    const catalog = (
      await db.rewardDefinition.findMany({
        where: { shopDomain: context.shop, enabled: true },
        orderBy: [{ sortOrder: "asc" }, { pointsCost: "asc" }],
      })
    ).map((reward) => ({
      id: reward.id,
      title: reward.title,
      type: reward.type,
      pointsCost: reward.pointsCost,
      value: reward.value ? Number(reward.value) : null,
      minSubtotal: reward.minSubtotal ? Number(reward.minSubtotal) : null,
    }));

    const widget = {
      homepageEnabled: settings.widget.homepageEnabled,
      productEnabled: settings.widget.productEnabled,
      cartEnabled: settings.widget.cartEnabled,
      accountEnabled: settings.widget.accountEnabled,
      primaryColor: settings.widget.primaryColor,
      accentColor: settings.widget.accentColor,
      backgroundColor: settings.widget.backgroundColor,
    };

    // Earn + redeem display info for the rewards launcher panel. Returned for
    // both logged-out and logged-in customers so the panel can always show how
    // points are earned and what they are worth.
    const rewards = {
      pointName: settings.program.pointName,
      currency: settings.rules.currency,
      currencyValuePerPoint: settings.rules.currencyValuePerPoint,
      minRedeemPoints: settings.rules.minRedeemPoints,
      redeemIncrementPoints: settings.rules.redeemIncrementPoints,
      redemptionEnabled: settings.redemptionEnabled,
      signupRewardPoints: settings.rules.signupRewardPoints,
      pointsPerSpendAmount: settings.rules.pointsPerSpendAmount,
      spendAmountForEarnPoints: settings.rules.spendAmountForEarnPoints,
    };

    if (!context.loggedInCustomerId) {
      const earnActions = await listEarnActions({
        db,
        shopDomain: context.shop,
      });
      return jsonResponse({
        ok: true,
        loggedIn: false,
        programName: settings.program.programName,
        pointName: settings.program.pointName,
        programStatus: settings.program.status,
        widget,
        rewards,
        catalog,
        earnActions,
        message: settings.widget.loggedOutMessage,
      });
    }

    const snapshot = await getCustomerSnapshot({
      db,
      shopDomain: context.shop,
      shopifyCustomerId: context.loggedInCustomerId,
    });
    const earnActions = await listEarnActions({
      db,
      shopDomain: context.shop,
      customerId: snapshot.customerId,
    });

    const multiplierContext = await getEarnMultiplierContext({
      db,
      shopDomain: context.shop,
      lifetimeEarnedPoints: snapshot.lifetimeEarnedPoints,
    });
    const vip =
      multiplierContext.currentTier || multiplierContext.nextTier
        ? {
            tier: multiplierContext.currentTier?.name ?? null,
            multiplier: multiplierContext.vipMultiplier,
            nextTier: multiplierContext.nextTier?.name ?? null,
            pointsToNext: multiplierContext.nextTier
              ? Math.max(
                  0,
                  multiplierContext.nextTier.thresholdPoints -
                    snapshot.lifetimeEarnedPoints,
                )
              : null,
          }
        : null;
    const campaign = multiplierContext.campaign
      ? {
          title: multiplierContext.campaign.title,
          multiplier: multiplierContext.campaignMultiplier,
          endsAt: multiplierContext.campaign.endsAt.toISOString(),
        }
      : null;

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
      widget,
      rewards,
      catalog,
      earnActions,
      vip,
      campaign,
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
