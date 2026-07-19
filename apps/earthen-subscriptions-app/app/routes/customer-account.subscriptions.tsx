import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { listPortalGroups, performPortalAction } from "../subscriptions/portal";
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
  const groups = await listPortalGroups(db, access);
  return cors(Response.json({ ok: true, groups }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, access } = await context(request);
  try {
    const payload = await request.json() as { groupId?: string };
    if (!payload.groupId) throw new Error("groupId is required");
    await performPortalAction({
      db,
      razorpay: new RazorpayHttpGateway(),
      access,
      groupId: payload.groupId,
      payload,
    });
    return cors(Response.json({ ok: true, groups: await listPortalGroups(db, access) }));
  } catch (error) {
    return cors(Response.json({ ok: false, error: error instanceof Error ? error.message : "Update failed" }, { status: 400 }));
  }
};
