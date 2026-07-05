import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Overview</s-link>
        <s-link href="/app/program">Point Program</s-link>
        <s-link href="/app/redemption">Redemption</s-link>
        <s-link href="/app/milestones">Milestones</s-link>
        <s-link href="/app/rewards">Rewards & Earning</s-link>
        <s-link href="/app/referrals">Referrals</s-link>
        <s-link href="/app/vip">VIP Tiers</s-link>
        <s-link href="/app/campaigns">Campaigns</s-link>
        <s-link href="/app/delivery">Delivery Estimates</s-link>
        <s-link href="/app/customers">Customer Data</s-link>
        <s-link href="/app/migration">Migration</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/branding">Branding</s-link>
        <s-link href="/app/health">Settings / Health</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
