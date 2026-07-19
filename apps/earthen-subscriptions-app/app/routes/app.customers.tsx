import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { AdminStyles, MetricCard } from "../components/admin-ui";
import { getAdminConfiguration, updateSettingsModule } from "../subscriptions/admin-config";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [{ modules }, totalCustomers, activeCustomers, cancellationReasons] = await Promise.all([
    getAdminConfiguration(db, session.shop),
    db.subscriptionGroup.groupBy({ by: ["shopifyCustomerId"], where: { shopDomain: session.shop } }),
    db.subscriptionGroup.groupBy({ by: ["shopifyCustomerId"], where: { shopDomain: session.shop, status: "active" } }),
    db.cancellationResponse.groupBy({ by: ["reasonCode"], where: { shopDomain: session.shop }, _count: true, orderBy: { _count: { reasonCode: "desc" } }, take: 10 }),
  ]);
  return { portal: modules.portal, cancellation: modules.cancellation, totalCustomers: totalCustomers.length, activeCustomers: activeCustomers.length, cancellationReasons };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const module = String(form.get("module"));
  try {
    if (module === "portal") {
      const current = (await getAdminConfiguration(db, session.shop)).modules.portal;
      await updateSettingsModule(db, session.shop, "portal", {
        ...current,
        allowSkip: form.has("allowSkip"), allowPause: form.has("allowPause"), allowResume: form.has("allowResume"),
        allowCancel: form.has("allowCancel"), allowRemoveLine: form.has("allowRemoveLine"), allowAddressChange: form.has("allowAddressChange"),
        allowReschedule: form.has("allowReschedule"), allowRetryPayment: form.has("allowRetryPayment"), allowChargeNow: form.has("allowChargeNow"),
        sections: form.getAll("sections").map(String), minimumRenewalsBeforeEdit: Number(form.get("minimumRenewalsBeforeEdit") || 0),
      });
    } else if (module === "cancellation") {
      const current = (await getAdminConfiguration(db, session.shop)).modules.cancellation;
      await updateSettingsModule(db, session.shop, "cancellation", { ...current, enabled: form.has("enabled"), requireReason: form.has("requireReason") });
    } else throw new Error("Unknown customer setting.");
    return { ok: true, message: "Customer experience settings saved." };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Could not save settings." }; }
};

export default function CustomersPage() {
  const data = useLoaderData<typeof loader>(); const result = useActionData<typeof action>();
  const controls = [
    ["allowSkip", "Skip next delivery"], ["allowPause", "Pause"], ["allowResume", "Resume"], ["allowCancel", "Cancel"],
    ["allowRemoveLine", "Remove a SKU"], ["allowAddressChange", "Change address"], ["allowReschedule", "Reschedule"], ["allowRetryPayment", "Retry payment"],
    ["allowChargeNow", "Charge now (disabled by default)"],
  ] as const;
  const sections = ["summary", "items", "billing_schedule", "payment", "recommended_products", "media", "history"] as const;
  return <s-page heading="Customers & portal"><AdminStyles /><s-stack direction="block" gap="base">
    {result ? <s-banner tone={result.ok ? "success" : "critical"}>{result.message}</s-banner> : null}
    <div className="es-admin-grid"><MetricCard label="Subscription customers" value={data.totalCustomers}/><MetricCard label="Active customers" value={data.activeCustomers}/><MetricCard label="Portal authentication" value="Shopify account + magic link"/></div>
    <s-banner tone="info">Customers manage each combined-delivery subscription from their Shopify account. Quantity, frequency, variant and add-product edits stay disabled because those changes create a replacement subscription under the approved policy.</s-banner>
    <s-section heading="Customer portal controls"><Form method="post"><input type="hidden" name="module" value="portal"/><div className="es-form-grid">{controls.map(([key, label]) => <label key={key}><input type="checkbox" name={key} defaultChecked={data.portal[key]}/>{" "}{label}</label>)}</div><p><label>Minimum completed renewals before editing <input type="number" name="minimumRenewalsBeforeEdit" min="0" max="100" defaultValue={data.portal.minimumRenewalsBeforeEdit}/></label></p><p>Visible sections</p><div className="es-form-grid">{sections.map((section) => <label key={section}><input type="checkbox" name="sections" value={section} defaultChecked={data.portal.sections.includes(section)}/>{" "}{section.replaceAll("_", " ")}</label>)}</div><p><s-button type="submit" variant="primary">Save portal controls</s-button></p></Form></s-section>
    <s-section heading="Cancellation flow"><Form method="post"><input type="hidden" name="module" value="cancellation"/><p><label><input type="checkbox" name="enabled" defaultChecked={data.cancellation.enabled}/> Show guided cancellation flow</label></p><p><label><input type="checkbox" name="requireReason" defaultChecked={data.cancellation.requireReason}/> Require a cancellation reason</label></p><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Reason shown to customer</th><th>Retention options</th></tr></thead><tbody>{data.cancellation.reasons.map((reason) => <tr key={reason.code}><td>{reason.label}</td><td>{reason.treatments.join(", ").replaceAll("_", " ")}</td></tr>)}</tbody></table></div><p><s-button type="submit" variant="primary">Save cancellation flow</s-button></p></Form></s-section>
    <s-section heading="Cancellation insights">{data.cancellationReasons.length ? data.cancellationReasons.map((reason) => <s-paragraph key={reason.reasonCode}>{reason.reasonCode.replaceAll("_", " ")}: {reason._count}</s-paragraph>) : <s-paragraph>No cancellation responses recorded.</s-paragraph>}</s-section>
  </s-stack></s-page>;
}
