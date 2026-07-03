import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

const APP_URL = 'https://earthen-loyalty-app-x5vmupepiq-el.a.run.app';

const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const dateFormatter = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const money = (value) => currencyFormatter.format(Number(value || 0));
const formatDate = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
};

export default async () => {
  render(<RewardsPage />, document.body);
};

function RewardsPage() {
  const [status, setStatus] = useState('loading');
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(`${APP_URL}/customer-account/summary`, {
          headers: {Authorization: `Bearer ${token}`},
        });
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        const json = await response.json();
        setData(json);
        setStatus(json?.ok ? 'ready' : 'error');
      } catch (error) {
        setStatus('error');
      }
    })();
  }, []);

  if (status === 'loading') {
    return (
      <s-page heading="Earthen Points">
        <s-stack alignItems="center" padding="large-100">
          <s-spinner accessibilityLabel="Loading your points" />
        </s-stack>
      </s-page>
    );
  }

  if (status === 'error') {
    return (
      <s-page heading="Earthen Points">
        <s-banner tone="critical" heading="Couldn’t load your points">
          <s-text>Please try again in a moment.</s-text>
        </s-banner>
      </s-page>
    );
  }

  const transactions = data.transactions || [];

  return (
    <s-page heading="Earthen Points">
      <s-section heading="Your balance">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading>
            {data.availablePoints} {data.pointName || 'points'}
          </s-heading>
          <s-badge tone="neutral">{money(data.availableValue)} to spend</s-badge>
        </s-stack>
        <s-text color="subdued">
          Redeem your points in the cart for instant savings. 1 point = {money(data.currencyValuePerPoint)}.
        </s-text>
      </s-section>

      <s-section heading="Points history">
        {transactions.length === 0 ? (
          <s-text color="subdued">No points activity yet. Earn points on your next order.</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {transactions.map((txn) => {
              const positive = Number(txn.points) > 0;
              const order = txn.orderName ? ` · ${txn.orderName}` : '';
              return (
                <s-stack
                  key={txn.id}
                  direction="inline"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="none">
                    <s-text>
                      {txn.label}
                      {order}
                    </s-text>
                    <s-text color="subdued" type="small">
                      {formatDate(txn.date)}
                    </s-text>
                  </s-stack>
                  <s-stack direction="block" gap="none" alignItems="end">
                    <s-text tone={positive ? 'success' : 'warning'}>
                      {positive ? '+' : ''}
                      {txn.points} pts
                    </s-text>
                    {txn.moneyValue ? (
                      <s-text color="subdued" type="small">
                        {money(txn.moneyValue)}
                      </s-text>
                    ) : null}
                  </s-stack>
                </s-stack>
              );
            })}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
