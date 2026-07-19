import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { RazorpayHttpGateway } from "../subscriptions/razorpay";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const customerId = String((payload as { customer?: { id?: string | number }; customer_id?: string | number }).customer?.id ??
    (payload as { customer_id?: string | number }).customer_id ?? "");
  if (String(topic).includes("CUSTOMERS_REDACT") && customerId) {
    const customerGid = customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
    const groups = await db.subscriptionGroup.findMany({
      where: { shopDomain: shop, shopifyCustomerId: customerGid },
      select: { razorpayTokenId: true },
    });
    const gateway = groups.some((group) => group.razorpayTokenId) ? new RazorpayHttpGateway() : null;
    for (const group of groups) {
      if (group.razorpayTokenId) await gateway!.cancelToken(group.razorpayTokenId);
    }
    await db.subscriptionGroup.updateMany({
      where: { shopDomain: shop, shopifyCustomerId: customerGid },
      data: {
        status: "cancelled",
        customerName: "Redacted customer",
        customerEmail: "",
        customerPhone: "",
        addressJson: {},
        razorpayCustomerId: null,
        razorpayTokenId: null,
        cancelledAt: new Date(),
      },
    });
  } else if (String(topic).includes("SHOP_REDACT")) {
    await db.$transaction(async (tx) => {
      await tx.subscriptionIntent.deleteMany({ where: { shopDomain: shop } });
      await tx.subscriptionGroup.deleteMany({ where: { shopDomain: shop } });
      await tx.pricingPolicyVersion.deleteMany({ where: { shopDomain: shop } });
      await tx.subscriptionSettings.deleteMany({ where: { shopDomain: shop } });
      await tx.notificationLog.deleteMany({ where: { shopDomain: shop } });
      await tx.eventLog.deleteMany({ where: { shopDomain: shop } });
      await tx.session.deleteMany({ where: { shop } });
    });
  } else if (String(topic).includes("CUSTOMERS_DATA_REQUEST")) {
    await db.eventLog.create({
      data: {
        shopDomain: shop,
        entityType: "privacy_request",
        entityId: customerId || "unknown",
        eventType: "customer_data_export_requested",
        maskedPayload: { status: "merchant_export_required" },
      },
    });
  }
  return new Response();
};
