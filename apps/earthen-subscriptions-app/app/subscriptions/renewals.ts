import type { Prisma, PrismaClient } from "@prisma/client";
import { computeRenewalQuote, type RenewalQuote } from "./pricing";
import type { RazorpayGateway } from "./razorpay";
import { nextOccurrence } from "./schedule";
import {
  createShopifyRenewalOrder,
  calculateRenewalTaxes,
  fetchVariantSnapshots,
  type ShopifyGraphql,
} from "./shopify";
import type { Address, IntervalCode, RenewalLineInput } from "./types";
import { notifyBoth, sendNotification } from "./notifications";
import { createPortalToken } from "./portal";

export async function runDueRenewals(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  graphqlForShop: (shop: string) => Promise<ShopifyGraphql>;
  now?: Date;
  limit?: number;
}) {
  const now = input.now ?? new Date();
  const enabledShops = await input.db.subscriptionSettings.findMany({
    where: { schedulerEnabled: true }, select: { shopDomain: true },
  });
  const groups = await input.db.subscriptionGroup.findMany({
    where: { shopDomain: { in: enabledShops.map((item) => item.shopDomain) }, status: "active", nextChargeAt: { lte: now }, endAt: { gt: now } },
    orderBy: { nextChargeAt: "asc" },
    take: input.limit ?? 50,
  });
  const results: Array<{ groupId: string; status: string; error?: string }> = [];
  for (const group of groups) {
    try {
      const graphql = await input.graphqlForShop(group.shopDomain);
      const result = await prepareRenewal({
        db: input.db, razorpay: input.razorpay, graphql, groupId: group.id, now,
      });
      results.push({ groupId: group.id, status: result.status });
    } catch (error) {
      results.push({
        groupId: group.id,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown renewal error",
      });
    }
  }
  return results;
}

export async function prepareRenewal(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  graphql: ShopifyGraphql;
  groupId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const group = await input.db.subscriptionGroup.findUniqueOrThrow({
    where: { id: input.groupId },
    include: {
      lines: { where: { status: "active" } },
      pricingPolicy: { include: { tiers: true } },
      cycles: { orderBy: { seq: "desc" }, take: 1 },
    },
  });
  if (group.status !== "active" || !group.nextChargeAt || group.nextChargeAt > now) {
    return { status: "not_due" };
  }
  // A cycle-end cancellation wins over a renewal job that reaches the same due
  // group first. This prevents a final unintended debit caused by scheduler races.
  if (group.cancelAtCycleEnd) {
    if (group.razorpayTokenId) await input.razorpay.cancelToken(group.razorpayTokenId);
    await input.db.subscriptionGroup.update({
      where: { id: group.id },
      data: { status: "cancelled", cancelledAt: now, nextChargeAt: null },
    });
    return { status: "cancelled" };
  }
  if (!group.razorpayCustomerId || !group.razorpayTokenId || !group.mandateMaxPaise) {
    await input.db.subscriptionGroup.update({
      where: { id: group.id }, data: { status: "reauthorization_required" },
    });
    await sendReauthorizationNotice(input.db, group, "missing_or_invalid_mandate");
    return { status: "reauthorization_required" };
  }
  const seq = (group.cycles[0]?.seq ?? 0) + 1;
  let cycle;
  try {
    cycle = await input.db.billingCycle.create({
      data: {
        subscriptionGroupId: group.id,
        seq,
        status: "preparing",
        scheduledAt: group.nextChargeAt,
        qualificationQuantity: group.lines.reduce((sum, line) => sum + line.quantity, 0),
        baseDiscountBps: group.pricingPolicy.baseDiscountBps,
        tierBonusBps: 0,
        claimedAt: now,
      },
    });
  } catch {
    const existing = await input.db.billingCycle.findUniqueOrThrow({
      where: { subscriptionGroupId_seq: { subscriptionGroupId: group.id, seq } },
    });
    return { status: existing.status, cycle: existing };
  }

  const settings = await input.db.subscriptionSettings.findUniqueOrThrow({
    where: { shopDomain: group.shopDomain },
  });
  const quote = await quoteRenewalGroup(
    input.graphql,
    group.lines,
    group.pricingPolicy,
    settings,
    group.shopifyCustomerId,
    group.addressJson as unknown as Address,
  );
  const nextChargeAt = nextOccurrence(group.nextChargeAt, group.intervalCode as IntervalCode);
  if (quote.status === "skipped_oos") {
    await input.db.$transaction([
      input.db.billingCycle.update({
        where: { id: cycle.id },
        data: {
          status: "skipped_oos",
          tierBonusBps: quote.tierBonusBps,
          chargeAmountPaise: 0,
          shippingPaise: 0,
          lineSnapshot: quote as unknown as Prisma.InputJsonValue,
        },
      }),
      input.db.subscriptionGroup.update({ where: { id: group.id }, data: { nextChargeAt } }),
    ]);
    await notifyBoth({
      db: input.db, shopDomain: group.shopDomain,
      email: group.customerEmail, phone: group.customerPhone,
      template: "subscription_skipped_out_of_stock",
      idempotencyKey: `cycle:${cycle.id}:stockout`,
      variables: { groupId: group.id, nextChargeAt: nextChargeAt.toISOString(), charged: false },
    });
    return { status: "skipped_oos", cycleId: cycle.id };
  }
  if (quote.chargeAmountPaise > group.mandateMaxPaise || quote.chargeAmountPaise > 1_500_000) {
    await input.db.$transaction([
      input.db.billingCycle.update({
        where: { id: cycle.id },
        data: {
          status: "reauthorization_required",
          chargeAmountPaise: quote.chargeAmountPaise,
          shippingPaise: quote.shippingPaise,
          tierBonusBps: quote.tierBonusBps,
          lineSnapshot: quote as unknown as Prisma.InputJsonValue,
        },
      }),
      input.db.subscriptionGroup.update({
        where: { id: group.id }, data: { status: "reauthorization_required" },
      }),
    ]);
    await sendReauthorizationNotice(input.db, group, "amount_above_mandate_maximum");
    return { status: "reauthorization_required", cycleId: cycle.id };
  }

  await notifyBoth({
    db: input.db, shopDomain: group.shopDomain,
    email: group.customerEmail, phone: group.customerPhone,
    template: "subscription_pre_renewal",
    idempotencyKey: `cycle:${cycle.id}:pre-renewal`,
    variables: { groupId: group.id, amountPaise: quote.chargeAmountPaise, scheduledAt: cycle.scheduledAt.toISOString() },
  });
  const payment = await input.razorpay.createRecurringPayment({
    customerId: group.razorpayCustomerId,
    tokenId: group.razorpayTokenId,
    amountPaise: quote.chargeAmountPaise,
    receipt: `sub-${group.id}-${seq}`,
    email: group.customerEmail,
    contact: group.customerPhone,
    groupId: group.id,
    cycleId: cycle.id,
  });
  await input.db.$transaction([
    input.db.billingCycle.update({
      where: { id: cycle.id },
      data: {
        status: "payment_pending",
        chargeAmountPaise: quote.chargeAmountPaise,
        shippingPaise: quote.shippingPaise,
        tierBonusBps: quote.tierBonusBps,
        lineSnapshot: quote as unknown as Prisma.InputJsonValue,
        razorpayOrderId: payment.orderId,
        razorpayPaymentId: payment.paymentId,
      },
    }),
    input.db.paymentAttempt.create({
      data: {
        billingCycleId: cycle.id,
        externalPaymentId: payment.paymentId,
        externalOrderId: payment.orderId,
        status: payment.status,
      },
    }),
  ]);
  return { status: "payment_pending", cycleId: cycle.id };
}

export async function finalizeCapturedCycle(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  graphql: ShopifyGraphql;
  razorpayOrderId: string;
  paymentId: string;
  now?: Date;
}) {
  const attempt = await input.db.paymentAttempt.findUnique({
    where: { externalOrderId: input.razorpayOrderId }, select: { billingCycleId: true },
  });
  const cycle = await input.db.billingCycle.findFirst({
    where: attempt ? { id: attempt.billingCycleId } : { razorpayOrderId: input.razorpayOrderId },
    include: {
      group: {
        include: {
          lines: { where: { status: "active" } },
          pricingPolicy: { include: { tiers: true } },
        },
      },
    },
  });
  if (!cycle) throw new Error("Unknown Razorpay renewal order");
  if (cycle.shopifyOrderId) return { status: cycle.status, shopifyOrderId: cycle.shopifyOrderId };
  const claimed = await input.db.billingCycle.updateMany({
    where: { id: cycle.id, status: { in: ["payment_pending", "failed"] } },
    data: { status: "order_creating", razorpayPaymentId: input.paymentId },
  });
  if (claimed.count === 0) return { status: cycle.status };
  const settings = await input.db.subscriptionSettings.findUniqueOrThrow({
    where: { shopDomain: cycle.group.shopDomain },
  });
  const quote = await quoteRenewalGroup(
    input.graphql,
    cycle.group.lines,
    cycle.group.pricingPolicy,
    settings,
    cycle.group.shopifyCustomerId,
    cycle.group.addressJson as unknown as Address,
  );
  const captured = cycle.chargeAmountPaise ?? 0;
  if (quote.status === "skipped_oos") {
    await input.razorpay.refundPayment(input.paymentId);
    await advanceAfterCycle(input.db, cycle.group.id, cycle.group.nextChargeAt!, cycle.group.intervalCode, cycle.id, {
      status: "refunded_oos", failureMessage: "Inventory unavailable after payment capture",
    });
    return { status: "refunded_oos" };
  }
  if (quote.chargeAmountPaise < captured) {
    await input.razorpay.refundPayment(input.paymentId, captured - quote.chargeAmountPaise);
  } else if (quote.chargeAmountPaise > captured) {
    // Never charge more after the pre-debit amount. Scale to the original snapshot.
    throw new Error("Inventory/price recomputation exceeds captured amount; manual review required");
  }
  try {
    const order = await createShopifyRenewalOrder({
      graphql: input.graphql,
      groupId: cycle.group.id,
      cycleId: cycle.id,
      cycleSeq: cycle.seq,
      customerId: cycle.group.shopifyCustomerId,
      email: cycle.group.customerEmail,
      phone: cycle.group.customerPhone,
      address: cycle.group.addressJson as unknown as Address,
      paymentId: input.paymentId,
      quote,
    });
    const partial = quote.lines.some((line) => line.unavailableQuantity > 0);
    await advanceAfterCycle(
      input.db,
      cycle.group.id,
      cycle.group.nextChargeAt!,
      cycle.group.intervalCode,
      cycle.id,
      {
        status: partial ? "partially_skipped" : "order_created",
        shopifyOrderId: order.id,
        chargeAmountPaise: quote.chargeAmountPaise,
        shippingPaise: quote.shippingPaise,
        lineSnapshot: quote as unknown as Prisma.InputJsonValue,
      },
      quote.lines.map((line) => ({
        id: line.subscriptionLineId,
        unitPricePaise: line.currentUnitPricePaise,
      })),
    );
    if (partial) await notifyBoth({
      db: input.db, shopDomain: cycle.group.shopDomain,
      email: cycle.group.customerEmail, phone: cycle.group.customerPhone,
      template: "subscription_partially_shipped",
      idempotencyKey: `cycle:${cycle.id}:partial-stockout`,
      variables: { groupId: cycle.group.id, chargedPaise: quote.chargeAmountPaise },
    });
    if (!partial && settings.successfulRenewalWhatsapp && cycle.group.customerPhone) {
      await sendNotification({
        db: input.db,
        shopDomain: cycle.group.shopDomain,
        channel: "whatsapp",
        recipient: cycle.group.customerPhone,
        template: "subscription_renewal_successful",
        idempotencyKey: `cycle:${cycle.id}:success:whatsapp`,
        variables: {
          groupId: cycle.group.id,
          chargedPaise: quote.chargeAmountPaise,
          shopifyOrderId: order.id,
        },
      });
    }
    return { status: partial ? "partially_skipped" : "order_created", shopifyOrderId: order.id };
  } catch (error) {
    await input.db.billingCycle.update({
      where: { id: cycle.id },
      data: {
        status: "manual_review",
        failureMessage: error instanceof Error ? error.message : "Shopify order creation failed",
      },
    });
    throw error;
  }
}

export async function quoteRenewalGroup(
  graphql: ShopifyGraphql,
  lines: Array<{ id: string; shopifyVariantId: string; quantity: number }>,
  policy: { baseDiscountBps: number; tiers: Array<{ minimumQuantity: number; additionalDiscountBps: number }> },
  shipping: { freeShippingThresholdPaise: number; shippingFeePaise: number },
  customerId?: string | null,
  address?: Address,
): Promise<RenewalQuote> {
  const snapshots = await fetchVariantSnapshots(graphql, lines.map((line) => line.shopifyVariantId));
  const byId = new Map(snapshots.map((snapshot) => [numericId(snapshot.variantId), snapshot]));
  const renewalLines: RenewalLineInput[] = lines.map((line) => {
    const snapshot = byId.get(numericId(line.shopifyVariantId));
    return snapshot
      ? { ...snapshot, subscriptionLineId: line.id, requestedQuantity: line.quantity }
      : {
          subscriptionLineId: line.id,
          variantId: line.shopifyVariantId,
          productId: "",
          productTitle: "Unavailable product",
          currentUnitPricePaise: 0,
          availableQuantity: 0,
          taxable: false,
          active: false,
          requestedQuantity: line.quantity,
        };
  });
  const quote = computeRenewalQuote({
    lines: renewalLines,
    baseDiscountBps: policy.baseDiscountBps,
    tiers: policy.tiers,
    ...shipping,
  });
  if (!address || quote.status === "skipped_oos") return quote;
  return calculateRenewalTaxes({ graphql, quote, customerId, address });
}

async function advanceAfterCycle(
  db: PrismaClient,
  groupId: string,
  previous: Date,
  interval: string,
  cycleId: string,
  data: Record<string, unknown>,
  linePrices: Array<{ id: string; unitPricePaise: number }> = [],
) {
  await db.$transaction([
    db.billingCycle.update({ where: { id: cycleId }, data }),
    db.subscriptionGroup.update({
      where: { id: groupId },
      // A successful retry revives a group that dunning had temporarily halted.
      data: { status: "active", nextChargeAt: nextOccurrence(previous, interval as IntervalCode) },
    }),
    ...linePrices.map((line) => db.subscriptionLine.updateMany({
      where: { id: line.id, subscriptionGroupId: groupId },
      data: { lastChargedUnitPricePaise: line.unitPricePaise },
    })),
  ]);
}

function numericId(value: string): string {
  return value.split("/").pop() ?? value;
}

async function sendReauthorizationNotice(
  db: PrismaClient,
  group: { id: string; shopDomain: string; customerEmail: string; customerPhone: string },
  reason: string,
) {
  const token = createPortalToken({ shopDomain: group.shopDomain, groupId: group.id, ttlMinutes: 7 * 24 * 60 });
  const reauthorizationUrl = `https://${group.shopDomain}/apps/subscriptions/reauthorize?token=${encodeURIComponent(token)}`;
  await notifyBoth({
    db, shopDomain: group.shopDomain, email: group.customerEmail, phone: group.customerPhone,
    template: "subscription_reauthorization_required",
    idempotencyKey: `group:${group.id}:reauthorization:${reason}`,
    variables: { groupId: group.id, reason, reauthorizationUrl },
  });
}
