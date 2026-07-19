import type { Prisma, PrismaClient } from "@prisma/client";
import type { RazorpayGateway } from "./razorpay";
import { notifyBoth } from "./notifications";
import { quoteRenewalGroup } from "./renewals";
import { nextOccurrence } from "./schedule";
import type { ShopifyGraphql } from "./shopify";
import type { Address, IntervalCode } from "./types";
import { createPortalToken } from "./portal";

const DAY = 86_400_000;

export async function markPaymentFailed(input: {
  db: PrismaClient;
  razorpayOrderId: string;
  paymentId?: string;
  reason?: string;
  now?: Date;
}) {
  const attempt = await input.db.paymentAttempt.findUnique({
    where: { externalOrderId: input.razorpayOrderId },
  });
  const cycle = await input.db.billingCycle.findFirst({
    where: attempt ? { id: attempt.billingCycleId } : { razorpayOrderId: input.razorpayOrderId },
    include: { group: true },
  });
  if (!cycle) throw new Error("Unknown failed subscription payment");
  if (cycle.shopifyOrderId || cycle.razorpayOrderId !== input.razorpayOrderId || cycle.status !== "payment_pending") {
    return cycle;
  }
  await input.db.$transaction([
    input.db.billingCycle.update({
      where: { id: cycle.id },
      data: { status: "failed", failureMessage: input.reason, razorpayPaymentId: input.paymentId },
    }),
    input.db.subscriptionGroup.update({ where: { id: cycle.group.id }, data: { status: "halted" } }),
    ...(attempt ? [input.db.paymentAttempt.update({
      where: { id: attempt.id }, data: { status: "failed", reason: input.reason },
    })] : []),
  ]);
  await notifyBoth({
    db: input.db,
    shopDomain: cycle.group.shopDomain,
    email: cycle.group.customerEmail,
    phone: cycle.group.customerPhone,
    template: "subscription_payment_failed",
    idempotencyKey: `cycle:${cycle.id}:failure:1`,
    variables: { groupId: cycle.group.id, reason: input.reason ?? "Payment failed" },
  });
  return cycle;
}

export async function runDunning(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  graphqlForShop: (shop: string) => Promise<ShopifyGraphql>;
  now?: Date;
  limit?: number;
}) {
  const now = input.now ?? new Date();
  const cycles = await input.db.billingCycle.findMany({
    where: { status: "failed", group: { status: "halted" } },
    include: {
      group: {
        include: {
          lines: { where: { status: "active" } },
          pricingPolicy: { include: { tiers: true } },
        },
      },
      paymentAttempts: { orderBy: { attemptedAt: "asc" } },
    },
    take: input.limit ?? 50,
  });
  const results = [];
  for (const cycle of cycles) {
    const settings = await input.db.subscriptionSettings.findUniqueOrThrow({
      where: { shopDomain: cycle.group.shopDomain },
    });
    const first = cycle.paymentAttempts[0]?.attemptedAt ?? cycle.createdAt;
    const ageDays = Math.floor((now.getTime() - first.getTime()) / DAY);
    if (ageDays >= settings.autoCancelDays) {
      if (cycle.group.razorpayTokenId) await input.razorpay.cancelToken(cycle.group.razorpayTokenId);
      await input.db.subscriptionGroup.update({
        where: { id: cycle.group.id }, data: { status: "cancelled", cancelledAt: now },
      });
      await notifyBoth({
        db: input.db, shopDomain: cycle.group.shopDomain,
        email: cycle.group.customerEmail, phone: cycle.group.customerPhone,
        template: "subscription_auto_cancelled",
        idempotencyKey: `cycle:${cycle.id}:auto-cancel`, variables: { groupId: cycle.group.id },
      });
      results.push({ cycleId: cycle.id, status: "cancelled" });
      continue;
    }
    const attemptCount = cycle.paymentAttempts.length;
    const retryDue = (attemptCount === 1 && ageDays >= settings.retryDay3) ||
      (attemptCount === 2 && ageDays >= settings.retryDay7);
    if (!retryDue || !cycle.group.razorpayCustomerId || !cycle.group.razorpayTokenId) continue;

    // A retry is a new debit decision. Re-read Shopify price, tax and inventory so
    // the customer is never charged from a stale failed-attempt snapshot.
    const graphql = await input.graphqlForShop(cycle.group.shopDomain);
    const quote = await quoteRenewalGroup(
      graphql,
      cycle.group.lines,
      cycle.group.pricingPolicy,
      settings,
      cycle.group.shopifyCustomerId,
      cycle.group.addressJson as unknown as Address,
    );
    if (quote.status === "skipped_oos") {
      await input.db.$transaction([
        input.db.billingCycle.update({
          where: { id: cycle.id },
          data: {
            status: "skipped_oos", chargeAmountPaise: 0, shippingPaise: 0,
            tierBonusBps: quote.tierBonusBps,
            lineSnapshot: quote as unknown as Prisma.InputJsonValue,
          },
        }),
        input.db.subscriptionGroup.update({
          where: { id: cycle.group.id },
          data: {
            status: "active",
            nextChargeAt: nextOccurrence(cycle.group.nextChargeAt!, cycle.group.intervalCode as IntervalCode),
          },
        }),
      ]);
      await notifyBoth({
        db: input.db, shopDomain: cycle.group.shopDomain,
        email: cycle.group.customerEmail, phone: cycle.group.customerPhone,
        template: "subscription_skipped_out_of_stock",
        idempotencyKey: `cycle:${cycle.id}:retry-stockout`,
        variables: { groupId: cycle.group.id, charged: false },
      });
      results.push({ cycleId: cycle.id, status: "skipped_oos" });
      continue;
    }
    if (!cycle.group.mandateMaxPaise || quote.chargeAmountPaise > cycle.group.mandateMaxPaise || quote.chargeAmountPaise > 1_500_000) {
      await input.db.$transaction([
        input.db.billingCycle.update({
          where: { id: cycle.id },
          data: {
            status: "reauthorization_required", chargeAmountPaise: quote.chargeAmountPaise,
            shippingPaise: quote.shippingPaise, tierBonusBps: quote.tierBonusBps,
            lineSnapshot: quote as unknown as Prisma.InputJsonValue,
          },
        }),
        input.db.subscriptionGroup.update({
          where: { id: cycle.group.id }, data: { status: "reauthorization_required" },
        }),
      ]);
      const token = createPortalToken({
        shopDomain: cycle.group.shopDomain, groupId: cycle.group.id, ttlMinutes: 7 * 24 * 60,
      });
      await notifyBoth({
        db: input.db, shopDomain: cycle.group.shopDomain,
        email: cycle.group.customerEmail, phone: cycle.group.customerPhone,
        template: "subscription_reauthorization_required",
        idempotencyKey: `cycle:${cycle.id}:retry-reauthorization`,
        variables: {
          groupId: cycle.group.id,
          reason: "amount_above_mandate_maximum",
          reauthorizationUrl: `https://${cycle.group.shopDomain}/apps/subscriptions/reauthorize?token=${encodeURIComponent(token)}`,
        },
      });
      results.push({ cycleId: cycle.id, status: "reauthorization_required" });
      continue;
    }
    const payment = await input.razorpay.createRecurringPayment({
      customerId: cycle.group.razorpayCustomerId,
      tokenId: cycle.group.razorpayTokenId,
      amountPaise: quote.chargeAmountPaise,
      receipt: `retry-${cycle.id}-${attemptCount + 1}`,
      email: cycle.group.customerEmail,
      contact: cycle.group.customerPhone,
      groupId: cycle.group.id,
      cycleId: cycle.id,
    });
    await input.db.$transaction([
      input.db.billingCycle.update({
        where: { id: cycle.id },
        data: {
          status: "payment_pending", razorpayOrderId: payment.orderId,
          razorpayPaymentId: payment.paymentId, chargeAmountPaise: quote.chargeAmountPaise,
          shippingPaise: quote.shippingPaise, tierBonusBps: quote.tierBonusBps,
          lineSnapshot: quote as unknown as Prisma.InputJsonValue,
        },
      }),
      input.db.paymentAttempt.create({
        data: {
          billingCycleId: cycle.id, externalOrderId: payment.orderId,
          externalPaymentId: payment.paymentId, status: payment.status,
        },
      }),
    ]);
    results.push({ cycleId: cycle.id, status: "payment_pending" });
  }
  return results;
}
