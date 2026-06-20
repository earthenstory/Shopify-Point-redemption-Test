# In-House Shopify Loyalty Program Plan

## Problem Statement

The store currently uses Bone Loyalty Program for reward points. Bone Loyalty is integrated and working, but it creates customer experience and integration limitations.

Current limitations:

- Customers need to generate a discount code before using points.
- Customers then need to manually apply that discount code in cart or checkout.
- This creates friction and reduces reward redemption.
- Rewards are not deeply integrated into the Shopify cart, cart drawer, homepage, and customer account experience.
- The store cannot fully control where and how point balances are displayed.
- The store cannot fully customize the redemption flow.
- The store depends on a third-party app for rules, customer balances, and redemption UX.

Desired experience:

- Customers should see their available points directly on the storefront.
- Customers should see points in the homepage, cart drawer, cart page, and customer account section.
- Customers should be able to apply points directly from the cart without manually generating or copying a code.
- The experience should feel native to the store.
- The backend should securely maintain customer balances, earning history, redemption history, refunds, and manual adjustments.
- The system should be built in-house as a custom Shopify app for this store only, not as a public Shopify App Store app.

## Recommendation

Build the loyalty program as a custom Shopify app for this store only. Do not publish it to the Shopify App Store.

The recommended architecture is:

```text
Shopify storefront theme
  -> Shopify app proxy / customer account extension / checkout extension
  -> Custom Shopify Remix app hosted on Google Cloud Run
  -> Google Cloud SQL PostgreSQL
```

This gives us a secure backend for points, a real transaction-safe database, and enough flexibility to show rewards in the homepage, cart drawer, cart page, customer account, and checkout-related surfaces.

Google Sheets should not be used as the live source of truth for points. It can be used for migration, exports, manual review, and reconciliation, but not for live customer balances or redemptions.

## Why A Custom Shopify App

The loyalty program needs to behave like a financial ledger. Points are not cash, but customers experience them as stored value. That means the system needs:

- Secure customer-specific access.
- Correct balances under concurrent usage.
- Immutable ledger history.
- Safe redemption reservations.
- Idempotent Shopify webhook processing.
- Reversal logic for refunds and cancellations.
- Admin controls for support and manual adjustments.
- A way to integrate into customer accounts and checkout surfaces.

Theme-only code cannot safely do this. Liquid and JavaScript can display a widget, but they cannot securely own points, prevent over-redemption, process webhooks, or maintain a reliable ledger.

## Infrastructure

### Application Framework

Use a Shopify Remix app.

Responsibilities:

- Shopify OAuth/custom app installation.
- Admin API calls.
- Webhook handling.
- App proxy APIs for storefront widgets.
- Admin interface for loyalty settings and customer support.
- Customer account extension backend.
- Checkout/cart redemption backend.

### Hosting

Host the app on Google Cloud Run.

Reasons:

- Managed deployment.
- Scales automatically.
- Good logging through Google Cloud Logging.
- Can run in a region close to the store's primary customer base.
- Works cleanly with Cloud SQL and Secret Manager.
- Does not require maintaining a VM.

### Database

Use Google Cloud SQL for PostgreSQL.

Reasons:

- Proper transactions.
- Row-level locking for redemptions.
- Unique constraints for webhook idempotency.
- Point-in-time recovery options.
- Backups.
- Strong querying for reconciliation and support.
- Durable source of truth for reward balances.

### Secrets

Use Google Secret Manager for:

- Shopify API key.
- Shopify API secret.
- App proxy secret validation.
- Database credentials.
- Any external service credentials.

### Background Jobs

Start with app-managed webhook processing and scheduled reconciliation jobs.

If the volume grows, add:

- Google Cloud Tasks for retryable background work.
- Pub/Sub for decoupled webhook/event processing.
- Cloud Scheduler for periodic expiry and reconciliation jobs.

## Shopify Integration Points

### Storefront Theme

The theme will show loyalty UI in:

- Homepage.
- Cart drawer.
- Cart page.
- Account drawer/popover.
- Product page earning message, optional.

Relevant current theme files:

- `layout/theme.liquid`
- `snippets/cart-summary.liquid`
- `snippets/cart-discount.liquid`
- `snippets/cart-drawer.liquid`
- `snippets/account-actions.liquid`
- `sections/main-cart.liquid`
- `assets/cart-discount.js`
- `assets/component-cart-items.js`

The current cart already supports discount application through `/cart/update.js` and section re-rendering. The loyalty widget can reuse this lifecycle.

### App Proxy

Use Shopify app proxy endpoints so storefront JavaScript can securely call the custom app through the shop domain.

Proposed endpoints:

- `GET /apps/loyalty/customer`
  - Returns current logged-in customer's points, value, tier, and expiry summary.

- `POST /apps/loyalty/cart-preview`
  - Returns max redeemable points and discount value for the current cart.

- `POST /apps/loyalty/redeem`
  - Creates a redemption reservation and applies the reward to the cart.

- `POST /apps/loyalty/remove`
  - Removes the current redemption from the cart and releases reserved points.

- `GET /apps/loyalty/history`
  - Optional endpoint for customer reward history if needed outside customer accounts.

Every app proxy request must be validated. The backend should not trust customer IDs or point amounts sent by the browser.

### Customer Account UI Extension

Use Shopify customer account extensions to show:

- Current points balance.
- Rupee value of available points.
- Points history.
- Expiring points.
- Earned points from recent orders.
- Redeemed points history.

This is important because modern Shopify customer accounts are not controlled like normal theme templates.

### Checkout Experience

Preferred long-term approach:

- Use Shopify Functions for discount logic.
- Use checkout UI extension where available to show/apply rewards.

MVP approach:

- Let customers apply points in cart/cart drawer.
- The app creates a redemption reservation.
- The app applies the discount automatically without forcing the customer to manually copy a code.

If checkout APIs are limited for the store's plan or payment method, the cart remains the primary redemption location. This still removes the biggest current friction: manually generating and applying a code from Bone Loyalty.

## Redemption Strategy

### MVP: Silent Discount Code

Flow:

1. Customer opens cart.
2. Theme requests balance and cart eligibility from app proxy.
3. Customer chooses points to redeem.
4. App validates customer, cart, balance, and rules.
5. App creates a single-use discount code or uses a preconfigured discount mechanism.
6. Theme applies the code automatically through Shopify cart update.
7. App stores a pending redemption reservation.
8. On order paid, app consumes the points.
9. If not used within a defined window, app releases the reservation.

Pros:

- Faster to implement.
- Removes manual code friction.
- Works well with the existing theme cart flow.

Cons:

- Still code-based internally.
- Needs cleanup for unused discount codes.
- Discount stacking rules need careful handling.

### Long-Term: Shopify Function Discount

Flow:

1. Customer chooses points.
2. App validates and stores redemption session.
3. Cart carries a redemption token or attribute.
4. Shopify Function reads validated redemption context.
5. Discount is applied automatically.
6. Order webhook consumes points after payment.

Pros:

- Cleaner customer experience.
- Stronger long-term architecture.
- Less reliance on generated discount codes.

Cons:

- More implementation complexity.
- Needs more careful Shopify extension setup.

## Data Model

### customers

Stores Shopify customer identity.

Fields:

- `id`
- `shopify_customer_id`
- `email`
- `phone`
- `first_name`
- `last_name`
- `status`
- `created_at`
- `updated_at`

### wallets

Stores current balance summary.

Fields:

- `id`
- `customer_id`
- `available_points`
- `pending_points`
- `lifetime_earned_points`
- `lifetime_redeemed_points`
- `lifetime_expired_points`
- `created_at`
- `updated_at`

The wallet is a summary table. The ledger remains the source for audit and reconciliation.

### ledger_entries

Append-only point movement history.

Fields:

- `id`
- `customer_id`
- `wallet_id`
- `type`
- `points_delta`
- `money_value`
- `currency`
- `shopify_order_id`
- `shopify_refund_id`
- `redemption_session_id`
- `description`
- `metadata`
- `created_at`

Types:

- `migration_credit`
- `order_earn`
- `redeem_reserve`
- `redeem_consume`
- `redeem_release`
- `refund_reversal`
- `order_cancel_reversal`
- `expiry`
- `manual_adjustment`

### redemption_sessions

Tracks active and historical redemptions.

Fields:

- `id`
- `customer_id`
- `cart_token`
- `checkout_token`
- `shopify_order_id`
- `points_reserved`
- `discount_amount`
- `currency`
- `discount_code`
- `status`
- `expires_at`
- `created_at`
- `updated_at`

Statuses:

- `pending`
- `applied`
- `consumed`
- `released`
- `expired`
- `failed`

### reward_rules

Stores configurable loyalty settings.

Fields:

- `id`
- `earn_rate_percent`
- `points_per_currency_unit`
- `currency_value_per_point`
- `min_redeem_points`
- `redeem_increment_points`
- `max_redeem_points_per_order`
- `max_redeem_percent_of_cart`
- `allow_discount_stacking`
- `award_on_status`
- `points_expiry_days`
- `created_at`
- `updated_at`

### webhook_events

Ensures Shopify webhooks are processed exactly once.

Fields:

- `id`
- `shopify_webhook_id`
- `topic`
- `shop_domain`
- `resource_id`
- `payload_hash`
- `status`
- `attempt_count`
- `last_error`
- `created_at`
- `processed_at`

### admin_audit_logs

Tracks admin actions.

Fields:

- `id`
- `admin_user`
- `action`
- `customer_id`
- `before`
- `after`
- `reason`
- `created_at`

## Loyalty Rules To Confirm

Before implementation, confirm:

- Point value, for example `1 point = ₹1` or `100 points = ₹1`.
- Earn rate, for example `2% back`.
- Whether points are awarded on order paid or order fulfilled.
- Whether points apply to discounted items.
- Whether points apply to bundles.
- Whether points apply to subscriptions.
- Whether points apply to shipping or taxes.
- Whether points can stack with coupon codes.
- Minimum redemption amount.
- Maximum redemption per order.
- Points expiry rules.
- Refund and cancellation reversal policy.
- Whether guest orders earn points after account creation.
- Whether referrals, birthday rewards, and tiers are in scope for V1.

Recommended V1 scope:

- Earn points on paid orders.
- Redeem points in cart.
- Reverse points on refunds/cancellations.
- Show balance in account/cart/homepage.
- Import Bone balances.
- No tiers/referrals/birthday rewards until the core ledger is stable.

## Implementation Plan

### Phase 1: Discovery

Tasks:

- Confirm Shopify plan and checkout extensibility availability.
- Confirm customer account type.
- Export Bone Loyalty rules and balance data.
- Confirm current earning and redemption rules.
- Confirm discount stacking expectations.
- Confirm whether Bone will remain active during testing.

Deliverables:

- Final loyalty rule document.
- Final migration mapping.
- Final technical architecture.

### Phase 2: App Scaffold

Tasks:

- Create Shopify Remix app.
- Configure custom app credentials.
- Add local Postgres for development.
- Add Prisma or equivalent ORM.
- Add base tables and migrations.
- Add app authentication.
- Add environment configuration.
- Add logging and error handling.

Deliverables:

- Running local app.
- Database schema.
- Shopify app installed on development store or test environment.

### Phase 3: Webhooks And Ledger

Tasks:

- Subscribe to required Shopify webhooks.
- Implement webhook signature validation.
- Store webhook event records for idempotency.
- Process order paid/fulfilled events.
- Process refund events.
- Process cancellation events.
- Add ledger entry creation.
- Add wallet balance updates in transactions.

Deliverables:

- Correct point earning.
- Correct refund reversal.
- Correct duplicate webhook handling.

### Phase 4: Storefront App Proxy APIs

Tasks:

- Configure Shopify app proxy.
- Validate signed app proxy requests.
- Implement customer balance endpoint.
- Implement cart preview endpoint.
- Implement redeem endpoint.
- Implement remove redemption endpoint.
- Add rate limiting and error responses.

Deliverables:

- Storefront can securely fetch and apply rewards.
- Browser never controls point amounts directly.

### Phase 5: Cart And Theme UI

Tasks:

- Add loyalty widget snippet.
- Add loyalty JavaScript asset.
- Add loyalty CSS asset.
- Render widget in cart summary.
- Render widget in cart drawer.
- Render compact balance in account drawer.
- Add homepage balance/earn prompt.
- Integrate with existing cart update events.
- Handle logged-out state.
- Handle loading, error, applied, and removed states.

Deliverables:

- Customer can see and redeem points from cart.
- Customer does not need to manually generate/copy a discount code.

### Phase 6: Admin UI

Tasks:

- Add customer lookup.
- Show wallet balance and ledger history.
- Allow manual adjustments with required reason.
- Add loyalty rule editor.
- Add migration import screen or CLI import.
- Add export/reconciliation reports.

Deliverables:

- Internal team can support customers.
- Adjustments are audited.

### Phase 7: Customer Account Extension

Tasks:

- Build customer account rewards block.
- Build full rewards history page if needed.
- Show current points, rupee value, and recent activity.
- Show expiring points.
- Link to shop/cart for redemption.

Deliverables:

- Rewards are visible inside customer account.

### Phase 8: Checkout And Shopify Function Upgrade

Tasks:

- Evaluate checkout extension availability for the store.
- Build checkout reward block if available.
- Build Shopify Function discount if selected.
- Move from hidden discount-code MVP to function-based discount logic.
- Keep fallback for cart-based redemption.

Deliverables:

- More seamless checkout-level redemption where Shopify allows it.

### Phase 9: Bone Migration

Tasks:

- Export Bone customer balances.
- Map Bone customers to Shopify customer IDs.
- Import opening balances as `migration_credit` ledger entries.
- Reconcile sample customers manually.
- Run a soft launch with internal accounts.
- Disable Bone storefront widget.
- Keep Bone export backup.

Deliverables:

- Customer balances preserved.
- Bone removed from customer-facing flow.

## Testing Plan

### Unit Tests

Cover:

- Earning calculations.
- Redemption calculations.
- Max redeemable amount.
- Minimum redemption rules.
- Discount stacking rules.
- Expiry calculations.
- Refund reversal calculations.
- Ledger entry validation.
- Wallet summary updates.

### Database Transaction Tests

Cover:

- Two simultaneous redemption attempts cannot overdraw the wallet.
- Duplicate webhook IDs are ignored after first processing.
- Failed redemption rolls back wallet updates.
- Expired reservation releases points exactly once.
- Manual adjustment writes both wallet update and audit log.

### Webhook Tests

Cover:

- Valid webhook signature accepted.
- Invalid signature rejected.
- Duplicate `orders/paid` webhook does not double-award points.
- Refund webhook reverses correct amount.
- Cancellation webhook reverses pending/earned points.
- Out-of-order webhook handling does not corrupt balance.

### Storefront API Tests

Cover:

- Logged-out customer receives sign-in state.
- Logged-in customer receives only their own balance.
- Customer cannot submit arbitrary customer ID.
- Customer cannot redeem more than available points.
- Customer cannot redeem more than cart allows.
- Invalid cart or expired redemption returns clear error.
- Remove redemption releases points.

### Theme Integration Tests

Cover:

- Homepage balance display.
- Cart drawer logged-out state.
- Cart drawer logged-in balance.
- Cart drawer apply/remove redemption.
- Cart page apply/remove redemption.
- Account drawer compact balance.
- Cart quantity changes update max redeemable value.
- Existing discount code UI still works as intended.
- Cart section morphing does not break the widget.
- Mobile layout.

### Checkout Tests

Cover:

- Applied redemption carries into checkout.
- Customer sees correct discount.
- Accelerated checkout behavior.
- Discount stacking behavior.
- Checkout abandoned reservation expiry.
- Order paid consumes points.

### Migration Tests

Cover:

- Bone balance import maps to correct Shopify customer.
- Duplicate emails handled safely.
- Customers missing from Shopify are reported.
- Imported balances match source totals.
- Ledger entries are created for every imported balance.

### Admin Tests

Cover:

- Customer search.
- Ledger display.
- Manual adjustment.
- Required adjustment reason.
- Rule updates.
- Export generation.
- Permission checks.

### End-To-End Test Scenarios

Scenario 1: New customer earns points.

1. Customer creates account.
2. Customer places order.
3. Order is paid.
4. Points are awarded.
5. Customer sees points in account and cart.

Scenario 2: Existing customer redeems points.

1. Customer logs in.
2. Customer adds products to cart.
3. Customer applies points in cart drawer.
4. Discount appears automatically.
5. Customer checks out.
6. Points are consumed after order paid.

Scenario 3: Refund reversal.

1. Customer earns points from order.
2. Merchant refunds order.
3. App reverses earned points.
4. Customer balance is updated.
5. Ledger shows reversal.

Scenario 4: Abandoned redemption.

1. Customer applies points.
2. Customer does not complete checkout.
3. Reservation expires.
4. Points become available again.

Scenario 5: Duplicate webhook.

1. Same order webhook is sent twice.
2. App processes only once.
3. Wallet and ledger remain correct.

## Deployment Plan

### Environments

Use:

- Local development.
- Staging app connected to a Shopify development/test store.
- Production app connected to the live store.

### CI/CD

Recommended:

- GitHub repository.
- Automated tests on pull request.
- Database migration check.
- Deploy staging on merge to staging branch.
- Deploy production on tagged release or approved main branch merge.

### Production Launch

Steps:

1. Deploy app to Cloud Run.
2. Create production Cloud SQL database.
3. Configure secrets.
4. Install custom Shopify app on live store.
5. Configure app proxy.
6. Subscribe webhooks.
7. Deploy theme changes.
8. Import Bone balances.
9. Test staff/customer accounts.
10. Disable Bone storefront widget.
11. Monitor logs and support tickets.

## Monitoring And Maintenance

Monitor:

- Webhook failures.
- Redemption failures.
- App proxy errors.
- Database errors.
- Duplicate webhook counts.
- Reservation expiry jobs.
- Balance reconciliation mismatches.

Scheduled jobs:

- Expire unused redemptions.
- Expire points if expiry is enabled.
- Reconcile wallet summaries against ledger.
- Export weekly finance/support report.

## Risks And Mitigations

### Risk: Over-redemption

Mitigation:

- Use database transactions and row locks.
- Reserve points before applying discount.
- Expire unused reservations.

### Risk: Duplicate Shopify webhooks

Mitigation:

- Store webhook IDs.
- Use unique constraints.
- Make processing idempotent.

### Risk: Discount stacking issues

Mitigation:

- Define rules upfront.
- Validate cart discount state before applying points.
- Test combinations with current coupon logic.

### Risk: Customer account limitations

Mitigation:

- Use customer account UI extensions.
- Keep cart as the primary redemption surface.

### Risk: Bone migration mismatch

Mitigation:

- Import as ledger entries.
- Reconcile totals before launch.
- Keep source export.

## Final Recommendation

Use a custom Shopify Remix app hosted on Google Cloud Run with Google Cloud SQL PostgreSQL.

Build the first production version with cart-based automatic redemption, backed by a real points ledger. Use generated/silent discount application for the MVP if it helps us launch faster. Then upgrade to Shopify Function-based discounts once the core wallet, ledger, and customer experience are stable.

Do not use Google Sheets as the production backend. Use it only for import, export, reporting, and reconciliation.
