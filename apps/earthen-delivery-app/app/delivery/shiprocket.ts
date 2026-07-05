import type { PrismaClient } from "@prisma/client";

// Thin client for the public Shiprocket External API
// (https://apidocs.shiprocket.in). Auth: a dedicated API user logs in and
// receives a bearer token valid ~10 days; we cache it in the ShiprocketToken
// row and refresh with a safety margin. Serviceability returns the couriers
// (with transit-day estimates) between two pincodes for a given weight.

const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in/v1/external";
// Tokens last 240h; refresh a day early so a warm instance never holds a
// token that expires mid-request.
const TOKEN_LIFETIME_MS = 9 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

export type ShiprocketCourier = {
  courierCompanyId: number;
  courierName: string;
  transitDays: number | null;
  etd: string | null;
  isSurface: boolean;
  rate: number | null;
};

export type ServiceabilityResult = {
  serviceable: boolean;
  couriers: ShiprocketCourier[];
  recommendedCourierCompanyId: number | null;
};

export class ShiprocketError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function credentials(): { email: string; password: string } {
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) {
    throw new ShiprocketError("Shiprocket API credentials are not configured", 500);
  }
  return { email, password };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function login(): Promise<string> {
  const response = await fetchWithTimeout(`${SHIPROCKET_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials()),
  });
  const json = (await response.json().catch(() => ({}))) as {
    token?: string;
    message?: string;
  };
  if (!response.ok || !json.token) {
    throw new ShiprocketError(
      `Shiprocket login failed: ${json.message || response.status}`,
      response.status || 502,
    );
  }
  return json.token;
}

// Single-flight guard: concurrent cache misses must not stampede the login
// endpoint (each login invalidates nothing, but they're slow and rate-limited).
let inflightLogin: Promise<string> | null = null;

export async function getShiprocketToken(
  db: PrismaClient,
  options?: { forceRefresh?: boolean },
): Promise<string> {
  if (!options?.forceRefresh) {
    const row = await db.shiprocketToken.findUnique({
      where: { id: "default" },
    });
    if (row?.token && row.expiresAt && row.expiresAt.getTime() > Date.now()) {
      return row.token;
    }
  }

  if (!inflightLogin) {
    inflightLogin = (async () => {
      const token = await login();
      await db.shiprocketToken.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          token,
          expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS),
        },
        update: {
          token,
          expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS),
        },
      });
      return token;
    })().finally(() => {
      inflightLogin = null;
    });
  }
  return inflightLogin;
}

function parseCouriers(payload: unknown): ServiceabilityResult {
  const data =
    payload && typeof payload === "object"
      ? (payload as {
          data?: {
            available_courier_companies?: unknown[];
            recommended_courier_company_id?: number;
          };
        }).data
      : undefined;
  const raw = Array.isArray(data?.available_courier_companies)
    ? data.available_courier_companies
    : [];

  const couriers: ShiprocketCourier[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const transitRaw = record.estimated_delivery_days;
    const transitDays =
      transitRaw == null || transitRaw === ""
        ? null
        : Number.parseInt(String(transitRaw), 10);
    couriers.push({
      courierCompanyId: Number(record.courier_company_id) || 0,
      courierName: String(record.courier_name ?? "Courier"),
      transitDays: Number.isFinite(transitDays) ? transitDays : null,
      etd: record.etd == null ? null : String(record.etd),
      isSurface: record.is_surface === true,
      rate: typeof record.rate === "number" ? record.rate : null,
    });
  }

  return {
    serviceable: couriers.length > 0,
    couriers,
    recommendedCourierCompanyId:
      typeof data?.recommended_courier_company_id === "number"
        ? data.recommended_courier_company_id
        : null,
  };
}

export async function checkServiceability(
  db: PrismaClient,
  input: {
    pickupPincode: string;
    deliveryPincode: string;
    weightKg: number;
    cod: boolean;
  },
): Promise<ServiceabilityResult> {
  const params = new URLSearchParams({
    pickup_postcode: input.pickupPincode,
    delivery_postcode: input.deliveryPincode,
    weight: String(input.weightKg),
    cod: input.cod ? "1" : "0",
  });
  const url = `${SHIPROCKET_BASE_URL}/courier/serviceability/?${params}`;

  let token = await getShiprocketToken(db);
  let response = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // A stale/revoked token comes back 401 — refresh once and retry.
  if (response.status === 401) {
    token = await getShiprocketToken(db, { forceRefresh: true });
    response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  // Shiprocket answers 404 with a message when no courier serves the lane —
  // that is a valid "not serviceable" outcome, not an error.
  if (response.status === 404) {
    return { serviceable: false, couriers: [], recommendedCourierCompanyId: null };
  }

  if (!response.ok) {
    throw new ShiprocketError(
      `Shiprocket serviceability failed (${response.status})`,
      response.status,
    );
  }

  return parseCouriers(await response.json());
}

export type CourierPick = {
  courierName: string;
  transitDays: number;
  isSurface: boolean;
};

/**
 * Choose the courier whose estimate we show the customer. Surface couriers
 * first (we ship surface); when none serves the pincode and fallback is
 * allowed, use whatever does (typically air-only regions like the North East).
 */
export function pickCourier(
  result: ServiceabilityResult,
  options: {
    strategy: "recommended" | "fastest";
    surfaceOnly: boolean;
    fallbackToAny: boolean;
  },
): CourierPick | null {
  const usable = result.couriers.filter((c) => c.transitDays != null);
  if (usable.length === 0) return null;

  const surface = usable.filter((c) => c.isSurface);
  let pool = surface;
  if (surface.length === 0) {
    if (options.surfaceOnly && !options.fallbackToAny) return null;
    pool = usable;
  }

  let choice: ShiprocketCourier | undefined;
  if (options.strategy === "recommended" && result.recommendedCourierCompanyId) {
    choice = pool.find(
      (c) => c.courierCompanyId === result.recommendedCourierCompanyId,
    );
  }
  if (!choice) {
    choice = [...pool].sort(
      (a, b) => (a.transitDays ?? 99) - (b.transitDays ?? 99),
    )[0];
  }

  return {
    courierName: choice.courierName,
    transitDays: choice.transitDays as number,
    isSurface: choice.isSurface,
  };
}
