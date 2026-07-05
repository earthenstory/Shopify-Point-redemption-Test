-- Earn points at DELIVERY (carrier "delivered" event) instead of at
-- fulfillment/shipping: rejected-at-doorstep / RTO shipments never earn.
-- Merchant-editable from the Earning & redemption rules admin page.
UPDATE "RewardRule"
SET "awardOnStatus" = 'delivered'
WHERE "shopDomain" = '701031-e7.myshopify.com'
  AND "awardOnStatus" = 'fulfilled';
