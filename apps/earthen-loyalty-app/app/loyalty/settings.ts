import type {
  LoyaltyMilestoneRule,
  LoyaltyProgramSettings,
  LoyaltyWidgetSettings,
  Prisma,
  PrismaClient,
  RewardRule,
} from "@prisma/client";
import { z } from "zod";
import { confirmedBonDefaults, type LoyaltyRules } from "./rules";

export type LoyaltyRuntimeSettings = {
  program: LoyaltyProgramSettings;
  rewardRule: RewardRule;
  widget: LoyaltyWidgetSettings;
  milestones: LoyaltyMilestoneRule[];
  rules: LoyaltyRules;
  earningEnabled: boolean;
  redemptionEnabled: boolean;
  discountCodeTtlMinutes: number;
};

export const programSettingsSchema = z.object({
  status: z.enum(["test", "active", "paused"]),
  programName: z.string().trim().min(1).max(80),
  pointName: z.string().trim().min(1).max(80),
  bonWidgetDisabled: z.boolean(),
  standardCheckoutTested: z.boolean(),
  expressCheckoutTested: z.boolean(),
});

export const rewardSettingsSchema = z.object({
  earningEnabled: z.boolean(),
  redemptionEnabled: z.boolean(),
  signupRewardPoints: z.number().int().min(0).max(1_000_000),
  pointsPerSpendAmount: z.number().positive().max(1_000_000),
  spendAmountForEarnPoints: z.number().positive().max(1_000_000),
  currencyValuePerPoint: z.number().positive().max(1_000_000),
  minRedeemPoints: z.number().int().positive().max(1_000_000),
  redeemIncrementPoints: z.number().int().positive().max(1_000_000),
  maxRedeemPercentOfCart: z.number().min(0).max(100),
  maxRedeemPointsPerOrder: z.number().int().positive().nullable(),
  allowDiscountStacking: z.boolean(),
  discountCodeTtlMinutes: z.number().int().min(5).max(10080),
  awardOnStatus: z.enum(["paid", "fulfilled"]),
  pointsExpiryDays: z.number().int().positive().nullable(),
  returnRedeemedPointsOnRefund: z.boolean(),
  reverseEarnedPointsOnRefund: z.boolean(),
});

export const widgetSettingsSchema = z.object({
  homepageEnabled: z.boolean(),
  productEnabled: z.boolean(),
  cartEnabled: z.boolean(),
  accountEnabled: z.boolean(),
  loggedOutMessage: z.string().trim().min(1).max(240),
  zeroPointsMessage: z.string().trim().min(1).max(240),
  primaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  backgroundColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
});

export const milestoneSettingsSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["signup", "first_order", "order_count", "spend_amount", "birthday"]),
  title: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  points: z.number().int().min(0).max(1_000_000),
  thresholdAmount: z.number().positive().nullable(),
  thresholdOrderCount: z.number().int().positive().nullable(),
  repeatable: z.boolean(),
});

// Runtime settings change rarely (only via the admin) but are read on every
// storefront request. Each miss runs three `ensure*` upserts + a milestone read,
// so we cache the assembled result per shop for a short TTL and let the admin
// write paths bust it. This turns the common path from ~4 DB round trips (3 of
// them writes) into zero. The TTL bounds staleness in the rare case a second
// Cloud Run instance holds an older copy.
const RUNTIME_SETTINGS_TTL_MS = 60_000;

type RuntimeSettingsCacheEntry = {
  value: LoyaltyRuntimeSettings;
  expiresAt: number;
};

const runtimeSettingsCache = new Map<string, RuntimeSettingsCacheEntry>();

export function invalidateLoyaltyRuntimeSettings(shopDomain: string) {
  runtimeSettingsCache.delete(shopDomain);
}

export async function getLoyaltyRuntimeSettings(input: {
  db: PrismaClient;
  shopDomain: string;
}): Promise<LoyaltyRuntimeSettings> {
  const cached = runtimeSettingsCache.get(input.shopDomain);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const [program, rewardRule, widget, milestones] = await Promise.all([
    ensureProgramSettings(input.db, input.shopDomain),
    ensureRewardRule(input.db, input.shopDomain),
    ensureWidgetSettings(input.db, input.shopDomain),
    input.db.loyaltyMilestoneRule.findMany({
      where: { shopDomain: input.shopDomain },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  const value: LoyaltyRuntimeSettings = {
    program,
    rewardRule,
    widget,
    milestones,
    rules: rewardRuleToRules(rewardRule),
    earningEnabled: rewardRule.earningEnabled && program.status !== "paused",
    redemptionEnabled:
      rewardRule.redemptionEnabled && program.status !== "paused",
    discountCodeTtlMinutes: rewardRule.discountCodeTtlMinutes,
  };

  runtimeSettingsCache.set(input.shopDomain, {
    value,
    expiresAt: Date.now() + RUNTIME_SETTINGS_TTL_MS,
  });

  return value;
}

export async function updateProgramSettings(input: {
  db: PrismaClient;
  shopDomain: string;
  adminUser: string;
  data: z.infer<typeof programSettingsSchema>;
}) {
  const parsed = programSettingsSchema.parse(input.data);
  const before = await ensureProgramSettings(input.db, input.shopDomain);
  const after = await input.db.loyaltyProgramSettings.update({
    where: { shopDomain: input.shopDomain },
    data: parsed,
  });
  await writeAdminAudit(input.db, {
    adminUser: input.adminUser,
    action: "program_settings_update",
    before,
    after,
    reason: "Updated loyalty program settings",
  });
  invalidateLoyaltyRuntimeSettings(input.shopDomain);
  return after;
}

export async function updateRewardSettings(input: {
  db: PrismaClient;
  shopDomain: string;
  adminUser: string;
  data: z.infer<typeof rewardSettingsSchema>;
}) {
  const parsed = rewardSettingsSchema.parse(input.data);
  if (parsed.minRedeemPoints % parsed.redeemIncrementPoints !== 0) {
    throw new Error("Minimum redemption must be a multiple of the increment.");
  }

  const before = await ensureRewardRule(input.db, input.shopDomain);
  const after = await input.db.rewardRule.update({
    where: { shopDomain: input.shopDomain },
    data: {
      ...parsed,
      earnRatePercent: earnRatePercent(parsed),
      pointsPerCurrencyUnit:
        parsed.pointsPerSpendAmount / parsed.spendAmountForEarnPoints,
    },
  });
  await writeAdminAudit(input.db, {
    adminUser: input.adminUser,
    action: "reward_settings_update",
    before,
    after,
    reason: "Updated loyalty earning/redemption settings",
  });
  invalidateLoyaltyRuntimeSettings(input.shopDomain);
  return after;
}

export async function updateWidgetSettings(input: {
  db: PrismaClient;
  shopDomain: string;
  adminUser: string;
  data: z.infer<typeof widgetSettingsSchema>;
}) {
  const parsed = widgetSettingsSchema.parse(input.data);
  const before = await ensureWidgetSettings(input.db, input.shopDomain);
  const after = await input.db.loyaltyWidgetSettings.update({
    where: { shopDomain: input.shopDomain },
    data: parsed,
  });
  await writeAdminAudit(input.db, {
    adminUser: input.adminUser,
    action: "widget_settings_update",
    before,
    after,
    reason: "Updated loyalty widget settings",
  });
  invalidateLoyaltyRuntimeSettings(input.shopDomain);
  return after;
}

export async function upsertMilestoneRule(input: {
  db: PrismaClient;
  shopDomain: string;
  adminUser: string;
  data: z.infer<typeof milestoneSettingsSchema>;
}) {
  const parsed = milestoneSettingsSchema.parse(input.data);
  const before = parsed.id
    ? await input.db.loyaltyMilestoneRule.findUnique({ where: { id: parsed.id } })
    : null;
  const data = {
    shopDomain: input.shopDomain,
    type: parsed.type,
    title: parsed.title,
    enabled: parsed.enabled,
    points: parsed.points,
    thresholdAmount: parsed.thresholdAmount,
    thresholdOrderCount: parsed.thresholdOrderCount,
    repeatable: parsed.repeatable,
  };
  const after = parsed.id
    ? await input.db.loyaltyMilestoneRule.update({
        where: { id: parsed.id },
        data,
      })
    : await input.db.loyaltyMilestoneRule.create({ data });
  await writeAdminAudit(input.db, {
    adminUser: input.adminUser,
    action: "milestone_rule_upsert",
    before,
    after,
    reason: "Updated loyalty milestone rule",
  });
  invalidateLoyaltyRuntimeSettings(input.shopDomain);
  return after;
}

export async function ensureProgramSettings(
  db: PrismaClient,
  shopDomain: string,
) {
  return db.loyaltyProgramSettings.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
  });
}

export async function ensureWidgetSettings(
  db: PrismaClient,
  shopDomain: string,
) {
  return db.loyaltyWidgetSettings.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
  });
}

export async function ensureRewardRule(db: PrismaClient, shopDomain: string) {
  return db.rewardRule.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      earnRatePercent: earnRatePercent(confirmedBonDefaults),
      pointsPerCurrencyUnit:
        confirmedBonDefaults.pointsPerSpendAmount /
        confirmedBonDefaults.spendAmountForEarnPoints,
      pointsPerSpendAmount: confirmedBonDefaults.pointsPerSpendAmount,
      spendAmountForEarnPoints: confirmedBonDefaults.spendAmountForEarnPoints,
      currencyValuePerPoint: confirmedBonDefaults.currencyValuePerPoint,
      signupRewardPoints: confirmedBonDefaults.signupRewardPoints,
      minRedeemPoints: confirmedBonDefaults.minRedeemPoints,
      redeemIncrementPoints: confirmedBonDefaults.redeemIncrementPoints,
      maxRedeemPointsPerOrder: confirmedBonDefaults.maxRedeemPointsPerOrder,
      maxRedeemPercentOfCart: confirmedBonDefaults.maxRedeemPercentOfCart,
      allowDiscountStacking: confirmedBonDefaults.allowDiscountStacking,
      awardOnStatus: confirmedBonDefaults.awardOnStatus,
      returnRedeemedPointsOnRefund:
        confirmedBonDefaults.returnRedeemedPointsOnRefund,
      reverseEarnedPointsOnRefund:
        confirmedBonDefaults.reverseEarnedPointsOnRefund,
    },
    update: {},
  });
}

export function rewardRuleToRules(rule: RewardRule): LoyaltyRules {
  return {
    currency: confirmedBonDefaults.currency,
    signupRewardPoints: rule.signupRewardPoints,
    pointsPerSpendAmount: Number(rule.pointsPerSpendAmount),
    spendAmountForEarnPoints: Number(rule.spendAmountForEarnPoints),
    currencyValuePerPoint: Number(rule.currencyValuePerPoint),
    minRedeemPoints: rule.minRedeemPoints,
    redeemIncrementPoints: rule.redeemIncrementPoints,
    maxRedeemPercentOfCart: Number(rule.maxRedeemPercentOfCart),
    maxRedeemPointsPerOrder: rule.maxRedeemPointsPerOrder,
    allowDiscountStacking: rule.allowDiscountStacking,
    awardOnStatus:
      rule.awardOnStatus === "paid" || rule.awardOnStatus === "fulfilled"
        ? rule.awardOnStatus
        : confirmedBonDefaults.awardOnStatus,
    returnRedeemedPointsOnRefund: rule.returnRedeemedPointsOnRefund,
    reverseEarnedPointsOnRefund: rule.reverseEarnedPointsOnRefund,
  };
}

export function formBoolean(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "1";
}

export function formNumber(value: FormDataEntryValue | null): number {
  return Number(String(value ?? "").trim());
}

export function formNullablePositiveInt(
  value: FormDataEntryValue | null,
): number | null {
  const text = String(value ?? "").trim();
  return text ? Number(text) : null;
}

async function writeAdminAudit(
  db: PrismaClient,
  input: {
    adminUser: string;
    action: string;
    before: unknown;
    after: unknown;
    reason: string;
  },
) {
  await db.adminAuditLog.create({
    data: {
      adminUser: input.adminUser,
      action: input.action,
      before: toJson(input.before),
      after: toJson(input.after),
      reason: input.reason,
    },
  });
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function earnRatePercent(input: {
  pointsPerSpendAmount: number | Prisma.Decimal;
  spendAmountForEarnPoints: number | Prisma.Decimal;
}) {
  return (
    (Number(input.pointsPerSpendAmount) /
      Number(input.spendAmountForEarnPoints)) *
    100
  );
}
