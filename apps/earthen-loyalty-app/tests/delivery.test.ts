import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverySettings } from "@prisma/client";
import {
  computeDeliveryDate,
  computeDispatchDate,
  getDeliveryEstimate,
  invalidateDeliverySettings,
  weightBucketGrams,
} from "../app/loyalty/delivery";
import {
  checkServiceability,
  pickCourier,
  type ServiceabilityResult,
} from "../app/loyalty/shiprocket";

const SHOP = "701031-e7.myshopify.com";

function makeSettings(overrides: Partial<DeliverySettings> = {}): DeliverySettings {
  return {
    shopDomain: SHOP,
    enabled: true,
    pickupPincode: "560048",
    cutoffHour: 11,
    workingDays: "1,2,3,4,5,6",
    holidays: [],
    defaultWeightKg: 0.5 as never,
    courierStrategy: "recommended",
    surfaceOnly: true,
    fallbackToAny: true,
    showRange: false,
    widgetTitle: "Check delivery date",
    cacheTtlMinutes: 720,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DeliverySettings;
}

// IST = UTC+5:30. Helper: build a UTC Date whose IST wall clock is as given.
function istDate(iso: string, hour: number, minute = 0): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 5, minute - 30));
}

beforeEach(() => invalidateDeliverySettings(SHOP));

describe("computeDispatchDate — 11:00 IST cutoff, Mon-Sat working", () => {
  const settings = makeSettings();

  it("dispatches same day before cutoff on a working day", () => {
    // Sat 4 Jul 2026, 09:00 IST
    const dispatch = computeDispatchDate(settings, istDate("2026-07-04", 9));
    expect(dispatch.day).toBe(4);
  });

  it("dispatches next working day after cutoff (Sat -> Mon, Sunday skipped)", () => {
    // Sat 4 Jul 2026, 11:30 IST
    const dispatch = computeDispatchDate(settings, istDate("2026-07-04", 11, 30));
    expect(dispatch.day).toBe(6); // Mon 6 Jul
    expect(dispatch.weekday).toBe(1);
  });

  it("dispatches exactly at the cutoff hour as next day (11:00 is past cutoff)", () => {
    const dispatch = computeDispatchDate(settings, istDate("2026-07-03", 11, 0));
    expect(dispatch.day).toBe(4); // Fri 11:00 -> Sat
  });

  it("never dispatches on a Sunday", () => {
    // Sun 5 Jul 2026, 09:00 IST — Sunday is not a working day even pre-cutoff
    const dispatch = computeDispatchDate(settings, istDate("2026-07-05", 9));
    expect(dispatch.day).toBe(6);
    expect(dispatch.weekday).toBe(1);
  });

  it("skips holidays from the calendar", () => {
    const withHoliday = makeSettings({ holidays: ["2026-07-06"] as never });
    // Sat after cutoff -> Mon is a holiday -> Tue 7 Jul
    const dispatch = computeDispatchDate(withHoliday, istDate("2026-07-04", 12));
    expect(dispatch.day).toBe(7);
    expect(dispatch.weekday).toBe(2);
  });

  it("handles the IST/UTC date boundary (late-night UTC is next-day IST)", () => {
    // 2026-07-04 20:00 UTC == 2026-07-05 01:30 IST (Sunday) -> Monday
    const dispatch = computeDispatchDate(
      settings,
      new Date(Date.UTC(2026, 6, 4, 20, 0)),
    );
    expect(dispatch.day).toBe(6);
  });
});

describe("computeDeliveryDate", () => {
  it("adds transit days to the dispatch day", () => {
    const settings = makeSettings();
    // Sat 4 Jul before cutoff -> dispatch Sat, +4 transit -> Wed 8 Jul
    const result = computeDeliveryDate(4, settings, istDate("2026-07-04", 9));
    expect(result.dispatchDate).toBe("2026-07-04");
    expect(result.deliveryDate).toBe("2026-07-08");
    expect(result.deliveryText).toBe("Wed, 8 Jul");
  });

  it("formats a range when showRange is on", () => {
    const settings = makeSettings({ showRange: true });
    const result = computeDeliveryDate(4, settings, istDate("2026-07-04", 9));
    expect(result.deliveryText).toBe("Wed, 8 Jul – Thu, 9 Jul");
  });

  it("treats zero/negative transit as at least one day", () => {
    const settings = makeSettings();
    const result = computeDeliveryDate(0, settings, istDate("2026-07-04", 9));
    expect(result.deliveryDate).toBe("2026-07-05");
  });
});

describe("weightBucketGrams", () => {
  it("rounds up to 500g buckets", () => {
    expect(weightBucketGrams(0.2)).toBe(500);
    expect(weightBucketGrams(0.5)).toBe(500);
    expect(weightBucketGrams(0.51)).toBe(1000);
    expect(weightBucketGrams(1)).toBe(1000);
    expect(weightBucketGrams(1.2)).toBe(1500);
  });
});

describe("pickCourier", () => {
  const result: ServiceabilityResult = {
    serviceable: true,
    recommendedCourierCompanyId: 22,
    couriers: [
      { courierCompanyId: 22, courierName: "Bluedart Surface", transitDays: 4, etd: null, isSurface: true, rate: 118 },
      { courierCompanyId: 43, courierName: "Delhivery Surface", transitDays: 3, etd: null, isSurface: true, rate: 103 },
      { courierCompanyId: 9, courierName: "Blue Dart Air", transitDays: 2, etd: null, isSurface: false, rate: 200 },
    ],
  };

  it("uses the recommended surface courier by default", () => {
    const pick = pickCourier(result, {
      strategy: "recommended",
      surfaceOnly: true,
      fallbackToAny: true,
    });
    expect(pick?.courierName).toBe("Bluedart Surface");
    expect(pick?.isSurface).toBe(true);
  });

  it("uses the fastest surface courier under the fastest strategy", () => {
    const pick = pickCourier(result, {
      strategy: "fastest",
      surfaceOnly: true,
      fallbackToAny: true,
    });
    expect(pick?.courierName).toBe("Delhivery Surface");
    expect(pick?.transitDays).toBe(3);
  });

  it("never picks an air courier while surface couriers exist", () => {
    const pick = pickCourier(result, {
      strategy: "fastest",
      surfaceOnly: true,
      fallbackToAny: true,
    });
    expect(pick?.isSurface).toBe(true);
  });

  it("falls back to air for air-only pincodes when allowed", () => {
    const airOnly: ServiceabilityResult = {
      serviceable: true,
      recommendedCourierCompanyId: null,
      couriers: [result.couriers[2]],
    };
    const pick = pickCourier(airOnly, {
      strategy: "recommended",
      surfaceOnly: true,
      fallbackToAny: true,
    });
    expect(pick?.courierName).toBe("Blue Dart Air");
    expect(pick?.isSurface).toBe(false);
  });

  it("returns null for air-only pincodes when strict surface-only", () => {
    const airOnly: ServiceabilityResult = {
      serviceable: true,
      recommendedCourierCompanyId: null,
      couriers: [result.couriers[2]],
    };
    const pick = pickCourier(airOnly, {
      strategy: "recommended",
      surfaceOnly: true,
      fallbackToAny: false,
    });
    expect(pick).toBeNull();
  });

  it("returns null when nothing is serviceable", () => {
    const pick = pickCourier(
      { serviceable: false, couriers: [], recommendedCourierCompanyId: null },
      { strategy: "recommended", surfaceOnly: true, fallbackToAny: true },
    );
    expect(pick).toBeNull();
  });
});

describe("checkServiceability (mocked fetch)", () => {
  const tokenRow = {
    id: "default",
    token: "tok-1",
    expiresAt: new Date(Date.now() + 86_400_000),
    updatedAt: new Date(),
  };

  function makeDb(overrides: Record<string, unknown> = {}) {
    return {
      shiprocketToken: {
        findUnique: vi.fn().mockResolvedValue(tokenRow),
        upsert: vi.fn().mockResolvedValue(tokenRow),
      },
      ...overrides,
    };
  }

  const goodBody = {
    status: 200,
    data: {
      recommended_courier_company_id: 22,
      available_courier_companies: [
        {
          courier_company_id: 22,
          courier_name: "Bluedart Surface",
          estimated_delivery_days: "4",
          etd: "Jul 09, 2026",
          is_surface: true,
          rate: 118.65,
        },
        {
          courier_company_id: 9,
          courier_name: "Blue Dart Air",
          estimated_delivery_days: "2",
          etd: "Jul 07, 2026",
          is_surface: false,
          rate: 200,
        },
      ],
    },
  };

  afterEach(() => vi.unstubAllGlobals());

  it("parses couriers, transit days, and the recommended id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(goodBody), { status: 200 }),
      ),
    );
    const result = await checkServiceability(makeDb() as never, {
      pickupPincode: "560048",
      deliveryPincode: "110001",
      weightKg: 1,
      cod: false,
    });
    expect(result.serviceable).toBe(true);
    expect(result.couriers).toHaveLength(2);
    expect(result.couriers[0]).toMatchObject({
      courierName: "Bluedart Surface",
      transitDays: 4,
      isSurface: true,
    });
    expect(result.recommendedCourierCompanyId).toBe(22);
  });

  it("treats Shiprocket's 404 as non-serviceable, not an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ message: "No courier service available" }),
          { status: 404 },
        ),
      ),
    );
    const result = await checkServiceability(makeDb() as never, {
      pickupPincode: "560048",
      deliveryPincode: "999999",
      weightKg: 1,
      cod: false,
    });
    expect(result.serviceable).toBe(false);
    expect(result.couriers).toHaveLength(0);
  });

  it("re-logins once on 401 and retries", async () => {
    process.env.SHIPROCKET_EMAIL = "api@test";
    process.env.SHIPROCKET_PASSWORD = "pwd";
    const fetchMock = vi
      .fn()
      // first serviceability call: stale token
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      // login
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "tok-2" }), { status: 200 }),
      )
      // retried serviceability
      .mockResolvedValueOnce(
        new Response(JSON.stringify(goodBody), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkServiceability(makeDb() as never, {
      pickupPincode: "560048",
      deliveryPincode: "110001",
      weightKg: 1,
      cod: false,
    });
    expect(result.serviceable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const loginCall = fetchMock.mock.calls[1][0] as string;
    expect(loginCall).toContain("/auth/login");
  });
});

describe("getDeliveryEstimate — cache + orchestration", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeDb(input: {
    settings?: Partial<DeliverySettings>;
    cachedRow?: unknown;
  }) {
    const upserts: unknown[] = [];
    const db = {
      deliverySettings: {
        upsert: vi.fn().mockResolvedValue(makeSettings(input.settings)),
      },
      deliveryEstimateCache: {
        findUnique: vi.fn().mockResolvedValue(input.cachedRow ?? null),
        upsert: vi.fn().mockImplementation((args: { create: unknown }) => {
          upserts.push(args);
          return Promise.resolve({
            ...(args.create as Record<string, unknown>),
            id: "cache-1",
            createdAt: new Date(),
          });
        }),
      },
      shiprocketToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: "default",
          token: "tok",
          expiresAt: new Date(Date.now() + 86_400_000),
          updatedAt: new Date(),
        }),
        upsert: vi.fn(),
      },
    };
    return { db, upserts };
  }

  it("returns disabled without calling anything when the feature is off", async () => {
    const { db } = makeDb({ settings: { enabled: false } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const estimate = await getDeliveryEstimate({
      db: db as never,
      shopDomain: SHOP,
      pincode: "110001",
    });
    expect(estimate.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves from a valid cache row with zero upstream calls", async () => {
    const { db } = makeDb({
      cachedRow: {
        id: "c1",
        pincode: "110001",
        weightBucket: 500,
        cod: false,
        serviceable: true,
        courierName: "Bluedart Surface",
        transitDays: 4,
        isSurface: true,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const estimate = await getDeliveryEstimate({
      db: db as never,
      shopDomain: SHOP,
      pincode: "110001",
      weightKg: 0.5,
      now: istDate("2026-07-04", 9),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estimate).toMatchObject({
      serviceable: true,
      cached: true,
      transitDays: 4,
      deliveryDate: "2026-07-08",
      mode: "surface",
    });
  });

  it("computes the date fresh even from an old cache row (caches days, not dates)", async () => {
    const { db } = makeDb({
      cachedRow: {
        id: "c1",
        pincode: "110001",
        weightBucket: 500,
        cod: false,
        serviceable: true,
        courierName: "Bluedart Surface",
        transitDays: 4,
        isSurface: true,
        expiresAt: new Date(istDate("2026-07-07", 9).getTime() + 60_000),
        createdAt: istDate("2026-07-04", 9),
      },
    });
    vi.stubGlobal("fetch", vi.fn());

    // Two days later, same cache row -> delivery date moves with "today".
    const estimate = await getDeliveryEstimate({
      db: db as never,
      shopDomain: SHOP,
      pincode: "110001",
      weightKg: 0.5,
      now: istDate("2026-07-06", 9), // Monday before cutoff
    });
    expect(estimate.serviceable && estimate.deliveryDate).toBe("2026-07-10");
  });

  it("fetches, stores transit days, and flags cached=false on a miss", async () => {
    const { db, upserts } = makeDb({});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 200,
            data: {
              recommended_courier_company_id: 22,
              available_courier_companies: [
                {
                  courier_company_id: 22,
                  courier_name: "Bluedart Surface",
                  estimated_delivery_days: "4",
                  etd: "x",
                  is_surface: true,
                  rate: 1,
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const estimate = await getDeliveryEstimate({
      db: db as never,
      shopDomain: SHOP,
      pincode: "110001",
      weightKg: 0.5,
      now: istDate("2026-07-04", 9),
    });
    expect(estimate).toMatchObject({
      serviceable: true,
      cached: false,
      transitDays: 4,
    });
    expect(upserts).toHaveLength(1);
    const stored = (upserts[0] as { create: Record<string, unknown> }).create;
    expect(stored.transitDays).toBe(4);
    expect(stored).not.toHaveProperty("deliveryDate");
  });

  it("stores and returns non-serviceable results", async () => {
    const { db } = makeDb({});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "none" }), { status: 404 }),
      ),
    );
    const estimate = await getDeliveryEstimate({
      db: db as never,
      shopDomain: SHOP,
      pincode: "999888",
    });
    expect(estimate.enabled).toBe(true);
    expect(estimate.serviceable).toBe(false);
  });

  it("rejects malformed pincodes before touching the API", async () => {
    const { db } = makeDb({});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      getDeliveryEstimate({
        db: db as never,
        shopDomain: SHOP,
        pincode: "12ab56",
      }),
    ).rejects.toThrow("Invalid pincode");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
