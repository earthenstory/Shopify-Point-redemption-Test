import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { INTERVALS } from "./types";

export const DEFAULT_TIERS = [
  { minimumQuantity: 2, additionalDiscountBps: 100 },
  { minimumQuantity: 3, additionalDiscountBps: 300 },
  { minimumQuantity: 5, additionalDiscountBps: 500 },
] as const;

const settingsInputSchema = z.object({
  widgetEnabled: z.boolean(),
  enrollmentMode: z.enum(["none", "selected", "all"]),
  selectedProductIds: z.array(z.string()).default([]),
  excludedProductIds: z.array(z.string()).default([]),
  defaultDurationMonths: z.number().int().min(12).max(120),
  allowedIntervals: z.array(z.enum(INTERVALS)).min(1),
  activationTtlHours: z.number().int().min(1).max(168),
  freeShippingThresholdPaise: z.number().int().min(0),
  shippingFeePaise: z.number().int().min(0),
  whatsappEnabled: z.boolean(),
  successfulRenewalWhatsapp: z.boolean(),
  emailEnabled: z.boolean(),
  emailFrom: z.string().email().or(z.literal("")).nullable(),
  retryDay3: z.number().int().min(1).max(30),
  retryDay7: z.number().int().min(1).max(30),
  autoCancelDays: z.number().int().min(1).max(90),
  expiryReminderDays: z.number().int().min(1).max(90),
});

const pricingInputSchema = z.object({
  baseDiscountBps: z.number().int().min(0).max(9_999),
  tiers: z.array(z.object({
    minimumQuantity: z.number().int().min(2).max(1_000),
    additionalDiscountBps: z.number().int().min(0).max(9_999),
  })).max(20),
});

export type SettingsInput = z.infer<typeof settingsInputSchema>;
export type PricingInput = z.infer<typeof pricingInputSchema>;

export async function ensureShopConfiguration(db: PrismaClient, shopDomain: string) {
  return db.$transaction(async (tx) => {
    let settings = await tx.subscriptionSettings.findUnique({ where: { shopDomain } });
    if (!settings) {
      const policy = await tx.pricingPolicyVersion.create({
        data: {
          shopDomain,
          version: 1,
          baseDiscountBps: 200,
          tiers: { create: DEFAULT_TIERS.map((tier) => ({ ...tier })) },
        },
      });
      settings = await tx.subscriptionSettings.create({
        data: { shopDomain, currentPricingPolicyId: policy.id },
      });
    } else if (!settings.currentPricingPolicyId) {
      const latest = await tx.pricingPolicyVersion.findFirst({
        where: { shopDomain }, orderBy: { version: "desc" },
      });
      const policy = latest ?? await tx.pricingPolicyVersion.create({
        data: {
          shopDomain,
          version: 1,
          baseDiscountBps: 200,
          tiers: { create: DEFAULT_TIERS.map((tier) => ({ ...tier })) },
        },
      });
      settings = await tx.subscriptionSettings.update({
        where: { shopDomain }, data: { currentPricingPolicyId: policy.id },
      });
    }
    return settings;
  });
}

export async function getShopConfiguration(db: PrismaClient, shopDomain: string) {
  const settings = await ensureShopConfiguration(db, shopDomain);
  const policy = await db.pricingPolicyVersion.findUniqueOrThrow({
    where: { id: settings.currentPricingPolicyId! },
    include: { tiers: { orderBy: { minimumQuantity: "asc" } } },
  });
  return { settings, policy };
}

export async function updateSettings(
  db: PrismaClient,
  shopDomain: string,
  raw: SettingsInput,
) {
  const input = settingsInputSchema.parse(raw);
  if (input.retryDay3 >= input.retryDay7 || input.retryDay7 >= input.autoCancelDays) {
    throw new Error("Retry days must be ascending and earlier than auto-cancel");
  }
  await ensureShopConfiguration(db, shopDomain);
  return db.subscriptionSettings.update({
    where: { shopDomain },
    data: {
      ...input,
      emailFrom: input.emailFrom || null,
      selectedProductIds: input.selectedProductIds,
      excludedProductIds: input.excludedProductIds,
      allowedIntervals: input.allowedIntervals,
    },
  });
}

export async function createPricingPolicy(
  db: PrismaClient,
  shopDomain: string,
  raw: PricingInput,
) {
  const input = pricingInputSchema.parse(raw);
  const tiers = [...input.tiers].sort((a, b) => a.minimumQuantity - b.minimumQuantity);
  tiers.forEach((tier, index) => {
    if (index && tier.minimumQuantity === tiers[index - 1].minimumQuantity) {
      throw new Error("Tier quantities must be unique");
    }
    if (index && tier.additionalDiscountBps < tiers[index - 1].additionalDiscountBps) {
      throw new Error("Tier bonuses cannot decrease at higher quantities");
    }
    if (input.baseDiscountBps + tier.additionalDiscountBps >= 10_000) {
      throw new Error("Effective discount must stay below 100%");
    }
  });

  return db.$transaction(async (tx) => {
    await ensureSettingsWithinTransaction(tx, shopDomain);
    const latest = await tx.pricingPolicyVersion.findFirst({
      where: { shopDomain }, orderBy: { version: "desc" }, select: { version: true },
    });
    const policy = await tx.pricingPolicyVersion.create({
      data: {
        shopDomain,
        version: (latest?.version ?? 0) + 1,
        baseDiscountBps: input.baseDiscountBps,
        tiers: { create: tiers },
      },
      include: { tiers: true },
    });
    await tx.subscriptionSettings.update({
      where: { shopDomain }, data: { currentPricingPolicyId: policy.id },
    });
    return policy;
  });
}

async function ensureSettingsWithinTransaction(
  tx: Prisma.TransactionClient,
  shopDomain: string,
) {
  const existing = await tx.subscriptionSettings.findUnique({ where: { shopDomain } });
  if (!existing) await tx.subscriptionSettings.create({ data: { shopDomain } });
}

export function isProductEligible(input: {
  widgetEnabled: boolean;
  enrollmentMode: string;
  selectedProductIds: unknown;
  excludedProductIds: unknown;
  productId: string;
}): boolean {
  if (!input.widgetEnabled || input.enrollmentMode === "none") return false;
  const selected = stringArray(input.selectedProductIds).map(resourceId);
  const excluded = stringArray(input.excludedProductIds).map(resourceId);
  const productId = resourceId(input.productId);
  if (excluded.includes(productId)) return false;
  return input.enrollmentMode === "all" ||
    (input.enrollmentMode === "selected" && selected.includes(productId));
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function resourceId(value: string): string {
  return value.split("/").pop() ?? value;
}
