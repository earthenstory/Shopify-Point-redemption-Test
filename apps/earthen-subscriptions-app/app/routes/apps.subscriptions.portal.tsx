import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateAppProxyRequest, jsonError, jsonResponse } from "../subscriptions/app-proxy";
import { assertPortalActionAllowed, listPortalGroups, performPortalAction, verifyPortalToken } from "../subscriptions/portal";
import { getAdminConfiguration } from "../subscriptions/admin-config";
import { RazorpayHttpGateway } from "../subscriptions/razorpay";

function accessFor(request: Request) {
  const proxy = authenticateAppProxyRequest(request);
  const token = new URL(request.url).searchParams.get("token");
  if (token) {
    const access = verifyPortalToken(token);
    if (access.shopDomain !== proxy.shop) throw jsonError("Invalid portal link", 401);
    return access;
  }
  if (!proxy.loggedInCustomerId) throw jsonError("Sign in to view subscriptions", 401);
  return { shopDomain: proxy.shop, customerId: proxy.loggedInCustomerId };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const access = accessFor(request); const [groups, configuration] = await Promise.all([listPortalGroups(db, access), getAdminConfiguration(db, access.shopDomain)]);
    return jsonResponse({ ok: true, groups, portal: configuration.modules.portal, cancellation: configuration.modules.cancellation });
  } catch (error) {
    if (error instanceof Response) throw error;
    return jsonError(error instanceof Error ? error.message : "Could not load subscriptions", 400);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const access = accessFor(request);
    const body = await request.json() as { groupId?: string; action?: string; reasonCode?: string };
    if (!body.groupId) return jsonError("groupId is required", 400);
    const configuration = await getAdminConfiguration(db, access.shopDomain);
    assertPortalActionAllowed(configuration.modules.portal, String(body.action));
    if (body.action === "cancel" && configuration.modules.cancellation.requireReason && !body.reasonCode) return jsonError("Choose a cancellation reason", 400);
    const group = await performPortalAction({
      db, razorpay: new RazorpayHttpGateway(), access, groupId: body.groupId, payload: body,
    });
    if (body.action === "cancel") await db.cancellationResponse.create({ data: { shopDomain: access.shopDomain, subscriptionId: body.groupId, customerId: access.customerId, reasonCode: body.reasonCode || "not_supplied", cancelled: true } });
    return jsonResponse({ ok: true, group });
  } catch (error) {
    if (error instanceof Response) throw error;
    return jsonError(error instanceof Error ? error.message : "Could not update subscription", 400);
  }
};
