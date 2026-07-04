-- Default reward catalog + a starter earn action for the Earthen Story shop so
-- the launcher has content on day one. All rows are merchant-editable from the
-- "Rewards & Earning" admin page; inserts are guarded so re-runs are no-ops.

INSERT INTO "RewardDefinition" ("id", "shopDomain", "title", "type", "pointsCost", "value", "minSubtotal", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT 'seed-reward-100-off', '701031-e7.myshopify.com', E'₹100 off your order', 'fixed_amount', 100, 100, NULL, true, 1, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "RewardDefinition" WHERE "id" = 'seed-reward-100-off');

INSERT INTO "RewardDefinition" ("id", "shopDomain", "title", "type", "pointsCost", "value", "minSubtotal", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT 'seed-reward-10-pct', '701031-e7.myshopify.com', '10% off your order', 'percent_off', 250, 10, 1500, true, 2, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "RewardDefinition" WHERE "id" = 'seed-reward-10-pct');

INSERT INTO "RewardDefinition" ("id", "shopDomain", "title", "type", "pointsCost", "value", "minSubtotal", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT 'seed-reward-free-ship', '701031-e7.myshopify.com', 'Free shipping', 'free_shipping', 50, NULL, NULL, true, 3, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "RewardDefinition" WHERE "id" = 'seed-reward-free-ship');

INSERT INTO "EarnAction" ("id", "shopDomain", "title", "url", "points", "enabled", "oncePerCustomer", "sortOrder", "createdAt", "updatedAt")
SELECT 'seed-action-instagram', '701031-e7.myshopify.com', 'Follow us on Instagram', 'https://www.instagram.com/earthenstory.official', 25, true, true, 1, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "EarnAction" WHERE "id" = 'seed-action-instagram');
