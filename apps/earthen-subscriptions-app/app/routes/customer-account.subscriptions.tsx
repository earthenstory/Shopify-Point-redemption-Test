import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { assertPortalActionAllowed, listPortalGroups, performPortalAction } from "../subscriptions/portal";
import { getAdminConfiguration } from "../subscriptions/admin-config";
import { RazorpayHttpGateway } from "../subscriptions/razorpay";

async function context(request: Request) {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const shopDomain = String(sessionToken.dest ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const customerId = String(sessionToken.sub ?? "").split("/").pop() || "";
  if (!shopDomain || !customerId) throw new Response("Unknown customer", { status: 401 });
  return { cors, access: { shopDomain, customerId } };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors, access } = await context(request);
  const [groups, configuration] = await Promise.all([listPortalGroups(db, access), getAdminConfiguration(db, access.shopDomain)]);
  return cors(Response.json({ ok: true, groups, portal: configuration.modules.portal, cancellation: configuration.modules.cancellation }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, access } = await context(request);
  try {
    const payload = await request.json() as { groupId?: string; action?: string; reasonCode?: string };
    if (!payload.groupId) throw new Error("groupId is required");
    const configuration = await getAdminConfiguration(db, access.shopDomain);
    assertPortalActionAllowed(configuration.modules.portal, String(payload.action));
    if (payload.action === "cancel" && configuration.modules.cancellation.requireReason && !payload.reasonCode) throw new Error("Choose a cancellation reason.");
    await performPortalAction({
      db,
      razorpay: new RazorpayHttpGateway(),
      access,
      groupId: payload.groupId,
      payload,
    });
    if (payload.action === "cancel") await db.cancellationResponse.create({ data: { shopDomain: access.shopDomain, subscriptionId: payload.groupId, customerId: access.customerId, reasonCode: payload.reasonCode || "not_supplied", cancelled: true } });
    return cors(Response.json({ ok: true, groups: await listPortalGroups(db, access) }));
  } catch (error) {
    return cors(Response.json({ ok: false, error: error instanceof Error ? error.message : "Update failed" }, { status: 400 }));
  }
};
