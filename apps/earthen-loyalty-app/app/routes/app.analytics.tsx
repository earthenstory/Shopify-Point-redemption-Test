import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [wallets, ledgerByType, redemptionByStatus, topCustomers, recent] =
    await Promise.all([
      db.wallet.aggregate({
        _sum: {
          availablePoints: true,
          pendingPoints: true,
          lifetimeEarnedPoints: true,
          lifetimeRedeemedPoints: true,
        },
        _count: { _all: true },
      }),
      db.ledgerEntry.groupBy({
        by: ["type"],
        _sum: { pointsDelta: true },
        _count: { _all: true },
      }),
      db.redemptionSession.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      db.loyaltyCustomer.findMany({
        where: { shopDomain: session.shop },
        include: { wallet: true },
        orderBy: { wallet: { availablePoints: "desc" } },
        take: 10,
      }),
      db.ledgerEntry.findMany({
        orderBy: { createdAt: "desc" },
        take: 15,
        include: { customer: true },
      }),
    ]);

  return {
    walletCount: wallets._count._all,
    totals: wallets._sum,
    ledgerByType: ledgerByType.map((row) => ({
      type: row.type,
      points: row._sum.pointsDelta ?? 0,
      count: row._count._all,
    })),
    redemptionByStatus: redemptionByStatus.map((row) => ({
      status: row.status,
      count: row._count._all,
    })),
    topCustomers: topCustomers.map((customer) => ({
      id: customer.id,
      email: customer.email,
      shopifyCustomerId: customer.shopifyCustomerId,
      availablePoints: customer.wallet?.availablePoints ?? 0,
    })),
    recent: recent.map((entry) => ({
      id: entry.id,
      customer: entry.customer.email ?? entry.customer.shopifyCustomerId,
      type: entry.type,
      pointsDelta: entry.pointsDelta,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
};

export default function AnalyticsPage() {
  const data = useLoaderData<typeof loader>();
  const outstandingValue =
    (data.totals.availablePoints ?? 0) + (data.totals.pendingPoints ?? 0);

  return (
    <s-page heading="Analytics">
      <s-section heading="Program totals">
        <s-unordered-list>
          <s-list-item>Wallets: {data.walletCount}</s-list-item>
          <s-list-item>
            Available points: {data.totals.availablePoints ?? 0}
          </s-list-item>
          <s-list-item>Pending points: {data.totals.pendingPoints ?? 0}</s-list-item>
          <s-list-item>
            Lifetime earned: {data.totals.lifetimeEarnedPoints ?? 0}
          </s-list-item>
          <s-list-item>
            Lifetime redeemed: {data.totals.lifetimeRedeemedPoints ?? 0}
          </s-list-item>
          <s-list-item>Outstanding value estimate: INR {outstandingValue}</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Ledger by type">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Count</th>
              <th>Points</th>
            </tr>
          </thead>
          <tbody>
            {data.ledgerByType.map((row) => (
              <tr key={row.type}>
                <td>{row.type}</td>
                <td>{row.count}</td>
                <td>{row.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>

      <s-section heading="Redemptions by status">
        <table>
          <tbody>
            {data.redemptionByStatus.map((row) => (
              <tr key={row.status}>
                <td>{row.status}</td>
                <td>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>

      <s-section heading="Top customers by points">
        <table>
          <tbody>
            {data.topCustomers.map((customer) => (
              <tr key={customer.id}>
                <td>{customer.email ?? customer.shopifyCustomerId}</td>
                <td>{customer.availablePoints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>

      <s-section heading="Recent activity">
        <table>
          <tbody>
            {data.recent.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.createdAt}</td>
                <td>{entry.customer}</td>
                <td>{entry.type}</td>
                <td>{entry.pointsDelta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
