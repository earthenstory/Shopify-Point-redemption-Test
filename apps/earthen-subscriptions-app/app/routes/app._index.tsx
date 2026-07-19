import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  createPricingPolicy,
  getShopConfiguration,
  stringArray,
  updateSettings,
} from "../subscriptions/settings";
import { INTERVALS } from "../subscriptions/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [{ settings, policy }, groupCounts, dueCount, recentEvents, policyHistory, cycleCounts] = await Promise.all([
    getShopConfiguration(db, session.shop),
    db.subscriptionGroup.groupBy({ by: ["status"], where: { shopDomain: session.shop }, _count: true }),
    db.subscriptionGroup.count({
      where: { shopDomain: session.shop, status: "active", nextChargeAt: { lte: new Date(Date.now() + 7 * 86_400_000) } },
    }),
    db.eventLog.findMany({ where: { shopDomain: session.shop }, orderBy: { createdAt: "desc" }, take: 10 }),
    db.pricingPolicyVersion.findMany({
      where: { shopDomain: session.shop },
      include: { tiers: { orderBy: { minimumQuantity: "asc" } }, _count: { select: { groups: true } } },
      orderBy: { version: "desc" },
    }),
    db.billingCycle.groupBy({
      by: ["status"],
      where: {
        group: { shopDomain: session.shop },
        status: { in: ["skipped_oos", "partially_skipped", "failed", "refunded_oos", "manual_review"] },
      },
      _count: true,
    }),
  ]);
  return {
    settings: {
      ...settings,
      selectedProductIds: stringArray(settings.selectedProductIds),
      excludedProductIds: stringArray(settings.excludedProductIds),
      allowedIntervals: stringArray(settings.allowedIntervals),
    },
    policy,
    groupCounts,
    dueCount,
    recentEvents,
    policyHistory,
    cycleCounts,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  try {
    if (intent === "toggle") {
      const { settings } = await getShopConfiguration(db, session.shop);
      await db.subscriptionSettings.update({
        where: { shopDomain: session.shop }, data: { widgetEnabled: !settings.widgetEnabled },
      });
      return { ok: true, message: `Subscriptions ${settings.widgetEnabled ? "disabled" : "enabled"}.` };
    }
    if (intent === "pricing") {
      const tiers = JSON.parse(String(form.get("tiers") || "[]"));
      await createPricingPolicy(db, session.shop, {
        baseDiscountBps: percentToBps(form.get("baseDiscountPercent")),
        tiers: tiers.map((tier: { minimumQuantity: unknown; additionalDiscountPercent: unknown }) => ({
          minimumQuantity: Number(tier.minimumQuantity),
          additionalDiscountBps: percentToBps(tier.additionalDiscountPercent),
        })),
      });
      return { ok: true, message: "A new pricing policy version was created for new subscriptions." };
    }
    if (intent === "migrate_policy") {
      const { policy } = await getShopConfiguration(db, session.shop);
      const result = await db.subscriptionGroup.updateMany({
        where: {
          shopDomain: session.shop,
          pricingPolicyId: { not: policy.id },
          status: { in: ["pending_mandate", "active", "paused", "halted", "reauthorization_required"] },
        },
        data: { pricingPolicyId: policy.id },
      });
      await db.eventLog.create({
        data: {
          shopDomain: session.shop,
          entityType: "pricing_policy",
          entityId: policy.id,
          eventType: "existing_subscriptions_migrated",
          maskedPayload: { policyVersion: policy.version, migratedGroups: result.count },
        },
      });
      return { ok: true, message: `${result.count} subscription${result.count === 1 ? "" : "s"} migrated to pricing policy version ${policy.version}.` };
    }
    const selectedProductIds = parseJsonArray(form.get("selectedProductIds"));
    const excludedProductIds = parseLines(form.get("excludedProductIds"));
    await updateSettings(db, session.shop, {
      widgetEnabled: form.get("widgetEnabled") === "true",
      enrollmentMode: String(form.get("enrollmentMode") || "none") as "none" | "selected" | "all",
      selectedProductIds,
      excludedProductIds,
      defaultDurationMonths: Number(form.get("defaultDurationMonths")),
      allowedIntervals: INTERVALS.filter((interval) => form.get(`interval_${interval}`) === "true"),
      activationTtlHours: Number(form.get("activationTtlHours")),
      freeShippingThresholdPaise: rupeesToPaise(form.get("freeShippingThreshold")),
      shippingFeePaise: rupeesToPaise(form.get("shippingFee")),
      whatsappEnabled: form.get("whatsappEnabled") === "true",
      successfulRenewalWhatsapp: form.get("successfulRenewalWhatsapp") === "true",
      emailEnabled: form.get("emailEnabled") === "true",
      emailFrom: String(form.get("emailFrom") || ""),
      retryDay3: Number(form.get("retryDay3")),
      retryDay7: Number(form.get("retryDay7")),
      autoCancelDays: Number(form.get("autoCancelDays")),
      expiryReminderDays: Number(form.get("expiryReminderDays")),
    });
    return { ok: true, message: "Subscription settings saved." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not save settings." };
  }
};

export default function SubscriptionAdmin() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [selectedProducts, setSelectedProducts] = useState(data.settings.selectedProductIds);
  const [tiers, setTiers] = useState(data.policy.tiers.map((tier) => ({
    minimumQuantity: tier.minimumQuantity,
    additionalDiscountPercent: tier.additionalDiscountBps / 100,
  })));

  async function pickProducts() {
    const shopify = (window as unknown as { shopify?: { resourcePicker: (options: unknown) => Promise<Array<{ id: string }>> } }).shopify;
    if (!shopify?.resourcePicker) return;
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: selectedProducts.map((id) => ({ id })),
    });
    if (selection) setSelectedProducts(selection.map((product) => product.id));
  }

  return (
    <s-page heading="Earthen Subscriptions">
      <s-stack direction="block" gap="large-100">
        {result ? <s-banner tone={result.ok ? "success" : "critical"}>{result.message}</s-banner> : null}

        <s-section heading="Master control">
          <s-stack direction="block" gap="base">
            <s-banner tone={data.settings.widgetEnabled ? "success" : "warning"}>
              Subscription signup is currently {data.settings.widgetEnabled ? "ON" : "OFF"}. Existing subscriptions continue when signup is off.
            </s-banner>
            <Form method="post">
              <input type="hidden" name="intent" value="toggle" />
              <s-button type="submit" tone={data.settings.widgetEnabled ? "critical" : undefined} variant={data.settings.widgetEnabled ? undefined : "primary"}>
                Turn subscriptions {data.settings.widgetEnabled ? "off" : "on"}
              </s-button>
            </Form>
          </s-stack>
        </s-section>

        <s-section heading="Overview">
          <s-grid gridTemplateColumns="repeat(4, 1fr)" gap="base">
            {data.groupCounts.map((item) => (
              <s-box key={item.status} padding="base" borderWidth="base" borderRadius="base">
                <s-text type="strong">{item._count} {item.status}</s-text>
              </s-box>
            ))}
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-text type="strong">{data.dueCount} delivery groups due in 7 days</s-text>
            </s-box>
            {data.cycleCounts.map((item) => (
              <s-box key={item.status} padding="base" borderWidth="base" borderRadius="base">
                <s-text type="strong">{item._count} {item.status.replaceAll("_", " ")} cycles</s-text>
              </s-box>
            ))}
          </s-grid>
        </s-section>

        <s-section heading="Products, schedule, shipping and notifications">
          <Form method="post">
            <input type="hidden" name="intent" value="settings" />
            <input type="hidden" name="widgetEnabled" value={String(data.settings.widgetEnabled)} />
            <input type="hidden" name="selectedProductIds" value={JSON.stringify(selectedProducts)} />
            <s-stack direction="block" gap="base">
              <s-select name="enrollmentMode" label="Products accepting new subscriptions" value={data.settings.enrollmentMode}>
                <s-option value="none">None</s-option>
                <s-option value="selected">Selected products</s-option>
                <s-option value="all">All eligible physical products</s-option>
              </s-select>
              <s-stack direction="inline" gap="base">
                <s-button type="button" onClick={pickProducts}>Select products from Shopify</s-button>
                <s-text>{selectedProducts.length} selected</s-text>
              </s-stack>
              <s-text-area
                name="excludedProductIds"
                label="Excluded product IDs (one per line)"
                defaultValue={data.settings.excludedProductIds.join("\n")}
                details="Useful when enrollment mode is All. Existing subscriptions continue."
              />
              <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
                <s-number-field name="defaultDurationMonths" label="Default duration (months)" min={12} max={120} defaultValue={String(data.settings.defaultDurationMonths)} />
                <s-number-field name="activationTtlHours" label="Activation link expiry (hours)" min={1} max={168} defaultValue={String(data.settings.activationTtlHours)} />
                <s-number-field name="expiryReminderDays" label="Expiry reminder (days before)" min={1} max={90} defaultValue={String(data.settings.expiryReminderDays)} />
              </s-grid>
              <s-stack direction="block" gap="small-100">
                <s-text type="strong">Customer intervals</s-text>
                <s-stack direction="inline" gap="base">
                  {INTERVALS.map((interval) => (
                    <s-checkbox key={interval} name={`interval_${interval}`} value="true" label={interval.replace("_", " ")} defaultChecked={data.settings.allowedIntervals.includes(interval)} />
                  ))}
                </s-stack>
              </s-stack>
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-number-field name="freeShippingThreshold" label="Free shipping threshold (₹)" min={0} step={1} defaultValue={String(data.settings.freeShippingThresholdPaise / 100)} />
                <s-number-field name="shippingFee" label="Shipping fee below threshold (₹)" min={0} step={1} defaultValue={String(data.settings.shippingFeePaise / 100)} />
              </s-grid>
              <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
                <s-number-field name="retryDay3" label="First retry day" min={1} max={30} defaultValue={String(data.settings.retryDay3)} />
                <s-number-field name="retryDay7" label="Second retry day" min={1} max={30} defaultValue={String(data.settings.retryDay7)} />
                <s-number-field name="autoCancelDays" label="Auto-cancel after days" min={1} max={90} defaultValue={String(data.settings.autoCancelDays)} />
              </s-grid>
              <s-stack direction="inline" gap="base">
                <s-checkbox name="whatsappEnabled" value="true" label="WhatsApp notifications" defaultChecked={data.settings.whatsappEnabled} />
                <s-checkbox name="successfulRenewalWhatsapp" value="true" label="Successful-renewal WhatsApp" defaultChecked={data.settings.successfulRenewalWhatsapp} />
                <s-checkbox name="emailEnabled" value="true" label="Transactional email" defaultChecked={data.settings.emailEnabled} />
              </s-stack>
              <s-text-field name="emailFrom" label="Transactional sender email" defaultValue={data.settings.emailFrom ?? ""} />
              <s-button type="submit" variant="primary">Save settings</s-button>
            </s-stack>
          </Form>
        </s-section>

        <s-section heading="Discount policy for new subscriptions">
          <Form method="post">
            <input type="hidden" name="intent" value="pricing" />
            <input type="hidden" name="tiers" value={JSON.stringify(tiers)} />
            <s-stack direction="block" gap="base">
              <s-number-field name="baseDiscountPercent" label="Base subscription discount (%)" min={0} max={99.99} step={0.01} defaultValue={String(data.policy.baseDiscountBps / 100)} />
              {tiers.map((tier, index) => (
                <s-grid key={index} gridTemplateColumns="1fr 1fr auto" gap="base">
                  <s-number-field label="Minimum total units" value={String(tier.minimumQuantity)} onChange={(event: Event) => updateTier(index, "minimumQuantity", event, setTiers)} />
                  <s-number-field label="Additional discount (%)" value={String(tier.additionalDiscountPercent)} step={0.01} onChange={(event: Event) => updateTier(index, "additionalDiscountPercent", event, setTiers)} />
                  <s-button type="button" tone="critical" onClick={() => setTiers((current) => current.filter((_, i) => i !== index))}>Remove</s-button>
                </s-grid>
              ))}
              <s-stack direction="inline" gap="base">
                <s-button type="button" onClick={() => setTiers((current) => [...current, { minimumQuantity: 2, additionalDiscountPercent: 1 }])}>Add tier</s-button>
                <s-button type="submit" variant="primary">Create pricing version {data.policy.version + 1}</s-button>
              </s-stack>
              <s-paragraph>Existing subscriptions remain on policy version {data.policy.version}; changes apply only to new activations.</s-paragraph>
            </s-stack>
          </Form>
        </s-section>

        <s-section heading="Discount policy history">
          <s-stack direction="block" gap="base">
            {data.policyHistory.map((item) => (
              <s-box key={item.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-100">
                  <s-text type="strong">
                    Version {item.version}{item.id === data.policy.id ? " — current" : ""}
                  </s-text>
                  <s-text>
                    {item.baseDiscountBps / 100}% base; {item.tiers.length} quantity tier{item.tiers.length === 1 ? "" : "s"}; {item._count.groups} subscription group{item._count.groups === 1 ? "" : "s"}
                  </s-text>
                </s-stack>
              </s-box>
            ))}
            <s-banner tone="warning">
              Migration changes the discount agreement for every current non-final subscription. Use it only after communicating the change to affected customers.
            </s-banner>
            <Form method="post">
              <input type="hidden" name="intent" value="migrate_policy" />
              <s-button type="submit" tone="critical">Migrate existing subscriptions to version {data.policy.version}</s-button>
            </Form>
          </s-stack>
        </s-section>

        <s-section heading="Recent subscription events">
          <s-stack direction="block" gap="small-100">
            {data.recentEvents.length === 0 ? <s-paragraph>No events yet.</s-paragraph> : data.recentEvents.map((event) => (
              <s-paragraph key={event.id}>{event.createdAt.toLocaleString("en-IN")} — {event.eventType.replaceAll("_", " ")} — {event.entityType} {event.entityId}</s-paragraph>
            ))}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

function updateTier(
  index: number,
  key: "minimumQuantity" | "additionalDiscountPercent",
  event: Event,
  setTiers: React.Dispatch<React.SetStateAction<Array<{ minimumQuantity: number; additionalDiscountPercent: number }>>>,
) {
  const value = Number((event.currentTarget as HTMLInputElement).value);
  setTiers((current) => current.map((tier, i) => i === index ? { ...tier, [key]: value } : tier));
}

function parseJsonArray(value: FormDataEntryValue | null): string[] {
  try { const parsed = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed.map(String) : []; }
  catch { return []; }
}
function parseLines(value: FormDataEntryValue | null): string[] {
  return String(value || "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}
function percentToBps(value: unknown): number { return Math.round(Number(value) * 100); }
function rupeesToPaise(value: unknown): number { return Math.round(Number(value) * 100); }
