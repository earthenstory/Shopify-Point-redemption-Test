# Earthen Subscriptions — Revised In-House Build Plan

Custom Shopify app using Razorpay variable Recurring Payments / UPI AutoPay tokens.

This document is the implementation brief for `apps/earthen-subscriptions-app` on
the Earthen Story store (`701031-e7.myshopify.com`). It supersedes the earlier
fixed Razorpay Subscriptions/Plan design.

### Implementation status — 19 July 2026

The repository implementation now exists at `apps/earthen-subscriptions-app` and
includes the embedded admin app, master signup/widget switch (off by default),
product enrollment, versioned global discounts/quantity tiers, theme widget and
subscription basket, paid-order activation, Razorpay UPI mandate registration and
reauthorization, dynamic-price/inventory/tax renewal processing, dunning,
notifications, customer portals, admin operations/calendar/health, privacy webhooks,
scheduled jobs and deployment assets.

Local verification passes TypeScript, ESLint, Prisma schema validation, the
production React Router build, Shopify CLI validation for both extensions, and 25
unit/integration/smoke tests across 9 test files. These are adapter-backed tests and
do not make real Razorpay debits or create live Shopify orders. The P0 live capability
spike in section 15 remains mandatory before enabling the master switch.

---

## 0. Final product decisions

| Area | Decision |
|---|---|
| Payment engine | Razorpay variable Recurring Payments with UPI AutoPay tokens, not fixed Razorpay Subscription Plans. |
| Launch method | UPI AutoPay first. Cards and eMandate follow only after Razorpay confirms equivalent variable-debit support. |
| First purchase | Customer completes the normal Shopify/Magic Checkout at normal price. No subscription discount applies to this first order. |
| Activation | A subscription can only originate from a paid Shopify order. After checkout, the customer authorizes the UPI mandate; only then does the subscription become active. |
| Activation-link expiry | A pending mandate-activation link expires after 48 hours. The value remains globally configurable in the admin app. |
| Subscription identity | Each subscription line is SKU/variant-level. Store Shopify `variantId` as the durable key and SKU as the merchant-facing identifier/snapshot. |
| Product eligibility | Configured at product level: none, selected products, or all eligible products. Enabling a product enables its active physical variants/SKUs. |
| Disabled product | Stops accepting new subscriptions; existing subscription lines continue unless explicitly removed/cancelled. |
| Grouping | Lines with the same customer, address, frequency, anchor date and mandate form one combined-delivery group. |
| Mandate | One mandate per combined-delivery group. Individual SKU lines remain independently removable; the mandate is cancelled only when the final line/group is cancelled. |
| Base discount | Store/account-level only, default 2%, editable in the embedded admin app. No per-product discount override. |
| Quantity tiers | Global additional bonuses, default: 2+ items = +1%, 3+ = +3%, 5+ = +5%. Editable in admin. |
| Tier counting | Total units due in the group, including multiple units of the same SKU. |
| Discount formula | Locked base discount + locked applicable quantity-tier bonus. No configurable maximum cap, but reject invalid effective discounts of 100% or more. |
| Pricing | Every renewal uses the SKU's latest Shopify price, then applies the subscription's locked discount-policy version. |
| Policy edits | New discount settings apply to new subscriptions. Existing subscriptions retain their accepted policy version unless explicitly migrated. |
| Duration | Default 2 years, configurable globally in the admin app. Customer can cancel earlier. |
| Intervals | Weekly, fortnightly, monthly, every two months, quarterly, and half-yearly. |
| Changes | Quantity, interval, variant, or adding a product uses a replacement subscription/mandate for MVP. Removing a SKU line is allowed in place. |
| Inventory | Never intentionally debit an unavailable item. Partial group fulfillment is allowed; a completely unavailable group is skipped. |
| Stockout benefit | Merchant-caused stockout does not reduce the qualified group discount for the remaining lines in that cycle. |
| Cancellation | Default at the end of the current paid cycle. |
| Failed payments | Notify on first failure, reminders at +3/+7 days, auto-cancel at +14 days; windows configurable. |
| Successful-renewal WhatsApp | Off at launch to avoid duplicate/noisy confirmations; failure, reminder, stockout and cancellation WhatsApp messages remain in scope. |
| Transactional email | Required, but the provider and sending address/domain remain an open merchant decision. |
| Uninstall | Pause active mandates and urgently alert the merchant. Do not allow continued unattended billing without Shopify access. |

---

## 1. Existing repository context

1. Razorpay Magic Checkout creates Shopify orders already marked paid. The loyalty
   app therefore uses `orders/create`, not only `orders/paid`. Preserve this
   invariant for the initial subscription-origin order and renewal orders.
2. Shopify-native selling plans/contracts are not used. Shopify records orders and
   fulfillment; this app owns subscription scheduling; Razorpay owns payment
   mandates/tokens and payment execution.
3. Reuse patterns from:
   - `apps/earthen-loyalty-app`: Shopify webhook idempotency/replay, app-proxy
     authentication, Health page, admin UI components and fake-Prisma tests.
   - `apps/earthen-delivery-app`: app skeleton, Prisma session model including
     refresh-token fields, Docker/Cloud Run deployment.
4. The PDP already contains cosmetic purchase-option UI in
   `sections/main-product-hero.liquid`. Replace its hardcoded 2% preview with live
   app configuration.
5. The existing loyalty/delivery custom elements demonstrate the morph-safe theme
   pattern. Preserve host elements and reassert visibility after cart morphs.
6. Renewal orders must use real Shopify variant IDs so inventory, fulfillment and
   BuyWithAmazon routing continue to work.

### Shopify Basic compatibility

The MVP can run on Shopify Basic, with one mandatory app-architecture choice:

- Create the production app with Shopify CLI/Dev Dashboard and select **Custom
  distribution** for this store. Do not depend on an admin-created custom app.
- A custom-distribution app has Level-2 protected-customer-data access available,
  which this design needs for the originating order's name, email, phone and shipping
  address. Access only the minimum fields required and implement Shopify's Level-1
  and Level-2 data-protection requirements.
- The mandate CTA is placed only on the Thank-you and Order-status pages. Those UI
  extensions are available on Basic. The design does not require extensions in the
  information, shipping or payment steps, which are Shopify Plus-only.
- Do not introduce custom Shopify Functions into the MVP: custom-app Functions are
  Plus-only. They are not needed by this plan because the first order has no
  subscription discount and renewal pricing is calculated by the app before it
  creates the renewal order.
- This is an app-owned subscription system, not Shopify-native selling plans or
  subscription contracts. Shopify Basic records the initial and renewal orders;
  Razorpay owns the UPI mandate and the app owns scheduling and subscription state.

Therefore, upgrading the store plan is not currently required for the documented
MVP. Revalidate the installed app's protected-data fields and the Thank-you/Order-
status extension on the actual Basic store during P0 before completing the build.

Official references: [checkout app availability by plan](https://help.shopify.com/en/manual/checkout-settings/customize-checkout-configurations/checkout-apps),
[checkout extension plan support](https://shopify.dev/docs/api/checkout-extensions/index),
[protected customer data access by app type](https://shopify.dev/docs/apps/launch/protected-customer-data),
and [app distribution models](https://shopify.dev/docs/apps/launch/distribution).

---

## 2. Scope

### MVP

- Embedded admin app for product eligibility, global base discount, quantity tiers,
  allowed intervals, default duration, shipping policy, dunning and notifications.
- PDP Subscribe option and subscription-specific basket within the normal cart
  journey.
- Normal Shopify/Magic Checkout for the first order, at normal price.
- Post-purchase UPI AutoPay mandate activation without a second address/contact form.
- Variable renewal pricing using current Shopify prices.
- Quantity-based combined-delivery discounts and one renewal order per group.
- Inventory-aware partial or complete cycle skipping before debit.
- Customer portal: view, skip, pause, resume, cancel, remove SKU, update address,
  and start replacement flows for material changes.
- Automatic renewal debit, Shopify order creation, notifications, dunning,
  reconciliation and Health/admin operational views.

### Post-MVP

- Variable recurring cards/eMandate after account capability is verified.
- In-place quantity/variant/interval increases.
- Adding products to an existing mandate without replacement.
- Product swaps, prepaid/gift subscriptions, box builder, loyalty redemption against
  renewals, retention offers and advanced cohort analytics.

### Explicit non-goals for MVP

- COD subscriptions, Shopify selling plans/contracts, multi-currency and
  per-product discount overrides.

---

## 3. Admin configuration

### Product eligibility

`enrollmentMode` values:

- `none`: no new subscriptions.
- `selected`: only selected product IDs; manage with Shopify Resource Picker.
- `all`: all active physical products except gift cards, digital products, archived
  products and explicit exclusions.

Product eligibility is stored in the app database. Optional Shopify metafields may
be added later as a storefront cache, but they are not authoritative.

Disabling a product affects new signup only. Existing active lines remain scheduled
until the customer or merchant removes/cancels them.

### Global discounts

- `baseDiscountBps`: default `200` (2%).
- No product-level discount overrides.
- Quantity-tier defaults:

| Minimum units due together | Additional bonus | Effective discount with 2% base |
|---:|---:|---:|
| 1 | 0% | 2% |
| 2 | 1% | 3% |
| 3 | 3% | 5% |
| 5 | 5% | 7% |

Admin can add, edit, delete and reorder tiers. Validate that minimum quantities are
unique and ascending, bonuses do not decrease at higher tiers, and the resulting
discount is below 100%.

Every activation records a `PricingPolicyVersion`. Later configuration edits create
a new version for new subscriptions; existing groups remain on the version they
accepted. Any migration of existing groups must be an explicit admin action with a
preview/audit record.

### Schedule and duration

Allowed customer intervals:

- weekly
- fortnightly
- monthly
- bimonthly
- quarterly
- half-yearly

Default mandate/subscription duration is 2 years and is editable globally. Add an
admin guardrail of 1–10 years unless Razorpay account limits require a narrower
range. Notify customers 30 days before expiry and provide reauthorization.

### Other settings

- Widget enabled/disabled.
- Free-shipping threshold and below-threshold fee, both stored in paise.
- Dunning windows and auto-cancel days.
- Hermes WhatsApp enablement/templates.
- Transactional email sender/provider settings.
- Successful-renewal WhatsApp toggle (default off; Shopify/Razorpay confirmations
  are sufficient initially).

---

## 4. Storefront and first-order flow

### PDP and subscription basket

1. `GET /apps/subscriptions/config?product_id=&variant_id=` returns eligibility,
   global base discount, tiers, intervals and future-renewal preview.
2. Customer selects a SKU/variant and Subscribe on the PDP.
3. The subscription basket stores selected SKU lines, quantities and one common
   interval/anchor for the proposed group.
4. Normal one-time cart lines may coexist and remain unrelated.
5. The UI counts total subscription units and displays progress, for example:
   `Add one more item to unlock 5% future subscription savings.`
6. Subscription-marked cart lines carry signed/private line attributes containing a
   subscription-intent ID, selected interval and pricing-policy version. Verify that
   Magic Checkout preserves them before launch.

### Normal checkout; no separate signup form

1. Customer completes normal Shopify/Magic Checkout.
2. The first order is charged at normal current price. It receives no subscription
   base or quantity-tier discount.
3. `orders/create` reads the signed subscription intent and the paid order's customer,
   contact and shipping address.
4. Only now create a `SubscriptionActivation` in `pending_mandate` state. A cart
   intent alone is not a subscription.
5. A Thank-you/Order-status extension shows `Activate UPI AutoPay` and opens the
   Razorpay UPI Intent/registration flow.
6. Email/WhatsApp may resend the activation link if the customer leaves checkout.
7. On confirmed mandate/token webhook, create/activate the `SubscriptionGroup` and
   its SKU lines. Subscription discounts start on the next renewal order.
8. If activation is not completed, the first paid Shopify order remains a normal
   purchase and no recurring subscription becomes active.

The activation-intent expiry is 48 hours by default and remains globally configurable.

---

## 5. Payment architecture

### Razorpay variable Recurring Payments

Use Razorpay customer + UPI AutoPay token APIs rather than `/v1/plans` and fixed
Razorpay Subscription entities.

Mandate registration:

1. Create/reuse Razorpay customer.
2. Create registration order with UPI method, frequency, expiry and maximum amount.
3. Use UPI Intent (recommended/current flow) for approval.
4. Store only Razorpay customer ID and token/mandate ID; never store VPA/PIN/bank data.

Subsequent renewal:

1. Create Razorpay order for the exact computed renewal amount.
2. Create recurring payment with customer ID + token ID.
3. Treat Razorpay webhook/payment state as the source for payment success.
4. Create Shopify order only after successful/captured payment.

### One mandate per combined-delivery group

A mandate authorizes amount/frequency/expiry; product membership remains in our
database. Removing one SKU does not cancel the group mandate. Recalculate future
debits from remaining lines and cancel the mandate only when the final line/group is
cancelled.

Do not use one mandate per SKU: that would cause multiple debits, notifications,
partial payment outcomes and difficult one-order reconciliation.

### Headroom

At activation:

```text
mandateMaxPaise = min(
  1_500_000,
  roundUpToNearest100Rupees(firstExpectedRenewalPaise * 2)
)
```

Show the expected next renewal and maximum mandate clearly before approval. If a
future computed group amount exceeds the mandate maximum, do not debit; mark
`reauthorization_required`, notify the customer and guide them through replacement.

### Payment-method rollout

- MVP: UPI AutoPay only.
- Cards/eMandate: hidden until variable-amount, token and pre-debit behavior is
  proven for the merchant account in test and live mode.

---

## 6. Data model

Store money as integer paise and discounts as integer basis points.

```prisma
model Session { /* copy delivery app, including refreshToken fields */ }

model SubscriptionSettings {
  shopDomain                  String   @id
  enrollmentMode             String   @default("none")
  selectedProductIds         Json     @default("[]")
  excludedProductIds         Json     @default("[]")
  currentPricingPolicyId     String?
  defaultDurationMonths      Int      @default(24)
  allowedIntervals           Json
  activationTtlHours         Int      @default(48)
  freeShippingThresholdPaise Int      @default(34900)
  shippingFeePaise           Int
  widgetEnabled              Boolean  @default(false)
  updatedAt                  DateTime @updatedAt
}

model PricingPolicyVersion {
  id                    String   @id @default(cuid())
  shopDomain            String
  version               Int
  baseDiscountBps       Int      @default(200)
  tiers                 QuantityDiscountTier[]
  createdAt             DateTime @default(now())
  @@unique([shopDomain, version])
}

model QuantityDiscountTier {
  id                    String @id @default(cuid())
  pricingPolicyId       String
  pricingPolicy         PricingPolicyVersion @relation(fields:[pricingPolicyId], references:[id])
  minimumQuantity       Int
  additionalDiscountBps Int
  @@unique([pricingPolicyId, minimumQuantity])
}

model SubscriptionIntent {
  id                    String   @id @default(cuid())
  shopDomain            String
  signedCartReference   String   @unique
  requestedLines        Json
  intervalCode          String
  pricingPolicyId       String
  status                String   // cart|ordered|pending_mandate|activated|expired
  shopifyOrderId        String?
  expiresAt             DateTime
  createdAt             DateTime @default(now())
}

model SubscriptionGroup {
  id                    String   @id @default(cuid())
  shopDomain            String
  status                String   // pending_mandate|active|paused|halted|cancelled|expired|reauthorization_required
  shopifyCustomerId     String?
  customerName          String
  customerEmail         String
  customerPhone         String
  addressJson           Json
  intervalCode          String
  anchorDate            DateTime
  nextChargeAt          DateTime?
  endAt                 DateTime
  pricingPolicyId       String
  razorpayCustomerId    String?
  razorpayTokenId       String?  @unique
  mandateMaxPaise       Int?
  cancelAtCycleEnd      Boolean  @default(false)
  cancelledAt           DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  lines                 SubscriptionLine[]
  cycles                BillingCycle[]
  @@index([shopDomain, status])
  @@index([shopifyCustomerId])
}

model SubscriptionLine {
  id                       String   @id @default(cuid())
  subscriptionGroupId      String
  group                    SubscriptionGroup @relation(fields:[subscriptionGroupId], references:[id])
  shopifyProductId         String
  shopifyVariantId         String
  sku                      String?
  productTitle             String
  variantTitle             String?
  quantity                 Int
  signupUnitPricePaise     Int
  lastChargedUnitPricePaise Int?
  status                   String   // active|removed|product_disabled|deleted
  removedAt                DateTime?
  @@index([shopifyVariantId])
}

model BillingCycle {
  id                    String   @id @default(cuid())
  subscriptionGroupId   String
  group                 SubscriptionGroup @relation(fields:[subscriptionGroupId], references:[id])
  seq                   Int
  status                String   // preparing|payment_pending|charged|order_created|partially_skipped|skipped_oos|failed|refunded
  scheduledAt           DateTime
  qualificationQuantity Int
  baseDiscountBps       Int
  tierBonusBps          Int
  chargeAmountPaise     Int?
  shippingPaise         Int?
  razorpayOrderId       String?  @unique
  razorpayPaymentId     String?  @unique
  shopifyOrderId        String?
  createdAt             DateTime @default(now())
  @@unique([subscriptionGroupId, seq])
}

model PaymentAttempt { /* cycle, external payment id, status, reason, attemptedAt */ }
model WebhookEvent   { /* source, externalEventId unique, raw payload hash/status */ }
model EventLog       { /* masked audit log */ }
model NotificationLog { /* channel/template/idempotency key/provider result */ }
model CronRun        { /* job, started/completed, counts/errors */ }
```

Use database constraints/leases so the browser, Razorpay webhook and reconcile job
cannot create duplicate debits or Shopify orders.

---

## 7. Renewal computation and inventory

For each group due for renewal:

1. Load active SKU lines and current Shopify variants.
2. Mark deleted/archived variants for manual attention; do not debit them.
3. Read current prices, taxable state and sellable inventory across fulfillment-
   eligible locations.
4. `qualificationQuantity` is total active quantity due before merchant-caused
   stockout filtering.
5. Select the group's locked pricing-policy tier for that quantity.
6. Remove unavailable quantities/lines from the payable shipment.
7. If every line is unavailable: create `skipped_oos`, notify, advance one normal
   interval, and do not debit.
8. For available lines:

```text
lineNetPaise = roundPaise(
  currentUnitPricePaise * quantity *
  (1 - (lockedBaseBps + lockedTierBonusBps) / 10_000)
)

preTaxOrTaxInclusiveSubtotalPaise = sum(lineNetPaise) + currentShippingPaise
```

Use Shopify `draftOrderCalculate` with the current variants, locked percentage,
current customer/address and shipping line to calculate the authoritative current
tax treatment before debit. Persist its `taxesIncluded`, tax lines, total tax and
final total in the cycle snapshot. The exact Razorpay debit is Shopify's calculated
final total; a tax-calculation error blocks the debit.

9. Merchant-caused stockout retains the originally qualified tier discount for the
   remaining items in this cycle. Customer-initiated removal recalculates the tier
   for future cycles.
10. Apply the current free-shipping threshold/rate. Never increase shipping after a
    payment because stock vanished.
11. Verify amount is below ₹15,000 and the mandate maximum.
12. Send/trigger the required pre-debit notice and initiate variable recurring payment.
13. On success, recheck inventory and create one paid Shopify order.
14. If inventory disappeared during the payment window, refund the unavailable
    amount (or full payment if nothing remains), notify and log for reconciliation.
15. Advance to the next interval; do not perform an immediate restock catch-up.

---

## 8. Shopify renewal order

Create with Admin GraphQL `orderCreate` using an offline token:

- real `variantId` and quantity for each shipped line;
- current discounted line price in INR;
- `taxesIncluded` and explicit current tax lines returned by Shopify's pre-debit
  `draftOrderCalculate` result;
- shipping line using the current renewal computation;
- associated Shopify customer and stored renewal shipping address;
- a successful `SALE` transaction for the captured Razorpay amount/reference;
- `financialStatus: PAID`;
- `sendReceipt: true`;
- tags: `Earthen Subscription`, `sub-group:<id>`, `cycle:<seq>`;
- custom attributes: group ID, cycle sequence, Razorpay payment ID;
- configured inventory decrement behavior and real variants for fulfillment routing.

Before creation, acquire an atomic DB claim. Tag lookup is only a secondary recovery
check, not the concurrency guarantee. Permanent failures enter manual review and may
trigger refund; reconcile retries only transient failures.

Renewal orders contain no loyalty discount code, but they remain ordinary paid
Shopify orders and accrue loyalty points through the existing fulfillment flow.

---

## 9. Customer portal

Access:

- Signed-in customer: signed app-proxy `logged_in_customer_id` scoped to the shop.
- Logged-out customer: single-use hashed magic link exchanged for a short-lived
  portal JWT/session. Return a generic response to link requests to prevent account
  enumeration.

Actions:

| Action | Behavior |
|---|---|
| View | Group lines, quantities, current estimate, locked policy, mandate maximum, schedule and history. |
| Skip next | No debit/order; advance one full interval. |
| Pause/resume | Stop/start app-initiated future debits and calculate next valid date. |
| Cancel group | Stop at end of current paid cycle by default; cancel mandate when effective. |
| Remove SKU | Remove only that line in place; group/mandate continues. Cancel mandate if it was the final line. |
| Update address | Validate serviceability and use for future orders. |
| Quantity/variant/interval/add product | Guide customer through replacement subscription/mandate for MVP. |

After customer removal, future tier qualification uses the remaining total quantity.
Stockout protection applies only to merchant-caused unavailability.

---

## 10. Notifications and dunning

Channels:

- Razorpay/bank: mandate and required pre-debit/payment notices.
- Shopify: successful renewal order receipt.
- Hermes: activation link, pre-renewal reminder, failure, halted and cancellation
  WhatsApp templates. Successful-renewal WhatsApp default off.
- Transactional email: activation, out-of-stock/partial shipment, reauthorization,
  dunning and mandate-expiry notices.

Out-of-stock copy must explicitly state which items were omitted and that the
customer was not charged for them. If the complete group is unavailable, state that
no charge occurred and the next normal date.

Dunning defaults:

- First failure: one immediate notice.
- Halted/unresolved: portal/replacement instructions.
- Reminder: +3 days.
- Reminder: +7 days.
- Auto-cancel: +14 days with final notice.

All notification sends have idempotency keys and logs; provider failure must not
roll back payment/order state.

---

## 11. Webhooks, jobs and reconciliation

### Webhooks

- Razorpay: verify `X-Razorpay-Signature` against raw bytes and deduplicate using
  `x-razorpay-event-id`.
- Shopify: use framework authentication and external webhook ID.
- Persist/acknowledge quickly. Process durable outbox/task work outside the webhook
  response path; do not rely on Cloud Run background execution after returning.
- Handlers tolerate duplicates and out-of-order events.

### Scheduled work

- Renewal preparation/debit scheduler frequent enough to satisfy UPI pre-debit timing.
- Hourly reconciliation for token/payment/order drift.
- Daily notifications, dunning, expiry reminders, activation cleanup and audit-log
  retention.

Reconciliation must find:

- successful payment without Shopify order;
- Shopify order without linked cycle;
- pending payment beyond normal provider time;
- duplicate/overlapping payment attempts;
- active group with invalid/expired token;
- amount above mandate maximum;
- missing next-charge date;
- paused/cancelled state drift;
- stockout/refund requiring manual review.

---

## 12. Admin app

- Dashboard: group/line counts by status, expected next-7-days charges, skipped/OOS,
  failures, refunds and recent events.
- Products: none/selected/all mode, picker and exclusions; no product discount field.
- Discounts: global base percentage, editable quantity tiers, policy-version history
  and explicit migration tool.
- Schedule: allowed intervals and configurable default duration (initially 24 months).
- Subscriptions: customer/group/SKU filters, details, cycles, payment/order links and
  actions.
- Calendar: upcoming combined deliveries and renewal workload.
- Settings: widget, shipping, duration, dunning, email and WhatsApp.
- Health: failed webhooks/replay, cron status, payment-order gaps, token drift,
  stockout refunds and manual-review queue.

---

## 13. Infrastructure and prerequisites

| Item | Requirement |
|---|---|
| Razorpay | Enable S2S/variable Recurring Payments, UPI AutoPay Intent/token APIs, test/live credentials and webhooks. Confirm all six frequencies and pre-debit responsibilities for the account/MCC. |
| Shopify app | New custom app with app proxy and `read_customers`, `read_inventory`, `read_locations`, `read_orders`, `read_products`, `write_draft_orders`, and `write_orders` for product/order/inventory access, current tax calculation, app extensions and renewal-order creation. Add `write_discounts` only if a Shopify Discount Function becomes necessary later. |
| Checkout extension | Thank-you/Order-status activation CTA; available on supported store plan. |
| Cloud SQL | New `earthen_subscriptions` database/user on the existing instance. |
| Cloud Run | `earthen-subscriptions-app`; configure safe DB pooling and no reliance on in-memory jobs. |
| Durable jobs | Cloud Tasks/outbox worker plus Cloud Scheduler for renewal, reconciliation and daily maintenance. |
| Hermes | Internal authenticated template-send endpoint and approved templates. |
| Email | Transactional provider, verified sending domain, SPF/DKIM and API secret. |
| Secrets | Database URL, Shopify credentials, Razorpay keys/webhook secret, portal/session secret, job authentication, Hermes and email secrets. |

---

## 14. Security and privacy

The app stores only data required to schedule and create future orders:

- Shopify customer ID, name, email, phone and renewal shipping address;
- product/variant/SKU, quantity, schedule and discount-policy details;
- Razorpay customer, token/mandate and payment IDs;
- price, notification and order audit records.

Do not store card number, expiry, CVV, UPI PIN, bank account, or raw UPI VPA. Treat
Razorpay token IDs as sensitive references. Encrypt in transit, restrict database
access, mask PII in logs, hash portal tokens, implement customer/shop redaction and
define retention/deletion periods. The fact that Shopify also stores customer data
does not remove the app's responsibility for its copy.

Cron endpoints must use strong authentication (prefer Cloud Run IAM/OIDC). Verify
all webhook/app-proxy signatures and never log full addresses, phone numbers, raw
tokens or secrets.

On uninstall, block new work, pause active Razorpay mandates/tokens where supported,
alert the merchant and retain only the minimal data required for controlled recovery
and legal/accounting obligations.

---

## 15. Testing and acceptance

### Required unit coverage

- Schedule math for all six intervals, month-end/IST boundaries, skip, pause/resume
  and 24-month/default expiry.
- Current-price calculations in integer paise.
- Quantity-tier qualification including repeated units of the same SKU.
- Locked policy versions and explicit migration.
- Product eligibility none/selected/all and disabled-product behavior.
- Group mandate with in-place line removal/final-line cancellation.
- Headroom rounding/cap and reauthorization-required path.
- Inventory matrices: full stock, partial stock, total stockout, post-debit stock race,
  discount protection and refund.
- Normal-order intent matching, activation expiry and no subscription before order.
- Razorpay signature/event-id idempotency and out-of-order handling.
- Atomic payment/order claims and reconcile recovery.
- Portal authorization and replacement actions.
- PII masking and notification idempotency.

### P0 capability spike (blocking)

1. Confirm Razorpay variable UPI AutoPay APIs are enabled in test mode.
2. Register a token via UPI Intent with 2x headroom and 2-year expiry.
3. Prove all requested frequencies or the correct `as_presented` mapping.
4. Create variable subsequent debits at different amounts below the mandate maximum.
5. Confirm pre-debit timing and webhook lifecycle.
6. Complete normal Magic Checkout with signed subscription cart-line attributes and
   verify they survive into `orders/create`.
7. Render Thank-you/Order-status activation CTA and complete mandate handoff.
8. Create one grouped renewal Shopify order with real variants, current prices,
   Shopify-calculated current taxes, partial inventory filtering, one transaction
   and normal fulfillment routing.
9. Install the app on the actual Shopify Basic store using Custom distribution;
   verify the required Level-2 order/customer fields and Thank-you/Order-status
   extension before the broader implementation proceeds.

### Launch acceptance

- Widget remains disabled globally except test products until P0/P1 pass.
- Real UPI mandate and at least two renewal cycles complete successfully.
- Current-price change produces the expected later renewal amount without reauth
  when below mandate max.
- Three-unit tier produces default effective 5% discount with 2% base.
- Removing one SKU retains the group mandate and recalculates the next tier.
- Total stockout causes no debit/order; partial stockout charges/orders only available
  lines while retaining the qualified tier.
- Duplicate webhook/worker execution produces exactly one debit and one Shopify order.
- Uninstall drill pauses billing and alerts operations.

Rollback for new signup is `widgetEnabled=false`/`enrollmentMode=none`. Existing
active groups continue only while the service is healthy; emergency operations must
be able to pause mandates in bulk.

---

## 16. Remaining open items

### Merchant decisions

1. Choose the transactional email provider and sending address/domain.

### External confirmations/actions

1. Razorpay relationship manager: enable/confirm variable Recurring Payments, UPI
   Intent, token headroom, the six frequencies, pre-debit handling, retries and
   webhooks for the Earthen Story account/MCC.
2. Confirm cards/eMandate variable recurring capability for post-MVP.
3. Confirm Hermes internal endpoint/token and approve WhatsApp templates.
4. Create/install the Shopify app using Custom distribution, configure the app proxy,
   and verify required protected-customer-data fields during P0.
5. Place and verify the Thank-you/Order-status extension through the checkout editor
   on the production Shopify Basic store.
6. Select/verify the transactional email provider, sender domain, SPF and DKIM.
