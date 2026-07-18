# Earthen Subscriptions — In-House Build Plan (Custom Shopify App + Razorpay Subscriptions)

Implementation brief for building `apps/earthen-subscriptions-app`: a custom Shopify app
providing true auto-pay subscriptions (UPI AutoPay / card e-mandate via Razorpay
Subscriptions) for the Earthen Story store (`701031-e7.myshopify.com`, live theme repo =
this repo). Written to be executed top-to-bottom by a Claude build session.

---

## 0. Context the builder MUST internalize first

1. **Checkout reality:** the store uses Razorpay **Magic Checkout** for one-time
   purchases. Magic creates Shopify orders **already marked paid**, so the
   `orders/paid` webhook NEVER fires for them — all order-lifecycle logic keys off
   `orders/create` (see `apps/earthen-loyalty-app/app/loyalty/webhooks.ts`,
   `settleRedemptionForOrder`). Renewal orders created by THIS app via Admin API will
   behave the same way (created as paid) — the loyalty app already handles that
   correctly; do not break this invariant.
2. **Shopify-native subscriptions are unusable in India** (no Shopify Payments; Razorpay
   is not a vaulting gateway). We do NOT use selling plans / subscription contracts /
   billing attempts at all. The subscription engine is entirely ours + Razorpay.
3. **Discount-code lesson:** Magic Checkout silently drops customer-restricted discount
   codes. Any code this app ever creates must use `customerSelection: { all: true }`
   (see `apps/earthen-loyalty-app/app/loyalty/redemptions.ts`). For subscriptions we
   avoid codes entirely (prices are set directly on draft/API orders), but the lesson
   applies to any promo work.
4. **Existing sibling apps to clone patterns from:**
   - `apps/earthen-loyalty-app` — the reference for: webhook idempotency framework
     (`recordWebhookEvent`/`markWebhookProcessed`/`replayFailedWebhooks`), app-proxy
     HMAC auth (`app/loyalty/app-proxy.ts`), admin UI kit
     (`app/components/loyalty-admin-ui.tsx`), Health page self-heal pattern, vitest
     fake-Prisma unit-test style (`tests/*.test.ts`, ~80 tests).
   - `apps/earthen-delivery-app` — the reference for: "clone the skeleton and strip"
     (it was itself cloned from loyalty), Prisma session storage incl.
     `refreshToken`/`refreshTokenExpires` columns fix, `scripts/deploy-cloudrun.sh`.
5. **Theme integration points already exist:**
   - `sections/main-product-hero.liquid` has a cosmetic One-time/Subscribe purchase-
     option card UI (`es-purchase-option`, frequency pills `EsFreqBox`, hardcoded 2%
     subscribe price). The storefront work wires this to real plans.
   - Cart drawer/page has custom rows for points (`earthen-loyalty-widget`) and
     delivery ETA (`earthen-delivery-estimate`) — follow the same custom-element +
     snippet + asset pattern for any subscription UI. Note the morph lesson: cart
     sections get DOM-morphed; widgets must survive it (`data-skip-subtree-update`,
     re-assert visibility in a MutationObserver microtask — see earthen-loyalty.js).
   - All 68 variants are currently **non-taxable** → renewal orders need no tax lines.
   - Free shipping threshold is ₹349 (`settings.free_shipping_threshold`) → most
     renewals ship free; below it, add a shipping line matching storefront rates.
6. **Fulfillment:** orders route by inventory location (Shop location vs BuyWithAmazon
   MCF); the BuyWithAmazon Flow moves mixed orders to the warehouse. Renewal orders
   created via API participate in normal routing — nothing special to do, but DO set
   real `variant_id`s (not custom line items) so routing/inventory work.
7. **WhatsApp:** Hermes (our own WhatsApp platform, same GCP project) is available for
   dunning/notifications. Integration = one internal HTTPS call; a small send-endpoint
   + token may need to be added on the Hermes side (flagged in Prereqs).

---

## 1. Scope

### MVP (Phases P0–P4) — "true autopay subscribe & save"
- Admin: create subscription **plans** (products, discount %, intervals).
- PDP: real Subscribe & save option with interval picker.
- Subscribe flow: address + mandate authorization (Razorpay Checkout, UPI
  AutoPay/cards) + first charge, then Shopify order #1 created via Admin API.
- Renewals: Razorpay auto-debits per cycle → `subscription.charged` webhook → paid
  Shopify order created automatically. No customer action, no payment links.
- Customer portal (magic link + logged-in account page): view, skip, pause, resume,
  cancel, change address, change quantity.
- Dunning: charge-failure handling with WhatsApp + email nudges, auto-pause policy.
- Admin: subscriptions list/detail, cycle history, payment calendar, Health page.

### Phase P5+ (post-MVP, design for but don't build)
- Prepaid plans (N cycles upfront), gift subscriptions, tiered/loyalty-linked
  discounts, product swaps, box-builder, analytics (MRR/churn/cohorts), cancellation
  retention offers, points-redemption against renewals.

### Explicit non-goals for MVP
- COD subscriptions, Shopify selling plans, multi-currency, per-customer pricing.

---

## 2. New infrastructure needed (everything else is reuse)

| Item | Action | Owner |
|---|---|---|
| **Razorpay Subscriptions feature** | Must be ENABLED on the existing Razorpay account (same account Magic uses). Contact RZP support/account manager. Also negotiate subscriptions pricing (rack: ~0.99% over PG fee). | Merchant (Shashank) — blocking prerequisite |
| Razorpay webhook | Configure endpoint `https://<cloud-run-url>/webhooks/razorpay` in RZP dashboard with events: `subscription.authenticated/activated/charged/pending/halted/cancelled/paused/resumed/completed`, `payment.failed`. Generate + store webhook secret. | Build session (URL) + merchant (dashboard click) |
| Shopify custom app | Create "earthen-subscriptions" custom app in the Partner/store admin exactly like earthen-delivery was created; scopes: `read_products, read_customers, write_customers, read_orders, write_orders, write_draft_orders, read_inventory` (+`write_discounts` reserved for retention offers). App proxy prefix: `/apps/subscriptions` → Cloud Run URL. | Merchant clicks, session drives |
| Cloud SQL database | `earthen_subscriptions` DB + `subscriptions_app` user on existing instance `earthen-loyalty-postgres` (project `es-automation-2026`, `asia-south1`). | Build session (gcloud) |
| Secrets | `earthen-subscriptions-database-url`, `earthen-subscriptions-shopify-api-secret`, `earthen-subscriptions-razorpay-key-id`, `earthen-subscriptions-razorpay-key-secret` (can reuse account keys), `earthen-subscriptions-razorpay-webhook-secret`, `earthen-subscriptions-cron-token`, `earthen-subscriptions-portal-jwt-secret`, `earthen-subscriptions-hermes-token`. | Build session |
| Cloud Run service | `earthen-subscriptions-app`, min-instances=1, same deploy-from-source script pattern. | Build session |
| **Cloud Scheduler** (new service type for us) | Job `subscriptions-daily-run`: 08:00 IST daily → `POST https://<url>/cron/daily` with `Authorization: Bearer <cron-token>`. Second job `subscriptions-hourly-reconcile` hourly → `/cron/reconcile`. | Build session |
| Hermes send API | Confirm/add an internal endpoint on Hermes: `POST /internal/send-template` (phone, template, params) guarded by bearer token. If Hermes lacks it, add minimally there first. | Build session (coordinate) |

---

## 3. Repo scaffold (P0)

1. Copy `apps/earthen-delivery-app` → `apps/earthen-subscriptions-app`; strip delivery
   domain code (keep session storage, app-proxy auth, webhook framework files, admin UI
   kit imports, vitest config, Dockerfile, deploy script).
2. Rename app identifiers, `.env.example`:
   ```
   SHOPIFY_API_KEY=            # from custom app
   SHOPIFY_API_SECRET=
   SHOPIFY_APP_URL=
   SCOPES=read_products,read_customers,write_customers,read_orders,write_orders,write_draft_orders,read_inventory
   DATABASE_URL=postgresql://subscriptions_app:...@localhost:5432/earthen_subscriptions
   RAZORPAY_KEY_ID=
   RAZORPAY_KEY_SECRET=
   RAZORPAY_WEBHOOK_SECRET=
   CRON_TOKEN=
   PORTAL_JWT_SECRET=
   HERMES_API_URL=
   HERMES_API_TOKEN=
   STORE_TZ=Asia/Kolkata
   ```
3. Directory layout under `app/`:
   ```
   subscriptions/
     razorpay.ts          # thin typed client (REST, auth, signature verify)
     plans.ts             # plan CRUD + validation + price computation
     lifecycle.ts         # subscription state machine (single authority for transitions)
     schedule.ts          # pure date math: next_charge_at, anchor, skip, pause (IST)
     orders.ts            # Shopify order/draft-order builders for renewals
     webhooks-razorpay.ts # RZP event handlers (idempotent)
     webhooks-shopify.ts  # orders/create matcher, customers/update, uninstall
     portal.ts            # magic-link tokens, portal action handlers
     notifications.ts     # WhatsApp (Hermes) + email senders, template registry
     dunning.ts           # failure policy decisions (pure)
     reconcile.ts         # drift repair: RZP <-> DB <-> Shopify
     app-proxy.ts         # HMAC verify (copied)
   routes/
     app._index.tsx                 # dashboard
     app.plans.tsx / app.plans.$id.tsx
     app.subscriptions.tsx / app.subscriptions.$id.tsx
     app.calendar.tsx
     app.settings.tsx
     app.health.tsx
     apps.subscriptions.config.tsx      # storefront: plans for a product (GET)
     apps.subscriptions.subscribe.tsx   # storefront: create sub + checkout params (POST)
     apps.subscriptions.confirm.tsx     # storefront: post-checkout verify (POST)
     apps.subscriptions.portal.tsx      # portal data (GET) + actions (POST)
     apps.subscriptions.portal-link.tsx # request magic link (POST)
     webhooks.razorpay.tsx              # RZP webhook receiver
     webhooks.orders.create.tsx / webhooks.app.uninstalled.tsx / webhooks.customers.update.tsx
     cron.daily.tsx / cron.reconcile.tsx
   ```

---

## 4. Data model (Prisma — `earthen_subscriptions`)

```prisma
model Session { /* copy exactly from earthen-delivery-app incl. refreshToken fields */ }

model SubscriptionPlan {
  id                String   @id @default(cuid())
  shopDomain        String
  name              String            // "Subscribe & Save 10%"
  status            String   @default("active") // active|archived
  discountPct       Decimal           // % off variant price for every cycle
  intervals         Json              // [{unit:"week"|"month", count:2, label:"Every 2 weeks"}]
  productSelection  Json              // {mode:"all"} | {mode:"products", productIds:[...]} | {mode:"collections", ids:[...]}
  minCycles         Int?              // optional commitment (informational for MVP)
  maxAmountHeadroom Decimal @default(2.0) // mandate max = first charge * headroom
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  subscriptions Subscription[]
}

model Subscription {
  id                 String   @id @default(cuid())
  shopDomain         String
  planId             String
  plan               SubscriptionPlan @relation(fields:[planId], references:[id])
  status             String   // draft|pending_auth|active|paused|halted|cancelled|completed
  shopifyCustomerId  String?
  customerEmail      String
  customerPhone      String   // E.164; required (mandate + WhatsApp)
  customerName       String
  addressJson        Json     // full shipping address snapshot (editable in portal)
  items              Json     // [{variantId, productId, title, qty, unitPriceInr, weightGrams}]
  intervalUnit       String   // week|month
  intervalCount      Int
  chargeAmountInr    Decimal  // per-cycle amount actually charged (items*qty net of discount + shipping)
  shippingInr        Decimal  @default(0)
  razorpayPlanId     String?
  razorpaySubId      String?  @unique
  mandateMaxInr      Decimal?
  payMethod          String?  // upi|card|emandate (from first payment)
  nextChargeAt       DateTime?         // authoritative schedule (mirrors RZP, IST-derived)
  pausedAt           DateTime?
  cancelReason       String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  cycles    BillingCycle[]
  @@index([shopDomain, status])
  @@index([shopifyCustomerId])
}

model BillingCycle {
  id               String  @id @default(cuid())
  subscriptionId   String
  subscription     Subscription @relation(fields:[subscriptionId], references:[id])
  seq              Int      // 1 = first charge at auth
  status           String   // scheduled|charged|order_created|failed|skipped|refunded
  chargedAt        DateTime?
  amountInr        Decimal?
  razorpayPaymentId String? @unique
  razorpayInvoiceId String?
  shopifyOrderId   String?
  failureReason    String?
  retriesSeen      Int @default(0)
  createdAt DateTime @default(now())
  @@unique([subscriptionId, seq])
}

model PortalToken {
  id         String @id @default(cuid())
  tokenHash  String @unique   // sha256; raw token only in the sent link
  subscriptionId String?      // null = customer-level link (all subs for email)
  email      String
  expiresAt  DateTime
  usedAt     DateTime?
}

model WebhookEvent { /* copy loyalty pattern; add source: "shopify"|"razorpay" */ }
model EventLog     { /* subscriptionId, type, message, metadata, createdAt — audit trail */ }
model NotificationLog { /* subscriptionId, channel, template, to, status, providerId, createdAt */ }
model AppSetting   { /* key/value: widgetEnabled, dunningPolicy overrides, senderEmail etc. */ }
```

State machine (enforce ONLY in `lifecycle.ts`; every transition writes `EventLog`):
```
draft -> pending_auth -> active -> (paused <-> active) -> cancelled | completed
active -> halted (RZP subscription.halted after retries) -> active (on manual/auto resume) | cancelled
Terminal: cancelled, completed.
```

---

## 5. Razorpay integration details

- **Client:** REST with basic auth (`key_id:key_secret`). Endpoints used:
  `POST /v1/plans`, `POST /v1/subscriptions`, `GET /v1/subscriptions/:id`,
  `POST /v1/subscriptions/:id/cancel` (`cancel_at_cycle_end` supported),
  `POST /v1/subscriptions/:id/pause`, `/resume`,
  `PATCH /v1/subscriptions/:id` (quantity/plan changes — verify account support; if
  unsupported, implement change = cancel+recreate with customer re-auth ONLY when
  amount increases beyond mandate max).
- **Plan mapping:** Razorpay Plans are (interval, amount) pairs. Create RZP plans
  lazily per (amount, interval) needed and cache the id in `Subscription.razorpayPlanId`
  (do NOT try to pre-create per SubscriptionPlan — amounts vary per cart).
- **Subscription create:** `total_count`: use 52/24/12 as a generous horizon (or
  `expire_by` far future); `quantity:1`; `notes`: `{shop, subscriptionId, variantIds}`;
  `customer_notify: 1` (RZP sends mandate + pre-debit notices).
- **Mandate auth (storefront):** open standard Razorpay Checkout (`checkout.js`) with
  `subscription_id`. First payment = cycle 1 charge + mandate registration in one step.
  On success the handler gets `razorpay_payment_id`, `razorpay_subscription_id`,
  `razorpay_signature` → POST to `/apps/subscriptions/confirm` → server verifies
  signature (`HMAC_SHA256(payment_id + '|' + subscription_id, key_secret)`).
- **Webhook verification:** `X-Razorpay-Signature` = HMAC_SHA256(raw body, webhook
  secret). Reject on mismatch. Store event id in WebhookEvent for idempotency (RZP
  retries aggressively; handlers MUST be idempotent).
- **RBI constraints encoded in code:** per-charge auto-debit cap ₹15,000 (validate at
  subscribe time: chargeAmount ≤ 15000 else block with clear message);
  `mandateMaxInr = ceil(chargeAmount * plan.maxAmountHeadroom)` and quantity/address
  changes must keep new amount ≤ mandateMax (else require re-subscribe).
- **Test mode:** RZP test keys support Subscriptions end-to-end (test UPI + test
  cards). Build everything against test keys; switch via secrets.

---

## 6. End-to-end flows (implement in this order)

### F1. Plan display on PDP
`GET /apps/subscriptions/config?product_id=&variant_id=` → `{enabled, plans:[{planId,
label, discountPct, intervals[], subscribePriceInr per variant}]}`. Widget
(`assets/earthen-subscriptions.js`, custom element `earthen-subscription-widget`)
hydrates the existing purchase-option cards: one-time price vs subscribe price
(strike-through + "SAVE X%" badge), interval pill selector. Section changes in
`sections/main-product-hero.liquid` replace the hardcoded 2% logic.

### F2. Subscribe (mandate + first order)
1. Click Subscribe → widget opens a **subscribe sheet** (rendered by our JS, on-domain):
   contact (prefill if logged in), shipping address (pincode → optionally validate via
   delivery app serviceability), qty. POST `/apps/subscriptions/subscribe`.
2. Server: validate variant price live via Admin API; compute
   `chargeAmount = round(variantPrice * qty * (1-discountPct)) + shipping
   (0 if ≥349)`; enforce ₹15k cap; create RZP plan (lazy) + subscription
   (`status=pending_auth` row first); return `{razorpayKeyId, subscription_id,
   prefill}`.
3. Widget opens Razorpay Checkout; customer approves mandate via UPI PIN.
4. `POST /apps/subscriptions/confirm` with checkout response → verify signature →
   mark cycle 1 `charged`, subscription `active` (webhooks will double-confirm) →
   **create Shopify order #1** via `orders.ts` (below) → return order confirmation
   (redirect to order status/thank-you page or portal).
5. Belt-and-braces: `subscription.activated`/`subscription.charged` webhooks perform
   the same steps idempotently if the browser died before `confirm`.

### F3. Order creation (`orders.ts`) — used by first charge AND renewals
Create order via Admin GraphQL `orderCreate` (2025-01+) or REST fallback:
- real `variantId` line items, quantity, `priceSet` = discounted unit price;
- `financialStatus: PAID`; attach `customerId` (find/create by phone/email);
- shipping line if applicable; no tax lines (products non-taxable);
- tags: `Earthen Subscription`, `sub:<subscriptionId>`, `cycle:<seq>`;
- `note_attributes`: subscriptionId, cycle seq, razorpay payment id;
- shipping address from `addressJson`; `sourceName: "earthen-subscriptions"`;
- inventory behaviour: decrement, allow overselling policy consistent with store;
- idempotency: before creating, look up existing order by tag `sub:<id>` +
  `cycle:<seq>` (or BillingCycle.shopifyOrderId) — never create twice.
Result stored on BillingCycle; failure → EventLog + Health surfacing + retry via
reconcile cron (order creation MUST eventually succeed after a captured payment).

### F4. Renewals (fully automatic)
`subscription.charged` webhook → locate Subscription by `razorpaySubId` → create
BillingCycle(seq=n, charged) → create Shopify order (F3) → update `nextChargeAt` from
RZP payload (`current_end`) → notify customer (WhatsApp "order placed" — optional,
Shopify order confirmation email already goes out) → EventLog.

### F5. Failures & dunning
- `payment.failed` / `subscription.pending`: cycle marked failed(retriesSeen++);
  RZP auto-retries per its schedule. Send WhatsApp+email "payment issue" notice on
  first failure only.
- `subscription.halted` (RZP exhausted retries): status=halted; WhatsApp+email with
  portal magic link ("update payment / resume"); daily cron nags at +3d, +7d;
  auto-cancel at +14d (configurable in Settings) with final notice.
- `dunning.ts` is pure decision logic (state, timestamps in → actions out) so it is
  fully unit-testable.

### F6. Portal (magic link + account page)
- Request link: `POST /apps/subscriptions/portal-link {email|phone}` → if subs exist,
  send WhatsApp+email with `https://www.earthenstory.com/pages/manage-subscription#t=<raw>`
  (theme page hosts the portal widget; token in fragment). Tokens: 32B random, sha256
  stored, 48h TTL, single-use refresh.
- Actions (all POST `/apps/subscriptions/portal` with token auth):
  `skip_next` (RZP: nothing — we just create no order? NO: skipping with autopay means
  the CHARGE must not happen → implement as RZP `pause` for one cycle:
  pause→resume_at computed; document clearly), `pause` (indefinite; RZP pause),
  `resume`, `cancel` (RZP cancel at cycle end by default; immediate option),
  `update_address` (validate ≤ mandate constraints; affects future orders only),
  `update_qty` (recompute amount; allowed only if ≤ mandateMax and ≤ ₹15k; else
  instruct re-subscribe), `change_interval` (RZP plan change if supported, else
  cancel+resubscribe path).
- Logged-in storefront: link portal from the account popover (same spot the loyalty
  widget lives, `snippets/account-actions.liquid`) using logged_in_customer_id via app
  proxy (no magic link needed).

### F7. Admin app
- **Dashboard:** active/paused/halted/cancelled counts, MRR-equivalent (sum
  chargeAmount normalized to monthly), next-7-days expected charges, recent events.
- **Plans:** CRUD per §4; product picker via Shopify resource picker; guardrails
  (discount 0–50%, intervals whitelist).
- **Subscriptions:** filterable list; detail = customer, items, schedule, cycles table
  (with links to Shopify orders + RZP payments), actions (pause/resume/cancel, resend
  portal link, force-run reconcile for this sub).
- **Calendar:** upcoming charges by day (ops workload view).
- **Settings:** enable/disable widget, dunning windows, notification templates
  (subject/body with variables), sender email, WhatsApp on/off.
- **Health:** clone loyalty Health page — webhook failures + replay button, cron run
  log (last daily/reconcile at, counts), stuck items (charged-but-no-order,
  active-but-no-nextCharge, RZP/DB status drift).

### F8. Reconcile cron (hourly) — drift is the #1 operational risk
For each non-terminal subscription: `GET /v1/subscriptions/:id` → compare status +
`current_end` with DB → repair DB (never repair RZP silently); find cycles
`charged` without `shopifyOrderId` → retry order creation; find RZP payments for our
sub ids missing BillingCycles (paginate `/v1/payments?subscription_id`) → backfill.
Daily cron additionally: send pre-renewal reminders (T-2d, informational; RZP sends
the mandatory pre-debit notice itself), dunning nags, token cleanup, EventLog prune.

---

## 7. Storefront deliverables (theme repo, this repo)

1. `snippets/earthen-subscription-widget.liquid` + `assets/earthen-subscriptions.js`
   + `assets/earthen-subscriptions.css` (custom element; morph-safe; follows
   earthen-delivery-estimate structure).
2. `sections/main-product-hero.liquid`: replace cosmetic subscribe cards with widget
   hookup (keep the existing visual design; it's already approved).
3. New theme page template `page.manage-subscription.json` + section embedding the
   portal widget (`earthen-subscription-portal` element in the same JS asset).
4. Account popover: "Manage subscriptions" link.
5. Cart note: if a cart contains a product that has a plan, show "Subscribe & save
   X%" upsell chip linking back to PDP (nice-to-have, last).

Theme changes deploy via `shopify theme push --store 701031-e7.myshopify.com --only <files> --allow-live`
after verifying the live theme id via `shopify theme list` (it changes when the team
republishes; NEVER assume).

---

## 8. Testing plan (vitest, mirror loyalty conventions — fake-Prisma objects, no DB)

### Unit tests (target ≥90 tests; each module isolated)
- **schedule.ts:** next-charge math across IST boundaries, month-end anchors (31st →
  Feb), week/month intervals, pause/resume date math, skip = one-cycle pause windows.
  (~15 tests)
- **plans.ts:** price computation incl. rounding (paise), discount bounds, ₹15k cap
  enforcement, shipping threshold ≥/< ₹349, headroom/mandate max. (~10)
- **lifecycle.ts:** every legal transition + every illegal transition rejected;
  EventLog written per transition; idempotent re-entry (same event twice = no-op).
  (~15)
- **webhooks-razorpay.ts:** signature verify (valid/invalid/missing); idempotency
  (duplicate event id → single side effect); `charged` creates cycle+order call once;
  `halted`/`cancelled`/`paused`/`resumed` map correctly; unknown sub id → ignored +
  logged. (~15)
- **orders.ts:** payload built with real variant ids, discounted priceSet, shipping
  line logic, tags/note_attributes, idempotent lookup-before-create, customer
  find/create branching. (~10)
- **dunning.ts:** decision table — first failure notice-once, halted nag schedule
  (+3/+7), auto-cancel at +14, paused subs never nagged. (~8)
- **portal.ts:** token hash/expiry/single-use; action authorization (token ↔
  subscription binding); qty change amount guard vs mandateMax and ₹15k;
  cancel-at-cycle-end default. (~12)
- **webhooks-shopify.ts:** orders/create with our tag → linked not double-processed;
  customers/update refreshes cached name/phone; uninstall cleanup. (~6)
- **reconcile.ts:** drift matrices (RZP active/DB halted etc. → repair action),
  charged-without-order retry, backfill from payments list. (~10)
- **notifications.ts:** template rendering with variables; Hermes payload shape;
  failure → NotificationLog(status=failed) not thrown. (~6)
- **app-proxy auth:** signature accept/reject (copy loyalty tests). (~4)

### Integration tests (Razorpay TEST mode, run manually/scripted against dev deploy)
1. Create plan → subscribe with test UPI → mandate authorized → webhook received →
   Shopify order #1 on the store (use a hidden ₹10 test product).
2. Trigger renewal: in test mode use short interval (daily) plan → verify auto charge
   → order #2 with correct tags/pricing, no tax, free-shipping logic.
3. Failure path: test card that fails → `payment.failed` → dunning notice →
   `subscription.halted` → nag → resume → next charge OK.
4. Portal: pause → verify RZP paused + no charge on due date; resume; qty change
   within mandate; cancel at cycle end.
5. Webhook chaos: replay the same `subscription.charged` 3× (RZP dashboard resend) →
   exactly one order. Kill the app during order creation (stop Cloud Run rev) →
   reconcile cron creates the missing order.
6. Reconcile drift: manually cancel a sub in RZP dashboard → hourly cron flips DB.

### End-to-end LIVE test (before announcing)
- Real ₹49 hidden product, weekly plan, real UPI mandate on founder's phone; verify
  pre-debit SMS/UPI notification, silent auto-debit on renewal day, order lands and
  routes (warehouse), loyalty points accrue on delivery, WhatsApp messages arrive.
  Run for 2 cycles, then cancel via portal and verify mandate cancellation in the
  UPI app.

### Quality gates per phase
`npx tsc --noEmit` clean + `npx vitest run` green + manual checklist for the phase
recorded in the PR/commit message. Follow loyalty-app commit style.

---

## 9. Build order & acceptance criteria

| Phase | Deliverables | Accept when |
|---|---|---|
| **P0 Scaffold** (0.5d) | App cloned/stripped, DB+secrets+Cloud Run up, custom app installed, Health page shows green, webhook frameworks (both sources) wired with tests | `/app` loads in admin; RZP + Shopify test webhooks recorded idempotently |
| **P1 Plans+PDP** (1.5d) | Plan CRUD admin, config proxy endpoint, PDP widget wired to real prices | Plan created in admin renders correct subscribe price/intervals on live PDP (widget behind `widgetEnabled=false` flag except on test product) |
| **P2 Subscribe+first order** (2d) | F2 + F3 + confirm + activated/charged webhooks | Test-mode mandate → active sub, order #1 in Shopify with correct price/tags; unit suites for schedule/plans/orders/lifecycle green |
| **P3 Renewals+dunning** (1.5d) | F4, F5, crons, reconcile, notifications via Hermes+email | Daily-interval test sub renews hands-free; failure path produces correct notices; chaos tests pass |
| **P4 Portal+admin** (2d) | F6, F7 complete, account-page entry, calendar | All portal actions verified in test mode; admin list/detail usable for ops |
| **P5 Launch** (0.5d) | Live E2E test (above), enable widget for chosen products (ghee/atta first), docs + memory update | 2 real renewal cycles clean; rollback = `widgetEnabled=false` (subs keep renewing; only new signups stop) |

---

## 10. Security & compliance checklist
- RZP webhook signature verified on raw body; Shopify webhook HMAC verified (framework
  does); app proxy signature verified; cron endpoints bearer-token gated.
- No card/UPI data ever stored — only RZP ids. PortalTokens hashed. PII (address,
  phone) stays in our DB; do not log full phone/address (mask in EventLog).
- Mandate cap ₹15k enforced server-side; amount changes never exceed mandateMax.
- All customer-visible money values in INR paise-safe arithmetic (integers or Decimal;
  no floats).
- Uninstall webhook: mark shop inactive; do NOT auto-cancel RZP mandates without
  explicit merchant action (money-affecting).

## 11. Known open decisions (builder should confirm with Shashank at the flagged point)
1. "Skip next delivery" implemented as one-cycle pause (charge skipped) — confirm UX
   copy. (F6)
2. Auto-cancel after 14 days halted — confirm window. (F5)
3. Which products launch first (suggest: A2 Ghee, Khapli/Ragi flours, gulkand) and
   discount % (suggest 5–10%). (P5)
4. Whether renewal WhatsApp "order placed" message is wanted or email-only. (F4)
5. PATCH subscription support on the RZP account (affects change_interval path). (F6)
```
