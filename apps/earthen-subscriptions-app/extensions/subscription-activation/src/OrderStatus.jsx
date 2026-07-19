import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default function extension() { render(<Activation />, document.body); }

function Activation() {
  const hasIntent = (shopify.lines?.value || []).some((line) =>
    (line.attributes || []).some((attribute) => attribute.key === '_earthen_subscription_intent'));
  const orderId = shopify.order.value?.id;
  if (!hasIntent || !orderId) return null;
  const numericOrderId = orderId.split('/').pop();
  const url = `https://${shopify.shop.myshopifyDomain}/apps/subscriptions/activate?order_id=${encodeURIComponent(numericOrderId)}`;
  return (
    <s-banner tone="info" heading="Subscription activation">
      <s-stack direction="block" gap="base">
        <s-text>If you have not completed UPI AutoPay authorization, activate it before the link expires.</s-text>
        <s-link href={url}>Activate or check subscription</s-link>
      </s-stack>
    </s-banner>
  );
}
