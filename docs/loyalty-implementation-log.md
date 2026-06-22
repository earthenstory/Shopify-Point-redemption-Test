# Loyalty Implementation Log

## 2026-06-21

### Phase 1 Discovery

- Created `docs/loyalty-phase-1-discovery.md`.
- Confirmed the draft theme `Shopify-Point-redemption-Test/main`.
- Confirmed new Shopify customer accounts are enabled.
- Confirmed BON Loyalty app status and active earning/redeeming rules visible from admin.
- Marked BON balance migration as a hard launch gate.

### Phase 2 Scaffold Slice

The official Shopify React Router template scaffold was attempted with:

```sh
shopify app init --template reactRouter --name loyalty-app --path apps --package-manager npm --no-color
```

The CLI required device authentication, so the official template scaffold is pending. A backend/database scaffold was created manually in `apps/loyalty-app` so implementation can continue without waiting on CLI auth.

Implemented:

- Prisma schema for:
  - loyalty customers
  - wallets
  - ledger entries
  - point lots
  - redemption sessions
  - reward rules
  - webhook events
  - admin audit logs
  - discount cleanup jobs
- Configurable loyalty rule calculations seeded from confirmed BON defaults.
- BON balance migration validation helpers.
- Tests for:
  - confirmed BON earning rate
  - point-to-INR redemption value
  - redemption increments/minimum
  - max redeemable cap calculation
  - Shopify discount minimum-subtotal protection
  - BON migration row validation and reconciliation totals

Validation:

```sh
npm run db:validate
npm run build
npm test
npm audit --omit=dev
```

Result:

- Prisma schema valid.
- TypeScript build passed.
- 8 tests passed.
- Production dependency audit found 0 vulnerabilities.

Known remaining issue:

- Full `npm audit` still reports one low-severity dev-only issue through `vitest -> vite -> esbuild`. `npm audit fix` did not update it. Production audit is clean.

Blocked/pending:

- Open detailed BON redemption rule settings.
- Export BON rules and customer balances.
- Confirm local/provisioned Postgres URL before generating database migrations.

### Phase 2 Official Shopify App Scaffold

Created the official React Router Shopify app at `apps/earthen-loyalty-app` after device authentication:

```sh
shopify app init --template reactRouter --flavor typescript --name earthen-loyalty-app --path apps --package-manager npm --no-color
```

The initial template generated an invalid `shopify.app.toml` because the demo custom-data definitions were rejected by the installed Shopify CLI. The demo product/metaobject configuration was removed and replaced with loyalty-specific scopes:

```text
read_customers,write_customers,read_orders,read_discounts,write_discounts
```

Merged the loyalty foundation into the official app:

- Preserved the Shopify `Session` model and switched Prisma to Postgres for the planned Cloud SQL target.
- Added loyalty customer, wallet, ledger, point lot, redemption, reward rule, webhook, audit, discount cleanup, and BON migration batch/row models.
- Added BON-confirmed rule helpers in `app/loyalty/rules.ts`.
- Added BON migration validation helpers in `app/loyalty/migration.ts`.
- Added `.env.example` with Shopify and database settings.
- Replaced the template product demo dashboard with a loyalty overview and migration gate.

BON migration remains a launch blocker. Imported BON balances must create immutable `migration_credit` ledger entries, reconcile source and imported totals, preserve the raw export reference, and report unmatched customers before BON is disabled.

Validation:

```sh
DATABASE_URL='postgresql://loyalty:loyalty@localhost:5432/earthen_loyalty' npm run db:validate
npm test
npm run typecheck
DATABASE_URL='postgresql://loyalty:loyalty@localhost:5432/earthen_loyalty' npm run build
DATABASE_URL='postgresql://loyalty:loyalty@localhost:5432/earthen_loyalty' shopify app build --no-color
npm audit --omit=dev
```

Result:

- Prisma schema valid.
- 9 loyalty tests passed.
- Typecheck passed.
- React Router production build passed.
- Shopify CLI app build passed.
- Production dependency audit found 0 vulnerabilities.

Known remaining issue:

- Full `npm audit` reports high-severity dev-only issues through generated Shopify template codegen/lint dependencies. The production audit is clean. The available fixes are semver-major upgrades to Shopify/codegen and TypeScript ESLint packages, so this should be handled as a separate dependency upgrade pass.

### Phase 3 Webhook Ledger Foundation

Implemented the first webhook plumbing slice in `apps/earthen-loyalty-app`:

- Added authenticated webhook routes for:
  - `customers/create`
  - `customers/update`
  - `customers/delete`
  - `orders/paid`
  - `orders/fulfilled`
  - `orders/cancelled`
  - `refunds/create`
- Added matching Shopify webhook subscriptions in `shopify.app.toml`.
- Added `app/loyalty/webhooks.ts` to record webhook deliveries idempotently using Shopify `webhookId`.
- Added stable SHA-256 payload hashing with object-key sorting.
- Added resource ID extraction that prefers Shopify GraphQL IDs and falls back to REST IDs.
- Added unit tests for webhook hash stability and resource extraction.

This slice intentionally records events before changing point balances. The next slice should attach event processors that create:

- `signup_bonus` ledger entries from customer creation or account activation rules.
- `order_earn` ledger entries once an order reaches the confirmed BON award state (`fulfilled`).
- redemption consumption/release entries from paid orders and refunds.

Validation:

```sh
npm test
DATABASE_URL='postgresql://loyalty:loyalty@localhost:5432/earthen_loyalty' npx prisma generate
npm run typecheck
DATABASE_URL='postgresql://loyalty:loyalty@localhost:5432/earthen_loyalty' npm run build
DATABASE_URL='postgresql://loyalty:loyalty@localhost:5432/earthen_loyalty' shopify app build --no-color
npm audit --omit=dev
```

Result:

- 12 tests passed.
- Prisma client generated from the loyalty schema.
- Typecheck passed.
- React Router production build passed.
- Shopify CLI app build passed.
- Production dependency audit found 0 vulnerabilities.

### Phase 4 GCP Database Foundation

Created the loyalty database resources in the existing Earthen Story automation project, as requested:

- Project: `es-automation-2026`
- Region: `asia-south1`
- Cloud SQL instance: `earthen-loyalty-postgres`
- Database: `earthen_loyalty`
- App user: `loyalty_app`
- Service account: `earthen-loyalty-runner@es-automation-2026.iam.gserviceaccount.com`
- Secrets:
  - `earthen-loyalty-database-url`
  - `earthen-loyalty-db-password`

Configuration:

- PostgreSQL 16
- Enterprise edition, `db-g1-small`
- Zonal availability
- Automated backups enabled
- Point-in-time recovery enabled
- Deletion protection enabled
- Labels: `app=loyalty`, `store=earthen-story`, `env=prod`

Applied the initial Prisma baseline migration to the live Cloud SQL database:

```sh
npx prisma migrate deploy
```

The generated Postgres migration is:

```text
apps/earthen-loyalty-app/prisma/migrations/20260621191500_init_loyalty_schema/migration.sql
```

Security note:

- A temporary `/32` authorized network was used only for the local migration and was cleared afterward.
- Cloud Run should use the Cloud SQL connection name `es-automation-2026:asia-south1:earthen-loyalty-postgres` and read `DATABASE_URL` from Secret Manager.

### BON Customer Points Import

Imported the BON Loyalty customer balance export:

```text
701031-e7.myshopify.com_export_customers_2026_06_21_69fb217523385f08ef7f121fc93adcea.csv
```

Dry-run reconciliation:

- Source rows: 909
- Valid rows: 909
- Invalid rows: 0
- Non-zero point rows: 899
- Zero point rows: 10
- Source points: 182,687
- Repaired one shifted CSV row at line 684:
  - Shopify customer ID: `8517051973728`
  - Email: `vanshikabhasin9456@gmail.com`
  - Points: 231

Live import result:

- Migration batch ID: `cmqo1tr9l00000zeiqeh5velk`
- Batch status: `processed`
- Imported points: 182,687
- `migration_credit` ledger entries: 909
- BON migration audit rows: 909
- Point lots: 909
- Wallets/customers created: 909
- Wallet available points total: 182,687
- Wallet pending points total: 0

The import was run through Cloud SQL Auth Proxy on `127.0.0.1:5433`; no public authorized network was opened for the database.

### Draft Theme And Loyalty QA Summary

Updated `/Users/shashank/Downloads/loyalty-program-plan.md` with an `Executed Test Cases To Date` section under `Testing Plan`.

Latest validation summary:

- Backend `npm test`: 22 tests passed.
- Backend `npm run typecheck`: passed.
- Draft theme browser journeys passed for anonymous, existing customer with points, and zero-point customer.
- Homepage, product page, cart page, and account/header loyalty widget surfaces were verified in the draft theme.
- Cart redemption slider was tested with an existing-points customer: selected `80` points, called the redeem endpoint, and sent the generated discount code to Shopify `/cart/update`.
- Mobile layout was checked for homepage, product page, and cart page.
- Fixes from QA:
  - persisted applied redemption UI across Shopify cart refresh,
  - removed duplicate cart widget placement,
  - added product widget to the active product section,
  - widened the mobile product widget layout.

Remaining launch checks:

- Disable the old BON storefront widget/app embed.
- Run final real customer-session checkout tests.
- Test Apple Pay, Google Pay, and Shop Pay express checkout behavior.
- Run final production migration reconciliation immediately before cutover.

### Pending QA Completion Pass

Completed an additional pending-test pass and updated `/Users/shashank/Downloads/loyalty-program-plan.md` under `Pending Test Case Completion Pass - 2026-06-22`.

Backend fixes deployed:

- Block duplicate active redemption sessions for the same customer/cart.
- Deactivate the Shopify discount code via `discountCodeDeactivate` before releasing a redemption through Remove.
- On `orders/paid`, consume only the actually allocated discount amount and release unused reserved points.

Validation:

- Backend `npm test`: 29 tests passed.
- Backend `npm run typecheck`: passed.
- Live Cloud Run revision: `earthen-loyalty-app-00008-zlw`, serving 100% traffic.
- Live signed app-proxy replay test:
  - first QA redemption succeeded,
  - second same-cart redemption was rejected,
  - Remove released the reservation.
- Live signed app-proxy tamper test:
  - valid signed request succeeded,
  - modified `logged_in_customer_id` with stale signature returned `401`.
- Live create/remove test after deactivation fix succeeded.
- Draft theme browser journeys passed again for anonymous, with-points, and zero-point customers.

Still genuinely pending:

- Real paid order checkout test.
- Promo-code stacking test.
- Express checkout tests.
- Customer account switch test.
- Empty-cart automatic revalidation/release.
- Interrupted cart apply recovery.
- `orders/edited` handling or documented manual adjustment process.
- FIFO lot consumption.
- Admin adjustment/session UI edge cases.
