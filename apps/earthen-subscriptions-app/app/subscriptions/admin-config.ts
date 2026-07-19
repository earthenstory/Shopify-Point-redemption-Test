import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, SubscriptionSettings } from "@prisma/client";
import { z } from "zod";
import { ensureShopConfiguration } from "./settings";

const color = z.string().regex(/^(#[0-9a-f]{6}|rgba?\(.+\))$/i);

export const widgetConfigSchema = z.object({
  heading: z.string().min(1).max(120).default("Subscribe & save on future deliveries"),
  description: z.string().max(500).default("Choose a delivery frequency. Your first order is at today’s normal price."),
  buttonLabel: z.string().min(1).max(80).default("Add to subscription basket"),
  design: z.enum(["default", "compact", "card"]).default("card"),
  accentColor: color.default("#112557"),
  borderColor: color.default("#dfc07a"),
  backgroundColor: color.default("#fffdf8"),
  textColor: color.default("#18181b"),
  showSavingsBadge: z.boolean().default(true),
  showOneTimeFirst: z.boolean().default(true),
  hideSingleIntervalSelector: z.boolean().default(false),
  updateDisplayedProductPrice: z.boolean().default(false),
  disabledPathFragments: z.array(z.string().max(200)).max(100).default([]),
  customCss: z.string().max(5_000).default(""),
});

export const portalConfigSchema = z.object({
  allowSkip: z.boolean().default(true),
  allowPause: z.boolean().default(true),
  allowResume: z.boolean().default(true),
  allowCancel: z.boolean().default(true),
  allowRemoveLine: z.boolean().default(true),
  allowAddressChange: z.boolean().default(true),
  allowReschedule: z.boolean().default(true),
  allowRetryPayment: z.boolean().default(true),
  allowChargeNow: z.boolean().default(false),
  allowDiscountCodes: z.boolean().default(false),
  allowQuantityChanges: z.boolean().default(false),
  allowIntervalChanges: z.boolean().default(false),
  allowVariantChanges: z.boolean().default(false),
  allowAddProducts: z.boolean().default(false),
  minimumRenewalsBeforeEdit: z.number().int().min(0).max(100).default(0),
  maximumVisibleBillingAttempts: z.number().int().min(1).max(100).default(25),
  headerHtml: z.string().max(5_000).default(""),
  sections: z.array(z.enum(["summary", "items", "billing_schedule", "payment", "recommended_products", "media", "history"]))
    .default(["summary", "items", "billing_schedule", "payment", "history"]),
});

export const cancellationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  requireReason: z.boolean().default(true),
  reasons: z.array(z.object({
    code: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    treatments: z.array(z.enum(["skip_next", "pause_30_days", "reschedule", "contact_support", "none"])),
  })).default([
    { code: "too_much_product", label: "I have too much product", treatments: ["skip_next", "pause_30_days"] },
    { code: "schedule", label: "The delivery schedule is not right", treatments: ["reschedule"] },
    { code: "price", label: "It is too expensive", treatments: ["contact_support"] },
    { code: "products", label: "These are not the items I want", treatments: ["contact_support"] },
    { code: "other", label: "Other", treatments: ["none"] },
  ]),
});

export const notificationConfigSchema = z.object({
  customerEmailEnabled: z.boolean().default(false),
  customerWhatsappEnabled: z.boolean().default(true),
  adminEmail: z.string().email().or(z.literal("")).default(""),
  preDebitDays: z.array(z.number().int().min(1).max(34)).max(3).default([1]),
  preDebitHours: z.array(z.number().int().min(1).max(23)).max(3).default([12, 6]),
  notifyBillingSuccess: z.boolean().default(false),
  notifyBillingFailure: z.boolean().default(true),
  notifyStockout: z.boolean().default(true),
  notifyPauseResume: z.boolean().default(true),
  notifyCancellation: z.boolean().default(true),
  notifyExpiry: z.boolean().default(true),
  adminNewSubscription: z.boolean().default(true),
  adminPaymentFailure: z.boolean().default(true),
  adminCustomerChange: z.boolean().default(true),
  adminStockout: z.boolean().default(true),
  adminJobFailure: z.boolean().default(true),
  emailDomain: z.string().max(255).default(""),
});

export const integrationConfigSchema = z.object({
  googleAnalyticsId: z.string().max(64).default(""),
  klaviyoEnabled: z.boolean().default(false),
  klaviyoPublicKey: z.string().max(255).default(""),
  includeMagicLinkInEvents: z.boolean().default(false),
  gorgiasEnabled: z.boolean().default(false),
  attentiveEnabled: z.boolean().default(false),
  orderTags: z.array(z.string().max(100)).max(20).default(["Earthen Subscription", "sub-group:{{subscription_id}}"]),
  customerActiveTag: z.string().max(40).default("Earthen Subscriber"),
  customerInactiveTag: z.string().max(40).default("Earthen Subscriber - Inactive"),
  customerPausedTag: z.string().max(40).default("Earthen Subscriber - Paused"),
});

export const installationConfigSchema = z.object({
  themeBlockInstalled: z.boolean().default(true),
  thankYouBlockInstalled: z.boolean().default(true),
  orderStatusBlockInstalled: z.boolean().default(true),
  accountPageInstalled: z.boolean().default(true),
  accountMenuInstalled: z.boolean().default(true),
  lastVerifiedAt: z.string().datetime().or(z.literal("")).default(""),
});

export const advancedConfigSchema = z.object({
  automaticallyDeleteCancelledAfterDays: z.number().int().min(0).max(3650).default(0),
  propagateProductTitlesAndSkus: z.boolean().default(true),
  propagateCurrentPrices: z.boolean().default(true),
  recalculateShippingAfterAddressChange: z.boolean().default(true),
  recalculateShippingAfterLineRemoval: z.boolean().default(true),
  recalculateShippingAfterProfileChange: z.boolean().default(true),
  shippingMethodName: z.string().max(120).default("Earthen subscription delivery"),
  dateFormat: z.enum(["automatic", "dd/mm/yyyy", "yyyy-mm-dd", "mm/dd/yyyy"]).default("automatic"),
});

export const MODULE_SCHEMAS = {
  widget: widgetConfigSchema,
  portal: portalConfigSchema,
  cancellation: cancellationConfigSchema,
  notifications: notificationConfigSchema,
  integrations: integrationConfigSchema,
  installation: installationConfigSchema,
  advanced: advancedConfigSchema,
} as const;

export type SettingsModule = keyof typeof MODULE_SCHEMAS;

export async function getAdminConfiguration(db: PrismaClient, shopDomain: string) {
  const settings = await ensureShopConfiguration(db, shopDomain);
  return {
    settings,
    modules: {
      widget: widgetConfigSchema.parse(jsonObject(settings.widgetConfig)),
      portal: portalConfigSchema.parse(jsonObject(settings.portalConfig)),
      cancellation: cancellationConfigSchema.parse(jsonObject(settings.cancellationConfig)),
      notifications: notificationConfigSchema.parse(jsonObject(settings.notificationConfig)),
      integrations: integrationConfigSchema.parse(jsonObject(settings.integrationConfig)),
      installation: installationConfigSchema.parse(jsonObject(settings.installationConfig)),
      advanced: advancedConfigSchema.parse(jsonObject(settings.advancedConfig)),
    },
  };
}

export async function updateSettingsModule(
  db: PrismaClient,
  shopDomain: string,
  module: SettingsModule,
  raw: unknown,
) {
  await ensureShopConfiguration(db, shopDomain);
  const parsed = MODULE_SCHEMAS[module].parse(raw) as unknown as Prisma.InputJsonValue;
  const data = moduleField(module, parsed);
  return db.subscriptionSettings.update({ where: { shopDomain }, data });
}

export function readinessReport(settings: SubscriptionSettings, installation: z.infer<typeof installationConfigSchema>) {
  const checks = [
    { key: "master", label: "Master signup switch", ready: settings.widgetEnabled, optional: true },
    { key: "products", label: "Products accepting subscriptions", ready: settings.enrollmentMode !== "none", optional: false },
    { key: "theme", label: "Product-page widget installed", ready: installation.themeBlockInstalled, optional: false },
    { key: "activation", label: "Thank-you and order-status activation blocks", ready: installation.thankYouBlockInstalled && installation.orderStatusBlockInstalled, optional: false },
    { key: "account", label: "Customer account page and menu", ready: installation.accountPageInstalled && installation.accountMenuInstalled, optional: false },
    { key: "razorpay", label: "Razorpay production credentials", ready: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET), optional: false },
    { key: "scheduler", label: "Renewal scheduler", ready: settings.schedulerEnabled, optional: false },
    { key: "whatsapp", label: "WhatsApp provider", ready: !settings.whatsappEnabled || Boolean(process.env.HERMES_BASE_URL && process.env.HERMES_TOKEN), optional: false },
    { key: "email", label: "Transactional email provider", ready: !settings.emailEnabled || Boolean(process.env.EMAIL_PROVIDER_URL && process.env.EMAIL_PROVIDER_TOKEN), optional: false },
  ];
  return {
    checks,
    launchReady: checks.filter((check) => !check.optional).every((check) => check.ready),
    completed: checks.filter((check) => check.ready).length,
    total: checks.length,
  };
}

export function issueMerchantCredential() {
  const token = `earthen_token_${randomBytes(24).toString("base64url")}`;
  const secret = `earthen_secret_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    secret,
    tokenHash: hashCredential(token),
    secretHash: hashCredential(secret),
    tokenLast4: token.slice(-4),
  };
}

export function hashCredential(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function moduleField(module: SettingsModule, value: Prisma.InputJsonValue): Prisma.SubscriptionSettingsUpdateInput {
  switch (module) {
    case "widget": return { widgetConfig: value };
    case "portal": return { portalConfig: value };
    case "cancellation": return { cancellationConfig: value };
    case "notifications": return { notificationConfig: value };
    case "integrations": return { integrationConfig: value };
    case "installation": return { installationConfig: value };
    case "advanced": return { advancedConfig: value };
  }
}
