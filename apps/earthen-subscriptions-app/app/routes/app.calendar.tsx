import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const now = new Date();
  const through = new Date(now.getTime() + 90 * 86_400_000);
  const groups = await db.subscriptionGroup.findMany({
    where: {
      shopDomain: session.shop,
      status: "active",
      nextChargeAt: { gte: now, lte: through },
    },
    include: { lines: { where: { status: "active" } } },
    orderBy: { nextChargeAt: "asc" },
  });
  const days = Object.entries(groups.reduce<Record<string, typeof groups>>((result, group) => {
    const day = group.nextChargeAt!.toISOString().slice(0, 10);
    (result[day] ||= []).push(group);
    return result;
  }, {}));
  return { days, total: groups.length };
};

export default function DeliveryCalendar() {
  const { days, total } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Upcoming delivery calendar">
      <s-stack direction="block" gap="base">
        <s-banner tone="info">{total} active combined-delivery group{total === 1 ? "" : "s"} scheduled in the next 90 days.</s-banner>
        {days.length === 0 ? <s-paragraph>No deliveries are scheduled.</s-paragraph> : days.map(([day, groups]) => (
          <s-section key={day} heading={new Date(`${day}T00:00:00+05:30`).toLocaleDateString("en-IN", { dateStyle: "full" })}>
            <s-stack direction="block" gap="small-100">
              {groups.map((group) => (
                <s-box key={group.id} padding="base" borderWidth="base" borderRadius="base">
                  <s-text type="strong">{group.customerName}</s-text>
                  <s-paragraph>{group.lines.reduce((sum, line) => sum + line.quantity, 0)} units — {group.lines.map((line) => `${line.quantity}× ${line.productTitle}`).join(", ")}</s-paragraph>
                </s-box>
              ))}
            </s-stack>
          </s-section>
        ))}
      </s-stack>
    </s-page>
  );
}
