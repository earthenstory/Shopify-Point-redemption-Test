import type { Address, VariantSnapshot } from "./types";
import type { RenewalQuote } from "./pricing";

export type ShopifyGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export async function fetchVariantSnapshots(
  graphql: ShopifyGraphql,
  variantIds: string[],
): Promise<VariantSnapshot[]> {
  if (variantIds.length === 0) return [];
  const response = await graphql(`#graphql
    query SubscriptionVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id sku title price taxable inventoryQuantity
          product { id title status }
        }
      }
    }
  `, { variables: { ids: variantIds.map((id) => toGid("ProductVariant", id)) } });
  const payload = await response.json() as {
    data?: { nodes?: Array<null | {
      id: string; sku?: string; title: string; price: string; taxable: boolean;
      inventoryQuantity?: number; product: { id: string; title: string; status: string };
    }> };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) throw new Error(payload.errors.map((e) => e.message).join("; "));
  return (payload.data?.nodes ?? []).filter(Boolean).map((variant) => ({
    variantId: variant!.id,
    productId: variant!.product.id,
    sku: variant!.sku,
    productTitle: variant!.product.title,
    variantTitle: variant!.title,
    currentUnitPricePaise: moneyToPaise(variant!.price),
    availableQuantity: Math.max(0, variant!.inventoryQuantity ?? 0),
    taxable: variant!.taxable,
    active: variant!.product.status === "ACTIVE",
  }));
}

export async function createShopifyRenewalOrder(input: {
  graphql: ShopifyGraphql;
  groupId: string;
  cycleId: string;
  cycleSeq: number;
  customerId?: string | null;
  email: string;
  phone: string;
  address: Address;
  paymentId: string;
  quote: RenewalQuote;
}) {
  const payableLines = input.quote.lines.filter((line) => line.fulfilledQuantity > 0);
  const orderInput = {
    email: input.email || undefined,
    phone: input.phone || undefined,
    customer: input.customerId ? { toAssociate: { id: input.customerId } } : undefined,
    shippingAddress: cleanAddress(input.address),
    lineItems: payableLines.map((line) => ({
      variantId: toGid("ProductVariant", line.variantId),
      quantity: line.fulfilledQuantity,
      priceSet: { shopMoney: { amount: paiseToMoney(line.netAmountPaise / line.fulfilledQuantity), currencyCode: "INR" } },
    })),
    shippingLines: input.quote.shippingPaise > 0 ? [{
      title: "Subscription delivery",
      priceSet: { shopMoney: { amount: paiseToMoney(input.quote.shippingPaise), currencyCode: "INR" } },
    }] : [],
    transactions: [{
      kind: "SALE",
      status: "SUCCESS",
      amountSet: { shopMoney: { amount: paiseToMoney(input.quote.chargeAmountPaise), currencyCode: "INR" } },
      gateway: "Razorpay UPI AutoPay",
      authorizationCode: input.paymentId,
    }],
    tags: ["Earthen Subscription", `sub-group:${input.groupId}`, `cycle:${input.cycleSeq}`],
    customAttributes: [
      { key: "subscription_group_id", value: input.groupId },
      { key: "billing_cycle_id", value: input.cycleId },
      { key: "razorpay_payment_id", value: input.paymentId },
    ],
    financialStatus: "PAID",
    taxesIncluded: input.quote.taxesIncluded,
    taxLines: input.quote.taxLines.map((line) => ({
      title: line.title,
      rate: line.rate,
      priceSet: { shopMoney: { amount: paiseToMoney(line.pricePaise), currencyCode: "INR" } },
    })),
  };
  const response = await input.graphql(`#graphql
    mutation CreateSubscriptionRenewal($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name }
        userErrors { field message }
      }
    }
  `, { variables: { order: orderInput, options: { sendReceipt: true, inventoryBehaviour: "DECREMENT_OBEYING_POLICY" } } });
  const payload = await response.json() as {
    data?: { orderCreate?: { order?: { id: string; name: string }; userErrors?: Array<{ message: string }> } };
    errors?: Array<{ message: string }>;
  };
  const errors = [
    ...(payload.errors ?? []).map((error) => error.message),
    ...(payload.data?.orderCreate?.userErrors ?? []).map((error) => error.message),
  ];
  if (errors.length || !payload.data?.orderCreate?.order) {
    throw new Error(errors.join("; ") || "Shopify did not create the renewal order");
  }
  return payload.data.orderCreate.order;
}

export async function calculateRenewalTaxes(input: {
  graphql: ShopifyGraphql;
  quote: RenewalQuote;
  customerId?: string | null;
  address: Address;
}): Promise<RenewalQuote> {
  if (input.quote.status === "skipped_oos") return input.quote;
  const payable = input.quote.lines.filter((line) => line.fulfilledQuantity > 0);
  const draftInput = {
    customerId: input.customerId || undefined,
    shippingAddress: cleanAddress(input.address),
    billingAddress: cleanAddress(input.address),
    presentmentCurrencyCode: "INR",
    lineItems: payable.map((line) => ({
      variantId: toGid("ProductVariant", line.variantId),
      quantity: line.fulfilledQuantity,
      appliedDiscount: {
        title: "Earthen subscription",
        description: "Locked subscription policy",
        value: input.quote.effectiveDiscountBps / 100,
        valueType: "PERCENTAGE",
      },
    })),
    shippingLine: {
      title: "Subscription delivery",
      price: paiseToMoney(input.quote.shippingPaise),
    },
  };
  const response = await input.graphql(`#graphql
    mutation CalculateSubscriptionTaxes($input: DraftOrderInput!) {
      draftOrderCalculate(input: $input) {
        calculatedDraftOrder {
          taxesIncluded
          totalPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          lineItems {
            variant { id }
            quantity
            discountedTotalSet { shopMoney { amount currencyCode } }
          }
          taxLines { title rate priceSet { shopMoney { amount currencyCode } } }
        }
        userErrors { field message }
      }
    }
  `, { variables: { input: draftInput } });
  const payload = await response.json() as {
    data?: { draftOrderCalculate?: {
      calculatedDraftOrder?: {
        taxesIncluded: boolean;
        totalPriceSet: { shopMoney: { amount: string } };
        totalTaxSet: { shopMoney: { amount: string } };
        lineItems: Array<{ variant?: { id: string }; quantity: number; discountedTotalSet: { shopMoney: { amount: string } } }>;
        taxLines: Array<{ title: string; rate: number; priceSet: { shopMoney: { amount: string } } }>;
      };
      userErrors?: Array<{ message: string }>;
    } };
    errors?: Array<{ message: string }>;
  };
  const errors = [
    ...(payload.errors ?? []).map((error) => error.message),
    ...(payload.data?.draftOrderCalculate?.userErrors ?? []).map((error) => error.message),
  ];
  const calculated = payload.data?.draftOrderCalculate?.calculatedDraftOrder;
  if (errors.length || !calculated) {
    throw new Error(`Shopify tax calculation failed: ${errors.join("; ") || "no calculation returned"}`);
  }
  const totalsByVariant = new Map(calculated.lineItems.map((line) => [
    line.variant?.id.split("/").pop() ?? "",
    moneyToPaise(line.discountedTotalSet.shopMoney.amount),
  ]));
  const lines = input.quote.lines.map((line) => {
    const calculatedTotal = totalsByVariant.get(line.variantId.split("/").pop() ?? line.variantId);
    return calculatedTotal === undefined ? line : { ...line, netAmountPaise: calculatedTotal };
  });
  const merchandisePaise = lines.reduce((sum, line) => sum + line.netAmountPaise, 0);
  return {
    ...input.quote,
    lines,
    merchandisePaise,
    taxPaise: moneyToPaise(calculated.totalTaxSet.shopMoney.amount),
    taxesIncluded: calculated.taxesIncluded,
    taxLines: calculated.taxLines.map((line) => ({
      title: line.title,
      rate: line.rate,
      pricePaise: moneyToPaise(line.priceSet.shopMoney.amount),
    })),
    chargeAmountPaise: moneyToPaise(calculated.totalPriceSet.shopMoney.amount),
  };
}

export function moneyToPaise(value: string | number): number {
  const numeric = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(numeric)) throw new Error(`Invalid money value: ${value}`);
  return Math.round(numeric * 100);
}

export function paiseToMoney(value: number): string {
  return (value / 100).toFixed(2);
}

function toGid(type: string, id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/${type}/${id}`;
}

function cleanAddress(address: Address) {
  return {
    address1: address.address1,
    address2: address.address2 || undefined,
    city: address.city,
    province: address.province || undefined,
    provinceCode: address.provinceCode || undefined,
    country: address.country || undefined,
    countryCode: address.countryCode || undefined,
    zip: address.zip,
    firstName: address.firstName || undefined,
    lastName: address.lastName || undefined,
    phone: address.phone || undefined,
    company: address.company || undefined,
  };
}
