-- Production-grade loyalty admin console settings.
CREATE TYPE "LoyaltyProgramStatus" AS ENUM ('test', 'active', 'paused');
CREATE TYPE "MilestoneType" AS ENUM ('signup', 'first_order', 'order_count', 'spend_amount', 'birthday');

ALTER TABLE "RewardRule"
  ADD COLUMN "earningEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "redemptionEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pointsPerSpendAmount" DECIMAL(10,2) NOT NULL DEFAULT 2,
  ADD COLUMN "spendAmountForEarnPoints" DECIMAL(10,2) NOT NULL DEFAULT 100,
  ADD COLUMN "discountCodeTtlMinutes" INTEGER NOT NULL DEFAULT 60;

CREATE TABLE "LoyaltyProgramSettings" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "status" "LoyaltyProgramStatus" NOT NULL DEFAULT 'test',
  "programName" TEXT NOT NULL DEFAULT 'Earthen Loyalty',
  "pointName" TEXT NOT NULL DEFAULT 'Earthen Points',
  "testModeCustomerTag" TEXT,
  "launchChecklist" JSONB,
  "bonWidgetDisabled" BOOLEAN NOT NULL DEFAULT false,
  "standardCheckoutTested" BOOLEAN NOT NULL DEFAULT false,
  "expressCheckoutTested" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoyaltyProgramSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoyaltyWidgetSettings" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "homepageEnabled" BOOLEAN NOT NULL DEFAULT true,
  "productEnabled" BOOLEAN NOT NULL DEFAULT true,
  "cartEnabled" BOOLEAN NOT NULL DEFAULT true,
  "accountEnabled" BOOLEAN NOT NULL DEFAULT true,
  "loggedOutMessage" TEXT NOT NULL DEFAULT 'Sign in to see your Earthen Points and unlock cart rewards.',
  "zeroPointsMessage" TEXT NOT NULL DEFAULT 'You do not have Earthen Points yet. Create an account or place an order to start earning.',
  "primaryColor" TEXT NOT NULL DEFAULT '#1c6b3a',
  "accentColor" TEXT NOT NULL DEFAULT '#b8841e',
  "backgroundColor" TEXT NOT NULL DEFAULT '#fffaf0',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoyaltyWidgetSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoyaltyMilestoneRule" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "type" "MilestoneType" NOT NULL,
  "title" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "points" INTEGER NOT NULL,
  "thresholdAmount" DECIMAL(12,2),
  "thresholdOrderCount" INTEGER,
  "repeatable" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoyaltyMilestoneRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoyaltyProgramSettings_shopDomain_key" ON "LoyaltyProgramSettings"("shopDomain");
CREATE UNIQUE INDEX "LoyaltyWidgetSettings_shopDomain_key" ON "LoyaltyWidgetSettings"("shopDomain");
CREATE INDEX "LoyaltyMilestoneRule_shopDomain_type_idx" ON "LoyaltyMilestoneRule"("shopDomain", "type");
