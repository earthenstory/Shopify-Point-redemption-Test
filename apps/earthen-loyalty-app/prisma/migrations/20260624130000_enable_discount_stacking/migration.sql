-- Allow the Earthen Points discount to combine with other discount codes so
-- customers can stack a coupon on top. New loyalty discount codes are created
-- with combinesWith order/product/shipping = true when this is enabled.
UPDATE "RewardRule"
SET "allowDiscountStacking" = true
WHERE "allowDiscountStacking" = false;
