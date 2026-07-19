import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateAppProxyRequest, jsonResponse } from "../subscriptions/app-proxy";
import { getShopConfiguration, isProductEligible, stringArray } from "../subscriptions/settings";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = authenticateAppProxyRequest(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("product_id") || "";
  const { settings, policy } = await getShopConfiguration(db, context.shop);
  return jsonResponse({
    ok: true,
    enabled: isProductEligible({ ...settings, productId }),
    productId,
    baseDiscountBps: policy.baseDiscountBps,
    tiers: policy.tiers,
    intervals: stringArray(settings.allowedIntervals),
    durationMonths: settings.defaultDurationMonths,
    pricingPolicyVersion: policy.version,
  });
};
