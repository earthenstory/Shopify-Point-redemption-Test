import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default function extension() { render(<Activation />, document.body); }

function Activation() {
  const hasIntent = (shopify.lines?.value || []).some((line) =>
    (line.attributes || []).some((attribute) => attribute.key === '_earthen_subscription_intent'));
  const orderId = shopify.orderConfirmation.value?.order?.id;
  if (!hasIntent || !orderId) return null;
  const numericOrderId = orderId.split('/').pop();
  const url = `https://${shopify.shop.myshopifyDomain}/apps/subscriptions/activate?order_id=${encodeURIComponent(numericOrderId)}`;
  return (
    <s-banner tone="info" heading="Finish activating your subscription">
      <s-stack direction="block" gap="base">
        <s-text>Your first order is complete at the normal price. Authorize UPI AutoPay to begin future discounted deliveries.</s-text>
        <s-link href={url}>Activate UPI AutoPay</s-link>
      </s-stack>
    </s-banner>
  );
}
