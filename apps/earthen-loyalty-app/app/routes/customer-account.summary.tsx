import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";
import {
  getCustomerLoyaltyMessage,
  getCustomerSnapshot,
  pointsToMoney,
} from "../loyalty/customers";
import { getLoyaltyCustomerHistory } from "../loyalty/history";
import { getLoyaltyRuntimeSettings } from "../loyalty/settings";

// Data source for the customer-account UI extension (the "Earthen Points" page in
// Shopify's hosted account). The extension calls this with a customer-account
// session token; we validate it, resolve the shop + customer, and return the same
// balance + transaction history the storefront widget shows. `cors` sets the
// headers the sandboxed extension needs; an OPTIONS preflight is answered by the
// authenticate call itself.
async function handleRequest(request: Request): Promise<Response> {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const shopDomain = String(sessionToken.dest ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const shopifyCustomerId = String(sessionToken.sub ?? "").split("/").pop() || null;

  if (!shopDomain || !shopifyCustomerId) {
    return cors(Response.json({ ok: false, error: "Unknown customer" }, { status: 400 }));
  }

  const settings = await getLoyaltyRuntimeSettings({ db, shopDomain });
  const snapshot = await getCustomerSnapshot({ db, shopDomain, shopifyCustomerId });
  const { transactions } = await getLoyaltyCustomerHistory({
    db,
    shopDomain,
    shopifyCustomerId,
    resolveOrderNames: async (orderIds) => {
      const { admin } = await unauthenticated.admin(shopDomain);
      return fetchOrderNames(admin, orderIds);
    },
  });

  return cors(
    Response.json({
      ok: true,
      pointName: settings.program.pointName,
      currency: settings.rules.currency,
      redemptionEnabled: settings.redemptionEnabled,
      availablePoints: snapshot.availablePoints,
      availableValue: pointsToMoney(snapshot.availablePoints, settings.rules),
      currencyValuePerPoint: settings.rules.currencyValuePerPoint,
      lifetimeEarnedPoints: snapshot.lifetimeEarnedPoints,
      lifetimeRedeemedPoints: snapshot.lifetimeRedeemedPoints,
      message: getCustomerLoyaltyMessage(snapshot, settings.widget.zeroPointsMessage),
      transactions,
    }),
  );
}

export const loader = ({ request }: LoaderFunctionArgs) => handleRequest(request);
export const action = ({ request }: ActionFunctionArgs) => handleRequest(request);

async function fetchOrderNames(
  admin: AdminApiContext,
  orderIds: string[],
): Promise<Record<string, string>> {
  const response = await admin.graphql(
    `#graphql
    query LoyaltyAccountOrderNames($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          name
        }
      }
    }`,
    { variables: { ids: orderIds.map((id) => `gid://shopify/Order/${id}`) } },
  );

  const json = (await response.json()) as {
    data?: { nodes?: Array<{ id?: string; name?: string } | null> };
  };

  const names: Record<string, string> = {};
  for (const node of json.data?.nodes ?? []) {
    if (node?.id && node.name) {
      const numericId = String(node.id).split("/").pop();
      if (numericId) names[numericId] = node.name;
    }
  }
  return names;
}
