import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import {
  authenticateAppProxyRequest,
  jsonError,
  jsonResponse,
} from "../delivery/app-proxy";
import { getDeliveryEstimate, PINCODE_PATTERN } from "../delivery/delivery";
import { ShiprocketError } from "../delivery/shiprocket";

// GET /apps/delivery/estimate?pincode=560001&weight=1.5
// Returns the estimated delivery date for the customer's pincode. Weight is
// in kg (optional — falls back to the merchant's default). Public via the
// HMAC-verified Shopify app proxy; works logged in or out.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);
    const url = new URL(request.url);

    const pincode = String(url.searchParams.get("pincode") || "").trim();
    if (!PINCODE_PATTERN.test(pincode)) {
      return jsonError("Enter a valid 6-digit pincode", 400);
    }

    const weightRaw = Number(url.searchParams.get("weight"));
    const weightKg =
      Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : undefined;

    const estimate = await getDeliveryEstimate({
      db,
      shopDomain: context.shop,
      pincode,
      weightKg,
    });

    if (!estimate.enabled) {
      return jsonResponse({ ok: true, enabled: false });
    }

    if (!estimate.serviceable) {
      return jsonResponse({ ok: true, enabled: true, serviceable: false });
    }

    return jsonResponse({
      ok: true,
      enabled: true,
      serviceable: true,
      pincode,
      deliveryText: estimate.deliveryText,
      deliveryDate: estimate.deliveryDate,
      dispatchDate: estimate.dispatchDate,
      transitDays: estimate.transitDays,
      courier: estimate.courierName,
      mode: estimate.mode,
      cached: estimate.cached,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ShiprocketError && error.status === 400) {
      return jsonError("Enter a valid 6-digit pincode", 400);
    }
    // Upstream hiccups (rate limit, timeout) degrade gracefully — the widget
    // hides rather than showing a broken state.
    return jsonError("Could not fetch a delivery estimate", 502);
  }
};
