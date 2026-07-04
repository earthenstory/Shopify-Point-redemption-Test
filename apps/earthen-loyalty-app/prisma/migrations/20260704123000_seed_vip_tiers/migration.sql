-- Default VIP ladder (merchant-editable from the VIP Tiers admin page).
-- Bronze is the baseline tier so every member sees a tier name.
INSERT INTO "VipTier" ("id", "shopDomain", "name", "thresholdPoints", "earnMultiplier", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT 'seed-tier-bronze', '701031-e7.myshopify.com', 'Bronze', 0, 1.00, true, 1, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "VipTier" WHERE "id" = 'seed-tier-bronze');

INSERT INTO "VipTier" ("id", "shopDomain", "name", "thresholdPoints", "earnMultiplier", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT 'seed-tier-silver', '701031-e7.myshopify.com', 'Silver', 2000, 1.25, true, 2, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "VipTier" WHERE "id" = 'seed-tier-silver');

INSERT INTO "VipTier" ("id", "shopDomain", "name", "thresholdPoints", "earnMultiplier", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT 'seed-tier-gold', '701031-e7.myshopify.com', 'Gold', 10000, 1.50, true, 3, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "VipTier" WHERE "id" = 'seed-tier-gold');
