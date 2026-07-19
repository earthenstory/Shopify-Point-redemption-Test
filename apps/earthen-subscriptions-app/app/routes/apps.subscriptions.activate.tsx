import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateAppProxyRequest } from "../subscriptions/app-proxy";
import { startMandateActivation } from "../subscriptions/activation";
import { RazorpayHttpGateway } from "../subscriptions/razorpay";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = authenticateAppProxyRequest(request);
  const url = new URL(request.url);
  const orderId = url.searchParams.get("order_id");
  const intentId = url.searchParams.get("intent_id");
  const where = {
    shopDomain: context.shop,
    ...(intentId ? { id: intentId } : {}),
    ...(orderId ? { shopifyOrderId: { endsWith: orderId.split("/").pop()! } } : {}),
    status: { in: ["pending_mandate", "ordered", "activated"] },
  };
  let intent = await db.subscriptionIntent.findFirst({ where });
  // The Thank-you page can render before Shopify delivers orders/create.
  for (let attempt = 0; !intent && attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    intent = await db.subscriptionIntent.findFirst({ where });
  }
  if (!intent) return htmlPage("Activation unavailable", "We could not find a pending subscription for this order.", 404);
  try {
    const activation = await startMandateActivation({
      db, razorpay: new RazorpayHttpGateway(), intentId: intent.id, shopDomain: context.shop,
    });
    if (activation.alreadyActive) {
      return htmlPage("Subscription active", "Your subscription is already active. You can close this page.");
    }
    const checkoutOptions = JSON.stringify({
      key: activation.checkoutKey,
      order_id: activation.registrationOrderId,
      name: "Earthen Story",
      description: "Activate UPI AutoPay subscription",
      recurring: true,
      readonly: { email: true, contact: true },
      theme: { color: "#B8841E" },
      handler: "__HANDLER__",
    }).replace('"__HANDLER__"', "function(){document.getElementById('status').textContent='Authorization received. We will confirm activation shortly.'}");
    return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Activate subscription</title><script src="https://checkout.razorpay.com/v1/checkout.js"></script><style>body{font-family:system-ui;max-width:560px;margin:60px auto;padding:24px;color:#18181b}button{background:#112557;color:#fff;border:0;border-radius:8px;padding:14px 22px;font-weight:600}p{line-height:1.6}</style></head><body><h1>Activate your subscription</h1><p>Your first purchase is complete. Authorize UPI AutoPay to start future deliveries. The subscription discount starts with the next order.</p><button id="activate">Activate UPI AutoPay</button><p id="status"></p><script>const options=${checkoutOptions};document.getElementById('activate').onclick=()=>new Razorpay(options).open();</script></body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self' https://checkout.razorpay.com; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; frame-src https://api.razorpay.com https://*.razorpay.com; style-src 'self' 'unsafe-inline'" },
    });
  } catch (error) {
    return htmlPage("Activation could not start", error instanceof Error ? error.message : "Please try again later.", 400);
  }
};

function htmlPage(title: string, message: string, status = 200) {
  return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:24px"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
