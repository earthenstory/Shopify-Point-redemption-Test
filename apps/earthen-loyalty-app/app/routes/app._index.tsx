import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { getLoyaltyRuntimeSettings } from "../loyalty/settings";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: session.shop,
  });
  const [wallets, ledgers, redemptions, latestBatch, failedWebhooks] =
    await Promise.all([
      db.wallet.aggregate({
        _sum: {
          availablePoints: true,
          pendingPoints: true,
          lifetimeEarnedPoints: true,
          lifetimeRedeemedPoints: true,
        },
        _count: { _all: true },
      }),
      db.ledgerEntry.count(),
      db.redemptionSession.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      db.bonMigrationBatch.findFirst({
        where: { shopDomain: session.shop },
        orderBy: { createdAt: "desc" },
      }),
      db.webhookEvent.count({
        where: { shopDomain: session.shop, status: "failed" },
      }),
    ]);

  return {
    shop: session.shop,
    program: {
      status: settings.program.status,
      programName: settings.program.programName,
      pointName: settings.program.pointName,
      bonWidgetDisabled: settings.program.bonWidgetDisabled,
      standardCheckoutTested: settings.program.standardCheckoutTested,
      expressCheckoutTested: settings.program.expressCheckoutTested,
    },
    rule: {
      earningEnabled: settings.earningEnabled,
      redemptionEnabled: settings.redemptionEnabled,
      signupRewardPoints: settings.rules.signupRewardPoints,
      pointsPerSpendAmount: settings.rules.pointsPerSpendAmount,
      spendAmountForEarnPoints: settings.rules.spendAmountForEarnPoints,
      minRedeemPoints: settings.rules.minRedeemPoints,
      maxRedeemPercentOfCart: settings.rules.maxRedeemPercentOfCart,
    },
    wallets: wallets._sum,
    walletCount: wallets._count._all,
    ledgerCount: ledgers,
    redemptions: redemptions.map((row) => ({
      status: row.status,
      count: row._count._all,
    })),
    latestBatch: latestBatch
      ? {
          sourceFileName: latestBatch.sourceFileName,
          status: latestBatch.status,
          validRowCount: latestBatch.validRowCount,
          invalidRowCount: latestBatch.invalidRowCount,
          totalSourcePoints: latestBatch.totalSourcePoints,
          totalImportedPoints: latestBatch.totalImportedPoints,
          importedAt: latestBatch.importedAt?.toISOString() ?? null,
        }
      : null,
    failedWebhooks,
  };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const warnings = [
    !data.program.bonWidgetDisabled
      ? "BON storefront widget/app embed is still marked as not disabled."
      : null,
    !data.program.standardCheckoutTested
      ? "Standard checkout test is not marked complete."
      : null,
    !data.program.expressCheckoutTested
      ? "Express checkout test is not marked complete."
      : null,
    data.failedWebhooks > 0
      ? `${data.failedWebhooks} failed webhook event(s) need review.`
      : null,
  ].filter((warning): warning is string => Boolean(warning));

  const metrics = [
    { label: "Members", value: data.walletCount },
    { label: "Available points", value: data.wallets.availablePoints ?? 0 },
    { label: "Lifetime earned", value: data.wallets.lifetimeEarnedPoints ?? 0 },
    { label: "Lifetime redeemed", value: data.wallets.lifetimeRedeemedPoints ?? 0 },
  ];
  const statusTone =
    data.program.status === "active"
      ? "success"
      : data.program.status === "paused"
        ? "warning"
        : "info";

  return (
    <s-page heading={`${data.program.programName} overview`}>
      <s-stack direction="block" gap="large-100">
        {warnings.length > 0 ? (
          <s-banner tone="warning" heading="Before you go live">
            <s-unordered-list>
              {warnings.map((warning) => (
                <s-list-item key={warning}>{warning}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        ) : (
          <s-banner tone="success">Everything looks ready to go live.</s-banner>
        )}

        <s-section heading="At a glance">
          <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
            {metrics.map((metric) => (
              <s-box
                key={metric.label}
                padding="base"
                background="subdued"
                borderRadius="base"
              >
                <s-stack direction="block" gap="none">
                  <s-text color="subdued">
                    {metric.label}
                  </s-text>
                  <s-heading>{metric.value.toLocaleString("en-IN")}</s-heading>
                </s-stack>
              </s-box>
            ))}
          </s-grid>
          <s-text color="subdued">
            {data.ledgerCount.toLocaleString("en-IN")} ledger entries ·{" "}
            {data.wallets.pendingPoints ?? 0} points currently reserved
          </s-text>
        </s-section>

        <s-section heading="Program">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-badge tone={statusTone}>
                {data.program.status === "active"
                  ? "Active"
                  : data.program.status === "paused"
                    ? "Paused"
                    : "Test mode"}
              </s-badge>
              <s-badge tone={data.rule.earningEnabled ? "success" : "neutral"}>
                Earning {data.rule.earningEnabled ? "on" : "off"}
              </s-badge>
              <s-badge tone={data.rule.redemptionEnabled ? "success" : "neutral"}>
                Redemption {data.rule.redemptionEnabled ? "on" : "off"}
              </s-badge>
            </s-stack>
            <s-paragraph>
              Customers earn{" "}
              <s-text type="strong">
                {data.rule.pointsPerSpendAmount} {data.program.pointName}
              </s-text>{" "}
              per ₹{data.rule.spendAmountForEarnPoints} spent, plus{" "}
              <s-text type="strong">{data.rule.signupRewardPoints}</s-text> on
              signup. They can redeem from {data.rule.minRedeemPoints} points, up to{" "}
              {data.rule.maxRedeemPercentOfCart}% of a cart.
            </s-paragraph>
          </s-stack>
        </s-section>

        <s-section heading="Migration from BON">
          {data.latestBatch ? (
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
              <s-stack direction="block" gap="none">
                <s-text color="subdued">File</s-text>
                <s-text>{data.latestBatch.sourceFileName}</s-text>
              </s-stack>
              <s-stack direction="block" gap="none">
                <s-text color="subdued">Imported points</s-text>
                <s-text>
                  {data.latestBatch.totalImportedPoints?.toLocaleString("en-IN")}
                </s-text>
              </s-stack>
              <s-stack direction="block" gap="none">
                <s-text color="subdued">Rows</s-text>
                <s-text>
                  {data.latestBatch.validRowCount} valid ·{" "}
                  {data.latestBatch.invalidRowCount} invalid
                </s-text>
              </s-stack>
            </s-grid>
          ) : (
            <s-paragraph>No BON migration batch has been imported yet.</s-paragraph>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
