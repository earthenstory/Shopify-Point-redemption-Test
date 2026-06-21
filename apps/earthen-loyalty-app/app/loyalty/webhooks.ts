import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { calculateOrderEarnPoints, confirmedBonDefaults } from "./rules";

const LOYALTY_CODE_PREFIX = "ESPOINTS-";

export type LoyaltyWebhookContext = {
  shop: string;
  topic: string | number | symbol;
  webhookId: string;
  payload: Record<string, unknown>;
};

export type WebhookRecordResult =
  | { status: "received"; eventId: string }
  | { status: "duplicate"; eventId: string };

export function hashWebhookPayload(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(sortObjectKeys(payload)))
    .digest("hex");
}

export function extractWebhookResourceId(
  payload: Record<string, unknown>,
): string | null {
  const candidates = [
    payload.admin_graphql_api_id,
    payload.id,
    payload.order_id,
    payload.customer?.valueOf(),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }

    if (typeof candidate === "number" || typeof candidate === "bigint") {
      return String(candidate);
    }
  }

  return null;
}

export async function recordWebhookEvent(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<WebhookRecordResult> {
  const topic = String(context.topic);
  const payloadHash = hashWebhookPayload(context.payload);
  const resourceId = extractWebhookResourceId(context.payload);

  const existing = await db.webhookEvent.findUnique({
    where: { shopifyWebhookId: context.webhookId },
    select: { id: true },
  });

  if (existing) {
    return { status: "duplicate", eventId: existing.id };
  }

  const event = await db.webhookEvent.create({
    data: {
      shopifyWebhookId: context.webhookId,
      topic,
      shopDomain: context.shop,
      resourceId,
      payloadHash,
      status: "received",
    },
  });

  return { status: "received", eventId: event.id };
}

export async function processCustomerUpsert(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  const customerInfo = extractCustomerInfo(context.payload);
  if (!customerInfo.shopifyCustomerId) return "ignored";

  const customer = await ensureCustomerWallet(db, {
    shopDomain: context.shop,
    ...customerInfo,
  });

  if (!isCustomerCreateTopic(context.topic)) {
    return "processed";
  }

  const existingSignupBonus = await db.ledgerEntry.findFirst({
    where: {
      customerId: customer.id,
      type: "signup_bonus",
    },
    select: { id: true },
  });

  if (existingSignupBonus || confirmedBonDefaults.signupRewardPoints <= 0) {
    return "processed";
  }

  await db.$transaction(async (tx) => {
    const freshCustomer = await ensureCustomerWallet(tx, {
      shopDomain: context.shop,
      ...customerInfo,
    });
    if (!freshCustomer.wallet) return;

    await tx.wallet.update({
      where: { id: freshCustomer.wallet.id },
      data: {
        availablePoints: {
          increment: confirmedBonDefaults.signupRewardPoints,
        },
        lifetimeEarnedPoints: {
          increment: confirmedBonDefaults.signupRewardPoints,
        },
      },
    });

    await tx.ledgerEntry.create({
      data: {
        customerId: freshCustomer.id,
        walletId: freshCustomer.wallet.id,
        type: "signup_bonus",
        pointsDelta: confirmedBonDefaults.signupRewardPoints,
        currency: confirmedBonDefaults.currency,
        description: "Signup bonus points",
        metadata: {
          source: "customers/create webhook",
        },
      },
    });
  });

  return "processed";
}

export async function processCustomerDelete(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  const customerInfo = extractCustomerInfo(context.payload);
  if (!customerInfo.shopifyCustomerId) return "ignored";

  await db.loyaltyCustomer.updateMany({
    where: {
      shopDomain: context.shop,
      shopifyCustomerId: customerInfo.shopifyCustomerId,
    },
    data: {
      email: null,
      phone: null,
      firstName: null,
      lastName: null,
      status: "anonymized",
    },
  });

  return "processed";
}

export async function processOrderPaid(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  const orderId = extractWebhookResourceId(context.payload);
  const discountCode = extractLoyaltyDiscountCode(context.payload);
  if (!orderId || !discountCode) return "ignored";

  const subtotal = extractMoney(context.payload, [
    "current_subtotal_price",
    "subtotal_price",
    "total_line_items_price",
  ]);
  const actualDiscountAmount = extractDiscountAmountForCode(
    context.payload,
    discountCode,
  );

  const session = await db.redemptionSession.findFirst({
    where: {
      discountCode,
      customer: { shopDomain: context.shop },
      status: { in: ["pending", "applied"] },
    },
    include: { customer: { include: { wallet: true } } },
  });

  if (!session?.customer.wallet) return "ignored";

  const pointsToConsume =
    session.pointsReserved - session.pointsConsumed - session.pointsReleased;
  if (pointsToConsume <= 0) return "processed";

  await db.$transaction(async (tx) => {
    await tx.wallet.update({
      where: { id: session.customer.wallet!.id },
      data: {
        pendingPoints: { decrement: pointsToConsume },
        lifetimeRedeemedPoints: { increment: pointsToConsume },
      },
    });

    await tx.redemptionSession.update({
      where: { id: session.id },
      data: {
        pointsConsumed: { increment: pointsToConsume },
        actualDiscountAmount: actualDiscountAmount ?? session.discountAmount,
        shopifyOrderId: orderId,
        status: "consumed",
      },
    });

    await tx.ledgerEntry.create({
      data: {
        customerId: session.customerId,
        walletId: session.customer.wallet!.id,
        redemptionSessionId: session.id,
        shopifyOrderId: orderId,
        type: "redeem_consume",
        pointsDelta: 0,
        moneyValue: actualDiscountAmount ?? session.discountAmount,
        currency: session.currency,
        description: "Consumed reserved points on paid order",
        metadata: {
          discountCode,
          orderSubtotal: subtotal,
        },
      },
    });
  });

  return "processed";
}

export async function processOrderFulfilled(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  if (confirmedBonDefaults.awardOnStatus !== "fulfilled") return "ignored";

  const orderId = extractWebhookResourceId(context.payload);
  const customerInfo = extractOrderCustomerInfo(context.payload);
  if (!orderId || !customerInfo.shopifyCustomerId) return "ignored";

  const existingEarn = await db.ledgerEntry.findFirst({
    where: {
      shopifyOrderId: orderId,
      type: "order_earn",
    },
    select: { id: true },
  });
  if (existingEarn) return "processed";

  const subtotal = extractMoney(context.payload, [
    "current_subtotal_price",
    "subtotal_price",
    "total_line_items_price",
  ]);
  const earnedPoints = calculateOrderEarnPoints(subtotal, confirmedBonDefaults);

  if (earnedPoints <= 0) return "ignored";

  await db.$transaction(async (tx) => {
    const customer = await ensureCustomerWallet(tx, {
      shopDomain: context.shop,
      ...customerInfo,
    });
    if (!customer.wallet) return;

    await tx.wallet.update({
      where: { id: customer.wallet.id },
      data: {
        availablePoints: { increment: earnedPoints },
        lifetimeEarnedPoints: { increment: earnedPoints },
      },
    });

    await tx.ledgerEntry.create({
      data: {
        customerId: customer.id,
        walletId: customer.wallet.id,
        shopifyOrderId: orderId,
        type: "order_earn",
        pointsDelta: earnedPoints,
        currency: confirmedBonDefaults.currency,
        description: "Earned points on fulfilled order",
        metadata: {
          orderSubtotal: subtotal,
          earningRule: "2 points per INR 100",
        },
      },
    });
  });

  return "processed";
}

export async function processOrderCancelled(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  const orderId = extractWebhookResourceId(context.payload);
  if (!orderId) return "ignored";

  await reverseEarnedPointsForOrder({
    db,
    orderId,
    pointsToReverse: Number.MAX_SAFE_INTEGER,
    ledgerType: "order_cancel_reversal",
    refundId: null,
    description: "Reversed earned points for cancelled order",
  });

  await returnRedeemedPointsForOrder({
    db,
    orderId,
    refundId: null,
    description: "Returned redeemed points for cancelled order",
    prorate: 1,
  });

  return "processed";
}

export async function processRefundCreated(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  const orderId = extractRefundOrderId(context.payload);
  const refundId = extractWebhookResourceId(context.payload);
  if (!orderId) return "ignored";

  const refundSubtotal = extractRefundSubtotal(context.payload);
  const pointsToReverse = calculateOrderEarnPoints(
    refundSubtotal,
    confirmedBonDefaults,
  );

  await reverseEarnedPointsForOrder({
    db,
    orderId,
    pointsToReverse,
    ledgerType: "refund_reversal",
    refundId,
    description: "Reversed earned points for refunded items",
  });

  const orderSubtotal = await findOrderSubtotalFromRedemption(db, orderId);
  if (orderSubtotal > 0 && refundSubtotal > 0) {
    await returnRedeemedPointsForOrder({
      db,
      orderId,
      refundId,
      description: "Returned redeemed points for refunded items",
      prorate: Math.min(1, refundSubtotal / orderSubtotal),
    });
  }

  return "processed";
}

export async function markWebhookProcessed(
  db: PrismaClient,
  eventId: string,
  status: "processed" | "ignored" | "failed",
  error?: unknown,
): Promise<void> {
  await db.webhookEvent.update({
    where: { id: eventId },
    data: {
      status,
      attemptCount: { increment: 1 },
      lastError: error instanceof Error ? error.message : null,
      processedAt: status === "failed" ? null : new Date(),
    },
  });
}

export function isCustomerCreateTopic(
  topic: string | number | symbol,
): boolean {
  const normalized = String(topic).toLowerCase().replace(/_/g, "/");
  return normalized === "customers/create";
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortObjectKeys(nestedValue)]),
    );
  }

  return value;
}

async function ensureCustomerWallet(
  db: PrismaClient | Prisma.TransactionClient,
  input: CustomerInfo & { shopDomain: string },
) {
  return db.loyaltyCustomer.upsert({
    where: {
      shopDomain_shopifyCustomerId: {
        shopDomain: input.shopDomain,
        shopifyCustomerId: input.shopifyCustomerId,
      },
    },
    create: {
      shopDomain: input.shopDomain,
      shopifyCustomerId: input.shopifyCustomerId,
      email: input.email,
      phone: input.phone,
      firstName: input.firstName,
      lastName: input.lastName,
      status: "active",
      wallet: { create: {} },
    },
    update: {
      email: input.email,
      phone: input.phone,
      firstName: input.firstName,
      lastName: input.lastName,
      status: "active",
      wallet: {
        upsert: {
          create: {},
          update: {},
        },
      },
    },
    include: { wallet: true },
  });
}

type CustomerInfo = {
  shopifyCustomerId: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

function extractCustomerInfo(payload: Record<string, unknown>): CustomerInfo {
  return {
    shopifyCustomerId:
      stringifyShopifyId(payload.id) ??
      extractNumericId(payload.admin_graphql_api_id) ??
      "",
    email: asString(payload.email),
    phone: asString(payload.phone),
    firstName: asString(payload.first_name),
    lastName: asString(payload.last_name),
  };
}

function extractOrderCustomerInfo(
  payload: Record<string, unknown>,
): CustomerInfo {
  const customer = asRecord(payload.customer);
  if (!customer) {
    return extractCustomerInfo(payload);
  }

  return {
    shopifyCustomerId:
      stringifyShopifyId(customer.id) ??
      extractNumericId(customer.admin_graphql_api_id) ??
      "",
    email: asString(customer.email) ?? asString(payload.email),
    phone: asString(customer.phone) ?? asString(payload.phone),
    firstName: asString(customer.first_name),
    lastName: asString(customer.last_name),
  };
}

function extractLoyaltyDiscountCode(
  payload: Record<string, unknown>,
): string | null {
  for (const code of extractDiscountCodes(payload)) {
    if (code.startsWith(LOYALTY_CODE_PREFIX)) return code;
  }

  return null;
}

function extractDiscountCodes(payload: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const discountCodes = asArray(payload.discount_codes);
  const discountApplications = asArray(payload.discount_applications);

  for (const discount of [...discountCodes, ...discountApplications]) {
    const record = asRecord(discount);
    const code = asString(record?.code) ?? asString(record?.title);
    if (code) candidates.push(code);
  }

  return candidates;
}

function extractDiscountAmountForCode(
  payload: Record<string, unknown>,
  code: string,
): number | null {
  for (const discount of asArray(payload.discount_codes)) {
    const record = asRecord(discount);
    if ((asString(record?.code) ?? "") === code) {
      return parseMoney(record?.amount);
    }
  }

  return null;
}

function extractRefundOrderId(payload: Record<string, unknown>): string | null {
  return (
    extractNumericId(payload.order_id) ??
    extractNumericId(payload.order?.valueOf()) ??
    extractNumericId(payload.admin_graphql_api_id)
  );
}

function extractRefundSubtotal(payload: Record<string, unknown>): number {
  return asArray(payload.refund_line_items).reduce<number>((sum, item) => {
    const record = asRecord(item);
    const subtotal =
      parseMoney(record?.subtotal) ||
      parseMoney(asRecord(record?.subtotal_set)?.shop_money?.valueOf()) ||
      parseMoney(asRecord(asRecord(record?.subtotal_set)?.shop_money)?.amount);
    return sum + subtotal;
  }, 0);
}

async function reverseEarnedPointsForOrder(input: {
  db: PrismaClient;
  orderId: string;
  pointsToReverse: number;
  ledgerType: "refund_reversal" | "order_cancel_reversal";
  refundId: string | null;
  description: string;
}): Promise<void> {
  if (input.pointsToReverse <= 0) return;

  const earnedEntries = await input.db.ledgerEntry.findMany({
    where: {
      shopifyOrderId: input.orderId,
      type: "order_earn",
    },
    include: { customer: { include: { wallet: true } } },
  });

  for (const earnedEntry of earnedEntries) {
    if (!earnedEntry.customer.wallet) continue;

    const previousReversals = await input.db.ledgerEntry.aggregate({
      where: {
        shopifyOrderId: input.orderId,
        type: { in: ["refund_reversal", "order_cancel_reversal"] },
        pointsDelta: { lt: 0 },
      },
      _sum: { pointsDelta: true },
    });
    const alreadyReversed = Math.abs(previousReversals._sum.pointsDelta ?? 0);
    const remainingEarned = Math.max(
      0,
      earnedEntry.pointsDelta - alreadyReversed,
    );
    const pointsToReverse = Math.min(remainingEarned, input.pointsToReverse);

    if (pointsToReverse <= 0) continue;

    await input.db.$transaction(async (tx) => {
      await tx.wallet.update({
        where: { id: earnedEntry.customer.wallet!.id },
        data: {
          availablePoints: { decrement: pointsToReverse },
          lifetimeEarnedPoints: { decrement: pointsToReverse },
        },
      });

      await tx.ledgerEntry.create({
        data: {
          customerId: earnedEntry.customerId,
          walletId: earnedEntry.walletId,
          shopifyOrderId: input.orderId,
          shopifyRefundId: input.refundId,
          type: input.ledgerType,
          pointsDelta: -pointsToReverse,
          currency: earnedEntry.currency,
          description: input.description,
          metadata: {
            originalLedgerEntryId: earnedEntry.id,
          },
        },
      });
    });
  }
}

async function returnRedeemedPointsForOrder(input: {
  db: PrismaClient;
  orderId: string;
  refundId: string | null;
  description: string;
  prorate: number;
}): Promise<void> {
  if (!confirmedBonDefaults.returnRedeemedPointsOnRefund) return;

  const sessions = await input.db.redemptionSession.findMany({
    where: {
      shopifyOrderId: input.orderId,
      status: { in: ["consumed", "partially_consumed"] },
    },
    include: { customer: { include: { wallet: true } } },
  });

  for (const session of sessions) {
    if (!session.customer.wallet) continue;

    const previousReturns = await input.db.ledgerEntry.aggregate({
      where: {
        redemptionSessionId: session.id,
        type: { in: ["refund_reversal", "order_cancel_reversal"] },
        pointsDelta: { gt: 0 },
      },
      _sum: { pointsDelta: true },
    });
    const alreadyReturned = previousReturns._sum.pointsDelta ?? 0;
    const pointsToReturn = Math.min(
      session.pointsConsumed - alreadyReturned,
      Math.floor(session.pointsConsumed * input.prorate),
    );

    if (pointsToReturn <= 0) continue;

    await input.db.$transaction(async (tx) => {
      await tx.wallet.update({
        where: { id: session.customer.wallet!.id },
        data: {
          availablePoints: { increment: pointsToReturn },
          lifetimeRedeemedPoints: { decrement: pointsToReturn },
        },
      });

      await tx.redemptionSession.update({
        where: { id: session.id },
        data: {
          pointsReleased: { increment: pointsToReturn },
          status:
            pointsToReturn + alreadyReturned >= session.pointsConsumed
              ? "released"
              : "partially_consumed",
        },
      });

      await tx.ledgerEntry.create({
        data: {
          customerId: session.customerId,
          walletId: session.customer.wallet!.id,
          redemptionSessionId: session.id,
          shopifyOrderId: input.orderId,
          shopifyRefundId: input.refundId,
          type: input.refundId ? "refund_reversal" : "order_cancel_reversal",
          pointsDelta: pointsToReturn,
          moneyValue: session.actualDiscountAmount ?? session.discountAmount,
          currency: session.currency,
          description: input.description,
        },
      });
    });
  }
}

async function findOrderSubtotalFromRedemption(
  db: PrismaClient,
  orderId: string,
): Promise<number> {
  const consumeEntry = await db.ledgerEntry.findFirst({
    where: {
      shopifyOrderId: orderId,
      type: "redeem_consume",
    },
    select: { metadata: true },
  });
  const metadata = asRecord(consumeEntry?.metadata);

  return parseMoney(metadata?.orderSubtotal);
}

function extractMoney(
  payload: Record<string, unknown>,
  fields: string[],
): number {
  for (const field of fields) {
    const value = parseMoney(payload[field]);
    if (value > 0) return value;
  }

  return 0;
}

function parseMoney(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const record = asRecord(value);
  if (record) return parseMoney(record.amount);

  return 0;
}

function stringifyShopifyId(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "string" && value.length > 0) {
    return extractNumericId(value) ?? value;
  }

  return null;
}

function extractNumericId(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  if (typeof value !== "string") return null;

  const match = value.match(/(\d+)$/);
  return match?.[1] ?? null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
