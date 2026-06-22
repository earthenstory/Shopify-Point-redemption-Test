import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { releaseRedemption } from "../loyalty/redemptions";
import { formNumber } from "../loyalty/settings";
import { authenticate, unauthenticated } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const customer = query
    ? await db.loyaltyCustomer.findFirst({
        where: {
          shopDomain: session.shop,
          OR: [
            { shopifyCustomerId: { contains: query } },
            { email: { contains: query, mode: "insensitive" } },
            { phone: { contains: query } },
            { firstName: { contains: query, mode: "insensitive" } },
            { lastName: { contains: query, mode: "insensitive" } },
          ],
        },
        include: {
          wallet: true,
          ledgerEntries: {
            orderBy: { createdAt: "desc" },
            take: 25,
          },
          redemptions: {
            where: { status: { in: ["pending", "applied"] } },
            orderBy: { createdAt: "desc" },
            take: 10,
          },
        },
      })
    : null;

  return {
    query,
    customer: customer
      ? {
          id: customer.id,
          shopifyCustomerId: customer.shopifyCustomerId,
          email: customer.email,
          phone: customer.phone,
          firstName: customer.firstName,
          lastName: customer.lastName,
          wallet: customer.wallet,
          ledgerEntries: customer.ledgerEntries.map((entry) => ({
            id: entry.id,
            type: entry.type,
            pointsDelta: entry.pointsDelta,
            moneyValue: entry.moneyValue ? Number(entry.moneyValue) : null,
            description: entry.description,
            createdAt: entry.createdAt.toISOString(),
          })),
          redemptions: customer.redemptions.map((session) => ({
            id: session.id,
            status: session.status,
            cartToken: session.cartToken,
            pointsReserved: session.pointsReserved,
            pointsConsumed: session.pointsConsumed,
            pointsReleased: session.pointsReleased,
            discountCode: session.discountCode,
            expiresAt: session.expiresAt.toISOString(),
          })),
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "adjust") {
      const customerId = String(form.get("customerId"));
      const reason = String(form.get("reason") ?? "").trim();
      const points = formNumber(form.get("points"));
      if (!reason) throw new Error("Manual adjustment reason is required.");
      if (!Number.isInteger(points) || points === 0) {
        throw new Error("Adjustment points must be a non-zero integer.");
      }

      const customer = await db.loyaltyCustomer.findFirst({
        where: { id: customerId, shopDomain: session.shop },
        include: { wallet: true },
      });
      if (!customer?.wallet) throw new Error("Customer wallet was not found.");
      if (points < 0 && customer.wallet.availablePoints + points < 0) {
        throw new Error("Adjustment would make available points negative.");
      }

      await db.$transaction(async (tx) => {
        const before = customer.wallet;
        const wallet = await tx.wallet.update({
          where: { id: customer.wallet!.id },
          data: {
            availablePoints: { increment: points },
            lifetimeEarnedPoints:
              points > 0 ? { increment: points } : undefined,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            customerId: customer.id,
            walletId: customer.wallet!.id,
            type: "manual_adjustment",
            pointsDelta: points,
            currency: "INR",
            description: reason,
            metadata: { adminUser: session.id },
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminUser: session.id,
            action: "manual_points_adjustment",
            customerId: customer.id,
            before: JSON.parse(JSON.stringify(before ?? {})),
            after: JSON.parse(JSON.stringify(wallet)),
            reason,
          },
        });
      });
      return { ok: true, message: "Manual adjustment saved." };
    }

    if (intent === "release") {
      const customerId = String(form.get("customerId"));
      const redemptionSessionId = String(form.get("redemptionSessionId"));
      const customer = await db.loyaltyCustomer.findFirst({
        where: { id: customerId, shopDomain: session.shop },
      });
      if (!customer) throw new Error("Customer was not found.");
      const { admin } = await unauthenticated.admin(session.shop);
      const result = await releaseRedemption({
        db,
        admin,
        shopDomain: session.shop,
        shopifyCustomerId: customer.shopifyCustomerId,
        sessionId: redemptionSessionId,
        reason: "Admin manually released redemption session",
      });
      return {
        ok: result.released,
        message: result.released
          ? "Redemption session released."
          : "No releasable redemption session found.",
      };
    }

    throw new Error("Unsupported customer action.");
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Customer action failed.",
    };
  }
};

export default function CustomersPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params] = useSearchParams();

  return (
    <s-page heading="Customer data">
      <s-section heading="Search">
        {actionData?.message ? (
          <s-paragraph>{actionData.message}</s-paragraph>
        ) : null}
        <Form method="get">
          <div style={{ display: "flex", gap: 12, maxWidth: 720 }}>
            <input
              name="q"
              defaultValue={params.get("q") ?? data.query}
              placeholder="Email, phone, name, or Shopify customer ID"
            />
            <s-button type="submit">Search</s-button>
          </div>
        </Form>
      </s-section>

      {data.customer ? (
        <>
          <s-section heading="Balance">
            <s-unordered-list>
              <s-list-item>
                Customer: {data.customer.firstName} {data.customer.lastName}
              </s-list-item>
              <s-list-item>Email: {data.customer.email ?? "None"}</s-list-item>
              <s-list-item>
                Shopify ID: {data.customer.shopifyCustomerId}
              </s-list-item>
              <s-list-item>
                Available: {data.customer.wallet?.availablePoints ?? 0}
              </s-list-item>
              <s-list-item>
                Pending: {data.customer.wallet?.pendingPoints ?? 0}
              </s-list-item>
              <s-list-item>
                Lifetime earned:{" "}
                {data.customer.wallet?.lifetimeEarnedPoints ?? 0}
              </s-list-item>
              <s-list-item>
                Lifetime redeemed:{" "}
                {data.customer.wallet?.lifetimeRedeemedPoints ?? 0}
              </s-list-item>
            </s-unordered-list>
          </s-section>

          <s-section heading="Manual adjustment">
            <Form method="post">
              <input type="hidden" name="intent" value="adjust" />
              <input type="hidden" name="customerId" value={data.customer.id} />
              <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
                <input
                  type="number"
                  name="points"
                  placeholder="Positive or negative points"
                  required
                />
                <input name="reason" placeholder="Required reason" required />
                <s-button type="submit">Apply adjustment</s-button>
              </div>
            </Form>
          </s-section>

          <s-section heading="Active redemptions">
            {data.customer.redemptions.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Status</th>
                    <th>Reserved</th>
                    <th>Code</th>
                    <th>Expires</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.customer.redemptions.map((redemption) => (
                    <tr key={redemption.id}>
                      <td>{redemption.id}</td>
                      <td>{redemption.status}</td>
                      <td>{redemption.pointsReserved}</td>
                      <td>{redemption.discountCode}</td>
                      <td>{redemption.expiresAt}</td>
                      <td>
                        <Form method="post">
                          <input type="hidden" name="intent" value="release" />
                          <input
                            type="hidden"
                            name="customerId"
                            value={data.customer!.id}
                          />
                          <input
                            type="hidden"
                            name="redemptionSessionId"
                            value={redemption.id}
                          />
                          <s-button type="submit">Release</s-button>
                        </Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <s-paragraph>No active redemption sessions.</s-paragraph>
            )}
          </s-section>

          <s-section heading="Ledger">
            {data.customer.ledgerEntries.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Points</th>
                    <th>Value</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {data.customer.ledgerEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.createdAt}</td>
                      <td>{entry.type}</td>
                      <td>{entry.pointsDelta}</td>
                      <td>{entry.moneyValue ?? ""}</td>
                      <td>{entry.description ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <s-paragraph>No ledger entries found.</s-paragraph>
            )}
          </s-section>
        </>
      ) : data.query ? (
        <s-section heading="No customer found">
          <s-paragraph>No loyalty customer matched the search.</s-paragraph>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
