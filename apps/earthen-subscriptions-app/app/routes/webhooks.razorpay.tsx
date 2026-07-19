import { createHash } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { activateMandate } from "../subscriptions/activation";
import { markPaymentFailed } from "../subscriptions/dunning";
import { RazorpayHttpGateway, verifyRazorpayWebhook } from "../subscriptions/razorpay";
import { finalizeCapturedCycle } from "../subscriptions/renewals";
import { unauthenticated } from "../shopify.server";
import { finishWebhook, recordWebhook } from "../subscriptions/webhooks";

export const action = async ({ request }: ActionFunctionArgs) => {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";
  if (!verifyRazorpayWebhook(rawBody, signature)) return new Response("Invalid signature", { status: 401 });
  const payload = JSON.parse(rawBody) as RazorpayWebhook;
  const eventId = request.headers.get("x-razorpay-event-id") || createHash("sha256").update(rawBody).digest("hex");
  const record = await recordWebhook({ db, source: "razorpay", eventId, topic: payload.event, rawBody });
  if (record.duplicate) return new Response();
  try {
    const token = payload.payload?.token?.entity;
    const payment = payload.payload?.payment?.entity;
    if (["token.confirmed", "token.activated"].includes(payload.event) && token?.id && token.order_id) {
      await activateMandate({
        db, razorpay: new RazorpayHttpGateway(), registrationOrderId: token.order_id, tokenId: token.id,
      });
    } else if (payload.event === "payment.captured" && payment?.order_id && payment.id) {
      const cycle = await findCycleByOrder(payment.order_id);
      if (cycle) {
        const { admin } = await unauthenticated.admin(cycle.group.shopDomain);
        await finalizeCapturedCycle({
          db,
          razorpay: new RazorpayHttpGateway(),
          graphql: admin.graphql,
          razorpayOrderId: payment.order_id,
          paymentId: payment.id,
        });
      }
    } else if (payload.event === "payment.failed" && payment?.order_id) {
      await markPaymentFailed({
        db,
        razorpayOrderId: payment.order_id,
        paymentId: payment.id,
        reason: payment.error_description ?? payment.error_reason ?? "Payment failed",
      });
    } else {
      await finishWebhook(db, record.event.id, "ignored");
      return new Response();
    }
    await finishWebhook(db, record.event.id, "processed");
  } catch (error) {
    await finishWebhook(db, record.event.id, "failed", error);
    throw error;
  }
  return new Response();
};

async function findCycleByOrder(orderId: string) {
  const attempt = await db.paymentAttempt.findUnique({ where: { externalOrderId: orderId } });
  return db.billingCycle.findFirst({
    where: attempt ? { id: attempt.billingCycleId } : { razorpayOrderId: orderId },
    include: { group: true },
  });
}

type RazorpayWebhook = {
  event: string;
  payload?: {
    token?: { entity?: { id?: string; order_id?: string } };
    payment?: { entity?: { id?: string; order_id?: string; error_description?: string; error_reason?: string } };
  };
};
