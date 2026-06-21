# Loyalty Program Phase 1 Discovery

Date: 2026-06-21

## Scope

This document captures Phase 1 discovery for the in-house Shopify loyalty program. It is based on the implementation plan in `/Users/shashank/Downloads/loyalty-program-plan.md`, local theme inspection, and live Shopify admin theme verification.

## Confirmed

- Shopify plan constraint: Basic plan, no Shopify Plus upgrade planned.
- Target draft theme exists in Shopify admin:
  - `Shopify-Point-redemption-Test/main`
  - GitHub source shown by Shopify: `Shopify-Point-redemption-Test / main`
- Customer account mode:
  - Shopify new customer accounts are enabled/configured.
  - Customer account URL shown in admin: `https://shopify.com/58501824608/account`.
  - Sign-in links are enabled for the online store header and checkout.
- Local repository is the Shopify theme source, not a Shopify app scaffold.
- Shopify CLI is installed locally at `/Users/shashank/.nvm/versions/node/v22.18.0/bin/shopify`.
- No `shopify.theme.toml`, `shopify.app.toml`, `package.json`, or lockfile is present at the repository root.
- Current cart type is drawer.
- Current cart discount UI is enabled.
- Current accelerated checkout buttons are enabled.
- BON Loyalty app embed is currently enabled in `config/settings_data.json`.
- BON Loyalty app status:
  - Current plan: Free Forever.
  - Monthly orders included: 250.
  - Order limit remaining at time of discovery: 227.
  - Storefront app embeds: Active.
  - Loyalty page: Inactive.
  - Active app blocks: 0.

## Confirmed BON Rules

Earn points:

- `Create an account`
  - Status: Active.
  - Reward: 250 points.
  - Rule summary: customers earn 250 points for completing this action.
- `Complete an order`
  - Status: Active.
  - Reward: 2 points for every INR 100 spent.
  - Award timing: orders fulfilled.
  - Product eligibility: applies to all products.
- Inactive earn rules visible:
  - Subscribe for newsletter: 10 points, upgrade gated.
  - Happy birthday: 10 points, upgrade gated.
  - Complete profile: 10 points.

Redeem points:

- Active redeem rule visible:
  - `Redeem every 10 points to get INR 10 off discount`.
  - List-level value shown: 10 points.
- Inactive redeem rules visible:
  - `10% off discount`: 100 points.
  - `Free shipping coupon`: 100 points.
  - `POS 10% discount`: 100 points, upgrade gated.
  - `POS INR10 discount`: 100 points, upgrade gated.
  - `POS Product discount`: 100 points, upgrade gated.

## BON Migration Requirement

BON balance migration is a hard launch gate. The new loyalty program must not go live for customers until BON balances are exported, imported into the new ledger, and reconciled.

Required migration behavior:

- Export BON customer point balances before launch.
- Map each BON customer to a Shopify customer ID.
- Import opening balances as immutable `migration_credit` ledger entries.
- Initialize wallet summaries from those ledger entries, not by writing balances directly without history.
- Reconcile imported totals against the BON export total.
- Manually spot-check sample customers across low, medium, and high balances.
- Report customers that cannot be matched to Shopify customers.
- Keep the raw BON export as a backup artifact.
- Disable BON storefront/customer-facing widgets only after migration and reconciliation pass.

Launch blocker:

- Any mismatch between BON exported balances and new-program imported balances must be resolved or explicitly approved before customer launch.

## Theme Discount Mechanism

The theme already supports applying discount codes through Shopify's cart endpoint:

- `assets/cart-discount.js` posts to `Theme.routes.cart_update_url`.
- The request body includes:
  - `discount`
  - `sections`
- The component reads `data.discount_codes` to detect invalid discount codes.
- The component dispatches `DiscountUpdateEvent` after a successful apply/remove.
- The component morphs the rerendered cart section with `morphSection(...)`.
- `assets/component-cart-items.js` listens for `ThemeEvents.discountUpdate` and rerenders the cart section.
- `snippets/cart-summary.liquid` renders applied cart-level discounts and the current cart total.

Conclusion: the loyalty widget should reuse this flow. It should request a server-generated loyalty discount code from the backend, then apply that code through the existing cart discount mechanism instead of building a parallel cart updater.

## Theme Integration Points

Primary files for Phase 5:

- `snippets/cart-summary.liquid`
- `snippets/cart-discount.liquid`
- `snippets/cart-drawer.liquid`
- `snippets/account-actions.liquid`
- `snippets/header-actions.liquid`
- `assets/cart-discount.js`
- `assets/component-cart-items.js`
- `snippets/scripts.liquid`

Existing storefront notes:

- `snippets/cart-drawer.liquid` already contains a rewards-style banner: "Sign up for a INR 250 welcome gift, plus 2% back always".
- `templates/page.faq.json` mentions BON Loyalty and says customers use the Rewards tab.
- The BON app embed should remain enabled during initial testing unless the rollout plan explicitly disables it.
- Before launch, BON customer-facing surfaces must be disabled or replaced to avoid duplicate rewards UX.

## Express Checkout Risk

`snippets/cart-summary.liquid` renders `content_for_additional_checkout_buttons` when both conditions are true:

- `additional_checkout_buttons`
- `settings.show_accelerated_checkout_buttons`

Because accelerated checkout is currently enabled, the express checkout bypass risk from the plan is active. The implementation must either:

- hide/suppress accelerated checkout buttons while a loyalty redemption is active, or
- prove through live checkout testing that the loyalty discount persists through Apple Pay, Google Pay, and Shop Pay.

This is a launch blocker, not a follow-up.

## Admin Confirmations Still Required

The following Phase 1 items still require Shopify admin/BON admin access. Chrome automation was blocked again by an open extension UI while opening the detailed BON redemption rule, so these remain pending:

- Export BON Loyalty rules.
- Export BON Loyalty customer balances.
- Confirm BON export format and required customer identifiers for migration mapping.
- Confirm detailed redemption settings for the active rule:
  - minimum redemption.
  - minimum cart subtotal.
  - discount combinations/stacking.
  - product/collection eligibility.
  - customer eligibility.
  - discount expiry behavior.
- Confirm redemption increment.
- Confirm maximum redemption per order.
- Confirm whether points apply to discounted items.
- Confirm whether points apply to bundles.
- Confirm whether points apply to subscriptions.
- Confirm whether points apply to shipping or taxes.
- Confirm refund/cancellation reversal policy.
- Confirm whether points expire.
- Confirm whether BON stays active during draft-theme testing.
- Confirm whether customer account display should use only customer-account extension session-token auth, or also sync a cached customer metafield.

## Recommended V1 Rule Defaults

These defaults should be used for initial app scaffolding only if detailed BON settings cannot be exported immediately. They must be reconciled with BON before production launch.

- Point value: `1 point = INR 1`, based on the active BON redemption rule `10 points = INR 10`.
- Earn rate: `2 points per INR 100`, based on active BON order earning rule.
- Signup reward: `250 points`, based on active BON account creation rule.
- Award on: `orders/fulfilled`, based on active BON order earning rule.
- Redeem surface: cart and cart drawer only
- Minimum redemption: `10 points`, pending detailed active redemption rule confirmation.
- Redemption increment: `10 points`, pending detailed active redemption rule confirmation.
- Maximum redemption per order: lower of available balance and configured cart percentage
- Maximum redemption percent of cart: unset until detailed BON rule confirmation; use a conservative configurable default of `20%` for scaffold tests only.
- Discount stacking: disabled until explicitly confirmed
- Points expiry: disabled in V1 unless BON export proves an active expiry policy
- Refund reversal:
  - reverse earned points proportionally on refund
  - return redeemed points proportionally on refund
- V1 excludes tiers, referrals, and birthday rewards

## Phase 1 Test Result

Live admin theme verification:

- The draft theme `Shopify-Point-redemption-Test/main` is visible in Shopify admin after the embedded Online Store app finishes loading.
- The theme card exposes `Publish` and `Edit theme`.
- Attempting to open the editor via Chrome automation was blocked by Chrome because another extension UI was open.
- Customer accounts admin page was opened and verified.
- BON Loyalty admin page was opened and verified.
- BON earning list and two active earning rule detail pages were opened and verified.
- BON redemption list was opened and the active rule was visible.
- Opening the active redemption rule detail page was blocked by Chrome because another extension UI was open.

Local code verification:

- Discount application path exists and uses `/cart/update.js`.
- Cart section rerender/morph path exists.
- Cart discount remove path exists.
- Accelerated checkout path exists and is enabled.
- BON app embed is enabled.

CLI verification:

- Ran `shopify theme check`.
- Result: failed on existing theme issues unrelated to this Phase 1 document.
- Examples:
  - `assets/header-drawer.liquid`: `UnsupportedDocTag`
  - multiple locale `MatchingTranslations` errors
  - existing `layout/theme.liquid` performance and undefined-object warnings
- No loyalty implementation files were introduced yet, so these are baseline theme validation issues that must be handled separately or accepted before using theme check as a launch gate.

## Phase 2 Entry Criteria

Before Phase 2 app scaffold begins, complete or explicitly accept the pending admin confirmations above. If time pressure requires starting Phase 2 immediately, scaffold with the recommended V1 rule defaults and mark all rule constants as configurable database-backed settings.
