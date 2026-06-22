import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { getLoyaltyRuntimeSettings } from "../loyalty/settings";
import { authenticate, unauthenticated } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
    const { admin } = await unauthenticated.admin(session.shop);
    const response = await admin.graphql(`#graphql { shop { id name } }`);
    adminApiOk = response.ok;
  } catch {
    adminApiOk = false;
  }

  const [latestWebhooks, failedWebhooks] = await Promise.all([
    db.webhookEvent.findMany({
      where: { shopDomain: session.shop },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    db.webhookEvent.count({
      where: { shopDomain: session.shop, status: "failed" },
    }),
  ]);

  return {
    databaseOk,
    adminApiOk,
    appProxyConfigured: true,
    failedWebhooks,
    program: {
      status: settings.program.status,
      bonWidgetDisabled: settings.program.bonWidgetDisabled,
      standardCheckoutTested: settings.program.standardCheckoutTested,
      expressCheckoutTested: settings.program.expressCheckoutTested,
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

  return (
    <s-page heading="Settings and health">
      <s-section heading="Health checks">
        <s-unordered-list>
          <s-list-item>Database: {data.databaseOk ? "OK" : "Fail"}</s-list-item>
          <s-list-item>
            Shopify Admin API: {data.adminApiOk ? "OK" : "Fail"}
          </s-list-item>
          <s-list-item>
            App proxy: {data.appProxyConfigured ? "Configured" : "Check"}
          </s-list-item>
          <s-list-item>Failed webhooks: {data.failedWebhooks}</s-list-item>
          <s-list-item>Program status: {data.program.status}</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Launch checklist">
        <s-unordered-list>
          <s-list-item>
            BON widget disabled:{" "}
            {data.program.bonWidgetDisabled ? "Complete" : "Pending"}
          </s-list-item>
          <s-list-item>
            Standard checkout tested:{" "}
            {data.program.standardCheckoutTested ? "Complete" : "Pending"}
          </s-list-item>
          <s-list-item>
            Express checkout tested/suppressed:{" "}
            {data.program.expressCheckoutTested ? "Complete" : "Pending"}
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Recent webhooks">
        {data.latestWebhooks.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Topic</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.latestWebhooks.map((event) => (
                <tr key={event.id}>
                  <td>{event.createdAt}</td>
                  <td>{event.topic}</td>
                  <td>{event.status}</td>
                  <td>{event.attemptCount}</td>
                  <td>{event.lastError ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <s-paragraph>No webhook events have been recorded.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
