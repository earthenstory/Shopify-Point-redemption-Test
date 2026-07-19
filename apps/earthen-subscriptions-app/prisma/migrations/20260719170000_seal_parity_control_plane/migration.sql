ALTER TABLE "SubscriptionSettings"
  ADD COLUMN "schedulerEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "onboardingState" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "widgetConfig" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "portalConfig" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "cancellationConfig" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "notificationConfig" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "installationConfig" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "integrationConfig" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "advancedConfig" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "AutomationRule" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "config" JSONB NOT NULL DEFAULT '{}',
  "lastRunAt" TIMESTAMP(3),
  "lastRunStatus" TEXT,
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BulkOperation" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "requestedBy" TEXT,
  "selection" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB NOT NULL DEFAULT '{}',
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BulkOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriptionImport" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "fileName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "mapping" JSONB NOT NULL DEFAULT '{}',
  "summary" JSONB NOT NULL DEFAULT '{}',
  "rowCount" INTEGER NOT NULL DEFAULT 0,
  "importedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionImport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CancellationResponse" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "customerId" TEXT,
  "reasonCode" TEXT NOT NULL,
  "reasonText" TEXT,
  "treatmentCode" TEXT,
  "treatmentResult" TEXT,
  "cancelled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CancellationResponse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MerchantWebhook" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "topics" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'active',
  "signingKeyHash" TEXT,
  "lastDeliveryAt" TIMESTAMP(3),
  "lastStatus" INTEGER,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchantWebhook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MerchantApiCredential" (
  "shopDomain" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "tokenHash" TEXT,
  "secretHash" TEXT,
  "tokenLast4" TEXT,
  "rotatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchantApiCredential_pkey" PRIMARY KEY ("shopDomain")
);

CREATE INDEX "AutomationRule_shopDomain_kind_status_idx" ON "AutomationRule"("shopDomain", "kind", "status");
CREATE INDEX "BulkOperation_shopDomain_kind_createdAt_idx" ON "BulkOperation"("shopDomain", "kind", "createdAt");
CREATE INDEX "BulkOperation_status_createdAt_idx" ON "BulkOperation"("status", "createdAt");
CREATE INDEX "SubscriptionImport_shopDomain_createdAt_idx" ON "SubscriptionImport"("shopDomain", "createdAt");
CREATE INDEX "CancellationResponse_shopDomain_createdAt_idx" ON "CancellationResponse"("shopDomain", "createdAt");
CREATE INDEX "CancellationResponse_reasonCode_createdAt_idx" ON "CancellationResponse"("reasonCode", "createdAt");
CREATE INDEX "MerchantWebhook_shopDomain_status_idx" ON "MerchantWebhook"("shopDomain", "status");
