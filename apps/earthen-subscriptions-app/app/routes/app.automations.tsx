import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { AdminStyles, StatusBadge } from "../components/admin-ui";

const KINDS = ["loyalty_discount", "product_swap", "interval_change", "product_upsell", "fixed_schedule"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rules = await db.automationRule.findMany({ where: { shopDomain: session.shop }, orderBy: { createdAt: "desc" } });
  return { rules };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request); const form = await request.formData(); const intent = String(form.get("intent"));
  try {
    if (intent === "create") {
      const kind = String(form.get("kind")); if (!KINDS.includes(kind as typeof KINDS[number])) throw new Error("Unsupported automation type.");
      await db.automationRule.create({ data: { shopDomain: session.shop, kind, name: String(form.get("name") || kind.replaceAll("_", " ")), status: "draft", config: { trigger: String(form.get("trigger") || "manual"), action: String(form.get("ruleAction") || "review") } } });
    } else if (intent === "toggle") {
      const rule = await db.automationRule.findFirst({ where: { id: String(form.get("id")), shopDomain: session.shop } }); if (!rule) throw new Error("Automation not found.");
      await db.automationRule.update({ where: { id: rule.id }, data: { status: rule.status === "active" ? "paused" : "active" } });
    } else if (intent === "delete") {
      const rule = await db.automationRule.findFirst({ where: { id: String(form.get("id")), shopDomain: session.shop } }); if (!rule) throw new Error("Automation not found.");
      await db.automationRule.delete({ where: { id: rule.id } });
    } else throw new Error("Unknown automation action.");
    return { ok: true, message: "Automation updated." };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Automation update failed." }; }
};

export default function AutomationsPage() { const { rules } = useLoaderData<typeof loader>(); const result = useActionData<typeof action>(); return <s-page heading="Automations"><AdminStyles/><s-stack direction="block" gap="base">
  {result ? <s-banner tone={result.ok ? "success" : "critical"}>{result.message}</s-banner> : null}
  <s-banner tone="info">Rules are created in draft. Activating a rule makes it eligible for scheduled evaluation; changes are audit-safe and never retroactively alter accepted pricing unless explicitly migrated.</s-banner>
  <s-section heading="Create automation"><Form method="post"><input type="hidden" name="intent" value="create"/><div className="es-form-grid"><label>Name<br/><input name="name" required/></label><label>Type<br/><select name="kind">{KINDS.map((kind) => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}</select></label><label>Trigger<br/><input name="trigger" placeholder="e.g. after 6 renewals"/></label><label>Action<br/><input name="ruleAction" placeholder="e.g. add 1% loyalty bonus"/></label></div><p><s-button type="submit" variant="primary">Create draft</s-button></p></Form></s-section>
  <s-section heading="Automation rules"><div className="es-table-wrap"><table className="es-table"><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Last run</th><th>Processed</th><th>Actions</th></tr></thead><tbody>{rules.length ? rules.map((rule) => <tr key={rule.id}><td>{rule.name}</td><td>{rule.kind.replaceAll("_", " ")}</td><td><StatusBadge status={rule.status}/></td><td>{rule.lastRunAt?.toLocaleString("en-IN") ?? "Never"}</td><td>{rule.processedCount}</td><td><div className="es-actions"><Form method="post"><input type="hidden" name="id" value={rule.id}/><button name="intent" value="toggle">{rule.status === "active" ? "Pause" : "Activate"}</button></Form><Form method="post"><input type="hidden" name="id" value={rule.id}/><button name="intent" value="delete">Delete</button></Form></div></td></tr>) : <tr><td colSpan={6}>No automations configured.</td></tr>}</tbody></table></div></s-section>
</s-stack></s-page>; }
