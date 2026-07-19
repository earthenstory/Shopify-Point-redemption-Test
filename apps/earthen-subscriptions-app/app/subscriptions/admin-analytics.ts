import type { PrismaClient } from "@prisma/client";

const DAY = 86_400_000;

export async function getAnalyticsDashboard(
  db: PrismaClient,
  shopDomain: string,
  input: { from?: Date; to?: Date } = {},
) {
  const to = input.to ?? new Date();
  const from = input.from ?? new Date(to.getTime() - 30 * DAY);
  const [groups, cycles, attempts, cancellations] = await Promise.all([
    db.subscriptionGroup.findMany({
      where: { shopDomain },
      include: { lines: true },
      orderBy: { createdAt: "asc" },
    }),
    db.billingCycle.findMany({
      where: { group: { shopDomain }, scheduledAt: { gte: from, lte: to } },
      include: { group: { select: { id: true, customerEmail: true } } },
      orderBy: { scheduledAt: "asc" },
    }),
    db.paymentAttempt.findMany({
      where: { cycle: { group: { shopDomain }, scheduledAt: { gte: from, lte: to } } },
      include: { cycle: { select: { chargeAmountPaise: true, scheduledAt: true } } },
      orderBy: { attemptedAt: "asc" },
    }),
    db.cancellationResponse.findMany({
      where: { shopDomain, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const active = groups.filter((group) => group.status === "active");
  const paused = groups.filter((group) => group.status === "paused");
  const cancelledInPeriod = groups.filter((group) => group.cancelledAt && group.cancelledAt >= from && group.cancelledAt <= to);
  const createdInPeriod = groups.filter((group) => group.createdAt >= from && group.createdAt <= to);
  const activeAtStart = groups.filter((group) =>
    group.createdAt < from && (!group.cancelledAt || group.cancelledAt >= from),
  ).length;
  const successfulCycles = cycles.filter((cycle) => ["order_created", "partially_skipped"].includes(cycle.status));
  const failedCycles = cycles.filter((cycle) => ["failed", "manual_review", "reauthorization_required"].includes(cycle.status));
  const scheduledRevenuePaise = cycles.reduce((sum, cycle) => sum + (cycle.chargeAmountPaise ?? 0), 0);
  const collectedRevenuePaise = successfulCycles.reduce((sum, cycle) => sum + (cycle.chargeAmountPaise ?? 0), 0);
  const uniqueRenewalCustomers = new Set(successfulCycles.map((cycle) => cycle.group.customerEmail)).size;

  const productMap = new Map<string, { productId: string; title: string; sku: string; units: number; subscriptions: number }>();
  for (const group of active) {
    for (const line of group.lines.filter((item) => item.status === "active")) {
      const key = line.shopifyVariantId;
      const item = productMap.get(key) ?? {
        productId: line.shopifyProductId,
        title: `${line.productTitle}${line.variantTitle ? ` — ${line.variantTitle}` : ""}`,
        sku: line.sku ?? "",
        units: 0,
        subscriptions: 0,
      };
      item.units += line.quantity;
      item.subscriptions += 1;
      productMap.set(key, item);
    }
  }

  const upcomingGroups = active.filter((group) => group.nextChargeAt && group.nextChargeAt > to);
  const forecast = (days: number) => {
    const end = new Date(to.getTime() + days * DAY);
    const rows = new Map<string, { title: string; sku: string; units: number; deliveries: number }>();
    for (const group of upcomingGroups.filter((item) => item.nextChargeAt! <= end)) {
      for (const line of group.lines.filter((item) => item.status === "active")) {
        const row = rows.get(line.shopifyVariantId) ?? {
          title: `${line.productTitle}${line.variantTitle ? ` — ${line.variantTitle}` : ""}`,
          sku: line.sku ?? "",
          units: 0,
          deliveries: 0,
        };
        row.units += line.quantity;
        row.deliveries += 1;
        rows.set(line.shopifyVariantId, row);
      }
    }
    return [...rows.entries()].map(([variantId, value]) => ({ variantId, ...value })).sort((a, b) => b.units - a.units);
  };

  const cancellationReasons = [...cancellations.reduce((map, response) => {
    const current = map.get(response.reasonCode) ?? { reasonCode: response.reasonCode, attempts: 0, cancelled: 0, retained: 0 };
    current.attempts += 1;
    if (response.cancelled) current.cancelled += 1;
    else current.retained += 1;
    map.set(response.reasonCode, current);
    return map;
  }, new Map<string, { reasonCode: string; attempts: number; cancelled: number; retained: number }>()).values()]
    .sort((a, b) => b.attempts - a.attempts);

  const paymentStatuses = attempts.reduce<Record<string, number>>((result, attempt) => {
    result[attempt.status] = (result[attempt.status] ?? 0) + 1;
    return result;
  }, {});
  const failureReasons = attempts.filter((attempt) => attempt.reason).reduce<Record<string, number>>((result, attempt) => {
    result[attempt.reason!] = (result[attempt.reason!] ?? 0) + 1;
    return result;
  }, {});

  return {
    period: { from, to },
    summary: {
      total: groups.length,
      active: active.length,
      paused: paused.length,
      cancelled: groups.filter((group) => group.status === "cancelled").length,
      newSubscriptions: createdInPeriod.length,
      cancelledInPeriod: cancelledInPeriod.length,
      churnRate: activeAtStart ? cancelledInPeriod.length / activeAtStart : 0,
      growthRate: activeAtStart ? createdInPeriod.length / activeAtStart : 0,
      scheduledRevenuePaise,
      collectedRevenuePaise,
      unresolvedRevenuePaise: Math.max(0, scheduledRevenuePaise - collectedRevenuePaise),
      paymentSuccessRate: cycles.length ? successfulCycles.length / cycles.length : 0,
      paymentFailureRate: cycles.length ? failedCycles.length / cycles.length : 0,
      averageRenewalRevenuePaise: successfulCycles.length ? Math.round(collectedRevenuePaise / successfulCycles.length) : 0,
      averageRenewalRevenuePerCustomerPaise: uniqueRenewalCustomers ? Math.round(collectedRevenuePaise / uniqueRenewalCustomers) : 0,
    },
    statusCounts: groups.reduce<Record<string, number>>((result, group) => {
      result[group.status] = (result[group.status] ?? 0) + 1;
      return result;
    }, {}),
    products: [...productMap.entries()].map(([variantId, value]) => ({ variantId, ...value })).sort((a, b) => b.units - a.units),
    inventoryForecast: { days7: forecast(7), days30: forecast(30), days90: forecast(90) },
    upcoming: upcomingGroups.slice(0, 100).map((group) => ({
      id: group.id,
      customerName: group.customerName,
      nextChargeAt: group.nextChargeAt,
      units: group.lines.filter((line) => line.status === "active").reduce((sum, line) => sum + line.quantity, 0),
    })),
    payments: { statuses: paymentStatuses, failureReasons },
    cancellationReasons,
  };
}
