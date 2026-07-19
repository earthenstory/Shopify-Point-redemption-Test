import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type AppProxyContext = { shop: string; loggedInCustomerId: string | null };

export function authenticateAppProxyRequest(request: Request): AppProxyContext {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const parsed = z.object({
    shop: z.string().min(1),
    signature: z.string().min(1),
    logged_in_customer_id: z.string().optional(),
  }).safeParse(query);
  if (!parsed.success) throw jsonError("Invalid subscription request", 401);
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw jsonError("Shopify app secret is not configured", 500);
  if (!hasValidAppProxySignature(url.searchParams, secret)) {
    throw jsonError("Invalid subscription request signature", 401);
  }
  return {
    shop: parsed.data.shop,
    loggedInCustomerId: parsed.data.logged_in_customer_id || null,
  };
}

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: { "Cache-Control": "no-store", ...init?.headers },
  });
}

export function jsonError(message: string, status = 400): Response {
  return jsonResponse({ ok: false, error: message }, { status });
}

function hasValidAppProxySignature(params: URLSearchParams, secret: string): boolean {
  const received = params.get("signature");
  if (!received || !/^[a-f0-9]+$/i.test(received)) return false;
  const entries = Array.from(params.entries())
    .filter(([key]) => key !== "signature" && key !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b));
  const messages = [
    entries.map(([key, value]) => `${key}=${value}`).join(""),
    entries.map(([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&"),
  ];
  return messages.some((message) => {
    const expected = createHmac("sha256", secret).update(message).digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(received, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
