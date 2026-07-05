import type { DeliverySettings, PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  checkServiceability,
  pickCourier,
  ShiprocketError,
} from "./shiprocket";

// Estimated delivery date = dispatch day + courier transit days.
//
// Dispatch rule (merchant-configurable): orders placed before the cutoff on a
// working day dispatch the SAME day; otherwise the next working day. Working
// days default to Mon-Sat, plus a holiday calendar of explicit dates.
//
// We cache the courier's transit DAYS per destination pincode — never the
// date — so a cache entry stays correct across midnight.

const IST_OFFSET_MINUTES = 5 * 60 + 30;

export const deliverySettingsSchema = z.object({
  enabled: z.boolean(),
  pickupPincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, "Pickup pincode must be a valid 6-digit PIN"),
  cutoffHour: z.number().int().min(0).max(23),
  workingDays: z
    .array(z.number().int().min(1).max(7))
    .min(1, "Select at least one working day"),
  holidays: z.array(
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Holidays must be YYYY-MM-DD"),
  ),
  defaultWeightKg: z.number().positive().max(50),
  courierStrategy: z.enum(["recommended", "fastest"]),
  surfaceOnly: z.boolean(),
  fallbackToAny: z.boolean(),
  showRange: z.boolean(),
  widgetTitle: z.string().trim().min(1).max(80),
  cacheTtlMinutes: z.number().int().min(5).max(10080),
});

export type DeliverySettingsInput = z.infer<typeof deliverySettingsSchema>;

const SETTINGS_TTL_MS = 60_000;
const settingsCache = new Map<
  string,
  { value: DeliverySettings; expiresAt: number }
>();

export function invalidateDeliverySettings(shopDomain: string) {
  settingsCache.delete(shopDomain);
}

export async function getDeliverySettings(
  db: PrismaClient,
  shopDomain: string,
): Promise<DeliverySettings> {
  const cached = settingsCache.get(shopDomain);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await db.deliverySettings.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
  });
  settingsCache.set(shopDomain, {
    value,
    expiresAt: Date.now() + SETTINGS_TTL_MS,
  });
  return value;
}

export async function updateDeliverySettings(input: {
  db: PrismaClient;
  shopDomain: string;
  data: DeliverySettingsInput;
}): Promise<DeliverySettings> {
  const parsed = deliverySettingsSchema.parse(input.data);
  const updated = await input.db.deliverySettings.upsert({
    where: { shopDomain: input.shopDomain },
    create: {
      shopDomain: input.shopDomain,
      ...toDbShape(parsed),
    },
    update: toDbShape(parsed),
  });
  invalidateDeliverySettings(input.shopDomain);
  return updated;
}

function toDbShape(parsed: DeliverySettingsInput) {
  return {
    enabled: parsed.enabled,
    pickupPincode: parsed.pickupPincode,
    cutoffHour: parsed.cutoffHour,
    workingDays: [...parsed.workingDays].sort((a, b) => a - b).join(","),
    holidays: parsed.holidays,
    defaultWeightKg: parsed.defaultWeightKg,
    courierStrategy: parsed.courierStrategy,
    surfaceOnly: parsed.surfaceOnly,
    fallbackToAny: parsed.fallbackToAny,
    showRange: parsed.showRange,
    widgetTitle: parsed.widgetTitle,
    cacheTtlMinutes: parsed.cacheTtlMinutes,
  };
}

// ---------------------------------------------------------------------------
// IST calendar math. We only ever need day-level precision, so we work with
// "IST-shifted" Date objects: real UTC instant + 5h30 — then the UTC getters
// read out IST wall-clock values. No DST in India, so the offset is constant.
// ---------------------------------------------------------------------------

type IstDay = { year: number; month: number; day: number; weekday: number; hour: number };

function toIst(now: Date): IstDay {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  // getUTCDay(): 0=Sun..6=Sat -> ISO 1=Mon..7=Sun
  const weekday = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday,
    hour: shifted.getUTCHours(),
  };
}

function addDays(day: IstDay, count: number): IstDay {
  const date = new Date(Date.UTC(day.year, day.month, day.day + count));
  const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday,
    hour: 0,
  };
}

function isoDate(day: IstDay): string {
  const m = String(day.month + 1).padStart(2, "0");
  const d = String(day.day).padStart(2, "0");
  return `${day.year}-${m}-${d}`;
}

function parseWorkingDays(value: string): Set<number> {
  const days = value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return new Set(days.length > 0 ? days : [1, 2, 3, 4, 5, 6]);
}

function holidaySet(settings: DeliverySettings): Set<string> {
  const raw = Array.isArray(settings.holidays) ? settings.holidays : [];
  return new Set(raw.map((h) => String(h)));
}

function isWorkingDay(
  day: IstDay,
  workingDays: Set<number>,
  holidays: Set<string>,
): boolean {
  return workingDays.has(day.weekday) && !holidays.has(isoDate(day));
}

/**
 * The IST calendar day the order leaves the warehouse: today when placed
 * before the cutoff on a working day, else the next working day.
 */
export function computeDispatchDate(
  settings: DeliverySettings,
  now: Date = new Date(),
): IstDay {
  const workingDays = parseWorkingDays(settings.workingDays);
  const holidays = holidaySet(settings);
  let day = toIst(now);

  const sameDay =
    day.hour < settings.cutoffHour && isWorkingDay(day, workingDays, holidays);
  if (sameDay) return day;

  // Walk forward to the next working day (bounded: a year of holidays would
  // be a misconfiguration, not a calendar).
  for (let i = 1; i <= 366; i += 1) {
    const candidate = addDays(day, i);
    if (isWorkingDay(candidate, workingDays, holidays)) return candidate;
  }
  return addDays(day, 1);
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDay(day: IstDay): string {
  return `${WEEKDAY_NAMES[day.weekday - 1]}, ${day.day} ${MONTH_NAMES[day.month]}`;
}

export type DeliveryDateResult = {
  dispatchDate: string;
  deliveryDate: string;
  deliveryText: string;
};

export function computeDeliveryDate(
  transitDays: number,
  settings: DeliverySettings,
  now: Date = new Date(),
): DeliveryDateResult {
  const dispatch = computeDispatchDate(settings, now);
  const delivery = addDays(dispatch, Math.max(1, transitDays));

  let deliveryText: string;
  if (settings.showRange) {
    const upper = addDays(delivery, 1);
    deliveryText = `${formatDay(delivery)} – ${formatDay(upper)}`;
  } else {
    deliveryText = formatDay(delivery);
  }

  return {
    dispatchDate: isoDate(dispatch),
    deliveryDate: isoDate(delivery),
    deliveryText,
  };
}

// ---------------------------------------------------------------------------
// Estimate orchestration: cache -> Shiprocket -> compute date.
// ---------------------------------------------------------------------------

export const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;

// 500g buckets keep the cache small without materially changing the estimate.
export function weightBucketGrams(weightKg: number): number {
  const grams = Math.max(100, Math.round(weightKg * 1000));
  return Math.ceil(grams / 500) * 500;
}

export type DeliveryEstimate =
  | {
      serviceable: true;
      deliveryText: string;
      deliveryDate: string;
      dispatchDate: string;
      transitDays: number;
      courierName: string;
      mode: "surface" | "air";
      cached: boolean;
    }
  | { serviceable: false };

export async function getDeliveryEstimate(input: {
  db: PrismaClient;
  shopDomain: string;
  pincode: string;
  weightKg?: number;
  cod?: boolean;
  now?: Date;
  // Admin "test a pincode" runs the full lookup even while the storefront
  // widget is switched off.
  force?: boolean;
}): Promise<DeliveryEstimate & { enabled: boolean }> {
  const settings = await getDeliverySettings(input.db, input.shopDomain);
  if (!settings.enabled && !input.force) {
    return { enabled: false, serviceable: false };
  }
  if (!PINCODE_PATTERN.test(input.pincode)) {
    throw new ShiprocketError("Invalid pincode", 400);
  }

  const weightKg =
    input.weightKg && input.weightKg > 0
      ? Math.min(input.weightKg, 50)
      : Number(settings.defaultWeightKg);
  const bucket = weightBucketGrams(weightKg);
  const cod = input.cod ?? false;
  const now = input.now ?? new Date();

  const cached = await input.db.deliveryEstimateCache.findUnique({
    where: {
      pincode_weightBucket_cod: {
        pincode: input.pincode,
        weightBucket: bucket,
        cod,
      },
    },
  });

  let entry = cached && cached.expiresAt.getTime() > now.getTime() ? cached : null;

  if (!entry) {
    const result = await checkServiceability(input.db, {
      pickupPincode: settings.pickupPincode,
      deliveryPincode: input.pincode,
      weightKg: bucket / 1000,
      cod,
    });
    const pick = pickCourier(result, {
      strategy: settings.courierStrategy === "fastest" ? "fastest" : "recommended",
      surfaceOnly: settings.surfaceOnly,
      fallbackToAny: settings.fallbackToAny,
    });

    const expiresAt = new Date(
      now.getTime() + settings.cacheTtlMinutes * 60 * 1000,
    );
    entry = await input.db.deliveryEstimateCache.upsert({
      where: {
        pincode_weightBucket_cod: {
          pincode: input.pincode,
          weightBucket: bucket,
          cod,
        },
      },
      create: {
        pincode: input.pincode,
        weightBucket: bucket,
        cod,
        serviceable: pick != null,
        courierName: pick?.courierName ?? null,
        transitDays: pick?.transitDays ?? null,
        isSurface: pick?.isSurface ?? null,
        expiresAt,
      },
      update: {
        serviceable: pick != null,
        courierName: pick?.courierName ?? null,
        transitDays: pick?.transitDays ?? null,
        isSurface: pick?.isSurface ?? null,
        expiresAt,
        createdAt: now,
      },
    });
    entry = { ...entry, createdAt: now } as typeof entry;
    // Mark freshly fetched for the caller.
    (entry as { fresh?: boolean }).fresh = true;
  }

  if (!entry.serviceable || entry.transitDays == null) {
    return { enabled: settings.enabled, serviceable: false };
  }

  const dates = computeDeliveryDate(entry.transitDays, settings, now);
  return {
    enabled: settings.enabled,
    serviceable: true,
    deliveryText: dates.deliveryText,
    deliveryDate: dates.deliveryDate,
    dispatchDate: dates.dispatchDate,
    transitDays: entry.transitDays,
    courierName: entry.courierName ?? "Courier",
    mode: entry.isSurface === false ? "air" : "surface",
    cached: !(entry as { fresh?: boolean }).fresh,
  };
}
