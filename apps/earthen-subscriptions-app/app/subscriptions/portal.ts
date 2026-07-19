import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { signPayload, verifyPayload } from "./crypto";
import type { RazorpayGateway } from "./razorpay";
import { nextOccurrence } from "./schedule";
import type { Address, IntervalCode } from "./types";

export type PortalAccess = { shopDomain: string; customerId?: string; groupId?: string };

export function createPortalToken(input: {
  shopDomain: string;
  groupId: string;
  ttlMinutes?: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return signPayload({
    shop: input.shopDomain,
    groupId: input.groupId,
    exp: Math.floor((now.getTime() + (input.ttlMinutes ?? 30) * 60_000) / 1000),
  }, process.env.PORTAL_SESSION_SECRET || process.env.SUBSCRIPTION_SIGNING_SECRET);
}

export function verifyPortalToken(token: string): PortalAccess {
  const claims = verifyPayload<{ shop: string; groupId: string; exp: number }>(
    token,
    process.env.PORTAL_SESSION_SECRET || process.env.SUBSCRIPTION_SIGNING_SECRET,
  );
  return { shopDomain: claims.shop, groupId: claims.groupId };
}

export async function listPortalGroups(db: PrismaClient, access: PortalAccess) {
  return db.subscriptionGroup.findMany({
    where: {
      shopDomain: access.shopDomain,
      ...(access.groupId ? { id: access.groupId } : {}),
      ...(access.customerId ? { shopifyCustomerId: customerGid(access.customerId) } : {}),
    },
    include: {
      lines: { where: { status: "active" } },
      cycles: { orderBy: { seq: "desc" }, take: 12 },
      pricingPolicy: { include: { tiers: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("remove_line"), lineId: z.string().min(1) }),
  z.object({
    action: z.literal("update_address"),
    address: z.object({
      address1: z.string().min(1), address2: z.string().nullable().optional(),
      city: z.string().min(1), province: z.string().nullable().optional(),
      provinceCode: z.string().nullable().optional(), country: z.string().nullable().optional(),
      countryCode: z.literal("IN").or(z.literal("")).nullable().optional(),
      zip: z.string().regex(/^[1-9][0-9]{5}$/, "Enter a valid Indian PIN code"),
      firstName: z.string().nullable().optional(), lastName: z.string().nullable().optional(),
      phone: z.string().nullable().optional(), company: z.string().nullable().optional(),
    }),
  }),
]);

export async function performPortalAction(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  access: PortalAccess;
  groupId: string;
  payload: unknown;
  now?: Date;
}) {
  const action = actionSchema.parse(input.payload);
  const group = await input.db.subscriptionGroup.findFirst({
    where: {
      id: input.groupId,
      shopDomain: input.access.shopDomain,
      ...(input.access.groupId ? { id: input.access.groupId } : {}),
      ...(input.access.customerId
        ? { shopifyCustomerId: customerGid(input.access.customerId) }
        : {}),
    },
    include: { lines: { where: { status: "active" } } },
  });
  if (!group) throw new Error("Subscription not found");
  const now = input.now ?? new Date();

  if (action.action === "skip") {
    if (!group.nextChargeAt) throw new Error("Subscription has no next delivery");
    return input.db.subscriptionGroup.update({
      where: { id: group.id },
      data: { nextChargeAt: nextOccurrence(group.nextChargeAt, group.intervalCode as IntervalCode) },
    });
  }
  if (action.action === "pause") {
    if (group.status !== "active") throw new Error("Only an active subscription can be paused");
    return input.db.subscriptionGroup.update({ where: { id: group.id }, data: { status: "paused" } });
  }
  if (action.action === "resume") {
    if (group.status !== "paused") throw new Error("Only a paused subscription can be resumed");
    let next = group.nextChargeAt ?? now;
    while (next <= now) next = nextOccurrence(next, group.intervalCode as IntervalCode);
    return input.db.subscriptionGroup.update({
      where: { id: group.id }, data: { status: "active", nextChargeAt: next },
    });
  }
  if (action.action === "cancel") {
    return input.db.subscriptionGroup.update({
      where: { id: group.id }, data: { cancelAtCycleEnd: true },
    });
  }
  if (action.action === "update_address") {
    return input.db.subscriptionGroup.update({
      where: { id: group.id }, data: { addressJson: action.address as Address },
    });
  }
  const line = group.lines.find((candidate) => candidate.id === action.lineId);
  if (!line) throw new Error("Subscription item not found");
  if (group.lines.length === 1) {
    if (group.razorpayTokenId) await input.razorpay.cancelToken(group.razorpayTokenId);
    return input.db.$transaction(async (tx) => {
      await tx.subscriptionLine.update({
        where: { id: line.id }, data: { status: "removed", removedAt: now },
      });
      return tx.subscriptionGroup.update({
        where: { id: group.id }, data: { status: "cancelled", cancelledAt: now },
      });
    });
  }
  await input.db.subscriptionLine.update({
    where: { id: line.id }, data: { status: "removed", removedAt: now },
  });
  return input.db.subscriptionGroup.findUniqueOrThrow({ where: { id: group.id } });
}

function customerGid(value: string) {
  return value.startsWith("gid://shopify/Customer/") ? value : `gid://shopify/Customer/${value}`;
}

export async function applyCycleEndCancellations(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const groups = await input.db.subscriptionGroup.findMany({
    where: {
      cancelAtCycleEnd: true,
      status: { in: ["active", "paused", "halted"] },
      nextChargeAt: { lte: now },
    },
  });
  for (const group of groups) {
    if (group.razorpayTokenId) await input.razorpay.cancelToken(group.razorpayTokenId);
    await input.db.subscriptionGroup.update({
      where: { id: group.id }, data: { status: "cancelled", cancelledAt: now },
    });
  }
  return groups.length;
}

export async function expireEndedGroups(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const groups = await input.db.subscriptionGroup.findMany({
    where: {
      endAt: { lte: now },
      status: { in: ["active", "paused", "halted", "reauthorization_required"] },
    },
  });
  for (const group of groups) {
    if (group.razorpayTokenId) await input.razorpay.cancelToken(group.razorpayTokenId);
    await input.db.subscriptionGroup.update({
      where: { id: group.id }, data: { status: "expired", cancelledAt: now },
    });
  }
  return groups.length;
}
