import type { PrismaClient, WebhookEvent } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  processCustomerDelete,
  processCustomerUpsert,
  processOrderCancelled,
  processOrderCreated,
  processOrderDelivered,
  processOrderFulfilled,
  processOrderPaid,
  processRefundCreated,
  type LoyaltyWebhookContext,
} from "./webhooks";

// Failed webhook events only store the topic and resource id (payloads are
// hashed, not persisted), so a replay re-fetches the resource from the Shopify
// Admin API, rebuilds a webhook-shaped payload, and re-runs the processor.
// Every processor is idempotent (existing-earn / already-reversed / session
// status guards), so replaying an event whose side effects already landed is a
// no-op rather than a double award.

const MAX_REPLAY_ATTEMPTS = 6;
const REPLAY_BATCH_SIZE = 25;

export type ReplaySummary = {
  scanned: number;
  processed: number;
  ignored: number;
  stillFailing: number;
};

export function normalizeWebhookTopic(topic: string): string {
  return topic.toLowerCase().replace(/_/g, "/");
}

export function extractNumericResourceId(
  resourceId: string | null,
): string | null {
  if (!resourceId) return null;
  const match = resourceId.match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

export function buildOrderWebhookPayload(order: {
  legacyResourceId: string;
  currentSubtotal: string | null;
  subtotal: string | null;
  discountCodes: string[];
  customer: {
    legacyResourceId: string;
    email: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
}): Record<string, unknown> {
  return {
    id: Number(order.legacyResourceId),
    admin_graphql_api_id: `gid://shopify/Order/${order.legacyResourceId}`,
    current_subtotal_price: order.currentSubtotal,
    subtotal_price: order.subtotal ?? order.currentSubtotal,
    discount_codes: order.discountCodes.map((code) => ({ code })),
    customer: order.customer
      ? {
          id: Number(order.customer.legacyResourceId),
          admin_graphql_api_id: `gid://shopify/Customer/${order.customer.legacyResourceId}`,
          email: order.customer.email,
          phone: order.customer.phone,
          first_name: order.customer.firstName,
          last_name: order.customer.lastName,
        }
      : null,
  };
}

export function buildCustomerWebhookPayload(customer: {
  legacyResourceId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
}): Record<string, unknown> {
  return {
    id: Number(customer.legacyResourceId),
    admin_graphql_api_id: `gid://shopify/Customer/${customer.legacyResourceId}`,
    email: customer.email,
    phone: customer.phone,
    first_name: customer.firstName,
    last_name: customer.lastName,
  };
}

export async function fetchOrderPayloadForReplay(
  admin: AdminApiContext,
  numericId: string,
) {
  return fetchOrderForReplay(admin, numericId);
}

async function fetchOrderDeliveryStatus(
  admin: AdminApiContext,
  numericId: string,
): Promise<string | null> {
  const response = await admin.graphql(
    `#graphql
    query LoyaltyReplayOrderDelivery($id: ID!) {
      order(id: $id) { displayFulfillmentStatus }
    }`,
    { variables: { id: `gid://shopify/Order/${numericId}` } },
  );
  const json = (await response.json()) as {
    data?: { order?: { displayFulfillmentStatus?: string } | null };
  };
  return json.data?.order?.displayFulfillmentStatus ?? null;
}

async function fetchOrderForReplay(admin: AdminApiContext, numericId: string) {
  const response = await admin.graphql(
    `#graphql
    query LoyaltyReplayOrder($id: ID!) {
      order(id: $id) {
        legacyResourceId
        currentSubtotalPriceSet { shopMoney { amount } }
        subtotalPriceSet { shopMoney { amount } }
        discountCodes
        customer {
          legacyResourceId
          email
          phone
          firstName
          lastName
        }
      }
    }`,
    { variables: { id: `gid://shopify/Order/${numericId}` } },
  );
  const json = (await response.json()) as {
    data?: {
      order?: {
        legacyResourceId: string;
        currentSubtotalPriceSet?: { shopMoney?: { amount?: string } };
        subtotalPriceSet?: { shopMoney?: { amount?: string } };
        discountCodes?: string[];
        customer?: {
          legacyResourceId: string;
          email: string | null;
          phone: string | null;
          firstName: string | null;
          lastName: string | null;
        } | null;
      } | null;
    };
  };
  const order = json.data?.order;
  if (!order) return null;

  return buildOrderWebhookPayload({
    legacyResourceId: order.legacyResourceId,
    currentSubtotal: order.currentSubtotalPriceSet?.shopMoney?.amount ?? null,
    subtotal: order.subtotalPriceSet?.shopMoney?.amount ?? null,
    discountCodes: order.discountCodes ?? [],
    customer: order.customer ?? null,
  });
}

async function fetchCustomerForReplay(
  admin: AdminApiContext,
  numericId: string,
) {
  const response = await admin.graphql(
    `#graphql
    query LoyaltyReplayCustomer($id: ID!) {
      customer(id: $id) {
        legacyResourceId
        email
        phone
        firstName
        lastName
      }
    }`,
    { variables: { id: `gid://shopify/Customer/${numericId}` } },
  );
  const json = (await response.json()) as {
    data?: {
      customer?: {
        legacyResourceId: string;
        email: string | null;
        phone: string | null;
        firstName: string | null;
        lastName: string | null;
      } | null;
    };
  };
  const customer = json.data?.customer;
  if (!customer) return null;
  return buildCustomerWebhookPayload(customer);
}

async function fetchRefundForReplay(admin: AdminApiContext, numericId: string) {
  const response = await admin.graphql(
    `#graphql
    query LoyaltyReplayRefund($id: ID!) {
      node(id: $id) {
        ... on Refund {
          legacyResourceId
          order { legacyResourceId }
          refundLineItems(first: 100) {
            nodes { subtotalSet { shopMoney { amount } } }
          }
        }
      }
    }`,
    { variables: { id: `gid://shopify/Refund/${numericId}` } },
  );
  const json = (await response.json()) as {
    data?: {
      node?: {
        legacyResourceId?: string;
        order?: { legacyResourceId?: string };
        refundLineItems?: {
          nodes?: Array<{ subtotalSet?: { shopMoney?: { amount?: string } } }>;
        };
      } | null;
    };
  };
  const refund = json.data?.node;
  if (!refund?.legacyResourceId || !refund.order?.legacyResourceId) return null;

  return {
    id: Number(refund.legacyResourceId),
    admin_graphql_api_id: `gid://shopify/Refund/${refund.legacyResourceId}`,
    order_id: Number(refund.order.legacyResourceId),
    refund_line_items: (refund.refundLineItems?.nodes ?? []).map((node) => ({
      subtotal: node.subtotalSet?.shopMoney?.amount ?? "0",
    })),
  } as Record<string, unknown>;
}

type ReplayOutcome = "processed" | "ignored" | "failed";

async function replayEvent(
  db: PrismaClient,
  admin: AdminApiContext,
  event: WebhookEvent,
): Promise<{ outcome: ReplayOutcome; error?: string }> {
  const topic = normalizeWebhookTopic(event.topic);
  const numericId = extractNumericResourceId(event.resourceId);
  const context = (payload: Record<string, unknown>): LoyaltyWebhookContext => ({
    shop: event.shopDomain,
    topic,
    webhookId: event.shopifyWebhookId,
    payload,
  });

  if (topic.startsWith("app/")) {
    return { outcome: "ignored" };
  }
  if (!numericId) {
    return { outcome: "failed", error: "No resource id recorded for replay" };
  }

  switch (topic) {
    case "customers/create":
    case "customers/update": {
      const payload = await fetchCustomerForReplay(admin, numericId);
      if (!payload) return { outcome: "ignored" };
      await processCustomerUpsert(db, context(payload));
      return { outcome: "processed" };
    }
    case "customers/delete": {
      await processCustomerDelete(db, context({ id: Number(numericId) }));
      return { outcome: "processed" };
    }
    case "orders/create":
    case "orders/paid":
    case "orders/fulfilled":
    case "orders/cancelled": {
      const payload = await fetchOrderForReplay(admin, numericId);
      if (!payload) return { outcome: "ignored" };
      if (topic === "orders/create")
        await processOrderCreated(db, context(payload));
      else if (topic === "orders/paid")
        await processOrderPaid(db, context(payload));
      else if (topic === "orders/fulfilled")
        await processOrderFulfilled(db, context(payload));
      else await processOrderCancelled(db, context(payload));
      return { outcome: "processed" };
    }
    case "fulfillment/events/create": {
      // The event itself can't be re-fetched; check the order's current
      // delivery state instead and award if it has been delivered.
      const deliveryStatus = await fetchOrderDeliveryStatus(admin, numericId);
      if (deliveryStatus !== "DELIVERED") return { outcome: "ignored" };
      const payload = await fetchOrderForReplay(admin, numericId);
      if (!payload) return { outcome: "ignored" };
      await processOrderDelivered(db, context(payload));
      return { outcome: "processed" };
    }
    case "refunds/create": {
      const payload = await fetchRefundForReplay(admin, numericId);
      if (!payload) return { outcome: "ignored" };
      await processRefundCreated(db, context(payload));
      return { outcome: "processed" };
    }
    default:
      return { outcome: "failed", error: `No replay handler for ${topic}` };
  }
}

export async function replayFailedWebhooks(
  db: PrismaClient,
  admin: AdminApiContext,
  shopDomain: string,
): Promise<ReplaySummary> {
  const failedEvents = await db.webhookEvent.findMany({
    where: {
      shopDomain,
      status: "failed",
      attemptCount: { lt: MAX_REPLAY_ATTEMPTS },
    },
    orderBy: { createdAt: "asc" },
    take: REPLAY_BATCH_SIZE,
  });

  const summary: ReplaySummary = {
    scanned: failedEvents.length,
    processed: 0,
    ignored: 0,
    stillFailing: 0,
  };

  for (const event of failedEvents) {
    try {
      const result = await replayEvent(db, admin, event);
      if (result.outcome === "failed") {
        summary.stillFailing += 1;
        await db.webhookEvent.update({
          where: { id: event.id },
          data: {
            attemptCount: { increment: 1 },
            lastError: result.error ?? "Replay failed",
          },
        });
        continue;
      }

      if (result.outcome === "processed") summary.processed += 1;
      else summary.ignored += 1;

      await db.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: result.outcome,
          attemptCount: { increment: 1 },
          lastError: null,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      summary.stillFailing += 1;
      await db.webhookEvent
        .update({
          where: { id: event.id },
          data: {
            attemptCount: { increment: 1 },
            lastError:
              error instanceof Error ? error.message : "Replay failed",
          },
        })
        .catch(() => {});
    }
  }

  return summary;
}
