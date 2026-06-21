import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { confirmedBonDefaults } from "../loyalty/rules";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function Index() {
  return (
    <s-page heading="Earthen loyalty">
      <s-section heading="Phase 2 foundation">
        <s-paragraph>
          The app scaffold is connected to Shopify and now carries the loyalty
          data model, confirmed BON earning defaults, redemption math, and BON
          migration validation path.
        </s-paragraph>
      </s-section>

      <s-section heading="Confirmed BON rules">
        <s-unordered-list>
          <s-list-item>
            Signup bonus: {confirmedBonDefaults.signupRewardPoints} points
          </s-list-item>
          <s-list-item>
            Earn rate: {confirmedBonDefaults.pointsPerSpendAmount} points per
            INR {confirmedBonDefaults.spendAmountForEarnPoints}
          </s-list-item>
          <s-list-item>
            Redemption value: INR {confirmedBonDefaults.currencyValuePerPoint}{" "}
            per point
          </s-list-item>
          <s-list-item>
            Minimum redemption: {confirmedBonDefaults.minRedeemPoints} points
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Migration gate">
        <s-paragraph>
          BON balances will be imported as ledger entries with type
          migration_credit, reconciled against the source export total, and
          reviewed for unmatched customers before BON is disabled.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
