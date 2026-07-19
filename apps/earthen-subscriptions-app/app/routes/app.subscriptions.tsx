import type { LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { AdminStyles, StatusBadge, formatMoney } from "../components/admin-ui";

const FILTERS = [
  ["", "All"], ["upcoming", "Upcoming"], ["failed", "Failed"], ["pending_mandate", "Pending"],
  ["active", "Active"], ["paused", "Paused"], ["cancelled", "Cancelled"],
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const take = 25;
  const now = new Date();
  const where = {
    shopDomain: session.shop,
    ...(status === "upcoming" ? { status: "active", nextChargeAt: { gte: now } }
      : status === "failed" ? { status: { in: ["halted", "reauthorization_required"] } }
        : status ? { status } : {}),
    ...(search ? { OR: [
      { id: { contains: search, mode: "insensitive" as const } },
      { customerName: { contains: search, mode: "insensitive" as const } },
      { customerEmail: { contains: search, mode: "insensitive" as const } },
      { customerPhone: { contains: search } },
      { lines: { some: { OR: [
        { sku: { contains: search, mode: "insensitive" as const } },
        { productTitle: { contains: search, mode: "insensitive" as const } },
      ] } } },
    ] } : {}),
  };
  const [groups, total, counts] = await Promise.all([
    db.subscriptionGroup.findMany({
      where, include: { lines: { where: { status: "active" } }, pricingPolicy: true },
      orderBy: status === "upcoming" ? { nextChargeAt: "asc" } : { createdAt: "desc" }, skip: (page - 1) * take, take,
    }),
    db.subscriptionGroup.count({ where }),
    db.subscriptionGroup.groupBy({ by: ["status"], where: { shopDomain: session.shop }, _count: true }),
  ]);
  return { groups, total, counts, search, status, page, pages: Math.max(1, Math.ceil(total / take)) };
};

export default function SubscriptionsPage() {
  const data = useLoaderData<typeof loader>();
  const countMap = Object.fromEntries(data.counts.map((row) => [row.status, row._count]));
  return <s-page heading="Subscriptions">
    <AdminStyles />
    <s-button slot="primary-action" href="/app/operations?section=imports">Import subscriptions</s-button>
    <s-stack direction="block" gap="base">
      <div className="es-tabs">
        {FILTERS.map(([value, label]) => <a key={value} href={`/app/subscriptions${value ? `?status=${value}` : ""}`} aria-current={data.status === value ? "page" : undefined}>
          {label}{["active", "paused", "pending_mandate", "cancelled"].includes(value) ? ` (${countMap[value] ?? 0})` : ""}
        </a>)}
      </div>
      <Form method="get">
        {data.status ? <input type="hidden" name="status" value={data.status} /> : null}
        <s-grid gridTemplateColumns="1fr auto" gap="base">
          <s-text-field name="search" label="Search subscriptions" defaultValue={data.search} placeholder="Customer, email, phone, product, SKU or ID" />
          <s-button type="submit" variant="primary">Search</s-button>
        </s-grid>
      </Form>
      <s-banner tone="info">{data.total} matching subscription{data.total === 1 ? "" : "s"}. A subscription groups SKUs sharing one customer, frequency and renewal date into one order and payment.</s-banner>
      <div className="es-table-wrap"><table className="es-table"><thead><tr>
        <th>Subscription</th><th>Customer</th><th>Items</th><th>Status</th><th>Next renewal</th><th>Mandate</th><th></th>
      </tr></thead><tbody>
        {data.groups.length === 0 ? <tr><td colSpan={7}>No subscriptions match this view.</td></tr> : data.groups.map((group) => <tr key={group.id}>
          <td><span className="es-code">{group.id.slice(-8)}</span><br/><span className="es-muted">{group.intervalCode.replaceAll("_", " ")}</span></td>
          <td>{group.customerName}<br/><span className="es-muted">{group.customerEmail}</span></td>
          <td>{group.lines.reduce((sum, line) => sum + line.quantity, 0)} units<br/><span className="es-muted">{group.lines.map((line) => `${line.quantity}× ${line.productTitle}`).join(", ")}</span></td>
          <td><StatusBadge status={group.status} /></td>
          <td>{group.nextChargeAt?.toLocaleDateString("en-IN") ?? "—"}</td>
          <td>{formatMoney(group.mandateMaxPaise)}</td>
          <td><s-link href={`/app/subscriptions/${group.id}`}>View</s-link></td>
        </tr>)}
      </tbody></table></div>
      <div className="es-actions">
        {data.page > 1 ? <s-button href={pageHref(data.page - 1, data.status, data.search)}>Previous</s-button> : null}
        <span>Page {data.page} of {data.pages}</span>
        {data.page < data.pages ? <s-button href={pageHref(data.page + 1, data.status, data.search)}>Next</s-button> : null}
      </div>
    </s-stack>
  </s-page>;
}

function pageHref(page: number, status: string, search: string) {
  const params = new URLSearchParams({ page: String(page) });
  if (status) params.set("status", status);
  if (search) params.set("search", search);
  return `/app/subscriptions?${params}`;
}
