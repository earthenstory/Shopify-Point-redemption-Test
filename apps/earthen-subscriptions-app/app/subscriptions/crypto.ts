import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type SignedPayload = Record<string, unknown> & { exp: number };

export function signPayload(payload: SignedPayload, secret = signingSecret()): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyPayload<T extends SignedPayload>(
  token: string,
  secret = signingSecret(),
  now = Date.now(),
): T {
  const [body, received, extra] = token.split(".");
  if (!body || !received || extra) throw new Error("Invalid signed token");
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(expected, received)) throw new Error("Invalid signed token");
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  if (!Number.isFinite(parsed.exp) || parsed.exp * 1000 <= now) {
    throw new Error("Signed token has expired");
  }
  return parsed;
}

export function hashPayload(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function verifyHmacHex(raw: string, received: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  return safeEqual(expected, received);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signingSecret(): string {
  const secret = process.env.SUBSCRIPTION_SIGNING_SECRET;
  if (!secret) throw new Error("SUBSCRIPTION_SIGNING_SECRET is not configured");
  return secret;
}
