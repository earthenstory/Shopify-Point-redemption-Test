import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateAppProxyRequest, jsonError, jsonResponse } from "../subscriptions/app-proxy";
import { listPortalGroups, performPortalAction, verifyPortalToken } from "../subscriptions/portal";
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
    return jsonResponse({ ok: true, groups: await listPortalGroups(db, accessFor(request)) });
  } catch (error) {
    if (error instanceof Response) throw error;
    return jsonError(error instanceof Error ? error.message : "Could not load subscriptions", 400);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const access = accessFor(request);
    const body = await request.json() as { groupId?: string; action?: string };
    if (!body.groupId) return jsonError("groupId is required", 400);
    const group = await performPortalAction({
      db, razorpay: new RazorpayHttpGateway(), access, groupId: body.groupId, payload: body,
    });
    return jsonResponse({ ok: true, group });
  } catch (error) {
    if (error instanceof Response) throw error;
    return jsonError(error instanceof Error ? error.message : "Could not update subscription", 400);
  }
};
