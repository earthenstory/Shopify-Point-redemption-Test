import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  EmptyState,
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatSigned,
  MetricCard,
  MetricGrid,
  StatusBadge,
} from "../components/loyalty-admin-ui";
import db from "../db.server";
import { getLoyaltyRuntimeSettings } from "../loyalty/settings";
import { authenticate } from "../shopify.server";

const RANGE_OPTIONS = [
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "All time", value: "all" },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range"));
  const since = range === "all" ? null : daysAgo(Number(range));
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: session.shop,
  });
  const pointValue = settings.rules.currencyValuePerPoint;
  const customerWhere = { shopDomain: session.shop };
  const ledgerWhere = {
    customer: customerWhere,
    ...(since ? { createdAt: { gte: since } } : {}),
  };
  const redemptionWhere = {
    customer: customerWhere,
    ...(since ? { createdAt: { gte: since } } : {}),
  };

  const [
    wallets,
    customersTotal,
    customersInRange,
    ledgerByType,
    ledgerTotals,
    redemptionByStatus,
    topCustomers,
    recent,
    activeRedemptions,
  ] = await Promise.all([
    db.wallet.aggregate({
      where: { customer: customerWhere },
      _sum: {
        availablePoints: true,
        pendingPoints: true,
        lifetimeEarnedPoints: true,
        lifetimeRedeemedPoints: true,
        lifetimeExpiredPoints: true,
      },
      _count: { _all: true },
    }),
    db.loyaltyCustomer.count({ where: customerWhere }),
    db.loyaltyCustomer.count({
      where: {
        ...customerWhere,
        ...(since ? { createdAt: { gte: since } } : {}),
      },
    }),
    db.ledgerEntry.groupBy({
      by: ["type"],
      where: ledgerWhere,
      _sum: { pointsDelta: true },
      _count: { _all: true },
      orderBy: { _count: { type: "desc" } },
    }),
    db.ledgerEntry.aggregate({
      where: ledgerWhere,
      _sum: { pointsDelta: true },
      _count: { _all: true },
    }),
    db.redemptionSession.groupBy({
      by: ["status"],
      where: redemptionWhere,
      _count: { _all: true },
      _sum: {
        pointsReserved: true,
        pointsConsumed: true,
        pointsReleased: true,
      },
    }),
    db.loyaltyCustomer.findMany({
      where: customerWhere,
      include: { wallet: true },
      orderBy: { wallet: { availablePoints: "desc" } },
      take: 10,
    }),
    db.ledgerEntry.findMany({
      where: { customer: customerWhere },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { customer: true },
    }),
    db.redemptionSession.count({
      where: {
        customer: customerWhere,
        status: { in: ["pending", "applied"] },
      },
    }),
  ]);

  const availablePoints = wallets._sum.availablePoints ?? 0;
  const pendingPoints = wallets._sum.pendingPoints ?? 0;
  const outstandingPoints = availablePoints + pendingPoints;
  const ledgerPointMagnitude = ledgerByType.reduce(
    (sum, row) => sum + Math.abs(row._sum.pointsDelta ?? 0),
    0,
  );

  return {
    range,
    rangeLabel: rangeLabel(range),
    customersTotal,
    customersInRange,
    walletCount: wallets._count._all,
    totals: {
      availablePoints,
      pendingPoints,
      outstandingPoints,
      outstandingValue: outstandingPoints * pointValue,
      lifetimeEarnedPoints: wallets._sum.lifetimeEarnedPoints ?? 0,
      lifetimeRedeemedPoints: wallets._sum.lifetimeRedeemedPoints ?? 0,
      lifetimeExpiredPoints: wallets._sum.lifetimeExpiredPoints ?? 0,
    },
    ledgerSummary: {
      count: ledgerTotals._count._all,
      netPoints: ledgerTotals._sum.pointsDelta ?? 0,
    },
    ledgerByType: ledgerByType.map((row) => ({
      type: row.type,
      label: labelize(row.type),
      points: row._sum.pointsDelta ?? 0,
      count: row._count._all,
      share:
        ledgerPointMagnitude > 0
          ? Math.round((Math.abs(row._sum.pointsDelta ?? 0) / ledgerPointMagnitude) * 100)
          : 0,
    })),
    redemptionByStatus: redemptionByStatus.map((row) => ({
      status: row.status,
      count: row._count._all,
      pointsReserved: row._sum.pointsReserved ?? 0,
      pointsConsumed: row._sum.pointsConsumed ?? 0,
      pointsReleased: row._sum.pointsReleased ?? 0,
    })),
    activeRedemptions,
    topCustomers: topCustomers.map((customer) => ({
      id: customer.id,
      email: customer.email,
      phone: customer.phone,
      name: [customer.firstName, customer.lastName].filter(Boolean).join(" "),
      shopifyCustomerId: customer.shopifyCustomerId,
      availablePoints: customer.wallet?.availablePoints ?? 0,
      pendingPoints: customer.wallet?.pendingPoints ?? 0,
      lifetimeRedeemedPoints: customer.wallet?.lifetimeRedeemedPoints ?? 0,
    })),
    recent: recent.map((entry) => ({
      id: entry.id,
      customer: entry.customer.email ?? entry.customer.phone ?? entry.customer.shopifyCustomerId,
      type: labelize(entry.type),
      pointsDelta: entry.pointsDelta,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
};

export default function AnalyticsPage() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Analytics">
      <s-section heading="Reporting window">
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <div style={{ width: 220 }}>
              <s-select name="range" label="Period" value={data.range}>
                {RANGE_OPTIONS.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>
            </div>
            <s-button type="submit">Apply</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Program performance">
        <MetricGrid>
          <MetricCard
            label="Customers"
            value={formatNumber(data.customersTotal)}
            detail={`${formatNumber(data.customersInRange)} added in ${data.rangeLabel}`}
            tone="info"
          />
          <MetricCard
            label="Outstanding points"
            value={formatNumber(data.totals.outstandingPoints)}
            detail={`${formatCurrency(data.totals.outstandingValue)} estimated liability`}
            tone="warning"
          />
          <MetricCard
            label="Lifetime earned"
            value={formatNumber(data.totals.lifetimeEarnedPoints)}
            detail="All wallets"
            tone="success"
          />
          <MetricCard
            label="Lifetime redeemed"
            value={formatNumber(data.totals.lifetimeRedeemedPoints)}
            detail={`${formatNumber(data.activeRedemptions)} active reservations`}
          />
        </MetricGrid>
      </s-section>

      <s-section heading="Point movement">
        <MetricGrid>
          <MetricCard
            label={`Ledger entries in ${data.rangeLabel}`}
            value={formatNumber(data.ledgerSummary.count)}
            detail={`Net movement ${formatSigned(data.ledgerSummary.netPoints)} points`}
            tone={data.ledgerSummary.netPoints >= 0 ? "success" : "warning"}
          />
          <MetricCard
            label="Available"
            value={formatNumber(data.totals.availablePoints)}
            detail="Customer redeemable balance"
            tone="success"
          />
          <MetricCard
            label="Pending"
            value={formatNumber(data.totals.pendingPoints)}
            detail="Reserved before checkout"
            tone={data.totals.pendingPoints > 0 ? "warning" : "neutral"}
          />
          <MetricCard
            label="Expired"
            value={formatNumber(data.totals.lifetimeExpiredPoints)}
            detail="Lifetime expired points"
          />
        </MetricGrid>
      </s-section>

      <s-section heading="Ledger by activity">
        {data.ledgerByType.length > 0 ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Activity</s-table-header>
              <s-table-header format="numeric">Entries</s-table-header>
              <s-table-header format="numeric">Points</s-table-header>
              <s-table-header>Share</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.ledgerByType.map((row) => (
                <s-table-row key={row.type}>
                  <s-table-cell>{row.label}</s-table-cell>
                  <s-table-cell>{formatNumber(row.count)}</s-table-cell>
                  <s-table-cell>{formatSigned(row.points)}</s-table-cell>
                  <s-table-cell>
                    <ShareBar percent={row.share} />
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <EmptyState
            heading="No point activity"
            message="There are no ledger entries in the selected reporting window."
          />
        )}
      </s-section>

      <s-section heading="Redemptions">
        {data.redemptionByStatus.length > 0 ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Status</s-table-header>
              <s-table-header format="numeric">Sessions</s-table-header>
              <s-table-header format="numeric">Reserved</s-table-header>
              <s-table-header format="numeric">Consumed</s-table-header>
              <s-table-header format="numeric">Released</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.redemptionByStatus.map((row) => (
                <s-table-row key={row.status}>
                  <s-table-cell>
                    <StatusBadge tone={redemptionTone(row.status)}>
                      {labelize(row.status)}
                    </StatusBadge>
                  </s-table-cell>
                  <s-table-cell>{formatNumber(row.count)}</s-table-cell>
                  <s-table-cell>{formatNumber(row.pointsReserved)}</s-table-cell>
                  <s-table-cell>{formatNumber(row.pointsConsumed)}</s-table-cell>
                  <s-table-cell>{formatNumber(row.pointsReleased)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <EmptyState
            heading="No redemptions yet"
            message="Redemption sessions will appear here after customers apply points in cart."
          />
        )}
      </s-section>

      <s-section heading="Top customers by points">
        {data.topCustomers.length > 0 ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Customer</s-table-header>
              <s-table-header format="numeric">Available</s-table-header>
              <s-table-header format="numeric">Pending</s-table-header>
              <s-table-header format="numeric">Redeemed</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.topCustomers.map((customer) => (
                <s-table-row key={customer.id}>
                  <s-table-cell>
                    <div style={{ fontWeight: 650 }}>
                      {customer.name || customer.email || customer.phone || customer.shopifyCustomerId}
                    </div>
                    <s-text color="subdued">
                      {customer.email ?? customer.phone ?? customer.shopifyCustomerId}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>{formatNumber(customer.availablePoints)}</s-table-cell>
                  <s-table-cell>{formatNumber(customer.pendingPoints)}</s-table-cell>
                  <s-table-cell>{formatNumber(customer.lifetimeRedeemedPoints)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <EmptyState
            heading="No customers yet"
            message="Imported or newly enrolled loyalty customers will appear here."
          />
        )}
      </s-section>

      <s-section heading="Recent point activity">
        {data.recent.length > 0 ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Time</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Activity</s-table-header>
              <s-table-header format="numeric">Points</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.recent.map((entry) => (
                <s-table-row key={entry.id}>
                  <s-table-cell>{formatDateTime(entry.createdAt)}</s-table-cell>
                  <s-table-cell>{entry.customer}</s-table-cell>
                  <s-table-cell>{entry.type}</s-table-cell>
                  <s-table-cell>{formatSigned(entry.pointsDelta)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <EmptyState
            heading="No recent activity"
            message="Ledger movement will appear here as customers earn, redeem, migrate, or receive adjustments."
          />
        )}
      </s-section>
    </s-page>
  );
}

function ShareBar({ percent }: { percent: number }) {
  return (
    <div style={{ alignItems: "center", display: "flex", gap: 8, minWidth: 160 }}>
      <div
        style={{
          background: "#e3e3e3",
          borderRadius: 999,
          height: 8,
          overflow: "hidden",
          width: 120,
        }}
      >
        <div
          style={{
            background: "#2c6ecb",
            height: "100%",
            width: `${Math.max(0, Math.min(100, percent))}%`,
          }}
        />
      </div>
      <s-text color="subdued">{percent}%</s-text>
    </div>
  );
}

function parseRange(value: string | null) {
  return RANGE_OPTIONS.some((option) => option.value === value)
    ? (value as (typeof RANGE_OPTIONS)[number]["value"])
    : "30";
}

function rangeLabel(range: string) {
  if (range === "all") return "all time";
  return `last ${range} days`;
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function labelize(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function redemptionTone(status: string) {
  switch (status) {
    case "consumed":
      return "success" as const;
    case "pending":
    case "applied":
      return "warning" as const;
    case "expired":
    case "cancelled":
      return "critical" as const;
    default:
      return "neutral" as const;
  }
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
