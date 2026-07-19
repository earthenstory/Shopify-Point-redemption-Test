import '@shopify/ui-extensions/preact';
/* eslint-disable react/prop-types -- Shopify UI-extension payloads are runtime-owned. */
import {render} from 'preact';
import {useCallback, useEffect, useState} from 'preact/hooks';

const APP_URL = 'https://earthen-subscriptions-app-768696379805.asia-south1.run.app';

export default function extension() { render(<SubscriptionsPage />, document.body); }

function SubscriptionsPage() {
  const [state, setState] = useState({status:'loading', groups:[], portal:{}, cancellation:{reasons:[]}, error:''});
  const request = useCallback(async (payload) => {
    try {
      setState(current => ({...current, status:'loading'}));
      const token = await shopify.sessionToken.get();
      const response = await fetch(`${APP_URL}/customer-account/subscriptions`, {
        method: payload ? 'POST' : 'GET',
        headers: {Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Request failed');
      setState(current => ({status:'ready', groups:data.groups || [], portal:data.portal || current.portal, cancellation:data.cancellation || current.cancellation, error:''}));
    } catch (error) { setState(current => ({...current, status:'error', error:error.message || 'Request failed'})); }
  }, []);
  useEffect(() => { request(); }, [request]);
  if (state.status === 'loading') return <s-page heading="Subscriptions"><s-spinner accessibilityLabel="Loading subscriptions" /></s-page>;
  if (state.status === 'error') return <s-page heading="Subscriptions"><s-banner tone="critical">{state.error}</s-banner></s-page>;
  return (
    <s-page heading="Your subscriptions">
      <s-stack direction="block" gap="base">
        {!state.groups.length
          ? <s-banner tone="info">You do not have an active or previous subscription.</s-banner>
          : state.groups.map(group => <GroupCard key={group.id} group={group} portal={state.portal} cancellation={state.cancellation} request={request} />)}
      </s-stack>
    </s-page>
  );
}

function GroupCard({group, portal, cancellation, request}) {
  const initial = group.addressJson || {};
  const [editingAddress, setEditingAddress] = useState(false);
  const [cancellationReason, setCancellationReason] = useState(cancellation.reasons?.[0]?.code || 'other');
  const [address, setAddress] = useState({
    firstName: initial.firstName || '', lastName: initial.lastName || '', phone: initial.phone || '',
    address1: initial.address1 || '', address2: initial.address2 || '', city: initial.city || '',
    province: initial.province || '', provinceCode: initial.provinceCode || '', country: initial.country || 'India',
    countryCode: 'IN', zip: initial.zip || '', company: initial.company || '',
  });
  const field = key => event => setAddress(current => ({...current, [key]: event.currentTarget.value}));
  async function saveAddress() {
    await request({groupId:group.id, action:'update_address', address});
    setEditingAddress(false);
  }
  return (
    <s-section heading={`${group.intervalCode.replace('_',' ')} delivery — ${group.status}`}>
      <s-stack direction="block" gap="base">
        {(group.lines || []).map(line => <s-text key={line.id}>{line.quantity} × {line.productTitle}{line.variantTitle ? ` — ${line.variantTitle}` : ''}</s-text>)}
        <s-text>Next delivery: {group.nextChargeAt ? new Date(group.nextChargeAt).toLocaleDateString('en-IN') : 'Not scheduled'}</s-text>
        <s-stack direction="inline" gap="base">
          {portal.allowSkip && group.status === 'active' && <s-button onClick={() => request({groupId:group.id, action:'skip'})}>Skip next</s-button>}
          {portal.allowPause && group.status === 'active' && <s-button onClick={() => request({groupId:group.id, action:'pause'})}>Pause</s-button>}
          {portal.allowResume && group.status === 'paused' && <s-button onClick={() => request({groupId:group.id, action:'resume'})}>Resume</s-button>}
        </s-stack>
        {portal.allowCancel && !['cancelled','expired'].includes(group.status) && <s-stack direction="block" gap="small"><s-select label="Reason for cancellation" value={cancellationReason} onChange={event => setCancellationReason(event.currentTarget.value)}>{(cancellation.reasons || []).map(reason => <s-option key={reason.code} value={reason.code}>{reason.label}</s-option>)}</s-select><s-button tone="critical" onClick={() => request({groupId:group.id, action:'cancel', reasonCode:cancellationReason})}>Cancel at cycle end</s-button></s-stack>}
        {portal.allowRemoveLine && (group.lines || []).length > 1 && group.lines.map(line => (
          <s-button key={line.id} variant="tertiary" onClick={() => request({groupId:group.id, action:'remove_line', lineId:line.id})}>Remove {line.productTitle}</s-button>
        ))}
        {portal.allowAddressChange && <s-button variant="tertiary" onClick={() => setEditingAddress(value => !value)}>
          {editingAddress ? 'Close address editor' : 'Update delivery address'}
        </s-button>}
        {portal.allowAddressChange && editingAddress && (
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field label="First name" value={address.firstName} onInput={field('firstName')} />
              <s-text-field label="Last name" value={address.lastName} onInput={field('lastName')} />
            </s-grid>
            <s-text-field label="Address" value={address.address1} onInput={field('address1')} />
            <s-text-field label="Apartment, suite, etc." value={address.address2} onInput={field('address2')} />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field label="City" value={address.city} onInput={field('city')} />
              <s-text-field label="State" value={address.province} onInput={field('province')} />
              <s-text-field label="PIN code" value={address.zip} onInput={field('zip')} />
              <s-text-field label="Phone" value={address.phone} onInput={field('phone')} />
            </s-grid>
            <s-button variant="primary" onClick={saveAddress}>Save delivery address</s-button>
          </s-stack>
        )}
        <s-text color="subdued">To change quantity, variant, frequency, or add products, cancel and start a replacement subscription.</s-text>
      </s-stack>
    </s-section>
  );
}
