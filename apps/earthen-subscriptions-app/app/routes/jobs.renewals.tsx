import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateJob } from "../subscriptions/jobs";
import { RazorpayHttpGateway } from "../subscriptions/razorpay";
import { runDueRenewals } from "../subscriptions/renewals";
import { unauthenticated } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  authenticateJob(request);
  const run = await db.cronRun.create({ data: { job: "renewals" } });
  try {
    const results = await runDueRenewals({
      db,
      razorpay: new RazorpayHttpGateway(),
      graphqlForShop: async (shop) => (await unauthenticated.admin(shop)).admin.graphql,
    });
    const errors = results.filter((result) => result.error);
    await db.cronRun.update({
      where: { id: run.id },
      data: {
        status: errors.length ? "completed_with_errors" : "completed",
        completedAt: new Date(), processedCount: results.length, errorCount: errors.length,
        errors,
      },
    });
    return Response.json({ ok: errors.length === 0, results });
  } catch (error) {
    await db.cronRun.update({
      where: { id: run.id },
      data: { status: "failed", completedAt: new Date(), errorCount: 1, errors: [error instanceof Error ? error.message : "Unknown error"] },
    });
    throw error;
  }
};
