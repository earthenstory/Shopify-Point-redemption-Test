import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { AdminStyles, StatusBadge } from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { createPricingPolicy, getShopConfiguration, stringArray, updateSettings } from "../subscriptions/settings";
import { INTERVALS } from "../subscriptions/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [{ settings, policy }, policies, schedules] = await Promise.all([
    getShopConfiguration(db, session.shop),
    db.pricingPolicyVersion.findMany({
      where: { shopDomain: session.shop }, include: { tiers: { orderBy: { minimumQuantity: "asc" } }, _count: { select: { groups: true } } },
      orderBy: { version: "desc" },
    }),
    db.automationRule.findMany({ where: { shopDomain: session.shop, kind: "fixed_schedule" }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    settings: {
      ...settings,
      selectedProductIds: stringArray(settings.selectedProductIds),
      excludedProductIds: stringArray(settings.excludedProductIds),
      allowedIntervals: stringArray(settings.allowedIntervals),
    }, policy, policies, schedules,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  try {
    if (intent === "settings") {
      const current = await db.subscriptionSettings.findUniqueOrThrow({ where: { shopDomain: session.shop } });
      await updateSettings(db, session.shop, {
        widgetEnabled: current.widgetEnabled,
        enrollmentMode: String(form.get("enrollmentMode") || "none") as "none" | "selected" | "all",
        selectedProductIds: parseJsonArray(form.get("selectedProductIds")),
        excludedProductIds: parseLines(form.get("excludedProductIds")),
        defaultDurationMonths: Number(form.get("defaultDurationMonths")),
        allowedIntervals: INTERVALS.filter((interval) => form.get(`interval_${interval}`) === "true"),
        activationTtlHours: current.activationTtlHours,
        freeShippingThresholdPaise: rupeesToPaise(form.get("freeShippingThreshold")),
        shippingFeePaise: rupeesToPaise(form.get("shippingFee")),
        whatsappEnabled: current.whatsappEnabled,
        successfulRenewalWhatsapp: current.successfulRenewalWhatsapp,
        emailEnabled: current.emailEnabled,
        emailFrom: current.emailFrom,
        retryDay3: current.retryDay3,
        retryDay7: current.retryDay7,
        autoCancelDays: current.autoCancelDays,
        expiryReminderDays: current.expiryReminderDays,
      });
      return { ok: true, message: "Product, interval, duration and shipping settings saved." };
    }
    if (intent === "pricing") {
      const tiers = JSON.parse(String(form.get("tiers") || "[]"));
      await createPricingPolicy(db, session.shop, {
        baseDiscountBps: percentToBps(form.get("baseDiscountPercent")),
        tiers: tiers.map((tier: { minimumQuantity: unknown; additionalDiscountPercent: unknown }) => ({
          minimumQuantity: Number(tier.minimumQuantity), additionalDiscountBps: percentToBps(tier.additionalDiscountPercent),
        })),
      });
      return { ok: true, message: "A new discount-policy version was created for new subscriptions." };
    }
    if (intent === "migrate_policy") {
      const { policy } = await getShopConfiguration(db, session.shop);
      const changed = await db.subscriptionGroup.updateMany({
        where: { shopDomain: session.shop, pricingPolicyId: { not: policy.id }, status: { in: ["pending_mandate", "active", "paused", "halted", "reauthorization_required"] } },
        data: { pricingPolicyId: policy.id },
      });
      return { ok: true, message: `${changed.count} subscriptions migrated to policy version ${policy.version}.` };
    }
    if (intent === "fixed_schedule") {
      const name = String(form.get("name") || "").trim();
      const day = Number(form.get("day"));
      if (!name || day < 1 || day > 28) throw new Error("Enter a schedule name and a day between 1 and 28");
      await db.automationRule.create({
        data: { shopDomain: session.shop, kind: "fixed_schedule", name, status: "active", config: { day, interval: String(form.get("interval") || "monthly") } },
      });
      return { ok: true, message: "Fixed schedule created." };
    }
    if (intent === "delete_schedule") {
      await db.automationRule.deleteMany({ where: { id: String(form.get("id")), shopDomain: session.shop, kind: "fixed_schedule" } });
      return { ok: true, message: "Fixed schedule removed." };
    }
    return { ok: false, message: "Unknown products and plans action." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not save configuration." };
  }
};

export default function ProductsAndPlans() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [selectedProducts, setSelectedProducts] = useState(data.settings.selectedProductIds);
  const [tiers, setTiers] = useState(data.policy.tiers.map((tier) => ({ minimumQuantity: tier.minimumQuantity, additionalDiscountPercent: tier.additionalDiscountBps / 100 })));
  async function pickProducts() {
    const shopify = (window as unknown as { shopify?: { resourcePicker: (options: unknown) => Promise<Array<{ id: string }>> } }).shopify;
    if (!shopify?.resourcePicker) return;
    const selection = await shopify.resourcePicker({ type: "product", multiple: true, selectionIds: selectedProducts.map((id) => ({ id })) });
    if (selection) setSelectedProducts(selection.map((product) => product.id));
  }
  return <s-page heading="Products & plans">
    <AdminStyles />
    <s-stack direction="block" gap="large-100">
      {result ? <s-banner tone={result.ok ? "success" : "critical"}>{result.message}</s-banner> : null}
      <s-banner tone="info">Earthen uses one global subscription policy. Quantity, interval and variant changes create a replacement subscription; removing a SKU remains available in place.</s-banner>
      <s-section heading="Product eligibility, intervals and shipping">
        <Form method="post"><input type="hidden" name="intent" value="settings" /><input type="hidden" name="selectedProductIds" value={JSON.stringify(selectedProducts)} />
          <s-stack direction="block" gap="base">
            <s-select name="enrollmentMode" label="Products accepting new subscriptions" value={data.settings.enrollmentMode}>
              <s-option value="none">None</s-option><s-option value="selected">Selected products</s-option><s-option value="all">All eligible physical products</s-option>
            </s-select>
            <div className="es-actions"><s-button type="button" onClick={pickProducts}>Select products from Shopify</s-button><span>{selectedProducts.length} selected</span></div>
            <s-text-area name="excludedProductIds" label="Excluded product IDs (one per line)" defaultValue={data.settings.excludedProductIds.join("\n")} details="Exclusions override All products. Existing subscriptions continue." />
            <div className="es-form-grid">
              <s-number-field name="defaultDurationMonths" label="Default duration (months)" min={12} max={120} defaultValue={String(data.settings.defaultDurationMonths)} />
              <s-number-field name="freeShippingThreshold" label="Free shipping threshold (₹)" min={0} defaultValue={String(data.settings.freeShippingThresholdPaise / 100)} />
              <s-number-field name="shippingFee" label="Shipping fee below threshold (₹)" min={0} defaultValue={String(data.settings.shippingFeePaise / 100)} />
            </div>
            <s-text type="strong">Customer intervals</s-text>
            <div className="es-actions">{INTERVALS.map((interval) => <s-checkbox key={interval} name={`interval_${interval}`} value="true" label={interval.replaceAll("_", " ")} defaultChecked={data.settings.allowedIntervals.includes(interval)} />)}</div>
            <s-button type="submit" variant="primary">Save product and plan settings</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Global discount policy for new subscriptions">
        <Form method="post"><input type="hidden" name="intent" value="pricing" /><input type="hidden" name="tiers" value={JSON.stringify(tiers)} />
          <s-stack direction="block" gap="base">
            <s-number-field name="baseDiscountPercent" label="Base subscription discount (%)" min={0} max={99.99} step={0.01} defaultValue={String(data.policy.baseDiscountBps / 100)} />
            {tiers.map((tier, index) => <div className="es-form-grid" key={index}>
              <s-number-field label="Minimum total units" value={String(tier.minimumQuantity)} onChange={(event: Event) => changeTier(index, "minimumQuantity", event, setTiers)} />
              <s-number-field label="Additional discount (%)" value={String(tier.additionalDiscountPercent)} step={0.01} onChange={(event: Event) => changeTier(index, "additionalDiscountPercent", event, setTiers)} />
              <s-button type="button" tone="critical" onClick={() => setTiers((current) => current.filter((_, i) => i !== index))}>Remove</s-button>
            </div>)}
            <div className="es-actions"><s-button type="button" onClick={() => setTiers((current) => [...current, { minimumQuantity: 2, additionalDiscountPercent: 1 }])}>Add tier</s-button><s-button type="submit" variant="primary">Create pricing version {data.policy.version + 1}</s-button></div>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Discount-policy history">
        <div className="es-table-wrap"><table className="es-table"><thead><tr><th>Version</th><th>Base</th><th>Quantity tiers</th><th>Subscriptions</th><th>Status</th></tr></thead><tbody>
          {data.policies.map((policy) => <tr key={policy.id}><td>{policy.version}</td><td>{policy.baseDiscountBps / 100}%</td><td>{policy.tiers.map((tier) => `${tier.minimumQuantity}+ = +${tier.additionalDiscountBps / 100}%`).join(", ")}</td><td>{policy._count.groups}</td><td><StatusBadge status={policy.id === data.policy.id ? "active" : "archived"} /></td></tr>)}
        </tbody></table></div>
        <s-banner tone="warning">Migrating existing subscriptions changes their accepted discount policy.</s-banner>
        <Form method="post"><input type="hidden" name="intent" value="migrate_policy" /><s-button type="submit" tone="critical">Migrate existing subscriptions to version {data.policy.version}</s-button></Form>
      </s-section>

      <s-section heading="Fixed schedules">
        <Form method="post"><input type="hidden" name="intent" value="fixed_schedule" /><div className="es-form-grid">
          <s-text-field name="name" label="Schedule name" placeholder="Monthly delivery day" />
          <s-select name="interval" label="Interval"><s-option value="monthly">Monthly</s-option><s-option value="bimonthly">Every two months</s-option><s-option value="quarterly">Quarterly</s-option></s-select>
          <s-number-field name="day" label="Billing day of month" min={1} max={28} defaultValue="1" />
        </div><s-button type="submit">Create fixed schedule</s-button></Form>
        {data.schedules.length === 0 ? <s-paragraph>No fixed schedules configured.</s-paragraph> : data.schedules.map((schedule) => <div className="es-check" key={schedule.id}><div><strong>{schedule.name}</strong><div className="es-muted">{JSON.stringify(schedule.config)}</div></div><Form method="post"><input type="hidden" name="intent" value="delete_schedule" /><input type="hidden" name="id" value={schedule.id} /><s-button type="submit" tone="critical">Remove</s-button></Form></div>)}
      </s-section>

      <s-section heading="Quick subscription link">
        <s-paragraph>Create campaign links that preselect a delivery interval and quantity on a product page.</s-paragraph>
        <s-text-area label="Link format" readOnly value="https://www.earthenstory.com/products/PRODUCT-HANDLE?earthen_subscription=1&interval=monthly&quantity=1" />
      </s-section>
    </s-stack>
  </s-page>;
}

function changeTier(index: number, key: "minimumQuantity" | "additionalDiscountPercent", event: Event, setTiers: React.Dispatch<React.SetStateAction<Array<{ minimumQuantity: number; additionalDiscountPercent: number }>>>) {
  const value = Number((event.currentTarget as HTMLInputElement).value);
  setTiers((current) => current.map((tier, i) => i === index ? { ...tier, [key]: value } : tier));
}
function parseJsonArray(value: FormDataEntryValue | null): string[] { try { const parsed = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } }
function parseLines(value: FormDataEntryValue | null): string[] { return String(value || "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean); }
function percentToBps(value: unknown) { return Math.round(Number(value) * 100); }
function rupeesToPaise(value: unknown) { return Math.round(Number(value) * 100); }
