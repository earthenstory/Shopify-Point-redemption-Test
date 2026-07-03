import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  EmptyState,
  formatDate,
  formatDateTime,
  formatNumber,
  formatSigned,
  MetricCard,
  MetricGrid,
  shortId,
  StatusBadge,
} from "../components/loyalty-admin-ui";
import db from "../db.server";
import { releaseRedemption } from "../loyalty/redemptions";
import { formNumber } from "../loyalty/settings";
import { authenticate, unauthenticated } from "../shopify.server";

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const pageSize = parsePageSize(url.searchParams.get("limit"));
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const rawPage = Number.isFinite(requestedPage)
    ? Math.max(1, Math.floor(requestedPage))
    : 1;
  const selectedCustomerId = url.searchParams.get("customerId");
  const where = {
    shopDomain: session.shop,
    ...(query
      ? {
          OR: [
            { shopifyCustomerId: { contains: query } },
            { email: { contains: query, mode: "insensitive" as const } },
            { phone: { contains: query } },
            { firstName: { contains: query, mode: "insensitive" as const } },
            { lastName: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const totalCustomers = await db.loyaltyCustomer.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCustomers / pageSize));
  const page = Math.min(rawPage, totalPages);

  const [customers, walletTotals, selectedCustomer] = await Promise.all([
      db.loyaltyCustomer.findMany({
        where,
        include: {
          wallet: true,
          _count: {
            select: {
              ledgerEntries: true,
              redemptions: true,
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { email: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.wallet.aggregate({
        where: { customer: { shopDomain: session.shop } },
        _sum: {
          availablePoints: true,
          pendingPoints: true,
          lifetimeEarnedPoints: true,
          lifetimeRedeemedPoints: true,
        },
        _count: { _all: true },
      }),
      selectedCustomerId
        ? db.loyaltyCustomer.findFirst({
            where: { id: selectedCustomerId, shopDomain: session.shop },
            include: {
              wallet: true,
              ledgerEntries: {
                orderBy: { createdAt: "desc" },
                take: 25,
              },
              redemptions: {
                where: { status: { in: ["pending", "applied"] } },
                orderBy: { createdAt: "desc" },
                take: 10,
              },
            },
          })
        : null,
    ]);

  const hasPreviousPage = page > 1;
  const hasNextPage = page < totalPages;

  return {
    query,
    page,
    pageSize,
    totalCustomers,
    totalPages,
    hasPreviousPage,
    hasNextPage,
    totals: {
      walletCount: walletTotals._count._all,
      availablePoints: walletTotals._sum.availablePoints ?? 0,
      pendingPoints: walletTotals._sum.pendingPoints ?? 0,
      lifetimeEarnedPoints: walletTotals._sum.lifetimeEarnedPoints ?? 0,
      lifetimeRedeemedPoints: walletTotals._sum.lifetimeRedeemedPoints ?? 0,
    },
    customers: customers.map((customer) => ({
      id: customer.id,
      shopifyCustomerId: customer.shopifyCustomerId,
      email: customer.email,
      phone: customer.phone,
      firstName: customer.firstName,
      lastName: customer.lastName,
      status: customer.status,
      availablePoints: customer.wallet?.availablePoints ?? 0,
      pendingPoints: customer.wallet?.pendingPoints ?? 0,
      lifetimeEarnedPoints: customer.wallet?.lifetimeEarnedPoints ?? 0,
      lifetimeRedeemedPoints: customer.wallet?.lifetimeRedeemedPoints ?? 0,
      ledgerCount: customer._count.ledgerEntries,
      redemptionCount: customer._count.redemptions,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
    })),
    selectedCustomer: selectedCustomer
      ? {
          id: selectedCustomer.id,
          shopifyCustomerId: selectedCustomer.shopifyCustomerId,
          email: selectedCustomer.email,
          phone: selectedCustomer.phone,
          firstName: selectedCustomer.firstName,
          lastName: selectedCustomer.lastName,
          status: selectedCustomer.status,
          createdAt: selectedCustomer.createdAt.toISOString(),
          wallet: selectedCustomer.wallet,
          ledgerEntries: selectedCustomer.ledgerEntries.map((entry) => ({
            id: entry.id,
            type: entry.type,
            pointsDelta: entry.pointsDelta,
            moneyValue: entry.moneyValue ? Number(entry.moneyValue) : null,
            description: entry.description,
            createdAt: entry.createdAt.toISOString(),
          })),
          redemptions: selectedCustomer.redemptions.map((redemption) => ({
            id: redemption.id,
            status: redemption.status,
            cartToken: redemption.cartToken,
            pointsReserved: redemption.pointsReserved,
            pointsConsumed: redemption.pointsConsumed,
            pointsReleased: redemption.pointsReleased,
            discountCode: redemption.discountCode,
            expiresAt: redemption.expiresAt.toISOString(),
          })),
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "adjust") {
      const customerId = String(form.get("customerId"));
      const reason = String(form.get("reason") ?? "").trim();
      const points = formNumber(form.get("points"));
      if (!reason) throw new Error("Manual adjustment reason is required.");
      if (!Number.isInteger(points) || points === 0) {
        throw new Error("Adjustment points must be a non-zero integer.");
      }

      const customer = await db.loyaltyCustomer.findFirst({
        where: { id: customerId, shopDomain: session.shop },
        include: { wallet: true },
      });
      if (!customer?.wallet) throw new Error("Customer wallet was not found.");
      if (points < 0 && customer.wallet.availablePoints + points < 0) {
        throw new Error("Adjustment would make available points negative.");
      }

      await db.$transaction(async (tx) => {
        const before = customer.wallet;
        const wallet = await tx.wallet.update({
          where: { id: customer.wallet!.id },
          data: {
            availablePoints: { increment: points },
            lifetimeEarnedPoints:
              points > 0 ? { increment: points } : undefined,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            customerId: customer.id,
            walletId: customer.wallet!.id,
            type: "manual_adjustment",
            pointsDelta: points,
            currency: "INR",
            description: reason,
            metadata: { adminUser: session.id },
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminUser: session.id,
            action: "manual_points_adjustment",
            customerId: customer.id,
            before: JSON.parse(JSON.stringify(before ?? {})),
            after: JSON.parse(JSON.stringify(wallet)),
            reason,
          },
        });
      });
      return { ok: true, message: "Manual adjustment saved." };
    }

    if (intent === "release") {
      const customerId = String(form.get("customerId"));
      const redemptionSessionId = String(form.get("redemptionSessionId"));
      const customer = await db.loyaltyCustomer.findFirst({
        where: { id: customerId, shopDomain: session.shop },
      });
      if (!customer) throw new Error("Customer was not found.");
      const { admin } = await unauthenticated.admin(session.shop);
      const result = await releaseRedemption({
        db,
        admin,
        shopDomain: session.shop,
        shopifyCustomerId: customer.shopifyCustomerId,
        sessionId: redemptionSessionId,
        reason: "Admin manually released redemption session",
      });
      return {
        ok: result.released,
        message: result.released
          ? "Redemption session released."
          : "No releasable redemption session found.",
      };
    }

    throw new Error("Unsupported customer action.");
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Customer action failed.",
    };
  }
};

export default function CustomersPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [search, setSearch] = useState(data.query);
  const isLoading = navigation.state !== "idle";

  return (
    <s-page heading="Customer data">
      {actionData?.message ? (
        <s-banner tone={actionData.ok ? "success" : "critical"}>
          {actionData.message}
        </s-banner>
      ) : null}

      <s-section heading="Customer lookup">
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <div style={{ minWidth: 280, width: "min(520px, 100%)" }}>
              <s-text-field
                name="q"
                label="Search"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value ?? "")}
                placeholder="Email, phone, name, or Shopify customer ID"
              ></s-text-field>
            </div>
            <s-button type="submit" loading={isLoading}>
              Search
            </s-button>
            {data.query ? (
              <s-button href="/app/customers" variant="secondary">
                Clear
              </s-button>
            ) : null}
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Program totals">
        <MetricGrid>
          <MetricCard
            label="Customers"
            value={formatNumber(data.totals.walletCount)}
            detail={`${formatNumber(data.totalCustomers)} visible in this view`}
            tone="info"
          />
          <MetricCard
            label="Available points"
            value={formatNumber(data.totals.availablePoints)}
            detail="Ready to redeem"
            tone="success"
          />
          <MetricCard
            label="Pending points"
            value={formatNumber(data.totals.pendingPoints)}
            detail="Reserved in active carts"
            tone={data.totals.pendingPoints > 0 ? "warning" : "neutral"}
          />
          <MetricCard
            label="Lifetime redeemed"
            value={formatNumber(data.totals.lifetimeRedeemedPoints)}
            detail="Consumed through orders"
          />
        </MetricGrid>
      </s-section>

      <s-section heading="Customers">
        <CustomerPagination
          hasNextPage={data.hasNextPage}
          hasPreviousPage={data.hasPreviousPage}
          page={data.page}
          pageSize={data.pageSize}
          query={data.query}
          totalCustomers={data.totalCustomers}
          totalPages={data.totalPages}
        />

        {data.customers.length > 0 ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Customer</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header format="numeric">Available</s-table-header>
              <s-table-header format="numeric">Pending</s-table-header>
              <s-table-header format="numeric">Redeemed</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.customers.map((customer) => (
                <s-table-row key={customer.id}>
                  <s-table-cell>
                    <CustomerIdentity customer={customer} />
                  </s-table-cell>
                  <s-table-cell>
                    <StatusBadge tone={customer.status === "active" ? "success" : "warning"}>
                      {customer.status === "active" ? "Included" : customer.status}
                    </StatusBadge>
                  </s-table-cell>
                  <s-table-cell>{formatNumber(customer.availablePoints)}</s-table-cell>
                  <s-table-cell>{formatNumber(customer.pendingPoints)}</s-table-cell>
                  <s-table-cell>
                    {formatNumber(customer.lifetimeRedeemedPoints)}
                  </s-table-cell>
                  <s-table-cell>{formatDate(customer.createdAt)}</s-table-cell>
                  <s-table-cell>
                    <s-button
                      href={customerHref(
                        customer.id,
                        data.page,
                        data.query,
                        data.pageSize,
                      )}
                      variant="secondary"
                    >
                      View
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <EmptyState
            heading="No customers found"
            message="Change the search term or clear filters to return to the full loyalty customer list."
          />
        )}
        <CustomerPagination
          hasNextPage={data.hasNextPage}
          hasPreviousPage={data.hasPreviousPage}
          page={data.page}
          pageSize={data.pageSize}
          query={data.query}
          totalCustomers={data.totalCustomers}
          totalPages={data.totalPages}
        />
      </s-section>

      {data.selectedCustomer ? (
        <>
          <s-section heading="Selected customer">
            <MetricGrid>
              <MetricCard
                label="Available"
                value={formatNumber(
                  data.selectedCustomer.wallet?.availablePoints ?? 0,
                )}
                tone="success"
              />
              <MetricCard
                label="Pending"
                value={formatNumber(data.selectedCustomer.wallet?.pendingPoints ?? 0)}
                tone={
                  (data.selectedCustomer.wallet?.pendingPoints ?? 0) > 0
                    ? "warning"
                    : "neutral"
                }
              />
              <MetricCard
                label="Lifetime earned"
                value={formatNumber(
                  data.selectedCustomer.wallet?.lifetimeEarnedPoints ?? 0,
                )}
              />
              <MetricCard
                label="Lifetime redeemed"
                value={formatNumber(
                  data.selectedCustomer.wallet?.lifetimeRedeemedPoints ?? 0,
                )}
              />
            </MetricGrid>
            <s-unordered-list>
              <s-list-item>
                Customer: <CustomerName customer={data.selectedCustomer} />
              </s-list-item>
              <s-list-item>
                Email: {data.selectedCustomer.email ?? "None"}
              </s-list-item>
              <s-list-item>
                Phone: {data.selectedCustomer.phone ?? "None"}
              </s-list-item>
              <s-list-item>
                Shopify ID: {data.selectedCustomer.shopifyCustomerId}
              </s-list-item>
              <s-list-item>
                Created: {formatDateTime(data.selectedCustomer.createdAt)}
              </s-list-item>
            </s-unordered-list>
          </s-section>

          <s-section heading="Manual adjustment">
            <Form method="post">
              <input type="hidden" name="intent" value="adjust" />
              <input
                type="hidden"
                name="customerId"
                value={data.selectedCustomer.id}
              />
              <s-stack direction="inline" gap="base" alignItems="end">
                <div style={{ width: 160 }}>
                  <s-number-field
                    name="points"
                    label="Points"
                    placeholder="+100 or -100"
                    required
                  ></s-number-field>
                </div>
                <div style={{ minWidth: 280, width: "min(520px, 100%)" }}>
                  <s-text-field
                    name="reason"
                    label="Reason"
                    placeholder="Required audit reason"
                    required
                  ></s-text-field>
                </div>
                <s-button type="submit">Apply adjustment</s-button>
              </s-stack>
            </Form>
          </s-section>

          <s-section heading="Active redemptions">
            {data.selectedCustomer.redemptions.length > 0 ? (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Session</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header format="numeric">Reserved</s-table-header>
                  <s-table-header>Code</s-table-header>
                  <s-table-header>Expires</s-table-header>
                  <s-table-header>Action</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.selectedCustomer.redemptions.map((redemption) => (
                    <s-table-row key={redemption.id}>
                      <s-table-cell>{shortId(redemption.id)}</s-table-cell>
                      <s-table-cell>{redemption.status}</s-table-cell>
                      <s-table-cell>{redemption.pointsReserved}</s-table-cell>
                      <s-table-cell>{redemption.discountCode}</s-table-cell>
                      <s-table-cell>{formatDateTime(redemption.expiresAt)}</s-table-cell>
                      <s-table-cell>
                        <Form method="post">
                          <input type="hidden" name="intent" value="release" />
                          <input
                            type="hidden"
                            name="customerId"
                            value={data.selectedCustomer!.id}
                          />
                          <input
                            type="hidden"
                            name="redemptionSessionId"
                            value={redemption.id}
                          />
                          <s-button type="submit" variant="secondary">
                            Release
                          </s-button>
                        </Form>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-paragraph>No active redemption sessions.</s-paragraph>
            )}
          </s-section>

          <s-section heading="Ledger">
            {data.selectedCustomer.ledgerEntries.length > 0 ? (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Time</s-table-header>
                  <s-table-header>Type</s-table-header>
                  <s-table-header format="numeric">Points</s-table-header>
                  <s-table-header format="currency">Value</s-table-header>
                  <s-table-header>Description</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.selectedCustomer.ledgerEntries.map((entry) => (
                    <s-table-row key={entry.id}>
                      <s-table-cell>{formatDateTime(entry.createdAt)}</s-table-cell>
                      <s-table-cell>{entry.type}</s-table-cell>
                      <s-table-cell>{formatSigned(entry.pointsDelta)}</s-table-cell>
                      <s-table-cell>
                        {entry.moneyValue == null ? "" : `INR ${entry.moneyValue}`}
                      </s-table-cell>
                      <s-table-cell>{entry.description ?? ""}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-paragraph>No ledger entries found.</s-paragraph>
            )}
          </s-section>
        </>
      ) : null}
    </s-page>
  );
}

function CustomerPagination({
  hasNextPage,
  hasPreviousPage,
  page,
  pageSize,
  query,
  totalCustomers,
  totalPages,
}: {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  page: number;
  pageSize: number;
  query: string;
  totalCustomers: number;
  totalPages: number;
}) {
  const pages = visiblePageNumbers(page, totalPages);

  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        justifyContent: "space-between",
        margin: "12px 0",
      }}
    >
      <s-text color="subdued">
        Page {page} of {totalPages} · {formatNumber(totalCustomers)} customers
      </s-text>

      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
        <s-button
          href={pageHref(1, query, pageSize)}
          disabled={!hasPreviousPage}
          variant="secondary"
        >
          First
        </s-button>
        <s-button
          href={pageHref(page - 1, query, pageSize)}
          disabled={!hasPreviousPage}
          variant="secondary"
        >
          Previous
        </s-button>
        {pages.map((item, index) =>
          item === "ellipsis" ? (
            <span key={`ellipsis-${index}`} style={{ padding: "0 4px" }}>
              ...
            </span>
          ) : (
            <s-button
              key={item}
              href={pageHref(item, query, pageSize)}
              variant={item === page ? "primary" : "secondary"}
            >
              {item}
            </s-button>
          ),
        )}
        <s-button
          href={pageHref(page + 1, query, pageSize)}
          disabled={!hasNextPage}
          variant="secondary"
        >
          Next
        </s-button>
        <s-button
          href={pageHref(totalPages, query, pageSize)}
          disabled={!hasNextPage}
          variant="secondary"
        >
          Last
        </s-button>
      </div>

      <div style={{ alignItems: "end", display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Form method="get">
          {query ? <input type="hidden" name="q" value={query} /> : null}
          <input type="hidden" name="page" value="1" />
          <s-stack direction="inline" gap="small" alignItems="end">
            <div style={{ width: 116 }}>
              <s-select name="limit" label="Rows" value={String(pageSize)}>
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <s-option key={option} value={String(option)}>
                    {option}
                  </s-option>
                ))}
              </s-select>
            </div>
            <s-button type="submit" variant="secondary">
              Apply
            </s-button>
          </s-stack>
        </Form>

        <Form method="get">
          {query ? <input type="hidden" name="q" value={query} /> : null}
          <input type="hidden" name="limit" value={String(pageSize)} />
          <s-stack direction="inline" gap="small" alignItems="end">
            <div style={{ width: 116 }}>
              <s-number-field
                label="Go to"
                max={totalPages}
                min={1}
                name="page"
                value={String(page)}
              ></s-number-field>
            </div>
            <s-button type="submit" variant="secondary">
              Go
            </s-button>
          </s-stack>
        </Form>
      </div>
    </div>
  );
}

function CustomerIdentity({
  customer,
}: {
  customer: {
    email: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    shopifyCustomerId: string;
  };
}) {
  return (
    <div>
      <div style={{ fontWeight: 650 }}>
        <CustomerName customer={customer} />
      </div>
      <div>{customer.email ?? "No email"}</div>
      <s-text color="subdued">
        {customer.phone ?? `Shopify ${customer.shopifyCustomerId}`}
      </s-text>
    </div>
  );
}

function CustomerName({
  customer,
}: {
  customer: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    shopifyCustomerId: string;
  };
}) {
  const fullName = [customer.firstName, customer.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return <>{fullName || customer.email || customer.phone || customer.shopifyCustomerId}</>;
}

function parsePageSize(value: string | null) {
  const parsed = Number(value);
  return PAGE_SIZE_OPTIONS.includes(parsed as (typeof PAGE_SIZE_OPTIONS)[number])
    ? parsed
    : DEFAULT_PAGE_SIZE;
}

function pageHref(page: number, query: string, pageSize: number) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("page", String(Math.max(1, page)));
  params.set("limit", String(pageSize));
  return `/app/customers?${params.toString()}`;
}

function customerHref(
  customerId: string,
  page: number,
  query: string,
  pageSize: number,
) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("page", String(page));
  params.set("limit", String(pageSize));
  params.set("customerId", customerId);
  return `/app/customers?${params.toString()}`;
}

function visiblePageNumbers(currentPage: number, totalPages: number) {
  const pages = new Set([1, totalPages]);
  for (
    let page = Math.max(1, currentPage - 2);
    page <= Math.min(totalPages, currentPage + 2);
    page += 1
  ) {
    pages.add(page);
  }

  const sorted = Array.from(pages).sort((left, right) => left - right);
  return sorted.flatMap((page, index) => {
    const previous = sorted[index - 1];
    return previous && page - previous > 1
      ? (["ellipsis", page] as const)
      : ([page] as const);
  });
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
