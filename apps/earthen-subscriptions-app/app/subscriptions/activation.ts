import type { Prisma, PrismaClient } from "@prisma/client";
import { addDurationMonths, nextOccurrence } from "./schedule";
import { mandateHeadroomPaise, tierForQuantity } from "./pricing";
import type { RazorpayGateway } from "./razorpay";
import { quoteRenewalGroup } from "./renewals";
import type { ShopifyGraphql } from "./shopify";
import type { Address, IntervalCode, RequestedLine } from "./types";

type CustomerSnapshot = {
  shopifyCustomerId?: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  address: Record<string, unknown>;
};

export async function startMandateActivation(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  intentId: string;
  shopDomain: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const intent = await input.db.subscriptionIntent.findFirst({
    where: { id: input.intentId, shopDomain: input.shopDomain },
    include: { pricingPolicy: { include: { tiers: true } }, subscriptionGroup: true },
  });
  if (!intent || !["pending_mandate", "ordered"].includes(intent.status)) {
    if (intent?.status === "activated" && intent.subscriptionGroup) {
      return { alreadyActive: true, group: intent.subscriptionGroup };
    }
    throw new Error("Subscription activation is not available");
  }
  if (intent.expiresAt <= now) {
    await input.db.subscriptionIntent.update({ where: { id: intent.id }, data: { status: "expired" } });
    throw new Error("Subscription activation link has expired");
  }
  if (intent.subscriptionGroup?.razorpayRegistrationOrderId) {
    return {
      alreadyActive: false,
      group: intent.subscriptionGroup,
      registrationOrderId: intent.subscriptionGroup.razorpayRegistrationOrderId,
      checkoutKey: process.env.RAZORPAY_KEY_ID ?? "",
    };
  }
  const customer = intent.customerSnapshot as unknown as CustomerSnapshot | null;
  if (!customer) throw new Error("The originating paid order has not been captured");
  const lines = intent.requestedLines as unknown as RequestedLine[];
  const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  const tier = tierForQuantity(intent.pricingPolicy.tiers, quantity);
  const discountBps = intent.pricingPolicy.baseDiscountBps + (tier?.additionalDiscountBps ?? 0);
  const merchandisePaise = lines.reduce((sum, line) =>
    sum + Math.round(line.unitPricePaise * line.quantity * (10_000 - discountBps) / 10_000), 0);
  const settings = await input.db.subscriptionSettings.findUniqueOrThrow({
    where: { shopDomain: input.shopDomain },
  });
  const expectedRenewalPaise = merchandisePaise +
    (merchandisePaise < settings.freeShippingThresholdPaise ? settings.shippingFeePaise : 0);
  const mandateMaxPaise = mandateHeadroomPaise(expectedRenewalPaise);
  const anchorDate = now;
  const interval = intent.intervalCode as IntervalCode;

  const group = await input.db.$transaction(async (tx) => {
    const existing = await tx.subscriptionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    if (existing.subscriptionGroupId) {
      return tx.subscriptionGroup.findUniqueOrThrow({ where: { id: existing.subscriptionGroupId } });
    }
    const created = await tx.subscriptionGroup.create({
      data: {
        shopDomain: input.shopDomain,
        status: "pending_mandate",
        shopifyCustomerId: customer.shopifyCustomerId,
        customerName: customer.customerName,
        customerEmail: customer.customerEmail,
        customerPhone: customer.customerPhone,
        addressJson: customer.address as Prisma.InputJsonValue,
        intervalCode: interval,
        anchorDate,
        nextChargeAt: nextOccurrence(anchorDate, interval),
        endAt: addDurationMonths(anchorDate, settings.defaultDurationMonths),
        pricingPolicyId: intent.pricingPolicyId,
        mandateMaxPaise,
        lines: {
          create: lines.map((line) => ({
            shopifyProductId: line.productId,
            shopifyVariantId: line.variantId,
            sku: line.sku,
            productTitle: line.productTitle,
            variantTitle: line.variantTitle,
            quantity: line.quantity,
            signupUnitPricePaise: line.unitPricePaise,
          })),
        },
      },
    });
    await tx.subscriptionIntent.update({
      where: { id: intent.id }, data: { subscriptionGroupId: created.id },
    });
    return created;
  });

  try {
    const registration = await input.razorpay.createRegistration({
      name: customer.customerName,
      email: customer.customerEmail,
      contact: customer.customerPhone,
      mandateMaxPaise,
      expireAt: addDurationMonths(anchorDate, settings.defaultDurationMonths),
      intervalCode: intent.intervalCode,
      groupId: group.id,
    });
    const updated = await input.db.subscriptionGroup.update({
      where: { id: group.id },
      data: {
        razorpayCustomerId: registration.customerId,
        razorpayRegistrationOrderId: registration.registrationOrderId,
      },
    });
    return {
      alreadyActive: false,
      group: updated,
      registrationOrderId: registration.registrationOrderId,
      checkoutKey: registration.checkoutKey,
    };
  } catch (error) {
    await input.db.eventLog.create({
      data: {
        shopDomain: input.shopDomain,
        entityType: "subscription_group",
        entityId: group.id,
        eventType: "mandate_registration_failed",
        maskedPayload: { message: error instanceof Error ? error.message : "unknown" },
      },
    });
    throw error;
  }
}

export async function activateMandate(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  registrationOrderId: string;
  tokenId: string;
  now?: Date;
}) {
  const group = await input.db.subscriptionGroup.findUnique({
    where: { razorpayRegistrationOrderId: input.registrationOrderId },
    include: { activationIntent: true },
  });
  if (!group) throw new Error("Unknown mandate registration order");
  if (group.status === "active" && group.razorpayTokenId === input.tokenId) return group;
  if (group.razorpayTokenId && group.razorpayTokenId !== input.tokenId) {
    await input.razorpay.cancelToken(group.razorpayTokenId);
  }
  return input.db.$transaction(async (tx) => {
    const updated = await tx.subscriptionGroup.update({
      where: { id: group.id },
      data: { status: "active", razorpayTokenId: input.tokenId },
    });
    if (group.activationIntent) {
      await tx.subscriptionIntent.update({
        where: { id: group.activationIntent.id }, data: { status: "activated" },
      });
    }
    await tx.eventLog.create({
      data: {
        shopDomain: group.shopDomain,
        entityType: "subscription_group",
        entityId: group.id,
        eventType: "mandate_activated",
        maskedPayload: {},
      },
    });
    return updated;
  });
}

export async function startGroupReauthorization(input: {
  db: PrismaClient;
  razorpay: RazorpayGateway;
  graphql: ShopifyGraphql;
  groupId: string;
  shopDomain: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const group = await input.db.subscriptionGroup.findFirst({
    where: { id: input.groupId, shopDomain: input.shopDomain },
    include: {
      lines: { where: { status: "active" } },
      pricingPolicy: { include: { tiers: true } },
    },
  });
  if (!group || ["cancelled", "expired"].includes(group.status) || group.lines.length === 0) {
    throw new Error("Subscription is not eligible for reauthorization");
  }
  const recent = await input.db.eventLog.findFirst({
    where: {
      shopDomain: input.shopDomain,
      entityType: "subscription_group",
      entityId: input.groupId,
      eventType: "mandate_reauthorization_started",
      createdAt: { gte: new Date(now.getTime() - 15 * 60_000) },
    },
  });
  if (recent && group.razorpayRegistrationOrderId) {
    return { registrationOrderId: group.razorpayRegistrationOrderId, checkoutKey: process.env.RAZORPAY_KEY_ID ?? "" };
  }
  const settings = await input.db.subscriptionSettings.findUniqueOrThrow({
    where: { shopDomain: input.shopDomain },
  });
  const quote = await quoteRenewalGroup(
    input.graphql,
    group.lines,
    group.pricingPolicy,
    settings,
    group.shopifyCustomerId,
    group.addressJson as unknown as Address,
  );
  const referenceAmount = quote.status === "skipped_oos"
    ? Math.max(group.mandateMaxPaise ?? 0, 50_000)
    : quote.chargeAmountPaise;
  const mandateMaxPaise = mandateHeadroomPaise(referenceAmount);
  const endAt = group.endAt <= new Date(now.getTime() + 31 * 86_400_000)
    ? addDurationMonths(now, settings.defaultDurationMonths)
    : group.endAt;
  const registration = await input.razorpay.createRegistration({
    name: group.customerName,
    email: group.customerEmail,
    contact: group.customerPhone,
    mandateMaxPaise,
    expireAt: endAt,
    intervalCode: group.intervalCode,
    groupId: group.id,
  });
  await input.db.subscriptionGroup.update({
    where: { id: group.id },
    data: {
      razorpayCustomerId: registration.customerId,
      razorpayRegistrationOrderId: registration.registrationOrderId,
      mandateMaxPaise,
      endAt,
    },
  });
  await input.db.eventLog.create({
    data: {
      shopDomain: group.shopDomain,
      entityType: "subscription_group",
      entityId: group.id,
      eventType: "mandate_reauthorization_started",
      maskedPayload: { mandateMaxPaise, endAt: endAt.toISOString() },
    },
  });
  return { registrationOrderId: registration.registrationOrderId, checkoutKey: registration.checkoutKey };
}
