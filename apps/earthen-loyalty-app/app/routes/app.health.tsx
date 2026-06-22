import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  EmptyState,
  formatDateTime,
  formatNumber,
  MetricCard,
  MetricGrid,
  StatusBadge,
} from "../components/loyalty-admin-ui";
import db from "../db.server";
import { getLoyaltyRuntimeSettings } from "../loyalty/settings";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: session.shop,
  });

  let databaseOk = false;
  let adminApiOk = false;
  try {
    await db.$queryRaw`SELECT 1`;
    databaseOk = true;
  } catch {
    databaseOk = false;
  }

  try {
    const response = await admin.graphql(`#graphql
      query LoyaltyHealthShop {
        shop {
          id
          name
        }
      }
    `);
    const payload = (await response.json().catch(() => null)) as {
      errors?: unknown;
    } | null;
    adminApiOk = response.ok && !payload?.errors;
  } catch {
    adminApiOk = false;
  }

  const [latestWebhooks, failedWebhooks, migrationBatch, activeRedemptions] =
    await Promise.all([
      db.webhookEvent.findMany({
        where: { shopDomain: session.shop },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      db.webhookEvent.count({
        where: { shopDomain: session.shop, status: "failed" },
      }),
      db.bonMigrationBatch.findFirst({
        where: { shopDomain: session.shop },
        orderBy: { createdAt: "desc" },
      }),
      db.redemptionSession.count({
        where: {
          customer: { shopDomain: session.shop },
          status: { in: ["pending", "applied"] },
        },
      }),
    ]);

  const checks = [
    {
      key: "database",
      label: "Database",
      ok: databaseOk,
      detail: databaseOk ? "Cloud SQL reachable" : "Database check failed",
    },
    {
      key: "adminApi",
      label: "Shopify Admin API",
      ok: adminApiOk,
      detail: adminApiOk ? "GraphQL available" : "Admin API check failed",
    },
    {
      key: "appProxy",
      label: "App proxy",
      ok: true,
      detail: "Configured for storefront loyalty endpoints",
    },
    {
      key: "webhooks",
      label: "Webhook processing",
      ok: failedWebhooks === 0,
      detail:
        failedWebhooks === 0
          ? "No failed webhook events"
          : `${failedWebhooks} failed event(s) need review`,
    },
  ];

  const launchGates = [
    {
      key: "status",
      label: "Program active status",
      complete: settings.program.status === "active",
      detail:
        settings.program.status === "active"
          ? "Program is active"
          : `Currently ${settings.program.status}`,
    },
    {
      key: "bon",
      label: "BON storefront disabled",
      complete: settings.program.bonWidgetDisabled,
      detail: settings.program.bonWidgetDisabled
        ? "Old widget marked disabled"
        : "Disable BON storefront surfaces before cutover",
    },
    {
      key: "standardCheckout",
      label: "Standard checkout tested",
      complete: settings.program.standardCheckoutTested,
      detail: settings.program.standardCheckoutTested
        ? "Marked complete"
        : "Run a final paid-order checkout test",
    },
    {
      key: "expressCheckout",
      label: "Express checkout tested/suppressed",
      complete: settings.program.expressCheckoutTested,
      detail: settings.program.expressCheckoutTested
        ? "Marked complete"
        : "Test or suppress Shop Pay, Apple Pay, and Google Pay",
    },
    {
      key: "migration",
      label: "BON migration batch",
      complete: migrationBatch?.status === "processed",
      detail: migrationBatch
        ? `${migrationBatch.totalImportedPoints} imported from ${migrationBatch.sourceFileName ?? "export"}`
        : "No migration batch found",
    },
  ];

  return {
    activeRedemptions,
    checks,
    failedWebhooks,
    launchGates,
    program: {
      programName: settings.program.programName,
      pointName: settings.program.pointName,
      status: settings.program.status,
    },
    latestWebhooks: latestWebhooks.map((event) => ({
      id: event.id,
      topic: event.topic,
      resourceId: event.resourceId,
      status: event.status,
      attemptCount: event.attemptCount,
      lastError: event.lastError,
      createdAt: event.createdAt.toISOString(),
      processedAt: event.processedAt?.toISOString() ?? null,
    })),
  };
};

export default function HealthPage() {
  const data = useLoaderData<typeof loader>();
  const blockingGateCount = data.launchGates.filter((gate) => !gate.complete).length;
  const failingCheckCount = data.checks.filter((check) => !check.ok).length;

  return (
    <s-page heading="Settings and health">
      <s-section heading="Runtime status">
        <MetricGrid>
          <MetricCard
            label="Program"
            value={data.program.programName}
            detail={`${data.program.pointName} · ${data.program.status}`}
            tone={data.program.status === "active" ? "success" : "warning"}
          />
          <MetricCard
            label="System checks"
            value={failingCheckCount === 0 ? "Healthy" : `${failingCheckCount} failing`}
            detail="Database, Admin API, app proxy, webhooks"
            tone={failingCheckCount === 0 ? "success" : "critical"}
          />
          <MetricCard
            label="Launch gates"
            value={blockingGateCount === 0 ? "Clear" : `${blockingGateCount} pending`}
            detail="Required before production cutover"
            tone={blockingGateCount === 0 ? "success" : "warning"}
          />
          <MetricCard
            label="Active redemptions"
            value={formatNumber(data.activeRedemptions)}
            detail="Pending/applied sessions"
            tone={data.activeRedemptions > 0 ? "warning" : "neutral"}
          />
        </MetricGrid>
      </s-section>

      <s-section heading="Health checks">
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">Check</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Detail</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {data.checks.map((check) => (
              <s-table-row key={check.key}>
                <s-table-cell>{check.label}</s-table-cell>
                <s-table-cell>
                  <StatusBadge tone={check.ok ? "success" : "critical"}>
                    {check.ok ? "OK" : "Fail"}
                  </StatusBadge>
                </s-table-cell>
                <s-table-cell>{check.detail}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Launch readiness">
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">Gate</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Detail</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {data.launchGates.map((gate) => (
              <s-table-row key={gate.key}>
                <s-table-cell>{gate.label}</s-table-cell>
                <s-table-cell>
                  <StatusBadge tone={gate.complete ? "success" : "warning"}>
                    {gate.complete ? "Complete" : "Pending"}
                  </StatusBadge>
                </s-table-cell>
                <s-table-cell>{gate.detail}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Recent webhook events">
        {data.latestWebhooks.length > 0 ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Time</s-table-header>
              <s-table-header>Topic</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header format="numeric">Attempts</s-table-header>
              <s-table-header>Error</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.latestWebhooks.map((event) => (
                <s-table-row key={event.id}>
                  <s-table-cell>{formatDateTime(event.createdAt)}</s-table-cell>
                  <s-table-cell>{event.topic}</s-table-cell>
                  <s-table-cell>
                    <StatusBadge tone={event.status === "failed" ? "critical" : "success"}>
                      {event.status}
                    </StatusBadge>
                  </s-table-cell>
                  <s-table-cell>{event.attemptCount}</s-table-cell>
                  <s-table-cell>{event.lastError ?? ""}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <EmptyState
            heading="No webhook events"
            message="Webhook deliveries will appear here after Shopify sends customer, order, refund, or app events."
          />
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
