import type { LoaderFunctionArgs } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  authenticateAppProxyRequest,
  jsonError,
  jsonResponse,
} from "../loyalty/app-proxy";
import { getLoyaltyCustomerHistory } from "../loyalty/history";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const context = authenticateAppProxyRequest(request);

    if (!context.loggedInCustomerId) {
      return jsonResponse({ ok: true, loggedIn: false, transactions: [] });
    }

    const { transactions } = await getLoyaltyCustomerHistory({
      db,
      shopDomain: context.shop,
      shopifyCustomerId: context.loggedInCustomerId,
      resolveOrderNames: async (orderIds) => {
        const { admin } = await unauthenticated.admin(context.shop);
        return fetchOrderNames(admin, orderIds);
      },
    });

    return jsonResponse({ ok: true, loggedIn: true, transactions });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonError("Could not load points history", 500);
  }
};

async function fetchOrderNames(
  admin: AdminApiContext,
  orderIds: string[],
): Promise<Record<string, string>> {
  const response = await admin.graphql(
    `#graphql
    query LoyaltyOrderNames($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          name
        }
      }
    }`,
    {
      variables: {
        ids: orderIds.map((id) => `gid://shopify/Order/${id}`),
      },
    },
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
