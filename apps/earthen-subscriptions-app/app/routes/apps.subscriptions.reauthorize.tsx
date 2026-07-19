import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { startGroupReauthorization } from "../subscriptions/activation";
import { authenticateAppProxyRequest } from "../subscriptions/app-proxy";
import { verifyPortalToken } from "../subscriptions/portal";
import { RazorpayHttpGateway } from "../subscriptions/razorpay";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const proxy = authenticateAppProxyRequest(request);
  const token = new URL(request.url).searchParams.get("token") || "";
  try {
    const access = verifyPortalToken(token);
    if (access.shopDomain !== proxy.shop || !access.groupId) throw new Error("Invalid link");
    const { admin } = await unauthenticated.admin(proxy.shop);
    const registration = await startGroupReauthorization({
      db,
      razorpay: new RazorpayHttpGateway(),
      graphql: admin.graphql,
      groupId: access.groupId,
      shopDomain: proxy.shop,
    });
    const options = JSON.stringify({
      key: registration.checkoutKey,
      order_id: registration.registrationOrderId,
      name: "Earthen Story",
      description: "Renew UPI AutoPay authorization",
      recurring: true,
      readonly: { email: true, contact: true },
      theme: { color: "#B8841E" },
      handler: "__HANDLER__",
    }).replace('"__HANDLER__"', "function(){document.getElementById('status').textContent='Authorization received. Your subscription will update after bank confirmation.'}");
    return page("Renew UPI AutoPay authorization", "Approve the updated mandate to continue future subscription deliveries.", `<button id="activate">Continue with UPI</button><p id="status"></p><script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>const options=${options};document.getElementById('activate').onclick=()=>new Razorpay(options).open();</script>`);
  } catch (error) {
    return page("Reauthorization unavailable", error instanceof Error ? error.message : "Please request a new link.", "", 400);
  }
};

function page(title: string, message: string, body: string, status = 200) {
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui;max-width:560px;margin:60px auto;padding:24px;color:#18181b}button{background:#112557;color:#fff;border:0;border-radius:8px;padding:14px 22px;font-weight:600}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${body}</body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self' https://checkout.razorpay.com; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; frame-src https://api.razorpay.com https://*.razorpay.com; style-src 'self' 'unsafe-inline'",
    },
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
