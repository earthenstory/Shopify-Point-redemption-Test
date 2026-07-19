import { describe, expect, it, vi } from "vitest";
import { computeRenewalQuote } from "../../app/subscriptions/pricing";
import { calculateRenewalTaxes, createShopifyRenewalOrder, fetchVariantSnapshots } from "../../app/subscriptions/shopify";
import { validateIntentVariants } from "../../app/subscriptions/intents";

describe("Shopify renewal adapter", () => {
  it("replaces browser signup data with an eligible authoritative Shopify SKU", async () => {
    const graphql = vi.fn(async () => Response.json({ data: { nodes: [{
      id: "gid://shopify/ProductVariant/20", sku: "HNY-500", title: "500 g", price: "150.00",
      inventoryItem: { requiresShipping: true },
      product: { id: "gid://shopify/Product/10", title: "Honey", status: "ACTIVE", isGiftCard: false },
    }] } }));
    const lines = await validateIntentVariants(graphql, [{
      productId: "browser-product", variantId: "20", productTitle: "Browser title",
      quantity: 2, unitPricePaise: 1,
    }]);
    expect(lines[0]).toEqual(expect.objectContaining({
      productId: "gid://shopify/Product/10", variantId: "gid://shopify/ProductVariant/20",
      sku: "HNY-500", productTitle: "Honey", quantity: 2, unitPricePaise: 15_000,
    }));
  });

  it("uses Shopify draft calculation for current address tax before debit", async () => {
    const quote = computeRenewalQuote({
      lines: [{
        subscriptionLineId: "line-1", variantId: "20", productId: "10", productTitle: "Honey",
        currentUnitPricePaise: 10_000, availableQuantity: 1, taxable: true, active: true, requestedQuantity: 1,
      }],
      baseDiscountBps: 200, tiers: [], freeShippingThresholdPaise: 0, shippingFeePaise: 0,
    });
    let variables: Record<string, unknown> | undefined;
    const graphql = vi.fn(async (_query: string, options?: { variables?: Record<string, unknown> }) => {
      variables = options?.variables;
      return Response.json({ data: { draftOrderCalculate: { calculatedDraftOrder: {
        taxesIncluded: false,
        totalPriceSet: { shopMoney: { amount: "115.64", currencyCode: "INR" } },
        totalTaxSet: { shopMoney: { amount: "17.64", currencyCode: "INR" } },
        lineItems: [{ variant: { id: "gid://shopify/ProductVariant/20" }, quantity: 1, discountedTotalSet: { shopMoney: { amount: "98.00", currencyCode: "INR" } } }],
        taxLines: [{ title: "GST", rate: 0.18, priceSet: { shopMoney: { amount: "17.64", currencyCode: "INR" } } }],
      }, userErrors: [] } } });
    });
    const taxed = await calculateRenewalTaxes({
      graphql, quote, customerId: "gid://shopify/Customer/7",
      address: { address1: "1 Road", city: "Bengaluru", zip: "560001", countryCode: "IN" },
    });
    expect(taxed.chargeAmountPaise).toBe(11_564);
    expect(taxed.taxPaise).toBe(1_764);
    expect(taxed.taxLines[0]).toEqual({ title: "GST", rate: 0.18, pricePaise: 1_764 });
    expect((variables as { input: { lineItems: Array<{ appliedDiscount: { value: number } }> } }).input.lineItems[0].appliedDiscount.value).toBe(2);
  });

  it("reads the latest variant price and creates one paid order for a group", async () => {
    const query = vi.fn(async () => Response.json({ data: { nodes: [{
      id: "gid://shopify/ProductVariant/20", sku: "HNY-500", title: "500 g", price: "150.00",
      taxable: true, inventoryQuantity: 8, product: { id: "gid://shopify/Product/10", title: "Honey", status: "ACTIVE" },
    }] } }));
    const snapshots = await fetchVariantSnapshots(query, ["20"]);
    expect(snapshots[0].currentUnitPricePaise).toBe(15_000);
    const quote = computeRenewalQuote({
      lines: [{ ...snapshots[0], subscriptionLineId: "line-1", requestedQuantity: 3 }],
      baseDiscountBps: 200,
      tiers: [{ minimumQuantity: 3, additionalDiscountBps: 300 }],
      freeShippingThresholdPaise: 34_900,
      shippingFeePaise: 4_900,
    });
    let variables: Record<string, unknown> | undefined;
    const mutation = vi.fn(async (_query: string, options?: { variables?: Record<string, unknown> }) => {
      variables = options?.variables;
      return Response.json({ data: { orderCreate: { order: { id: "gid://shopify/Order/900", name: "#900" }, userErrors: [] } } });
    });
    const order = await createShopifyRenewalOrder({
      graphql: mutation, groupId: "g1", cycleId: "c1", cycleSeq: 1,
      customerId: "gid://shopify/Customer/7", email: "buyer@example.com", phone: "+919999999999",
      address: { address1: "1 Road", city: "Bengaluru", zip: "560001", countryCode: "IN" },
      paymentId: "pay_1", quote,
    });
    expect(order.id).toContain("Order/900");
    const orderInput = (variables as { order: { lineItems: Array<{ priceSet: { shopMoney: { amount: string } } }>; tags: string[] } }).order;
    expect(orderInput.lineItems[0].priceSet.shopMoney.amount).toBe("142.50");
    expect(orderInput.tags).toContain("sub-group:g1");
    expect(mutation).toHaveBeenCalledOnce();
  });
});
