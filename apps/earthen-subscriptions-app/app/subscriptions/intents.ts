import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { signPayload, verifyPayload } from "./crypto";
import { getShopConfiguration, isProductEligible, stringArray } from "./settings";
import { INTERVALS, type Address, type RequestedLine } from "./types";
import { moneyToPaise, type ShopifyGraphql } from "./shopify";

const lineSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1),
  sku: z.string().nullable().optional(),
  productTitle: z.string().min(1).max(300),
  variantTitle: z.string().nullable().optional(),
  quantity: z.number().int().min(1).max(100),
  unitPricePaise: z.number().int().min(0),
});

export const intentInputSchema = z.object({
  intervalCode: z.enum(INTERVALS),
  lines: z.array(lineSchema).min(1).max(50),
});

export async function createSubscriptionIntent(input: {
  db: PrismaClient;
  shopDomain: string;
  intervalCode: string;
  lines: RequestedLine[];
  graphql: ShopifyGraphql;
  now?: Date;
}) {
  const parsed = intentInputSchema.parse({
    intervalCode: input.intervalCode,
    lines: input.lines,
  });
  const now = input.now ?? new Date();
  const { settings, policy } = await getShopConfiguration(input.db, input.shopDomain);
  if (!settings.widgetEnabled) throw new Error("Subscriptions are currently disabled");
  if (!stringArray(settings.allowedIntervals).includes(parsed.intervalCode)) {
    throw new Error("Selected subscription interval is not enabled");
  }
  const authoritativeLines = await validateIntentVariants(input.graphql, parsed.lines);
  for (const line of authoritativeLines) {
    if (!isProductEligible({ ...settings, productId: line.productId })) {
      throw new Error(`${line.productTitle} is not eligible for subscription`);
    }
  }
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + settings.activationTtlHours * 3_600_000);
  const signedCartReference = signPayload({
    intentId: id,
    shop: input.shopDomain,
    exp: Math.floor(expiresAt.getTime() / 1000),
  });
  return input.db.subscriptionIntent.create({
    data: {
      id,
      shopDomain: input.shopDomain,
      signedCartReference,
      requestedLines: authoritativeLines,
      intervalCode: parsed.intervalCode,
      pricingPolicyId: policy.id,
      status: "cart",
      expiresAt,
    },
  });
}

export async function validateIntentVariants(graphql: ShopifyGraphql, requested: RequestedLine[]): Promise<RequestedLine[]> {
  const ids = requested.map((line) => line.variantId.startsWith("gid://")
    ? line.variantId
    : `gid://shopify/ProductVariant/${line.variantId}`);
  const response = await graphql(`#graphql
    query SubscriptionIntentVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id sku title price
          inventoryItem { requiresShipping }
          product { id title status isGiftCard }
        }
      }
    }
  `, { variables: { ids } });
  const payload = await response.json() as {
    data?: { nodes?: Array<null | {
      id: string; sku?: string | null; title: string; price: string;
      inventoryItem?: { requiresShipping?: boolean } | null;
      product: { id: string; title: string; status: string; isGiftCard: boolean };
    }> };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
  const nodes = payload.data?.nodes ?? [];
  return requested.map((line, index) => {
    const variant = nodes[index];
    if (!variant) throw new Error(`Subscription variant ${line.variantId} was not found`);
    if (variant.product.status !== "ACTIVE" || variant.product.isGiftCard || variant.inventoryItem?.requiresShipping === false) {
      throw new Error(`${variant.product.title} is not an eligible physical subscription product`);
    }
    return {
      productId: variant.product.id,
      variantId: variant.id,
      sku: variant.sku || null,
      productTitle: variant.product.title,
      variantTitle: variant.title,
      quantity: line.quantity,
      unitPricePaise: moneyToPaise(variant.price),
    };
  });
}

type ShopifyOrderWebhook = {
  id: number | string;
  email?: string | null;
  phone?: string | null;
  contact_email?: string | null;
  customer?: { id?: number | string; first_name?: string; last_name?: string; email?: string; phone?: string } | null;
  shipping_address?: Record<string, unknown> | null;
  billing_address?: Record<string, unknown> | null;
  financial_status?: string | null;
  line_items?: Array<{
    variant_id?: number | string | null;
    product_id?: number | string | null;
    quantity: number;
    price?: string;
    title?: string;
    variant_title?: string | null;
    sku?: string | null;
    properties?: Array<{ name?: string; value?: string }> | Record<string, string>;
  }>;
};

export async function capturePaidOrderIntent(input: {
  db: PrismaClient;
  shopDomain: string;
  order: ShopifyOrderWebhook;
  now?: Date;
}) {
  if (input.order.financial_status !== "paid") return [];
  const references = new Set<string>();
  for (const line of input.order.line_items ?? []) {
    for (const [name, value] of propertyEntries(line.properties)) {
      if (name === "_earthen_subscription_intent" && value) references.add(value);
    }
  }
  const results = [];
  for (const reference of references) {
    let claims: { intentId: string; shop: string; exp: number };
    try {
      claims = verifyPayload(reference);
    } catch {
      continue;
    }
    if (claims.shop !== input.shopDomain) throw new Error("Subscription intent shop mismatch");
    const intent = await input.db.subscriptionIntent.findUnique({ where: { id: claims.intentId } });
    if (!intent || intent.signedCartReference !== reference) continue;
    if (intent.status !== "cart" && intent.status !== "ordered") {
      results.push(intent);
      continue;
    }
    if (intent.expiresAt <= (input.now ?? new Date())) continue;
    const requested = intent.requestedLines as unknown as RequestedLine[];
    assertOrderContainsRequestedLines(input.order, requested, reference);
    const rawAddress = input.order.shipping_address ?? input.order.billing_address;
    if (!rawAddress) throw new Error("Subscription order has no delivery address");
    const address = normalizeAddress(rawAddress);
    const customer = input.order.customer;
    const customerName = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ") ||
      [address.firstName, address.lastName].filter(Boolean).join(" ") || "Customer";
    const settings = await input.db.subscriptionSettings.findUniqueOrThrow({
      where: { shopDomain: input.shopDomain }, select: { activationTtlHours: true },
    });
    const activationExpiresAt = new Date((input.now ?? new Date()).getTime() + settings.activationTtlHours * 3_600_000);
    results.push(await input.db.subscriptionIntent.update({
      where: { id: intent.id },
      data: {
        status: "pending_mandate",
        requestedLines: authoritativeLines(input.order, requested, reference),
        shopifyOrderId: shopifyGid("Order", input.order.id),
        expiresAt: activationExpiresAt,
        customerSnapshot: {
          shopifyCustomerId: customer?.id ? shopifyGid("Customer", customer.id) : null,
          customerName,
          customerEmail: input.order.contact_email ?? input.order.email ?? customer?.email ?? "",
          customerPhone: input.order.phone ?? customer?.phone ?? address.phone ?? "",
          address,
        },
      },
    }));
  }
  return results;
}

function authoritativeLines(order: ShopifyOrderWebhook, requested: RequestedLine[], reference: string): RequestedLine[] {
  return requested.map((requestedLine) => {
    const expected = resourceNumericId(requestedLine.variantId);
    const matchingOrderLines = (order.line_items ?? []).filter((line) =>
      resourceNumericId(String(line.variant_id ?? "")) === expected &&
      propertyEntries(line.properties).some(([name, value]) => name === "_earthen_subscription_intent" && value === reference),
    );
    const orderLine = matchingOrderLines[0];
    if (!orderLine) return requestedLine;
    return {
      productId: String(orderLine.product_id ?? requestedLine.productId),
      variantId: String(orderLine.variant_id ?? requestedLine.variantId),
      sku: orderLine.sku ?? requestedLine.sku,
      productTitle: orderLine.title ?? requestedLine.productTitle,
      variantTitle: orderLine.variant_title ?? requestedLine.variantTitle,
      // The paid Shopify order is authoritative if the customer changed quantity
      // in the cart after creating the signed intent.
      quantity: matchingOrderLines.reduce((sum, line) => sum + line.quantity, 0),
      unitPricePaise: Number.isFinite(Number.parseFloat(orderLine.price ?? ""))
        ? Math.round(Number.parseFloat(orderLine.price!) * 100)
        : requestedLine.unitPricePaise,
    };
  });
}

function normalizeAddress(raw: Record<string, unknown>): Address {
  return {
    address1: String(raw.address1 ?? ""), address2: raw.address2 ? String(raw.address2) : null,
    city: String(raw.city ?? ""), province: raw.province ? String(raw.province) : null,
    provinceCode: raw.province_code ? String(raw.province_code) : raw.provinceCode ? String(raw.provinceCode) : null,
    country: raw.country ? String(raw.country) : null,
    countryCode: raw.country_code ? String(raw.country_code) : raw.countryCode ? String(raw.countryCode) : null,
    zip: String(raw.zip ?? ""),
    firstName: raw.first_name ? String(raw.first_name) : raw.firstName ? String(raw.firstName) : null,
    lastName: raw.last_name ? String(raw.last_name) : raw.lastName ? String(raw.lastName) : null,
    phone: raw.phone ? String(raw.phone) : null, company: raw.company ? String(raw.company) : null,
  };
}

function assertOrderContainsRequestedLines(
  order: ShopifyOrderWebhook,
  requested: RequestedLine[],
  reference: string,
) {
  for (const requestedLine of requested) {
    const expected = resourceNumericId(requestedLine.variantId);
    const quantity = (order.line_items ?? [])
      .filter((line) => resourceNumericId(String(line.variant_id ?? "")) === expected)
      .filter((line) => propertyEntries(line.properties).some(
        ([name, value]) => name === "_earthen_subscription_intent" && value === reference,
      ))
      .reduce((sum, line) => sum + line.quantity, 0);
    if (quantity < requestedLine.quantity) {
      throw new Error(`Order does not contain requested subscription variant ${expected}`);
    }
  }
}

function propertyEntries(value: unknown): [string, string][] {
  if (Array.isArray(value)) {
    return value.map((property: { name?: unknown; value?: unknown }) => [String(property.name ?? ""), String(property.value ?? "")]);
  }
  return value && typeof value === "object"
    ? Object.entries(value).map(([name, property]) => [name, String(property)])
    : [];
}

export function shopifyGid(type: string, value: string | number): string {
  const text = String(value);
  return text.startsWith("gid://") ? text : `gid://shopify/${type}/${text}`;
}

export function resourceNumericId(value: string): string {
  return value.split("/").pop() ?? value;
}
