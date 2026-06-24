-- Re-theme the loyalty widgets to match the Earthen Story brand (navy + gold).
-- Only update rows still on the previous green/amber defaults so any colors a
-- merchant set explicitly in the loyalty admin are left untouched.
UPDATE "LoyaltyWidgetSettings"
SET "primaryColor" = '#112557'
WHERE "primaryColor" = '#1c6b3a';

UPDATE "LoyaltyWidgetSettings"
SET "accentColor" = '#cca268'
WHERE "accentColor" = '#b8841e';
