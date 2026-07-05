import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  applyEarnMultiplier,
  getEarnMultiplierContext,
} from "./multipliers";
import {
  reverseReferralForCancelledOrder,
  rewardReferralForOrder,
} from "./referrals";
import { calculateOrderEarnPoints } from "./rules";
import { getLoyaltyRuntimeSettings } from "./settings";

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

  try {
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
  } catch (error) {
    // Shopify delivers webhooks at-least-once and can send the same delivery
    // concurrently. Two requests can both pass the findUnique check above and
    // race into create; the loser hits the unique constraint (P2002). Treat it
    // as the duplicate it is instead of crashing with a 500 (which would make
    // Shopify retry and pollute the failure metrics).
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: string }).code === "P2002"
    ) {
      const winner = await db.webhookEvent.findUnique({
        where: { shopifyWebhookId: context.webhookId },
        select: { id: true },
      });
      if (winner) {
        return { status: "duplicate", eventId: winner.id };
      }
    }
    throw error;
  }
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
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: context.shop,
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

  if (
    existingSignupBonus ||
    !settings.earningEnabled ||
    settings.rules.signupRewardPoints <= 0
  ) {
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
          increment: settings.rules.signupRewardPoints,
        },
        lifetimeEarnedPoints: {
          increment: settings.rules.signupRewardPoints,
        },
      },
    });

    await tx.ledgerEntry.create({
      data: {
        customerId: freshCustomer.id,
        walletId: freshCustomer.wallet.id,
        type: "signup_bonus",
        pointsDelta: settings.rules.signupRewardPoints,
        currency: settings.rules.currency,
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
  if (!orderId) return "ignored";

  // Referral payout is independent of loyalty-discount consumption: any first
  // qualifying order by a referred customer triggers it (idempotent inside).
  await maybeRewardReferral(db, context, orderId);

  const discountCode = extractLoyaltyDiscountCode(context.payload);
  if (!discountCode) return "ignored";
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: context.shop,
  });

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

  const remainingReservedPoints =
    session.pointsReserved - session.pointsConsumed - session.pointsReleased;
  if (remainingReservedPoints <= 0) return "processed";

  const discountAmountUsed = Number(
    actualDiscountAmount ?? session.discountAmount,
  );
  // Catalog reward claims (percent off / free shipping / fixed reward) have a
  // fixed points price: consume the full reservation regardless of the rupee
  // value Shopify allocated to the code. Slider redemptions keep the pro-rated
  // consume (points = rupees actually discounted).
  const pointsToConsume = session.rewardType
    ? remainingReservedPoints
    : Math.min(
        remainingReservedPoints,
        Math.floor(discountAmountUsed / settings.rules.currencyValuePerPoint),
      );
  const pointsToRelease = remainingReservedPoints - pointsToConsume;

  await db.$transaction(async (tx) => {
    await tx.wallet.update({
      where: { id: session.customer.wallet!.id },
      data: {
        ...(pointsToRelease > 0
          ? { availablePoints: { increment: pointsToRelease } }
          : {}),
        pendingPoints: { decrement: remainingReservedPoints },
        lifetimeRedeemedPoints: { increment: pointsToConsume },
      },
    });

    await tx.redemptionSession.update({
      where: { id: session.id },
      data: {
        pointsConsumed: { increment: pointsToConsume },
        pointsReleased: { increment: pointsToRelease },
        actualDiscountAmount: discountAmountUsed,
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
        moneyValue: discountAmountUsed,
        currency: session.currency,
        description: "Consumed reserved points on paid order",
        metadata: {
          discountCode,
          orderSubtotal: subtotal,
        },
      },
    });

    if (pointsToRelease > 0) {
      await tx.ledgerEntry.create({
        data: {
          customerId: session.customerId,
          walletId: session.customer.wallet!.id,
          redemptionSessionId: session.id,
          shopifyOrderId: orderId,
          type: "redeem_release",
          pointsDelta: pointsToRelease,
          moneyValue: pointsToRelease * settings.rules.currencyValuePerPoint,
          currency: session.currency,
          description:
            "Released unused reserved points after paid order discount allocation",
          metadata: {
            discountCode,
            orderSubtotal: subtotal,
            discountAmountUsed,
          },
        },
      });
    }
  });

  return "processed";
}

export async function processOrderFulfilled(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: context.shop,
  });
  if (!settings.earningEnabled || settings.rules.awardOnStatus !== "fulfilled") {
    return "ignored";
  }

  return awardOrderEarn(db, context, settings);
}

/**
 * Awards order earn from an ORDER-shaped payload once the caller has verified
 * the configured award trigger (fulfilled webhook, or a carrier "delivered"
 * fulfillment event). Idempotent via the per-order existingEarn check.
 */
export async function awardOrderEarn(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
  settings: Awaited<ReturnType<typeof getLoyaltyRuntimeSettings>>,
): Promise<"processed" | "ignored"> {
  const orderId = extractWebhookResourceId(context.payload);
  const customerInfo = extractOrderCustomerInfo(context.payload);
  if (!orderId || !customerInfo.shopifyCustomerId) return "ignored";

  await maybeRewardReferral(db, context, orderId);

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
  const basePoints = calculateOrderEarnPoints(subtotal, settings.rules);

  if (basePoints <= 0) return "ignored";

  // VIP tier + limited-time campaign multipliers. Ensure the wallet exists
  // first (idempotent upsert) so the tier is derived from the real lifetime
  // total.
  const existingCustomer = await ensureCustomerWallet(db, {
    shopDomain: context.shop,
    ...customerInfo,
  });
  const multiplierContext = await getEarnMultiplierContext({
    db,
    shopDomain: context.shop,
    lifetimeEarnedPoints: existingCustomer.wallet?.lifetimeEarnedPoints ?? 0,
  });
  const earnedPoints = applyEarnMultiplier(
    basePoints,
    multiplierContext.totalMultiplier,
  );
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
        currency: settings.rules.currency,
        description: "Earned points on fulfilled order",
        metadata: {
          orderSubtotal: subtotal,
          earningRule: `${settings.rules.pointsPerSpendAmount} points per INR ${settings.rules.spendAmountForEarnPoints}`,
          ...(multiplierContext.totalMultiplier !== 1
            ? {
                basePoints,
                vipTier: multiplierContext.currentTier?.name ?? null,
                vipMultiplier: multiplierContext.vipMultiplier,
                campaign: multiplierContext.campaign?.title ?? null,
                campaignMultiplier: multiplierContext.campaignMultiplier,
              }
            : {}),
        },
      },
    });
  });

  // Milestones ride on the same trigger as order earn; failures must never
  // fail the webhook (the earn itself has already landed).
  if (existingCustomer.wallet) {
    await evaluateOrderMilestones(
      db,
      settings,
      { id: existingCustomer.id, walletId: existingCustomer.wallet.id },
      orderId,
      subtotal,
    ).catch(() => {});
  }

  return "processed";
}

/**
 * Award earn once a carrier reports the shipment DELIVERED (payload must be an
 * ORDER payload; the route/replay verifies the delivered signal first). Used
 * when awardOnStatus === "delivered" — the safest mode for COD/RTO markets:
 * rejected-at-doorstep shipments simply never earn.
 */
export async function processOrderDelivered(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: context.shop,
  });
  if (!settings.earningEnabled || settings.rules.awardOnStatus !== "delivered") {
    return "ignored";
  }
  return awardOrderEarn(db, context, settings);
}

// Extend a reservation for the lifetime of a real order. Without this, a COD
// order's reservation (60-minute TTL) would expire before payment/delivery and
// the expiry self-heal would hand the points back even though the customer
// keeps the discount. Runs on orders/create: pins the session to the order and
// pushes expiry out; if the self-heal already released it (slow checkout),
// re-reserves the points so the books stay honest.
const ORDER_RESERVATION_TTL_DAYS = 45;

export async function processOrderCreated(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  const orderId = extractWebhookResourceId(context.payload);
  const discountCode = extractLoyaltyDiscountCode(context.payload);
  if (!orderId || !discountCode) return "ignored";

  const session = await db.redemptionSession.findUnique({
    where: { discountCode },
    include: { customer: { include: { wallet: true } } },
  });
  if (!session?.customer.wallet) return "ignored";

  const pinnedExpiry = new Date(
    Date.now() + ORDER_RESERVATION_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  if (session.status === "pending" || session.status === "applied") {
    await db.redemptionSession.update({
      where: { id: session.id },
      data: { shopifyOrderId: orderId, expiresAt: pinnedExpiry },
    });
    return "processed";
  }

  if (session.status === "released") {
    // The hold was released (expiry self-heal / manual) but the code was still
    // accepted at checkout. Re-reserve so the discount isn't a free ride.
    const amount = session.pointsReserved;
    const reclaimed = await db.wallet.updateMany({
      where: {
        id: session.customer.wallet.id,
        availablePoints: { gte: amount },
      },
      data: {
        availablePoints: { decrement: amount },
        pendingPoints: { increment: amount },
      },
    });

    if (reclaimed.count === 1) {
      await db.$transaction([
        db.redemptionSession.update({
          where: { id: session.id },
          data: {
            status: "applied",
            shopifyOrderId: orderId,
            expiresAt: pinnedExpiry,
            pointsReleased: { decrement: amount },
          },
        }),
        db.ledgerEntry.create({
          data: {
            customerId: session.customerId,
            walletId: session.customer.wallet.id,
            redemptionSessionId: session.id,
            shopifyOrderId: orderId,
            type: "redeem_reserve",
            pointsDelta: -amount,
            moneyValue: session.discountAmount,
            currency: session.currency,
            description:
              "Re-reserved points: released hold was used on a placed order",
          },
        }),
      ]);
    } else {
      // Balance already spent elsewhere — flag for the merchant instead of
      // driving the wallet negative.
      await db.redemptionSession.update({
        where: { id: session.id },
        data: { status: "manual_review", shopifyOrderId: orderId },
      });
    }
    return "processed";
  }

  return "processed";
}

export async function processOrderCancelled(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
): Promise<"processed" | "ignored"> {
  const orderId = extractWebhookResourceId(context.payload);
  if (!orderId) return "ignored";
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: context.shop,
  });

  // Unpaid orders (typical rejected COD): the reservation was never consumed.
  // Release it so the points go straight back to the customer.
  const unconsumedSessions = await db.redemptionSession.findMany({
    where: {
      shopifyOrderId: orderId,
      status: { in: ["pending", "applied"] },
    },
    include: { customer: { include: { wallet: true } } },
  });
  for (const session of unconsumedSessions) {
    const points =
      session.pointsReserved - session.pointsConsumed - session.pointsReleased;
    if (points <= 0 || !session.customer.wallet) continue;
    await db.$transaction([
      db.wallet.update({
        where: { id: session.customer.wallet.id },
        data: {
          availablePoints: { increment: points },
          pendingPoints: { decrement: points },
        },
      }),
      db.redemptionSession.update({
        where: { id: session.id },
        data: { status: "released", pointsReleased: { increment: points } },
      }),
      db.ledgerEntry.create({
        data: {
          customerId: session.customerId,
          walletId: session.customer.wallet.id,
          redemptionSessionId: session.id,
          shopifyOrderId: orderId,
          type: "redeem_release",
          pointsDelta: points,
          moneyValue: session.discountAmount,
          currency: session.currency,
          description: "Returned reserved points for cancelled order",
        },
      }),
    ]);
  }

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
    returnRedeemedPointsOnRefund: settings.rules.returnRedeemedPointsOnRefund,
  });

  // If this order triggered a referral payout, claw it back (fraud guard:
  // refer-a-friend + reject-the-first-order must not farm points).
  await reverseReferralForCancelledOrder({
    db,
    shopDomain: context.shop,
    orderId,
  }).catch(() => {});

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
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: context.shop,
  });

  // Reverse in proportion to what was ACTUALLY earned on this order (which may
  // include VIP/campaign multipliers), not the base earn rate — otherwise a
  // partial refund of a 2x-campaign order would under-reverse. Falls back to
  // the base-rate estimate when the earn entry has no recorded subtotal.
  const earnEntry = await db.ledgerEntry.findFirst({
    where: { shopifyOrderId: orderId, type: "order_earn" },
    select: { pointsDelta: true, metadata: true },
  });
  const earnedOrderSubtotal = Number(
    (earnEntry?.metadata as { orderSubtotal?: unknown } | null)
      ?.orderSubtotal ?? 0,
  );
  const pointsToReverse =
    earnEntry && earnedOrderSubtotal > 0 && refundSubtotal > 0
      ? Math.min(
          earnEntry.pointsDelta,
          Math.round(
            (earnEntry.pointsDelta * refundSubtotal) / earnedOrderSubtotal,
          ),
        )
      : calculateOrderEarnPoints(refundSubtotal, settings.rules);

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
      returnRedeemedPointsOnRefund: settings.rules.returnRedeemedPointsOnRefund,
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

/**
 * Awards configured milestone rules when an order lands. Runs once per new
 * earned order (right after the order_earn ledger entry is written), so
 * crossing checks are naturally idempotent:
 * - first_order: on the customer's first earned order
 * - order_count: when the order count crosses the threshold (repeatable:
 *   every multiple of the threshold)
 * - spend_amount: when cumulative earned-order spend crosses the threshold
 *   (repeatable: every multiple)
 * signup is covered by the signup bonus; birthday needs a stored DOB and is
 * not automated yet.
 */
async function evaluateOrderMilestones(
  db: PrismaClient,
  settings: Awaited<ReturnType<typeof getLoyaltyRuntimeSettings>>,
  customer: { id: string; walletId: string },
  orderId: string,
  orderSubtotal: number,
): Promise<void> {
  const rules = settings.milestones.filter(
    (rule) =>
      rule.enabled &&
      rule.points > 0 &&
      ["first_order", "order_count", "spend_amount"].includes(rule.type),
  );
  if (rules.length === 0) return;

  // Counts INCLUDE the order that was just awarded.
  const earnEntries = await db.ledgerEntry.findMany({
    where: { customerId: customer.id, type: "order_earn" },
    select: { metadata: true },
    take: 500,
  });
  const orderCount = earnEntries.length;
  const previousCount = Math.max(0, orderCount - 1);
  const totalSpend = earnEntries.reduce((sum, entry) => {
    const metadata = entry.metadata as { orderSubtotal?: unknown } | null;
    const value = Number(metadata?.orderSubtotal ?? 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  const previousSpend = Math.max(0, totalSpend - orderSubtotal);

  for (const rule of rules) {
    let crossings = 0;

    if (rule.type === "first_order") {
      crossings = orderCount === 1 ? 1 : 0;
    } else if (rule.type === "order_count") {
      const threshold = rule.thresholdOrderCount ?? 0;
      if (threshold > 0) {
        crossings = rule.repeatable
          ? Math.floor(orderCount / threshold) -
            Math.floor(previousCount / threshold)
          : previousCount < threshold && orderCount >= threshold
            ? 1
            : 0;
      }
    } else if (rule.type === "spend_amount") {
      const threshold = Number(rule.thresholdAmount ?? 0);
      if (threshold > 0) {
        crossings = rule.repeatable
          ? Math.floor(totalSpend / threshold) -
            Math.floor(previousSpend / threshold)
          : previousSpend < threshold && totalSpend >= threshold
            ? 1
            : 0;
      }
    }
    if (crossings <= 0) continue;

    // Once-guard for non-repeatable rules (safety on top of the crossing math).
    if (!rule.repeatable) {
      const alreadyAwarded = await db.ledgerEntry.findFirst({
        where: {
          customerId: customer.id,
          metadata: { path: ["milestoneId"], equals: rule.id },
        },
        select: { id: true },
      });
      if (alreadyAwarded) continue;
      crossings = 1;
    }

    const points = rule.points * crossings;
    await db.$transaction([
      db.wallet.update({
        where: { id: customer.walletId },
        data: {
          availablePoints: { increment: points },
          lifetimeEarnedPoints: { increment: points },
        },
      }),
      db.ledgerEntry.create({
        data: {
          customerId: customer.id,
          walletId: customer.walletId,
          shopifyOrderId: orderId,
          type: "manual_adjustment",
          pointsDelta: points,
          currency: settings.rules.currency,
          description: `Milestone reward: ${rule.title}`,
          metadata: {
            milestoneId: rule.id,
            milestoneType: rule.type,
            crossings,
          },
        },
      }),
    ]);
  }
}

async function maybeRewardReferral(
  db: PrismaClient,
  context: LoyaltyWebhookContext,
  orderId: string,
): Promise<void> {
  try {
    const customerInfo = extractOrderCustomerInfo(context.payload);
    if (!customerInfo.shopifyCustomerId) return;

    const customer = await db.loyaltyCustomer.findUnique({
      where: {
        shopDomain_shopifyCustomerId: {
          shopDomain: context.shop,
          shopifyCustomerId: customerInfo.shopifyCustomerId,
        },
      },
      select: { id: true },
    });
    if (!customer) return;

    const subtotal = extractMoney(context.payload, [
      "current_subtotal_price",
      "subtotal_price",
      "total_line_items_price",
    ]);

    await rewardReferralForOrder({
      db,
      shopDomain: context.shop,
      refereeCustomerId: customer.id,
      orderId,
      orderSubtotal: subtotal,
    });
  } catch {
    // Referral payout must never fail the webhook; a missed payout stays
    // pending and is retried by the next order webhook for the same order.
  }
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
  returnRedeemedPointsOnRefund: boolean;
}): Promise<void> {
  if (!input.returnRedeemedPointsOnRefund) return;

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
