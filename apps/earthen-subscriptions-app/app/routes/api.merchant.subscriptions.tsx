import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateMerchantRequest, dispatchMerchantWebhooks } from "../subscriptions/merchant-api";
import { nextOccurrence } from "../subscriptions/schedule";
import type { IntervalCode } from "../subscriptions/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopDomain } = await authenticateMerchantRequest(db, request); const url = new URL(request.url); const status = url.searchParams.get("status") || undefined; const cursor = url.searchParams.get("cursor") || undefined; const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const groups = await db.subscriptionGroup.findMany({ where: { shopDomain, ...(status ? { status } : {}) }, include: { lines: { where: { status: "active" } }, pricingPolicy: true }, orderBy: { id: "asc" }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: limit + 1 });
  const hasMore = groups.length > limit; const items = groups.slice(0, limit).map(publicSubscription);
  return Response.json({ items, nextCursor: hasMore ? items.at(-1)?.id : null });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopDomain } = await authenticateMerchantRequest(db, request); const body = await request.json() as { id?: string; action?: string };
  if (!body.id) return Response.json({ error: "id is required" }, { status: 400 });
  const group = await db.subscriptionGroup.findFirst({ where: { id: body.id, shopDomain } }); if (!group) return Response.json({ error: "Subscription not found" }, { status: 404 });
  const now = new Date();
  if (body.action === "pause" && group.status === "active") await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "paused" } });
  else if (body.action === "resume" && group.status === "paused") { let next = group.nextChargeAt ?? now; while (next <= now) next = nextOccurrence(next, group.intervalCode as IntervalCode); await db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "active", nextChargeAt: next } }); }
  else if (body.action === "skip" && group.status === "active" && group.nextChargeAt) await db.subscriptionGroup.update({ where: { id: group.id }, data: { nextChargeAt: nextOccurrence(group.nextChargeAt, group.intervalCode as IntervalCode) } });
  else if (body.action === "cancel_at_cycle_end") await db.subscriptionGroup.update({ where: { id: group.id }, data: { cancelAtCycleEnd: true } });
  else return Response.json({ error: "Action is invalid for the current state" }, { status: 409 });
  const updated = await db.subscriptionGroup.findUniqueOrThrow({ where: { id: group.id }, include: { lines: { where: { status: "active" } }, pricingPolicy: true } });
  await dispatchMerchantWebhooks({ db, shopDomain, topic: "subscription.updated", payload: publicSubscription(updated) });
  return Response.json({ item: publicSubscription(updated) });
};

function publicSubscription(group: {id:string;status:string;customerName:string;customerEmail:string;customerPhone:string;intervalCode:string;nextChargeAt:Date|null;endAt:Date;cancelAtCycleEnd:boolean;lines:Array<{id:string;shopifyProductId:string;shopifyVariantId:string;sku:string|null;productTitle:string;variantTitle:string|null;quantity:number}>;pricingPolicy:{version:number;baseDiscountBps:number}}) {
  return { id: group.id, status: group.status, customer: { name: group.customerName, email: group.customerEmail, phone: group.customerPhone }, interval: group.intervalCode, nextChargeAt: group.nextChargeAt, endAt: group.endAt, cancelAtCycleEnd: group.cancelAtCycleEnd, pricingPolicy: { version: group.pricingPolicy.version, baseDiscountBps: group.pricingPolicy.baseDiscountBps }, items: group.lines.map((line) => ({ id: line.id, productId: line.shopifyProductId, variantId: line.shopifyVariantId, sku: line.sku, title: line.productTitle, variantTitle: line.variantTitle, quantity: line.quantity })) };
}
