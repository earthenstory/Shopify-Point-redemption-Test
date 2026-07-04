-- Enable the referral program with sensible defaults (200 pts for the
-- referrer, 100 pts for the friend, no order minimum). Merchant-editable from
-- the Referrals admin page; guarded so re-runs are no-ops.
INSERT INTO "ReferralProgramSettings" ("id", "shopDomain", "enabled", "referrerPoints", "refereePoints", "minOrderSubtotal", "createdAt", "updatedAt")
SELECT 'seed-referral-settings', '701031-e7.myshopify.com', true, 200, 100, NULL, NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "ReferralProgramSettings" WHERE "shopDomain" = '701031-e7.myshopify.com'
);
