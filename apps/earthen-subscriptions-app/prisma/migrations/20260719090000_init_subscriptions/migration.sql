CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE "Session" (
  "id" TEXT NOT NULL, "shop" TEXT NOT NULL, "state" TEXT NOT NULL,
  "isOnline" BOOLEAN NOT NULL DEFAULT false, "scope" TEXT, "expires" TIMESTAMP(3),
  "accessToken" TEXT NOT NULL, "userId" BIGINT, "firstName" TEXT, "lastName" TEXT,
  "email" TEXT, "accountOwner" BOOLEAN NOT NULL DEFAULT false, "locale" TEXT,
  "collaborator" BOOLEAN DEFAULT false, "emailVerified" BOOLEAN DEFAULT false,
  "refreshToken" TEXT, "refreshTokenExpires" TIMESTAMP(3),
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriptionSettings" (
  "shopDomain" TEXT NOT NULL, "enrollmentMode" TEXT NOT NULL DEFAULT 'none',
  "selectedProductIds" JSONB NOT NULL DEFAULT '[]', "excludedProductIds" JSONB NOT NULL DEFAULT '[]',
  "currentPricingPolicyId" TEXT, "defaultDurationMonths" INTEGER NOT NULL DEFAULT 24,
  "allowedIntervals" JSONB NOT NULL DEFAULT '["weekly","fortnightly","monthly","bimonthly","quarterly","half_yearly"]',
  "activationTtlHours" INTEGER NOT NULL DEFAULT 48, "freeShippingThresholdPaise" INTEGER NOT NULL DEFAULT 34900,
  "shippingFeePaise" INTEGER NOT NULL DEFAULT 4900, "widgetEnabled" BOOLEAN NOT NULL DEFAULT false,
  "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true, "successfulRenewalWhatsapp" BOOLEAN NOT NULL DEFAULT false,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT false, "emailFrom" TEXT,
  "retryDay3" INTEGER NOT NULL DEFAULT 3, "retryDay7" INTEGER NOT NULL DEFAULT 7,
  "autoCancelDays" INTEGER NOT NULL DEFAULT 14, "expiryReminderDays" INTEGER NOT NULL DEFAULT 30,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionSettings_pkey" PRIMARY KEY ("shopDomain")
);

CREATE TABLE "PricingPolicyVersion" (
  "id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "version" INTEGER NOT NULL,
  "baseDiscountBps" INTEGER NOT NULL DEFAULT 200, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PricingPolicyVersion_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "QuantityDiscountTier" (
  "id" TEXT NOT NULL, "pricingPolicyId" TEXT NOT NULL, "minimumQuantity" INTEGER NOT NULL,
  "additionalDiscountBps" INTEGER NOT NULL, CONSTRAINT "QuantityDiscountTier_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SubscriptionIntent" (
  "id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "signedCartReference" TEXT NOT NULL,
  "requestedLines" JSONB NOT NULL, "intervalCode" TEXT NOT NULL, "pricingPolicyId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'cart', "shopifyOrderId" TEXT, "customerSnapshot" JSONB,
  "subscriptionGroupId" TEXT, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionIntent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SubscriptionGroup" (
  "id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending_mandate',
  "shopifyCustomerId" TEXT, "customerName" TEXT NOT NULL, "customerEmail" TEXT NOT NULL,
  "customerPhone" TEXT NOT NULL, "addressJson" JSONB NOT NULL, "intervalCode" TEXT NOT NULL,
  "anchorDate" TIMESTAMP(3) NOT NULL, "nextChargeAt" TIMESTAMP(3), "endAt" TIMESTAMP(3) NOT NULL,
  "pricingPolicyId" TEXT NOT NULL, "razorpayCustomerId" TEXT, "razorpayTokenId" TEXT,
  "razorpayRegistrationOrderId" TEXT, "mandateMaxPaise" INTEGER,
  "cancelAtCycleEnd" BOOLEAN NOT NULL DEFAULT false, "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionGroup_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SubscriptionLine" (
  "id" TEXT NOT NULL, "subscriptionGroupId" TEXT NOT NULL, "shopifyProductId" TEXT NOT NULL,
  "shopifyVariantId" TEXT NOT NULL, "sku" TEXT, "productTitle" TEXT NOT NULL, "variantTitle" TEXT,
  "quantity" INTEGER NOT NULL, "signupUnitPricePaise" INTEGER NOT NULL, "lastChargedUnitPricePaise" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'active', "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionLine_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "BillingCycle" (
  "id" TEXT NOT NULL, "subscriptionGroupId" TEXT NOT NULL, "seq" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'preparing', "scheduledAt" TIMESTAMP(3) NOT NULL,
  "qualificationQuantity" INTEGER NOT NULL, "baseDiscountBps" INTEGER NOT NULL,
  "tierBonusBps" INTEGER NOT NULL, "chargeAmountPaise" INTEGER, "shippingPaise" INTEGER,
  "lineSnapshot" JSONB NOT NULL DEFAULT '[]', "razorpayOrderId" TEXT, "razorpayPaymentId" TEXT,
  "shopifyOrderId" TEXT, "failureCode" TEXT, "failureMessage" TEXT, "claimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingCycle_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PaymentAttempt" (
  "id" TEXT NOT NULL, "billingCycleId" TEXT NOT NULL, "externalPaymentId" TEXT,
  "externalOrderId" TEXT, "status" TEXT NOT NULL, "reason" TEXT,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL, "source" TEXT NOT NULL, "externalEventId" TEXT NOT NULL,
  "topic" TEXT NOT NULL, "payloadHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'received',
  "error" TEXT, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processedAt" TIMESTAMP(3),
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "EventLog" (
  "id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL, "eventType" TEXT NOT NULL, "maskedPayload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "NotificationLog" (
  "id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "channel" TEXT NOT NULL,
  "template" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "recipientMasked" TEXT NOT NULL,
  "status" TEXT NOT NULL, "providerReference" TEXT, "error" TEXT, "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CronRun" (
  "id" TEXT NOT NULL, "job" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'running',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  "processedCount" INTEGER NOT NULL DEFAULT 0, "errorCount" INTEGER NOT NULL DEFAULT 0,
  "errors" JSONB NOT NULL DEFAULT '[]', CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PricingPolicyVersion_shopDomain_createdAt_idx" ON "PricingPolicyVersion"("shopDomain", "createdAt");
CREATE UNIQUE INDEX "PricingPolicyVersion_shopDomain_version_key" ON "PricingPolicyVersion"("shopDomain", "version");
CREATE UNIQUE INDEX "QuantityDiscountTier_pricingPolicyId_minimumQuantity_key" ON "QuantityDiscountTier"("pricingPolicyId", "minimumQuantity");
CREATE UNIQUE INDEX "SubscriptionIntent_signedCartReference_key" ON "SubscriptionIntent"("signedCartReference");
CREATE UNIQUE INDEX "SubscriptionIntent_subscriptionGroupId_key" ON "SubscriptionIntent"("subscriptionGroupId");
CREATE INDEX "SubscriptionIntent_shopDomain_status_idx" ON "SubscriptionIntent"("shopDomain", "status");
CREATE INDEX "SubscriptionIntent_shopifyOrderId_idx" ON "SubscriptionIntent"("shopifyOrderId");
CREATE UNIQUE INDEX "SubscriptionGroup_razorpayTokenId_key" ON "SubscriptionGroup"("razorpayTokenId");
CREATE UNIQUE INDEX "SubscriptionGroup_razorpayRegistrationOrderId_key" ON "SubscriptionGroup"("razorpayRegistrationOrderId");
CREATE INDEX "SubscriptionGroup_shopDomain_status_idx" ON "SubscriptionGroup"("shopDomain", "status");
CREATE INDEX "SubscriptionGroup_shopifyCustomerId_idx" ON "SubscriptionGroup"("shopifyCustomerId");
CREATE INDEX "SubscriptionGroup_status_nextChargeAt_idx" ON "SubscriptionGroup"("status", "nextChargeAt");
CREATE INDEX "SubscriptionLine_subscriptionGroupId_status_idx" ON "SubscriptionLine"("subscriptionGroupId", "status");
CREATE INDEX "SubscriptionLine_shopifyVariantId_idx" ON "SubscriptionLine"("shopifyVariantId");
CREATE UNIQUE INDEX "BillingCycle_razorpayOrderId_key" ON "BillingCycle"("razorpayOrderId");
CREATE UNIQUE INDEX "BillingCycle_razorpayPaymentId_key" ON "BillingCycle"("razorpayPaymentId");
CREATE INDEX "BillingCycle_status_scheduledAt_idx" ON "BillingCycle"("status", "scheduledAt");
CREATE UNIQUE INDEX "BillingCycle_subscriptionGroupId_seq_key" ON "BillingCycle"("subscriptionGroupId", "seq");
CREATE UNIQUE INDEX "PaymentAttempt_externalOrderId_key" ON "PaymentAttempt"("externalOrderId");
CREATE INDEX "PaymentAttempt_billingCycleId_attemptedAt_idx" ON "PaymentAttempt"("billingCycleId", "attemptedAt");
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");
CREATE UNIQUE INDEX "WebhookEvent_source_externalEventId_key" ON "WebhookEvent"("source", "externalEventId");
CREATE INDEX "EventLog_shopDomain_createdAt_idx" ON "EventLog"("shopDomain", "createdAt");
CREATE INDEX "EventLog_entityType_entityId_idx" ON "EventLog"("entityType", "entityId");
CREATE UNIQUE INDEX "NotificationLog_idempotencyKey_key" ON "NotificationLog"("idempotencyKey");
CREATE INDEX "NotificationLog_shopDomain_createdAt_idx" ON "NotificationLog"("shopDomain", "createdAt");
CREATE INDEX "CronRun_job_startedAt_idx" ON "CronRun"("job", "startedAt");

ALTER TABLE "QuantityDiscountTier" ADD CONSTRAINT "QuantityDiscountTier_pricingPolicyId_fkey" FOREIGN KEY ("pricingPolicyId") REFERENCES "PricingPolicyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionIntent" ADD CONSTRAINT "SubscriptionIntent_pricingPolicyId_fkey" FOREIGN KEY ("pricingPolicyId") REFERENCES "PricingPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SubscriptionIntent" ADD CONSTRAINT "SubscriptionIntent_subscriptionGroupId_fkey" FOREIGN KEY ("subscriptionGroupId") REFERENCES "SubscriptionGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SubscriptionGroup" ADD CONSTRAINT "SubscriptionGroup_pricingPolicyId_fkey" FOREIGN KEY ("pricingPolicyId") REFERENCES "PricingPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SubscriptionLine" ADD CONSTRAINT "SubscriptionLine_subscriptionGroupId_fkey" FOREIGN KEY ("subscriptionGroupId") REFERENCES "SubscriptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingCycle" ADD CONSTRAINT "BillingCycle_subscriptionGroupId_fkey" FOREIGN KEY ("subscriptionGroupId") REFERENCES "SubscriptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_billingCycleId_fkey" FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
