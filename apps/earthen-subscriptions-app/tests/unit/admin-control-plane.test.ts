import { describe, expect, it } from "vitest";
import type { SubscriptionSettings } from "@prisma/client";
import { advancedConfigSchema, cancellationConfigSchema, issueMerchantCredential, notificationConfigSchema, portalConfigSchema, readinessReport, widgetConfigSchema } from "../../app/subscriptions/admin-config";
import { assertPortalActionAllowed } from "../../app/subscriptions/portal";

describe("Seal-parity admin configuration", () => {
  it("supplies safe defaults for every customer-facing module", () => {
    expect(widgetConfigSchema.parse({}).heading).toMatch(/Subscribe/);
    expect(portalConfigSchema.parse({}).allowSkip).toBe(true);
    expect(portalConfigSchema.parse({}).allowQuantityChanges).toBe(false);
    expect(cancellationConfigSchema.parse({}).reasons.length).toBeGreaterThan(3);
    expect(notificationConfigSchema.parse({}).notifyStockout).toBe(true);
    expect(advancedConfigSchema.parse({}).propagateCurrentPrices).toBe(true);
  });

  it("rejects unsafe widget values and permits approved portal actions only", () => {
    expect(() => widgetConfigSchema.parse({ accentColor: "javascript:alert(1)" })).toThrow();
    const portal = portalConfigSchema.parse({});
    expect(() => assertPortalActionAllowed(portal, "skip")).not.toThrow();
    expect(() => assertPortalActionAllowed(portal, "charge_now")).toThrow(/disabled/);
    expect(() => assertPortalActionAllowed(portal, "change_quantity")).toThrow(/disabled/);
  });

  it("never exposes stored merchant secrets and issues unique one-time credentials", () => {
    const first = issueMerchantCredential(); const second = issueMerchantCredential();
    expect(first.token).not.toBe(second.token);
    expect(first.secret).not.toBe(second.secret);
    expect(first.tokenHash).not.toContain(first.token);
    expect(first.tokenLast4).toBe(first.token.slice(-4));
  });

  it("blocks launch when required infrastructure is incomplete", () => {
    const settings = {
      widgetEnabled: false, enrollmentMode: "all", schedulerEnabled: false,
      whatsappEnabled: false, emailEnabled: false,
    } as SubscriptionSettings;
    const installation = { themeBlockInstalled: true, thankYouBlockInstalled: true, orderStatusBlockInstalled: true, accountPageInstalled: true, accountMenuInstalled: true, lastVerifiedAt: "" };
    const report = readinessReport(settings, installation);
    expect(report.launchReady).toBe(false);
    expect(report.checks.find((check) => check.key === "scheduler")?.ready).toBe(false);
  });
});
