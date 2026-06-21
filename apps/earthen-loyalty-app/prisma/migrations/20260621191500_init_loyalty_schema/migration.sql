-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('active', 'disabled', 'anonymized');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('migration_credit', 'order_earn', 'signup_bonus', 'redeem_reserve', 'redeem_consume', 'redeem_release', 'refund_reversal', 'order_cancel_reversal', 'expiry', 'manual_adjustment');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('pending', 'applied', 'consumed', 'partially_consumed', 'released', 'expired', 'failed', 'manual_review');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('received', 'processed', 'failed', 'ignored');

-- CreateEnum
CREATE TYPE "DiscountCleanupStatus" AS ENUM ('pending', 'complete', 'failed');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyCustomer" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "availablePoints" INTEGER NOT NULL DEFAULT 0,
    "pendingPoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarnedPoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRedeemedPoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeExpiredPoints" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "pointsDelta" INTEGER NOT NULL,
    "moneyValue" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "shopifyOrderId" TEXT,
    "shopifyRefundId" TEXT,
    "redemptionSessionId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointLot" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceLedgerEntryId" TEXT NOT NULL,
    "originalPoints" INTEGER NOT NULL,
    "remainingPoints" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedemptionSession" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "cartToken" TEXT,
    "checkoutToken" TEXT,
    "shopifyOrderId" TEXT,
    "pointsReserved" INTEGER NOT NULL,
    "pointsConsumed" INTEGER NOT NULL DEFAULT 0,
    "pointsReleased" INTEGER NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(12,2) NOT NULL,
    "actualDiscountAmount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "discountCode" TEXT NOT NULL,
    "shopifyDiscountNodeId" TEXT,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RedemptionSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardRule" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "earnRatePercent" DECIMAL(5,2) NOT NULL,
    "pointsPerCurrencyUnit" DECIMAL(10,4) NOT NULL,
    "currencyValuePerPoint" DECIMAL(10,4) NOT NULL,
    "signupRewardPoints" INTEGER NOT NULL DEFAULT 250,
    "minRedeemPoints" INTEGER NOT NULL DEFAULT 10,
    "redeemIncrementPoints" INTEGER NOT NULL DEFAULT 10,
    "maxRedeemPointsPerOrder" INTEGER,
    "maxRedeemPercentOfCart" DECIMAL(5,2) NOT NULL,
    "allowDiscountStacking" BOOLEAN NOT NULL DEFAULT false,
    "awardOnStatus" TEXT NOT NULL DEFAULT 'fulfilled',
    "pointsExpiryDays" INTEGER,
    "returnRedeemedPointsOnRefund" BOOLEAN NOT NULL DEFAULT true,
    "reverseEarnedPointsOnRefund" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BonMigrationBatch" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "sourceFileName" TEXT,
    "rawExportUri" TEXT,
    "sourceRowCount" INTEGER NOT NULL,
    "validRowCount" INTEGER NOT NULL,
    "invalidRowCount" INTEGER NOT NULL,
    "totalSourcePoints" INTEGER NOT NULL,
    "totalImportedPoints" INTEGER NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'received',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMP(3),

    CONSTRAINT "BonMigrationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BonMigrationRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "shopifyCustomerId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "points" INTEGER,
    "matchedCustomerId" TEXT,
    "ledgerEntryId" TEXT,
    "error" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BonMigrationRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopifyWebhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "resourceId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'received',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminUser" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "customerId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountCleanupJob" (
    "id" TEXT NOT NULL,
    "redemptionSessionId" TEXT NOT NULL,
    "shopifyDiscountNodeId" TEXT,
    "discountCode" TEXT NOT NULL,
    "status" "DiscountCleanupStatus" NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountCleanupJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoyaltyCustomer_shopDomain_email_idx" ON "LoyaltyCustomer"("shopDomain", "email");

-- CreateIndex
CREATE INDEX "LoyaltyCustomer_shopDomain_phone_idx" ON "LoyaltyCustomer"("shopDomain", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyCustomer_shopDomain_shopifyCustomerId_key" ON "LoyaltyCustomer"("shopDomain", "shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_customerId_key" ON "Wallet"("customerId");

-- CreateIndex
CREATE INDEX "LedgerEntry_customerId_createdAt_idx" ON "LedgerEntry"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_shopifyOrderId_idx" ON "LedgerEntry"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "LedgerEntry_redemptionSessionId_idx" ON "LedgerEntry"("redemptionSessionId");

-- CreateIndex
CREATE INDEX "PointLot_customerId_expiresAt_idx" ON "PointLot"("customerId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RedemptionSession_discountCode_key" ON "RedemptionSession"("discountCode");

-- CreateIndex
CREATE INDEX "RedemptionSession_customerId_status_idx" ON "RedemptionSession"("customerId", "status");

-- CreateIndex
CREATE INDEX "RedemptionSession_cartToken_idx" ON "RedemptionSession"("cartToken");

-- CreateIndex
CREATE INDEX "RedemptionSession_shopifyOrderId_idx" ON "RedemptionSession"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardRule_shopDomain_key" ON "RewardRule"("shopDomain");

-- CreateIndex
CREATE INDEX "BonMigrationRow_batchId_rowIndex_idx" ON "BonMigrationRow"("batchId", "rowIndex");

-- CreateIndex
CREATE INDEX "BonMigrationRow_email_idx" ON "BonMigrationRow"("email");

-- CreateIndex
CREATE INDEX "BonMigrationRow_phone_idx" ON "BonMigrationRow"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_shopifyWebhookId_key" ON "WebhookEvent"("shopifyWebhookId");

-- CreateIndex
CREATE INDEX "WebhookEvent_topic_resourceId_idx" ON "WebhookEvent"("topic", "resourceId");

-- CreateIndex
CREATE INDEX "DiscountCleanupJob_status_nextAttemptAt_idx" ON "DiscountCleanupJob"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_redemptionSessionId_fkey" FOREIGN KEY ("redemptionSessionId") REFERENCES "RedemptionSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointLot" ADD CONSTRAINT "PointLot_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedemptionSession" ADD CONSTRAINT "RedemptionSession_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BonMigrationRow" ADD CONSTRAINT "BonMigrationRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BonMigrationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "LoyaltyCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountCleanupJob" ADD CONSTRAINT "DiscountCleanupJob_redemptionSessionId_fkey" FOREIGN KEY ("redemptionSessionId") REFERENCES "RedemptionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

