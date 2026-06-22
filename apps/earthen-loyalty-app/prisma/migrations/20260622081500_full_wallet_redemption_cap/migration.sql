-- Allow full wallet redemption, limited by cart subtotal, minimums, increments, and any per-order cap.
UPDATE "RewardRule"
SET "maxRedeemPercentOfCart" = 100
WHERE "maxRedeemPercentOfCart" < 100;
