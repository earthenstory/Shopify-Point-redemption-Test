# Earthen Subscriptions

Single-store Shopify custom-distribution app for SKU-level subscriptions using
Razorpay variable recurring payments / UPI AutoPay. Shopify owns products,
inventory, normal checkout, orders and fulfillment. This app owns subscription
configuration, scheduling, renewal computation, customer controls and operational
reconciliation.

The master signup switch is **off by default**. Existing active subscriptions keep
running when new signup/the storefront widget is disabled.

## Implemented surfaces

- Embedded admin dashboard with one-click subscription signup/widget on/off.
- Product enrollment modes: none, selected products, or all with exclusions.
- Global base discount, immutable quantity-tier policy versions and explicit migration.
- Six configurable intervals, 24-month default duration, shipping and dunning.
- Theme app block with a cross-product, quantity-aware subscription basket.
- Normal full-price first Shopify checkout and signed private cart intent.
- Paid-order-only activation, authoritative Shopify price/address capture and a
  48-hour activation window.
- Basic-compatible Thank-you and Order-status activation extension.
- Razorpay customer, UPI AutoPay registration, headroom, variable renewal debit,
  signed webhooks, retries and token cancellation.
- Current-price renewal quotes, inventory filtering, partial stockout protection,
  shipping calculation, one Shopify paid order per combined group and refund paths.
- Signed-in customer-account page plus short-lived magic-link portal.
- Skip, pause, resume, cycle-end cancel, remove line, address editing and mandate reauthorization.
- Scheduled renewal, daily maintenance/dunning and reconciliation endpoints.
- Notification idempotency, privacy webhooks, PII masking and uninstall billing pause.
- Admin subscription search/history, 90-day delivery calendar, privacy exports and health page.

## Safe local verification

```bash
cp .env.example .env
npm install
npm run db:validate
npm run typecheck
npm test
npm run lint
npm run build
```

Targeted suites:

```bash
npm run test:unit
npm run test:integration
npm run test:smoke
```

Tests use fake Shopify/Razorpay adapters and do not create charges or orders.

## Production setup required

1. Create a Shopify CLI/Dev Dashboard app using **Custom distribution** for the
   production Basic store. Replace the placeholders in `shopify.app.toml`.
2. Replace `REPLACE_WITH_CLOUD_RUN_URL` in the customer-account extension after the
   Cloud Run URL is known.
3. Provision the `earthen_subscriptions` PostgreSQL database and run
   `prisma migrate deploy`.
4. Configure all secrets from `.env.example`. Generate at least 32 random bytes for
   each signing/job secret.
5. Obtain Level-2 protected customer data for name, email, phone and address and
   approve the declared Admin API scopes.
6. Enable Razorpay variable recurring payments / UPI AutoPay and register
   `/webhooks/razorpay` with the configured webhook secret.
7. Deploy the app, app proxy, theme extension and checkout/customer-account
   extension. Add the blocks in Shopify's theme and checkout/accounts editors.
8. Create authenticated Cloud Scheduler POST jobs:
   - `/jobs/renewals` at the approved pre-debit cadence;
   - `/jobs/reconcile` hourly;
   - `/jobs/daily` daily.
   Each request uses `Authorization: Bearer $JOB_AUTH_SECRET`.
9. Configure Hermes templates. Transactional email stays disabled until the merchant
   selects a provider, sender domain and credentials.

## Required live P0 test

Keep the master switch off while completing these checks on the actual Basic store:

1. Verify Level-2 order/customer fields and app-proxy signatures.
2. Verify Magic Checkout preserves private line properties and emits a paid order.
3. Place and render the Thank-you/Order-status activation block.
4. Complete a real test UPI mandate with the six approved frequencies and 2× headroom.
5. Run two variable renewal amounts, including a Shopify price change.
6. Confirm inventory decrement, fulfillment routing, taxes and the Razorpay-to-
   Shopify transaction reference on the renewal order.
7. Exercise full stockout, partial stockout/refund, duplicate webhook, payment
   failure/dunning, cancellation and uninstall drills.

Razorpay account enablement, the production Shopify app/URL, infrastructure secrets,
Hermes approval and the transactional email-provider decision are external to the
repository and cannot be completed by local tests.
