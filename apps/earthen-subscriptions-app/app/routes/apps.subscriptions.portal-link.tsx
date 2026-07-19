import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import db from "../db.server";
import { authenticateAppProxyRequest, jsonResponse } from "../subscriptions/app-proxy";
import { notifyBoth } from "../subscriptions/notifications";
import { createPortalToken } from "../subscriptions/portal";

export const action = async ({ request }: ActionFunctionArgs) => {
  const context = authenticateAppProxyRequest(request);
  const parsed = z.object({ email: z.string().email() }).safeParse(await request.json().catch(() => null));
  if (parsed.success) {
    const groups = await db.subscriptionGroup.findMany({
      where: { shopDomain: context.shop, customerEmail: { equals: parsed.data.email, mode: "insensitive" } },
      take: 20,
    });
    for (const group of groups) {
      const token = createPortalToken({ shopDomain: context.shop, groupId: group.id, ttlMinutes: 30 });
      const portalUrl = `https://${context.shop}/apps/subscriptions/manage?token=${encodeURIComponent(token)}`;
      await notifyBoth({
        db, shopDomain: context.shop, email: group.customerEmail, phone: "",
        template: "subscription_portal_link", idempotencyKey: `group:${group.id}:portal:${Math.floor(Date.now() / 1_800_000)}`,
        variables: { portalUrl, expiresInMinutes: 30 },
      });
    }
  }
  return jsonResponse({ ok: true, message: "If a subscription exists, a secure link will be sent." });
};
