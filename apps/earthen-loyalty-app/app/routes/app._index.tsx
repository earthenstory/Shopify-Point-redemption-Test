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

  return (
    <s-page heading="Earthen loyalty overview">
      <s-section heading="Program status">
        <s-unordered-list>
          <s-list-item>Shop: {data.shop}</s-list-item>
          <s-list-item>Status: {data.program.status}</s-list-item>
          <s-list-item>Program: {data.program.programName}</s-list-item>
          <s-list-item>Point name: {data.program.pointName}</s-list-item>
          <s-list-item>
            Earning: {data.rule.earningEnabled ? "enabled" : "disabled"}
          </s-list-item>
          <s-list-item>
            Redemption: {data.rule.redemptionEnabled ? "enabled" : "disabled"}
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Current rules">
        <s-unordered-list>
          <s-list-item>
            Signup bonus: {data.rule.signupRewardPoints} points
          </s-list-item>
          <s-list-item>
            Earn rate: {data.rule.pointsPerSpendAmount} points per INR{" "}
            {data.rule.spendAmountForEarnPoints}
          </s-list-item>
          <s-list-item>
            Minimum redemption: {data.rule.minRedeemPoints} points
          </s-list-item>
          <s-list-item>
            Max cart redemption: {data.rule.maxRedeemPercentOfCart}%
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Point ledger summary">
        <s-unordered-list>
          <s-list-item>Wallets: {data.walletCount}</s-list-item>
          <s-list-item>
            Available points: {data.wallets.availablePoints ?? 0}
          </s-list-item>
          <s-list-item>
            Pending points: {data.wallets.pendingPoints ?? 0}
          </s-list-item>
          <s-list-item>
            Lifetime earned: {data.wallets.lifetimeEarnedPoints ?? 0}
          </s-list-item>
          <s-list-item>
            Lifetime redeemed: {data.wallets.lifetimeRedeemedPoints ?? 0}
          </s-list-item>
          <s-list-item>Ledger entries: {data.ledgerCount}</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Migration">
        {data.latestBatch ? (
          <s-unordered-list>
            <s-list-item>File: {data.latestBatch.sourceFileName}</s-list-item>
            <s-list-item>Status: {data.latestBatch.status}</s-list-item>
            <s-list-item>Valid rows: {data.latestBatch.validRowCount}</s-list-item>
            <s-list-item>
              Invalid rows: {data.latestBatch.invalidRowCount}
            </s-list-item>
            <s-list-item>
              Source points: {data.latestBatch.totalSourcePoints}
            </s-list-item>
            <s-list-item>
              Imported points: {data.latestBatch.totalImportedPoints}
            </s-list-item>
          </s-unordered-list>
        ) : (
          <s-paragraph>No BON migration batch has been imported yet.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Launch warnings">
        {warnings.length > 0 ? (
          <s-unordered-list>
            {warnings.map((warning) => (
              <s-list-item key={warning}>{warning}</s-list-item>
            ))}
          </s-unordered-list>
        ) : (
          <s-paragraph>No launch warnings are currently flagged.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
