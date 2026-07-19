import type { PrismaClient } from "@prisma/client";
import { jsonObject, notificationConfigSchema } from "./admin-config";

export type NotificationChannel = "email" | "whatsapp";

export async function sendNotification(input: {
  db: PrismaClient;
  shopDomain: string;
  channel: NotificationChannel;
  template: string;
  recipient: string;
  idempotencyKey: string;
  variables: Record<string, string | number | boolean | null>;
}) {
  const existing = await input.db.notificationLog.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return existing;
  const settings = await input.db.subscriptionSettings.findUnique({
    where: { shopDomain: input.shopDomain },
  });
  const notificationConfig = notificationConfigSchema.parse(jsonObject(settings?.notificationConfig));
  const templateEnabled = isTemplateEnabled(input.template, notificationConfig);
  const configured = input.channel === "email"
    ? Boolean(templateEnabled && notificationConfig.customerEmailEnabled && settings?.emailEnabled && process.env.EMAIL_PROVIDER_URL && process.env.EMAIL_PROVIDER_TOKEN)
    : Boolean(templateEnabled && notificationConfig.customerWhatsappEnabled && settings?.whatsappEnabled && process.env.HERMES_BASE_URL && process.env.HERMES_TOKEN);
  const log = await input.db.notificationLog.create({
    data: {
      shopDomain: input.shopDomain,
      channel: input.channel,
      template: input.template,
      idempotencyKey: input.idempotencyKey,
      recipientMasked: maskRecipient(input.recipient),
      status: configured ? "sending" : "skipped_unconfigured",
    },
  });
  if (!configured) return log;
  try {
    const endpoint = input.channel === "email"
      ? process.env.EMAIL_PROVIDER_URL!
      : `${process.env.HERMES_BASE_URL!.replace(/\/$/, "")}/messages/template`;
    const token = input.channel === "email"
      ? process.env.EMAIL_PROVIDER_TOKEN!
      : process.env.HERMES_TOKEN!;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: input.recipient,
        from: input.channel === "email" ? settings?.emailFrom ?? process.env.EMAIL_FROM : undefined,
        template: input.template,
        variables: input.variables,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Provider returned ${response.status}`);
    return input.db.notificationLog.update({
      where: { id: log.id },
      data: {
        status: "sent",
        sentAt: new Date(),
        providerReference: String((payload as { id?: string }).id ?? ""),
      },
    });
  } catch (error) {
    return input.db.notificationLog.update({
      where: { id: log.id },
      data: { status: "failed", error: error instanceof Error ? error.message : "Provider error" },
    });
  }
}

function isTemplateEnabled(template: string, config: ReturnType<typeof notificationConfigSchema.parse>) {
  if (["subscription_activation", "subscription_portal_link", "subscription_pre_renewal"].includes(template)) return true;
  if (["subscription_payment_failed", "subscription_reauthorization_required"].includes(template)) return config.notifyBillingFailure;
  if (["subscription_skipped_out_of_stock", "subscription_partially_shipped"].includes(template)) return config.notifyStockout;
  if (template === "subscription_renewal_successful") return config.notifyBillingSuccess;
  if (template === "subscription_auto_cancelled") return config.notifyCancellation;
  if (template === "subscription_expiry_reminder") return config.notifyExpiry;
  return true;
}

export async function notifyBoth(input: Omit<Parameters<typeof sendNotification>[0], "channel" | "recipient"> & {
  email: string;
  phone: string;
}) {
  const results = [];
  if (input.email) results.push(await sendNotification({
    ...input, channel: "email", recipient: input.email,
    idempotencyKey: `${input.idempotencyKey}:email`,
  }));
  if (input.phone) results.push(await sendNotification({
    ...input, channel: "whatsapp", recipient: input.phone,
    idempotencyKey: `${input.idempotencyKey}:whatsapp`,
  }));
  return results;
}

export function maskRecipient(value: string): string {
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return value.length <= 4 ? "****" : `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}
