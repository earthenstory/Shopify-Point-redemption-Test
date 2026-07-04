-- BON-parity program surfaces: reward catalog, ways-to-earn actions, referral
-- program, VIP tiers, and limited-time point campaigns.

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('fixed_amount', 'percent_off', 'free_shipping');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('pending', 'rewarded', 'blocked');

-- AlterTable
ALTER TABLE "RedemptionSession"
  ADD COLUMN "rewardType" "RewardType",
  ADD COLUMN "rewardTitle" TEXT;

-- CreateTable
CREATE TABLE "RewardDefinition" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "RewardType" NOT NULL,
    "pointsCost" INTEGER NOT NULL,
    "value" DECIMAL(12,2),
    "minSubtotal" DECIMAL(12,2),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarnAction" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "points" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "oncePerCustomer" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarnAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarnActionClaim" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarnActionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralProgramSettings" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "referrerPoints" INTEGER NOT NULL DEFAULT 200,
    "refereePoints" INTEGER NOT NULL DEFAULT 100,
    "minOrderSubtotal" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralProgramSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralAttribution" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "referrerCustomerId" TEXT NOT NULL,
    "refereeCustomerId" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'pending',
    "shopifyOrderId" TEXT,
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewardedAt" TIMESTAMP(3),

    CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VipTier" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "thresholdPoints" INTEGER NOT NULL,
    "earnMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VipTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointsCampaign" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "multiplier" DECIMAL(5,2) NOT NULL DEFAULT 2,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointsCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RewardDefinition_shopDomain_enabled_idx" ON "RewardDefinition"("shopDomain", "enabled");

-- CreateIndex
CREATE INDEX "EarnAction_shopDomain_enabled_idx" ON "EarnAction"("shopDomain", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "EarnActionClaim_actionId_customerId_key" ON "EarnActionClaim"("actionId", "customerId");

-- CreateIndex
CREATE INDEX "EarnActionClaim_customerId_idx" ON "EarnActionClaim"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralProgramSettings_shopDomain_key" ON "ReferralProgramSettings"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_customerId_key" ON "ReferralCode"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralAttribution_refereeCustomerId_key" ON "ReferralAttribution"("refereeCustomerId");

-- CreateIndex
CREATE INDEX "ReferralAttribution_referrerCustomerId_idx" ON "ReferralAttribution"("referrerCustomerId");

-- CreateIndex
CREATE INDEX "ReferralAttribution_shopDomain_status_idx" ON "ReferralAttribution"("shopDomain", "status");

-- CreateIndex
CREATE INDEX "VipTier_shopDomain_enabled_thresholdPoints_idx" ON "VipTier"("shopDomain", "enabled", "thresholdPoints");

-- CreateIndex
CREATE INDEX "PointsCampaign_shopDomain_enabled_startsAt_endsAt_idx" ON "PointsCampaign"("shopDomain", "enabled", "startsAt", "endsAt");

-- AddForeignKey
ALTER TABLE "EarnActionClaim" ADD CONSTRAINT "EarnActionClaim_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "EarnAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
