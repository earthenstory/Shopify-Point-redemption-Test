import { describe, expect, it, vi } from "vitest";
import { recordWebhook } from "../../app/subscriptions/webhooks";

describe("webhook idempotency", () => {
  it("treats a concurrent unique-key conflict as a duplicate", async () => {
    const stored = { id: "event-1", source: "razorpay", externalEventId: "evt-1" };
    const create = vi.fn().mockResolvedValueOnce(stored).mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const db = { webhookEvent: { create, findUnique: vi.fn(async () => stored) } };
    const first = await recordWebhook({ db: db as never, source: "razorpay", eventId: "evt-1", topic: "payment.captured", rawBody: "{}" });
    const second = await recordWebhook({ db: db as never, source: "razorpay", eventId: "evt-1", topic: "payment.captured", rawBody: "{}" });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });
});
