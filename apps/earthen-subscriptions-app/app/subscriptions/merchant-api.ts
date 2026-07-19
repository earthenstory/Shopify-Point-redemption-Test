import { timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { hashCredential } from "./admin-config";

export async function authenticateMerchantRequest(db: PrismaClient, request: Request) {
  const shopDomain = request.headers.get("x-earthen-shop")?.trim().toLowerCase() || "";
  const token = request.headers.get("x-earthen-token") || "";
  const secret = request.headers.get("x-earthen-secret") || "";
  if (!shopDomain || !token || !secret) throw new Response("Unauthorized", { status: 401 });
  const credential = await db.merchantApiCredential.findUnique({ where: { shopDomain } });
  if (!credential?.enabled || !credential.tokenHash || !credential.secretHash) throw new Response("Unauthorized", { status: 401 });
  if (!secureEqual(hashCredential(token), credential.tokenHash) || !secureEqual(hashCredential(secret), credential.secretHash)) throw new Response("Unauthorized", { status: 401 });
  return { shopDomain };
}

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function dispatchMerchantWebhooks(input: { db: PrismaClient; shopDomain: string; topic: string; payload: Record<string, unknown> }) {
  const hooks = await input.db.merchantWebhook.findMany({ where: { shopDomain: input.shopDomain, status: "active" } });
  const matching = hooks.filter((hook) => Array.isArray(hook.topics) && hook.topics.includes(input.topic));
  await Promise.all(matching.map(async (hook) => {
    try {
      const response = await fetch(hook.url, { method: "POST", headers: { "Content-Type": "application/json", "X-Earthen-Topic": input.topic }, body: JSON.stringify({ id: crypto.randomUUID(), topic: input.topic, createdAt: new Date().toISOString(), data: input.payload }) });
      await input.db.merchantWebhook.update({ where: { id: hook.id }, data: { lastDeliveryAt: new Date(), lastStatus: response.status, failureCount: response.ok ? 0 : { increment: 1 } } });
    } catch {
      await input.db.merchantWebhook.update({ where: { id: hook.id }, data: { lastDeliveryAt: new Date(), lastStatus: 0, failureCount: { increment: 1 } } });
    }
  }));
}
