-- Estimated delivery date (EDD) via Shiprocket serviceability.
-- DeliverySettings: one row per shop, fully merchant-editable from the admin.
-- ShiprocketToken: cached external-API bearer token (valid ~10 days).
-- DeliveryEstimateCache: transit DAYS per destination pincode (not the date —
-- the date is computed fresh from dispatch day + transit days on every read).

CREATE TABLE "DeliverySettings" (
    "shopDomain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "pickupPincode" TEXT NOT NULL DEFAULT '560048',
    "cutoffHour" INTEGER NOT NULL DEFAULT 11,
    "workingDays" TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
    "holidays" JSONB NOT NULL DEFAULT '[]',
    "defaultWeightKg" DECIMAL(6,2) NOT NULL DEFAULT 0.5,
    "courierStrategy" TEXT NOT NULL DEFAULT 'recommended',
    "surfaceOnly" BOOLEAN NOT NULL DEFAULT true,
    "fallbackToAny" BOOLEAN NOT NULL DEFAULT true,
    "showRange" BOOLEAN NOT NULL DEFAULT false,
    "widgetTitle" TEXT NOT NULL DEFAULT 'Check delivery date',
    "cacheTtlMinutes" INTEGER NOT NULL DEFAULT 720,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliverySettings_pkey" PRIMARY KEY ("shopDomain")
);

CREATE TABLE "ShiprocketToken" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "token" TEXT,
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiprocketToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeliveryEstimateCache" (
    "id" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "weightBucket" INTEGER NOT NULL,
    "cod" BOOLEAN NOT NULL DEFAULT false,
    "serviceable" BOOLEAN NOT NULL,
    "courierName" TEXT,
    "transitDays" INTEGER,
    "isSurface" BOOLEAN,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryEstimateCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryEstimateCache_pincode_weightBucket_cod_key"
    ON "DeliveryEstimateCache"("pincode", "weightBucket", "cod");
CREATE INDEX "DeliveryEstimateCache_expiresAt_idx"
    ON "DeliveryEstimateCache"("expiresAt");

-- Seed the store's settings row (disabled until QA passes; the admin page
-- flips it on). Warehouse = 560048, cutoff 11:00 IST, working days Mon-Sat.
INSERT INTO "DeliverySettings" ("shopDomain", "updatedAt")
VALUES ('701031-e7.myshopify.com', CURRENT_TIMESTAMP)
ON CONFLICT ("shopDomain") DO NOTHING;
