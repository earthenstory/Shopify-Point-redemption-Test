import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type AppProxyContext = {
  shop: string;
  loggedInCustomerId: string | null;
};

const appProxyQuerySchema = z.object({
  shop: z.string().min(1),
  signature: z.string().min(1),
  logged_in_customer_id: z.string().min(1).optional(),
});

export function authenticateAppProxyRequest(request: Request): AppProxyContext {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const parsed = appProxyQuerySchema.safeParse(query);

  if (!parsed.success) {
    throw jsonError("Invalid loyalty request", 401);
  }

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw jsonError("Loyalty app secret is not configured", 500);
  }

  if (!hasValidAppProxySignature(url.searchParams, secret)) {
    throw jsonError("Invalid loyalty request signature", 401);
  }

  return {
    shop: parsed.data.shop,
    loggedInCustomerId: parsed.data.logged_in_customer_id ?? null,
  };
}

export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodSchema<T>,
): Promise<T> {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw jsonError("Invalid loyalty request body", 400);
  }

  return parsed.data;
}

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
    status: init?.status,
    statusText: init?.statusText,
  });
}

export function jsonError(message: string, status = 400): Response {
  return jsonResponse({ ok: false, error: message }, { status });
}

function hasValidAppProxySignature(
  searchParams: URLSearchParams,
  secret: string,
): boolean {
  const receivedSignature = searchParams.get("signature");
  if (!receivedSignature) return false;

  const entries = Array.from(searchParams.entries())
    .filter(([key]) => key !== "signature" && key !== "hmac")
    .sort(([left], [right]) => left.localeCompare(right));

  const canonicalWithoutSeparators = entries
    .map(([key, value]) => `${key}=${value}`)
    .join("");
  const canonicalQueryString = entries
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");

  return [canonicalWithoutSeparators, canonicalQueryString].some((message) =>
    safeCompareHex(
      createHmac("sha256", secret).update(message).digest("hex"),
      receivedSignature,
    ),
  );
}

function safeCompareHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(right)) return false;

  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");

  if (leftBuffer.length !== rightBuffer.length) return false;

  return timingSafeEqual(leftBuffer, rightBuffer);
}
