import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export async function recordWebhook(input: {
  db: PrismaClient;
  source: string;
  eventId: string;
  topic: string;
  rawBody: string;
}) {
  try {
    const event = await input.db.webhookEvent.create({
      data: {
        source: input.source,
        externalEventId: input.eventId,
        topic: input.topic,
        payloadHash: createHash("sha256").update(input.rawBody).digest("hex"),
      },
    });
    return { duplicate: false, event };
  } catch {
    const event = await input.db.webhookEvent.findUnique({
      where: { source_externalEventId: { source: input.source, externalEventId: input.eventId } },
    });
    if (!event) throw new Error("Could not record webhook event");
    return { duplicate: true, event };
  }
}

export async function finishWebhook(
  db: PrismaClient,
  id: string,
  status: "processed" | "ignored" | "failed",
  error?: unknown,
) {
  await db.webhookEvent.update({
    where: { id },
    data: {
      status,
      processedAt: new Date(),
      error: error instanceof Error ? error.message.slice(0, 2_000) : null,
    },
  });
}
