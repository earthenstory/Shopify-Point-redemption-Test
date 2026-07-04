import { z } from "zod";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import {
  authenticateAppProxyRequest,
  jsonError,
  jsonResponse,
  readJsonBody,
} from "../loyalty/app-proxy";
import {
  attachReferral,
  getOrCreateReferralCode,
  getReferralSettings,
} from "../loyalty/referrals";

// GET: the logged-in customer's referral code + program info for the launcher.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const settings = await getReferralSettings(db, context.shop);

    if (!settings.enabled) {
      return jsonResponse({ ok: true, enabled: false });
    }

    if (!context.loggedInCustomerId) {
      return jsonResponse({
        ok: true,
        enabled: true,
        loggedIn: false,
        referrerPoints: settings.referrerPoints,
        refereePoints: settings.refereePoints,
      });
    }

    const customer = await db.loyaltyCustomer.findUnique({
      where: {
        shopDomain_shopifyCustomerId: {
          shopDomain: context.shop,
          shopifyCustomerId: context.loggedInCustomerId,
        },
      },
      select: { id: true },
    });
    if (!customer) {
      return jsonResponse({ ok: true, enabled: true, loggedIn: false });
    }

    const code = await getOrCreateReferralCode(db, customer.id);
    const rewardedCount = await db.referralAttribution.count({
      where: { referrerCustomerId: customer.id, status: "rewarded" },
    });

    return jsonResponse({
      ok: true,
      enabled: true,
      loggedIn: true,
      code,
      referrerPoints: settings.referrerPoints,
      refereePoints: settings.refereePoints,
      rewardedCount,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError("Could not load referral info", 500);
  }
};

const attachSchema = z.object({
  code: z.string().min(3).max(32),
});

// POST: attach a referral code to the logged-in (new) customer.
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const body = await readJsonBody(request, attachSchema);

    if (!context.loggedInCustomerId) {
      return jsonError("Sign in to use a referral code", 401);
    }

    const result = await attachReferral({
      db,
      shopDomain: context.shop,
      refereeShopifyCustomerId: context.loggedInCustomerId,
      code: body.code,
    });

    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError("Could not apply referral code", 400);
  }
};
