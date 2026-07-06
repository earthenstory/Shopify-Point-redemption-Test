import { ThemeEvents } from '@theme/events';
import { morphSection } from '@theme/section-renderer';
import { fetchConfig } from '@theme/utilities';

const STORAGE_KEY = 'earthen_loyalty_redemption';
const CUSTOMER_CACHE_TTL_MS = 30000;
const CURRENCY_FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const HISTORY_DATE_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

let customerCache = null;
let customerRequest = null;
let historyCache = null;
let historyRequest = null;
// Cart context only. Remembers whether the cart widget was last shown so that a
// cart-section morph — which re-applies the server `hidden` skeleton — can
// re-reveal it instantly (in a MutationObserver microtask, before paint) instead
// of blinking out for a debounce + `/customer` round-trip.
let cartWidgetShouldShow = false;

class EarthenLoyaltyWidget extends HTMLElement {
  connectedCallback() {
    this.cacheRefs();

    // Delegated listeners live on the host element, which survives cart-section
    // morphs that replace the inner DOM (direct node listeners would be lost).
    this.addEventListener('input', this.handleInput);
    this.addEventListener('click', this.handleClick);

    if (this.dataset.context === 'cart') {
      document.addEventListener(ThemeEvents.cartUpdate, this.handleCartRefresh);
      document.addEventListener(ThemeEvents.discountUpdate, this.handleCartRefresh);

      // Self-heal: a cart re-render (e.g. after adding another product) strips our
      // JS-applied `data-applied` marker back to the server skeleton. If the cart
      // still carries the loyalty discount, re-render the applied state so the
      // Remove control never silently disappears. Loop-safe: it only fires while
      // the applied marker is missing but a discount is present.
      this.appliedObserver = new MutationObserver(() => {
        // A cart re-render re-applies the server `hidden` skeleton on this same
        // element. Re-reveal it synchronously (before paint) so it never blinks
        // out, then let the debounced load() refresh the content underneath.
        this.syncVisibility();
        if (!this.dataset.applied && this.getServerAppliedRedemption()) this.scheduleLoad();
      });
      this.appliedObserver.observe(this, {
        attributes: true,
        attributeFilter: ['hidden', 'data-applied', 'data-applied-code', 'data-applied-amount', 'data-cart-subtotal'],
      });
    }

    // When the widget sits inside a <dialog> (the cart drawer), it hides itself
    // with `display:none`, so nothing layout-based can detect the drawer opening.
    // Watch the dialog's `open` attribute and reload when it opens, otherwise the
    // widget stays stuck in its reset/hidden state after the drawer re-renders.
    this.observeDrawer();

    this.load();
  }

  disconnectedCallback() {
    this.removeEventListener('input', this.handleInput);
    this.removeEventListener('click', this.handleClick);
    document.removeEventListener(ThemeEvents.cartUpdate, this.handleCartRefresh);
    document.removeEventListener(ThemeEvents.discountUpdate, this.handleCartRefresh);
    this.drawerObserver?.disconnect();
    this.appliedObserver?.disconnect();
    this.popoverEl?.removeEventListener('toggle', this.handlePopoverToggle);
    this.loadAbort?.abort();
    clearTimeout(this.reloadTimer);
  }

  cacheRefs() {
    this.refs = {
      value: this.querySelector('[data-loyalty-value]'),
      message: this.querySelector('[data-loyalty-message]'),
      redeem: this.querySelector('[data-loyalty-redeem]'),
      applied: this.querySelector('[data-loyalty-applied]'),
      appliedText: this.querySelector('[data-loyalty-applied-text]'),
      rangeRow: this.querySelector('[data-loyalty-range-row]'),
      range: this.querySelector('[data-loyalty-range]'),
      selected: this.querySelector('[data-loyalty-selected]'),
      apply: this.querySelector('[data-loyalty-apply]'),
      remove: this.querySelector('[data-loyalty-remove]'),
      history: this.querySelector('[data-loyalty-history]'),
    };
  }

  handleInput = (event) => {
    if (event.target.closest('[data-loyalty-range]')) this.updateSelected();
  };

  handleClick = (event) => {
    if (event.target.closest('[data-loyalty-apply]')) this.applyPoints();
    else if (event.target.closest('[data-loyalty-remove]')) this.removePoints();
  };

  observeDrawer() {
    const dialog = this.closest('dialog');
    if (dialog) {
      this.drawerObserver = new MutationObserver(() => {
        if (dialog.hasAttribute('open')) this.scheduleLoad();
      });
      this.drawerObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
    }

    // The header account menu is a native popover (popover="auto"), not a <dialog>.
    // Its content sits in the DOM but is only shown on open, and the initial
    // connectedCallback load() races with the closed popover, so the balance never
    // renders. (Re)load whenever it opens — this is what makes the points show up in
    // the account/profile popover.
    const popover = this.closest('[popover]');
    if (popover) {
      this.popoverEl = popover;
      this.handlePopoverToggle = (event) => {
        if (event.newState === 'open') this.scheduleLoad();
      };
      popover.addEventListener('toggle', this.handlePopoverToggle);
    }
  }

  getServerAppliedRedemption() {
    const discountAmount = Number(this.dataset.appliedAmount || 0);
    const discountCode = this.dataset.appliedCode || '';
    if (!discountCode || discountAmount <= 0) return null;
    return { discountCode, discountAmount };
  }

  async load() {
    const requestId = (this.loadRequestId || 0) + 1;
    this.loadRequestId = requestId;
    // Cancel any in-flight cart/preview fetches from a superseded load so rapid
    // cart edits don't stack concurrent requests against the backend. Pairs with
    // the 200ms debounce in scheduleLoad().
    this.loadAbort?.abort();
    const abort = new AbortController();
    this.loadAbort = abort;
    const { signal } = abort;
    // Refresh refs in case a cart-section morph replaced the inner DOM.
    this.cacheRefs();
    const isCart = this.dataset.context === 'cart';
    const cartToken = this.dataset.cartToken || null;
    // The server-rendered cart is the source of truth for whether a loyalty
    // discount is applied, so the Remove control always shows when one is on the
    // cart — even if localStorage was cleared or lost between sessions.
    const serverApplied = isCart ? this.getServerAppliedRedemption() : null;
    // Scope the stored reservation to the current cart token so a redemption from
    // a previous cart never bleeds into a new one.
    const storedRedemption = isCart ? getActiveStoredRedemption(cartToken) : null;

    // Drop a stale localStorage reservation if the cart no longer carries the
    // discount (e.g. removed elsewhere), so we don't show a phantom applied state.
    if (isCart && !serverApplied && storedRedemption) {
      clearStoredRedemption();
    }

    // Cart emptied: release any reserved points so the balance isn't left locked
    // behind a discount that can no longer apply, then hide the widget.
    if (isCart && Number(this.dataset.cartSubtotal || 0) <= 0) {
      if (storedRedemption || serverApplied) {
        await this.releaseOnEmptyCart(storedRedemption);
      }
      if (requestId !== this.loadRequestId || !this.isConnected) return;
      this.setHidden(true);
      return;
    }

    const applied = serverApplied
      ? { ...serverApplied, pointsReserved: storedRedemption?.pointsReserved, sessionId: storedRedemption?.sessionId }
      : null;

    try {
      if (applied) {
        this.setHidden(false);
        const cachedCustomer = getCachedCustomer();
        if (cachedCustomer?.widget) this.applyTheme(cachedCustomer.widget);
        this.resetRedeemControls();
        this.renderStoredRedemption(applied, 0);
        return;
      }

      const customer = await fetchCustomerSnapshot();
      if (requestId !== this.loadRequestId || !this.isConnected) return;

      if (!customer.ok) return;
      if (!this.isContextEnabled(customer.widget)) {
        this.setHidden(true);
        return;
      }

      this.applyTheme(customer.widget);

      this.setHidden(false);
      if (this.dataset.context === 'cart') this.resetRedeemControls();

      if (!customer.loggedIn) {
        this.renderMessage(customer.message || 'Sign in to see your Earthen Points and unlock cart rewards.', '');
        return;
      }

      // Orphan recovery (cart only): we reached here without a loyalty discount on the
      // cart, so any still-reserved points are stranded from a prior redemption whose
      // discount was dropped (coupon, emptied cart, or a lost client record). Release
      // them once so the balance is correct and the customer can redeem again.
      let snapshot = customer;
      if (
        this.dataset.context === 'cart' &&
        Number(snapshot.pendingPoints || 0) > 0 &&
        !this.orphanRecovering
      ) {
        this.orphanRecovering = true;
        try {
          await this.request('/apps/loyalty/remove', { method: 'POST', body: {} }).catch(() => null);
          clearCustomerCache();
          const refreshed = await fetchCustomerSnapshot();
          if (requestId !== this.loadRequestId || !this.isConnected) return;
          if (refreshed?.ok) snapshot = refreshed;
        } finally {
          this.orphanRecovering = false;
        }
      }

      this.renderMessage(
        snapshot.message ||
          `You have ${snapshot.availablePoints} points worth ${formatMoney(snapshot.availableValue)}.`,
        `${snapshot.availablePoints} pts`,
      );

      if (this.dataset.context === 'cart') {
        await this.loadCartRedemption(snapshot, requestId, signal);
      } else if (this.dataset.context === 'account') {
        await this.loadHistory(requestId);
      }
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') return;
      if (this.dataset.context === 'cart') {
        this.setHidden(false);
        this.resetRedeemControls();
        this.renderMessage(
          'Your Earthen Points are refreshing. Please try again in a moment.',
          this.refs.value?.textContent || '',
        );
        return;
      }
      this.setHidden(true);
    }
  }

  async loadCartRedemption(customer, requestId, signal) {
    const stored = getActiveStoredRedemption(this.dataset.cartToken || null);

    if (customer.redemption && !customer.redemption.enabled) {
      if (stored?.discountCode) this.renderStoredRedemption(stored, 0);
      return;
    }

    if (customer.availablePoints <= 0) {
      if (stored?.discountCode) this.renderStoredRedemption(stored, 0);
      return;
    }

    try {
      const cart = await this.getCartSnapshot(signal);
      if (requestId !== this.loadRequestId || !this.isConnected) return;

      // Preferred path: compute the slider maximum locally from the rules the
      // customer endpoint already returned. No network round trip on cart
      // changes. Falls back to the server preview only if an older backend
      // revision did not send `redemption` rules yet.
      const preview = customer.redemption
        ? previewFromRules(customer, cart)
        : await this.fetchCartPreview(cart, signal);
      if (requestId !== this.loadRequestId || !this.isConnected) return;

      if (!preview.ok || preview.maxRedeemablePoints <= 0) {
        this.refs.message.textContent = preview.message || 'Earn or migrate more points to redeem on this cart.';
        return;
      }

      this.refs.redeem.hidden = false;
      this.refs.range.max = String(preview.maxRedeemablePoints);
      this.refs.range.value = String(preview.maxRedeemablePoints);
      this.refs.range.step = String(preview.redeemIncrementPoints || 10);
      this.updateSelected();

      if (stored?.discountCode) {
        this.renderStoredRedemption(stored, preview.maxRedeemablePoints);
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') return;
      this.resetRedeemControls();
      this.refs.message.textContent = 'Cart rewards are refreshing. Please try again in a moment.';
    }
  }

  // Renders the customer's points transaction history (earned / redeemed) into the
  // account/profile widget. Only runs for the account context.
  async loadHistory(requestId) {
    const container = this.refs.history;
    if (!container) return;
    try {
      const data = await fetchLoyaltyHistory();
      if (requestId !== this.loadRequestId || !this.isConnected) return;
      const transactions = data?.ok ? data.transactions || [] : [];
      if (!transactions.length) {
        container.hidden = true;
        container.innerHTML = '';
        return;
      }
      container.innerHTML = renderHistoryHtml(transactions);
      container.hidden = false;
    } catch (error) {
      container.hidden = true;
    }
  }

  async fetchCartPreview(cart, signal) {
    return this.request('/apps/loyalty/cart-preview', {
      method: 'POST',
      signal,
      body: {
        cartToken: cart.token,
        subtotal: cart.subtotal,
      },
    });
  }

  // Release a reservation left behind when the cart is emptied. Best-effort: hits
  // the backend to free the reserved points and clears local state. We do not morph
  // a cart section here — the cart is already empty.
  async releaseOnEmptyCart(stored) {
    if (this.autoReleasing) return;
    this.autoReleasing = true;
    try {
      const discountCode = stored?.discountCode || this.dataset.appliedCode || '';
      if (stored?.sessionId || discountCode) {
        await this.request('/apps/loyalty/remove', {
          method: 'POST',
          body: { sessionId: stored?.sessionId, discountCode },
        }).catch(() => null);
      }
      clearStoredRedemption();
      clearCustomerCache();
      delete this.dataset.applied;
    } finally {
      this.autoReleasing = false;
    }
  }

  handleCartRefresh = () => {
    if (this.dataset.context !== 'cart') return;
    this.scheduleLoad();
  };

  // Toggle visibility and remember the decision for the cart context, so a later
  // morph can restore it without waiting on the network.
  setHidden(hidden) {
    this.hidden = hidden;
    if (this.dataset.context === 'cart') cartWidgetShouldShow = !hidden;
  }

  // Re-assert visibility right after a cart-section morph re-adds the server
  // `hidden` attribute. Runs from a MutationObserver (a microtask, before paint),
  // so the widget never visibly disappears on a cart update. Only ever reveals —
  // never overrides a hidden state load() set on purpose (empty cart / disabled
  // context), because those conditions fail the guards below.
  syncVisibility() {
    if (this.dataset.context !== 'cart' || !this.hidden) return;
    // Empty cart genuinely stays hidden (load() releases any reservation).
    if (Number(this.dataset.cartSubtotal || 0) <= 0) return;
    const cached = getCachedCustomer();
    const shouldShow =
      !!this.getServerAppliedRedemption() ||
      (cached ? this.isContextEnabled(cached.widget) : cartWidgetShouldShow);
    if (shouldShow) this.setHidden(false);
  }

  scheduleLoad() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.load(), 200);
  }

  updateSelected = () => {
    const points = Number(this.refs.range?.value || 0);
    this.refs.selected.textContent = `${points} pts`;
  };

  renderStoredRedemption(stored, maxRedeemablePoints) {
    // Always refresh refs and unhide: this also runs right after an apply morph
    // resets the root to `hidden` and may swap the inner nodes.
    this.cacheRefs();
    this.setHidden(false);
    const pointsReserved = Number(stored.pointsReserved || 0);
    const discountAmount = Number(stored.discountAmount || pointsReserved || 0);
    this.dataset.applied = 'true';
    this.refs.redeem.hidden = false;
    if (this.refs.applied) {
      this.refs.applied.hidden = false;
      if (this.refs.appliedText) {
        this.refs.appliedText.textContent = `Earthen Points discount · ${formatMoney(discountAmount)} off`;
      }
    }
    if (this.refs.rangeRow) this.refs.rangeRow.hidden = true;
    if (this.refs.apply) this.refs.apply.hidden = true;
    if (this.refs.remove) this.refs.remove.hidden = false;
    this.refs.value.textContent = `${formatMoney(discountAmount)} off`;

    if (pointsReserved && discountAmount) {
      this.refs.message.textContent = `${pointsReserved} points applied. This discount stays on the cart if you add more products. Remove it to change the points.`;
    } else if (discountAmount) {
      this.refs.message.textContent =
        'Earthen Points discount applied. Remove it to change how many points you use.';
    }

    if (this.refs.selected) this.refs.selected.textContent = '';
  }

  applyPoints = async () => {
    const points = Number(this.refs.range?.value || 0);
    if (points <= 0) return;

    await this.withBusy(async () => {
      const cart = await this.getCartSnapshot();
      const redemption = await this.request('/apps/loyalty/redeem', {
        method: 'POST',
        body: {
          cartToken: cart.token,
          subtotal: cart.subtotal,
          points,
        },
      });

      if (!redemption.ok) {
        throw new Error(redemption.error || 'Could not apply points.');
      }

      clearCustomerCache();
      writeStoredRedemption(redemption, cart.token);
      await this.applyDiscountCode(redemption.discountCode);

      if (this.lastDiscountApplied === false) {
        // The points code could not be applied (e.g. it cannot combine with a
        // coupon already on the cart). Release the reservation so the points are
        // not stranded, and tell the customer instead of a phantom applied state.
        await this.request('/apps/loyalty/remove', {
          method: 'POST',
          body: { sessionId: redemption.sessionId, discountCode: redemption.discountCode },
        }).catch(() => null);
        clearStoredRedemption();
        clearCustomerCache();
        if (this.refs.message) {
          this.refs.message.textContent =
            'These points could not combine with the coupon on your cart. Remove the coupon to redeem points.';
        }
        await this.load();
        return;
      }

      this.renderStoredRedemption(redemption, 0);
    });
  };

  removePoints = async () => {
    const stored = readStoredRedemption();
    // Fall back to the discount code the server rendered onto the cart so Remove
    // releases the reservation even when localStorage has no record of it.
    const discountCode = stored?.discountCode || this.dataset.appliedCode || '';

    await this.withBusy(async () => {
      await this.request('/apps/loyalty/remove', {
        method: 'POST',
        body: {
          sessionId: stored?.sessionId,
          discountCode,
        },
      }).catch(() => null);
      await this.applyDiscountCode('');
      clearStoredRedemption();
      clearCustomerCache();
      delete this.dataset.applied;
      this.refs.remove.hidden = true;
      await this.load();
    });
  };

  async applyDiscountCode(code) {
    const sectionId = this.dataset.sectionId;

    // Preserve any manually-applied coupon (e.g. ES10) so redeeming or releasing
    // points never silently drops a code the customer already added. Only the
    // loyalty code itself is ours to add or remove here.
    const preserved = await this.getAppliedCouponCodes();
    // Shopify rejects an order-level points discount applied in the SAME cart
    // update as an existing product coupon, but it accepts a coupon added on top
    // of an already-applied points discount. So when adding points to a cart that
    // already carries a coupon, apply the points alone first, then re-add the
    // coupon on top — the ordering Shopify does accept.
    if (code && preserved.length > 0) {
      await this.updateCartDiscount(code, null);
    }

    const discountList = [...preserved];
    if (code && !discountList.some(isLoyaltyDiscountCode)) {
      discountList.unshift(code);
    }

    const data = await this.updateCartDiscount(discountList.join(','), sectionId);

    // Safety net: if the points code was still rejected, don't leave points
    // reserved against a discount that never applied — signal to release it.
    if (code) {
      const stuck = (data.discount_codes || []).some(
        (entry) => String(entry?.code || '').toUpperCase() === code.toUpperCase() && entry?.applicable !== false,
      );
      this.lastDiscountApplied = stuck;
    }

    if (sectionId && data.sections?.[sectionId]) {
      // We morph our own cart section from the response we already have. We do
      // NOT dispatch DiscountUpdateEvent here: the cart-items component reacts
      // to it with a second full section re-fetch, and our own listener would
      // re-run load() — both redundant since this morph already updates totals.
      morphSection(sectionId, data.sections[sectionId]);
    } else {
      window.location.reload();
    }
  }

  async updateCartDiscount(discount, sectionId) {
    const body = { discount };
    if (sectionId) body.sections = [sectionId];
    const response = await fetch(Theme.routes.cart_update_url, fetchConfig('json', { body: JSON.stringify(body) }));
    return response.json();
  }

  // Reads the coupon codes currently on the cart, excluding our own loyalty code
  // and any Shopify flagged non-applicable, so they can be re-sent alongside the
  // points discount instead of being overwritten.
  async getAppliedCouponCodes() {
    try {
      const response = await fetch(`${Theme.routes.cart_url}.js`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const cart = await response.json();
      const codes = Array.isArray(cart.discount_codes) ? cart.discount_codes : [];
      return codes
        .filter((entry) => entry && entry.applicable !== false && !isLoyaltyDiscountCode(entry.code))
        .map((entry) => entry.code);
    } catch (error) {
      return [];
    }
  }

  async getCart(signal) {
    const response = await fetch(`${Theme.routes.cart_url}.js`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    });

    if (!response.ok) throw new Error('Could not load cart.');

    return response.json();
  }

  async getCartSnapshot(signal) {
    const fallback = {
      token: this.dataset.cartToken || null,
      subtotal: Math.max(0, Number(this.dataset.cartSubtotal || 0)),
    };

    if (fallback.token || fallback.subtotal > 0) {
      return fallback;
    }

    try {
      const cart = await this.getCart(signal);
      return {
        token: cart.token || fallback.token,
        subtotal: centsToMoney(cart.items_subtotal_price ?? fallback.subtotal * 100),
      };
    } catch (error) {
      if (fallback.token || fallback.subtotal > 0) return fallback;
      throw error;
    }
  }

  async request(path, options = {}) {
    const fetchOptions = {
      method: options.method || 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    };

    if (options.signal) fetchOptions.signal = options.signal;

    if (options.body) {
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(path, fetchOptions);
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error || 'Loyalty request failed.');
    }

    return response.json();
  }

  renderMessage(message, value) {
    this.refs.message.textContent = message;
    this.refs.value.textContent = value;
  }

  resetRedeemControls() {
    delete this.dataset.applied;
    if (this.refs.redeem) this.refs.redeem.hidden = true;
    if (this.refs.applied) {
      this.refs.applied.hidden = true;
      if (this.refs.appliedText) this.refs.appliedText.textContent = '';
    }
    if (this.refs.rangeRow) this.refs.rangeRow.hidden = false;
    if (this.refs.apply) this.refs.apply.hidden = false;
    if (this.refs.remove) this.refs.remove.hidden = true;
    if (this.refs.range) {
      this.refs.range.max = '0';
      this.refs.range.value = '0';
    }
    if (this.refs.selected) this.refs.selected.textContent = '';
  }

  isContextEnabled(widget = {}) {
    const key = `${this.dataset.context}Enabled`;
    return widget[key] !== false;
  }

  applyTheme(widget = {}) {
    if (widget.primaryColor) this.style.setProperty('--loyalty-primary', widget.primaryColor);
    if (widget.accentColor) this.style.setProperty('--loyalty-accent', widget.accentColor);
    if (widget.backgroundColor) this.style.setProperty('--loyalty-background', widget.backgroundColor);
  }

  async withBusy(callback) {
    if (this.refs.apply) this.refs.apply.disabled = true;
    if (this.refs.remove) this.refs.remove.disabled = true;
    try {
      await callback();
    } catch (error) {
      this.refs.message.textContent = error instanceof Error ? error.message : 'Loyalty action failed.';
    } finally {
      if (this.refs.apply) this.refs.apply.disabled = false;
      if (this.refs.remove) this.refs.remove.disabled = false;
    }
  }
}

function centsToMoney(value) {
  return Math.max(0, Number(value || 0) / 100);
}

// Client-side port of the backend redemption math (app/loyalty/rules.ts).
// Used to size the cart slider without a network round trip. Preview-only:
// the backend re-validates the real amount on /redeem.
function normalizeRedeemPoints(points, rules) {
  if (points < rules.minRedeemPoints) return 0;
  const increment = rules.redeemIncrementPoints || 1;
  return Math.floor(points / increment) * increment;
}

function calculateMaxRedeemablePoints(availablePoints, eligibleCartSubtotal, rules) {
  if (availablePoints < rules.minRedeemPoints || eligibleCartSubtotal <= 0) return 0;

  const currencyValuePerPoint = rules.currencyValuePerPoint || 1;
  const cartValueCap = Math.floor(
    (eligibleCartSubtotal * (rules.maxRedeemPercentOfCart / 100)) / currencyValuePerPoint,
  );
  const orderCap = rules.maxRedeemPointsPerOrder ?? Number.MAX_SAFE_INTEGER;
  const cappedPoints = Math.min(availablePoints, cartValueCap, orderCap);

  return normalizeRedeemPoints(cappedPoints, rules);
}

function previewFromRules(customer, cart) {
  const rules = customer.redemption;
  const maxRedeemablePoints = calculateMaxRedeemablePoints(
    Number(customer.availablePoints || 0),
    Number(cart.subtotal || 0),
    rules,
  );

  return {
    ok: true,
    maxRedeemablePoints,
    redeemIncrementPoints: rules.redeemIncrementPoints || 10,
  };
}

function formatMoney(value) {
  return CURRENCY_FORMATTER.format(Number(value || 0));
}

function isLoyaltyDiscountCode(code) {
  return String(code || '').toUpperCase().startsWith('ESPOINTS');
}

function readStoredRedemption() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
  } catch (error) {
    return null;
  }
}

function getActiveStoredRedemption(currentCartToken) {
  const stored = readStoredRedemption();
  if (!stored?.discountCode) return null;

  if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) {
    clearStoredRedemption();
    return null;
  }

  // A reservation belongs to the cart it was applied on. If the cart token has
  // changed (new/replaced cart), the stored code no longer applies here — drop it
  // so we never show a phantom applied state from a previous cart.
  if (stored.cartToken && currentCartToken && stored.cartToken !== currentCartToken) {
    clearStoredRedemption();
    return null;
  }

  return stored;
}

function writeStoredRedemption(redemption, cartToken) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      sessionId: redemption.sessionId,
      discountCode: redemption.discountCode,
      pointsReserved: redemption.pointsReserved,
      discountAmount: redemption.discountAmount,
      expiresAt: redemption.expiresAt,
      cartToken: cartToken ?? null,
    }),
  );
}

function clearStoredRedemption() {
  window.localStorage.removeItem(STORAGE_KEY);
}

function getCachedCustomer() {
  if (!customerCache) return null;
  if (Date.now() - customerCache.createdAt > CUSTOMER_CACHE_TTL_MS) return null;
  return customerCache.data;
}

async function fetchCustomerSnapshot() {
  const cachedCustomer = getCachedCustomer();
  if (cachedCustomer) return cachedCustomer;
  if (customerRequest) return customerRequest;

  customerRequest = fetch('/apps/loyalty/customer', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
    .then(async (response) => {
      if (!response.ok) throw new Error('Loyalty request failed.');
      const data = await response.json();
      customerCache = {
        createdAt: Date.now(),
        data,
      };
      return data;
    })
    .finally(() => {
      customerRequest = null;
    });

  return customerRequest;
}

function clearCustomerCache() {
  customerCache = null;
  customerRequest = null;
  historyCache = null;
  historyRequest = null;
}

async function fetchLoyaltyHistory() {
  if (historyCache && Date.now() - historyCache.createdAt <= CUSTOMER_CACHE_TTL_MS) {
    return historyCache.data;
  }
  if (historyRequest) return historyRequest;

  historyRequest = fetch('/apps/loyalty/history', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
    .then(async (response) => {
      if (!response.ok) throw new Error('Loyalty history request failed.');
      const data = await response.json();
      historyCache = { createdAt: Date.now(), data };
      return data;
    })
    .finally(() => {
      historyRequest = null;
    });

  return historyRequest;
}

function renderHistoryHtml(transactions) {
  const rows = transactions
    .map((txn) => {
      const points = Number(txn.points || 0);
      const positive = points > 0;
      const rowClass = positive ? 'is-earn' : 'is-redeem';
      const sign = positive ? '+' : '';
      const order = txn.orderName ? ` · ${escapeHtml(txn.orderName)}` : '';
      const money = txn.moneyValue
        ? ` <span class="el-txn__money">${formatMoney(txn.moneyValue)}</span>`
        : '';
      return `<li class="el-txn ${rowClass}">
          <span class="el-txn__info">
            <span class="el-txn__label">${escapeHtml(txn.label)}${order}</span>
            <span class="el-txn__date">${formatHistoryDate(txn.date)}</span>
          </span>
          <span class="el-txn__points">${sign}${points} pts${money}</span>
        </li>`;
    })
    .join('');
  return `<h3 class="el-txn__title">Points history</h3><ul class="el-txn__list">${rows}</ul>`;
}

function formatHistoryDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : HISTORY_DATE_FORMATTER.format(date);
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

// Release a reserved redemption once the cart is empty, independent of the widget's
// lifecycle: an empty cart does not render the cart widget, so a per-widget handler
// can never fire in that state and the reserved points would stay locked until the
// reservation TTL expires. This lives on `document` (and runs once at load) so it
// survives the widget unmounting. Cheap: it only touches the network when a
// reservation is actually stored AND a cart change happened.
async function releaseRedemptionIfCartEmpty() {
  const stored = readStoredRedemption();
  if (!stored?.discountCode && !stored?.sessionId) return;

  let itemCount = null;
  try {
    const response = await fetch(`${Theme.routes.cart_url}.js`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return;
    itemCount = (await response.json()).item_count;
  } catch (error) {
    return;
  }
  if (itemCount !== 0) return;

  await fetch('/apps/loyalty/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sessionId: stored.sessionId, discountCode: stored.discountCode }),
  }).catch(() => null);
  clearStoredRedemption();
  clearCustomerCache();
}

// Capture ?ref=CODE referral links for later attachment (after the visitor
// signs up / logs in, the launcher attaches it to their account).
const REFERRAL_STORAGE_KEY = 'earthen_referral_code';
try {
  const refParam = new URLSearchParams(window.location.search).get('ref');
  if (refParam && /^[A-Za-z0-9-]{3,32}$/.test(refParam)) {
    window.localStorage.setItem(REFERRAL_STORAGE_KEY, refParam.toUpperCase());
  }
} catch (error) {
  // Storage unavailable (private mode) — referral capture silently skipped.
}

if (!window.__earthenLoyaltyCartEmptyGuard) {
  window.__earthenLoyaltyCartEmptyGuard = true;
  // Handles the cart being emptied while the shopper is on the page.
  document.addEventListener(ThemeEvents.cartUpdate, releaseRedemptionIfCartEmpty);
  // Handles landing on / reloading an already-empty cart (no cartUpdate fires then).
  releaseRedemptionIfCartEmpty();
}

window.EarthenLoyalty = {
  ...(window.EarthenLoyalty || {}),
  clearCustomerCache,
};

if (!customElements.get('earthen-loyalty-widget')) {
  customElements.define('earthen-loyalty-widget', EarthenLoyaltyWidget);
}

const LAUNCHER_ICONS = {
  redeem:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7"/><path d="M2 8.5h20V12H2zM12 8.5V20M12 8.5S10.5 4 8 4a2 2 0 0 0 0 4.5zM12 8.5S13.5 4 16 4a2 2 0 0 1 0 4.5z"/></svg>',
  earn:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M9.5 9.2c.4-1 1.4-1.6 2.6-1.6 1.6 0 2.6.9 2.6 2.1 0 2.6-5 1.5-5 4.1 0 1.2 1.1 2.1 2.7 2.1 1.2 0 2.2-.6 2.6-1.6"/></svg>',
};

class EarthenLoyaltyLauncher extends HTMLElement {
  connectedCallback() {
    this.refs = {
      button: this.querySelector('[data-loyalty-launcher-button]'),
      panel: this.querySelector('[data-loyalty-launcher-panel]'),
      close: this.querySelector('[data-loyalty-launcher-close]'),
      value: this.querySelector('[data-loyalty-launcher-value]'),
      body: this.querySelector('[data-loyalty-launcher-body]'),
    };

    this.refs.button?.addEventListener('click', this.togglePanel);
    this.refs.close?.addEventListener('click', this.closePanel);
    this.addEventListener('click', this.handlePanelClick);
    this.load();
  }

  disconnectedCallback() {
    this.refs?.button?.removeEventListener('click', this.togglePanel);
    this.refs?.close?.removeEventListener('click', this.closePanel);
    this.removeEventListener('click', this.handlePanelClick);
  }

  // Delegated clicks for reward-claim and earn-action buttons rendered into the
  // panel body (innerHTML re-renders would drop direct listeners).
  handlePanelClick = async (event) => {
    const rewardButton = event.target.closest('[data-loyalty-claim-reward]');
    if (rewardButton) {
      await this.claimReward(rewardButton.dataset.loyaltyClaimReward, rewardButton);
      return;
    }
    const actionButton = event.target.closest('[data-loyalty-earn-action]');
    if (actionButton) {
      await this.claimEarnAction(actionButton.dataset.loyaltyEarnAction, actionButton);
      return;
    }
    const copyButton = event.target.closest('[data-loyalty-copy-referral]');
    if (copyButton) {
      const input = this.querySelector('[data-loyalty-referral-link]');
      if (!input?.value) return;
      try {
        await navigator.clipboard.writeText(input.value);
        copyButton.textContent = 'Copied ✓';
        setTimeout(() => {
          copyButton.textContent = 'Copy';
        }, 2000);
      } catch (error) {
        input.select();
        this.showPanelMessage('Press Ctrl/Cmd+C to copy your link.');
      }
    }
  };

  async claimReward(rewardId, button) {
    if (!rewardId || button.disabled) return;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = 'Applying…';
    try {
      const cart = await fetch(`${Theme.routes.cart_url}.js`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      }).then((response) => response.json());

      const claim = await fetch('/apps/loyalty/claim-reward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          rewardId,
          cartToken: cart.token || null,
          subtotal: centsToMoney(cart.items_subtotal_price),
        }),
      }).then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error || 'Could not claim reward.');
        }
        return data;
      });

      writeStoredRedemption(claim, cart.token || null);
      clearCustomerCache();
      await fetch(
        Theme.routes.cart_update_url,
        fetchConfig('json', { body: JSON.stringify({ discount: claim.discountCode }) }),
      );
      button.textContent = 'Applied ✓';
      if (window.location.pathname.startsWith('/cart')) {
        window.location.reload();
      } else {
        await this.load();
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = originalText;
      this.showPanelMessage(
        error instanceof Error ? error.message : 'Could not claim reward.',
      );
    }
  }

  async claimEarnAction(actionId, button) {
    if (!actionId || button.disabled) return;
    const url = button.dataset.loyaltyEarnUrl;
    if (url) window.open(url, '_blank', 'noopener');
    button.disabled = true;
    try {
      const result = await fetch('/apps/loyalty/earn-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ actionId }),
      }).then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error || 'Could not claim points.');
        }
        return data;
      });
      clearCustomerCache();
      await this.load();
      if (result.alreadyClaimed) {
        this.showPanelMessage('You have already claimed this reward.');
      }
    } catch (error) {
      button.disabled = false;
      this.showPanelMessage(
        error instanceof Error ? error.message : 'Could not claim points.',
      );
    }
  }

  showPanelMessage(message) {
    const note = this.querySelector('[data-loyalty-panel-note]');
    if (note) note.textContent = message;
  }

  async load() {
    try {
      const [customer, referral] = await Promise.all([
        fetchCustomerSnapshot(),
        fetch('/apps/loyalty/referral', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      ]);
      if (!customer.ok) return;

      await this.attachPendingReferral(customer, referral);

      this.applyTheme(customer.widget);
      this.hidden = false;
      this.refs.value.textContent = customer.loggedIn ? `${customer.availablePoints || 0} pts` : '';
      this.renderBody(customer, referral);
    } catch (error) {
      this.hidden = true;
    }
  }

  // If the visitor arrived through a referral link and is now signed in, link
  // the referral to their account (once). Server-side guards handle the rest
  // (self-referral, existing customers, duplicates).
  async attachPendingReferral(customer, referral) {
    let storedCode = null;
    try {
      storedCode = window.localStorage.getItem(REFERRAL_STORAGE_KEY);
    } catch (error) {
      return;
    }
    if (!storedCode || !customer.loggedIn || !referral?.enabled) return;
    if (referral.code && referral.code === storedCode) return;

    try {
      const result = await fetch('/apps/loyalty/referral', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ code: storedCode }),
      }).then((response) => response.json());
      if (result?.attached) {
        this.pendingReferralMessage = 'Referral linked — your bonus arrives with your first order!';
      }
      window.localStorage.removeItem(REFERRAL_STORAGE_KEY);
    } catch (error) {
      // Leave the stored code for a later retry.
    }
  }

  renderBody(customer, referral) {
    if (!this.refs.body) return;
    const rewards = customer.rewards || {};
    const loginUrl = this.dataset.loginUrl || '/account/login';
    const cartUrl = this.dataset.cartUrl || '/cart';

    const pointName = rewards.pointName || 'Earthen Points';
    const valuePerPoint = Number(rewards.currencyValuePerPoint || 1);
    const increment = Number(rewards.redeemIncrementPoints || 10);
    const signupPoints = Number(rewards.signupRewardPoints || 0);
    const pointsPerSpend = Number(rewards.pointsPerSpendAmount || 0);
    const spendAmount = Number(rewards.spendAmountForEarnPoints || 0);

    const vip = customer.vip || null;
    const vipLine = vip?.tier
      ? `<br><span class="el-rw__tier">${escapeHtml(vip.tier)} member${vip.multiplier > 1 ? ` · ${vip.multiplier}x points` : ''}</span>`
      : vip?.nextTier && vip.pointsToNext != null
        ? `<br><span class="el-rw__tier">${vip.pointsToNext} pts to ${escapeHtml(vip.nextTier)}</span>`
        : '';
    const balance = customer.loggedIn
      ? `<div class="el-rw__balance">
           <span class="el-rw__balance-num">${customer.availablePoints || 0}</span>
           <span class="el-rw__balance-meta">${pointName}<br><strong>${formatMoney(customer.availableValue || 0)}</strong> to spend${vipLine}</span>
         </div>`
      : `<div class="el-rw__balance el-rw__balance--out">
           <p>${customer.message || 'Sign in to see your balance and start redeeming.'}</p>
           <a class="el-rw__btn" href="${loginUrl}">Sign in</a>
         </div>`;

    const redeemBody =
      rewards.redemptionEnabled === false
        ? `<p class="el-rw__muted">Redemption is paused right now.</p>`
        : `<p class="el-rw__p">Use points in your cart for instant savings. <strong>${increment} points = ${formatMoney(increment * valuePerPoint)}</strong> (1 point = ${formatMoney(valuePerPoint)}).</p>
           ${customer.loggedIn ? `<a class="el-rw__btn el-rw__btn--block" href="${cartUrl}">Redeem in cart</a>` : ''}`;

    const availablePoints = Number(customer.availablePoints || 0);
    const catalog = Array.isArray(customer.catalog) ? customer.catalog : [];
    const catalogItems = catalog
      .map((reward) => {
        const valueLabel =
          reward.type === 'fixed_amount'
            ? `${formatMoney(reward.value)} off`
            : reward.type === 'percent_off'
              ? `${reward.value}% off`
              : 'Free shipping';
        const minLabel = reward.minSubtotal
          ? ` <span class="el-rw__muted">min ${formatMoney(reward.minSubtotal)}</span>`
          : '';
        const control = customer.loggedIn
          ? `<button class="el-rw__btn el-rw__btn--pill" type="button" data-loyalty-claim-reward="${reward.id}"${
              availablePoints < reward.pointsCost ? ' disabled' : ''
            }>${reward.pointsCost} pts</button>`
          : `<strong>${reward.pointsCost} pts</strong>`;
        return `<li><span>${escapeHtml(reward.title)} · <strong>${valueLabel}</strong>${minLabel}</span>${control}</li>`;
      })
      .join('');

    const actionItems = (Array.isArray(customer.earnActions) ? customer.earnActions : [])
      .map((action) => {
        const control = !customer.loggedIn
          ? `<strong>+${action.points} pts</strong>`
          : action.claimed
            ? `<strong>Claimed ✓</strong>`
            : `<button class="el-rw__btn el-rw__btn--pill" type="button" data-loyalty-earn-action="${action.id}" data-loyalty-earn-url="${escapeHtml(action.url || '')}">+${action.points} pts</button>`;
        return `<li><span>${escapeHtml(action.title)}</span>${control}</li>`;
      })
      .join('');

    const campaign = customer.campaign || null;
    const campaignLine = campaign
      ? `<li><span><strong>${escapeHtml(campaign.title)}</strong> · ${campaign.multiplier}x points until ${formatHistoryDate(campaign.endsAt)}</span></li>`
      : '';

    const earnItems = [
      campaignLine,
      signupPoints
        ? `<li><span>Create an account</span><strong>+${signupPoints} pts</strong></li>`
        : '',
      pointsPerSpend && spendAmount
        ? `<li><span>Every ${formatMoney(spendAmount)} you spend</span><strong>+${pointsPerSpend} pts</strong></li>`
        : '',
      actionItems,
    ].join('');

    let referralSection = '';
    if (referral?.enabled) {
      const referralLink = referral.code
        ? `${window.location.origin}/?ref=${referral.code}`
        : '';
      const referralBody = !customer.loggedIn
        ? `<p class="el-rw__p">Refer a friend: they get <strong>+${referral.refereePoints || 0} pts</strong>, you get <strong>+${referral.referrerPoints || 0} pts</strong> after their first order. Sign in to get your link.</p>`
        : `<p class="el-rw__p">Share your link — your friend gets <strong>+${referral.refereePoints || 0} pts</strong> and you get <strong>+${referral.referrerPoints || 0} pts</strong> after their first order.${referral.rewardedCount ? ` <strong>${referral.rewardedCount}</strong> rewarded so far.` : ''}</p>
           <div class="el-rw__reflink">
             <input class="el-rw__reflink-input" type="text" readonly value="${escapeHtml(referralLink)}" data-loyalty-referral-link>
             <button class="el-rw__btn el-rw__btn--pill" type="button" data-loyalty-copy-referral>Copy</button>
           </div>`;
      referralSection = `
      <section class="el-rw__section">
        <h3 class="el-rw__h">${LAUNCHER_ICONS.earn}<span>Refer a friend</span></h3>
        ${referralBody}
      </section>`;
    }

    this.refs.body.innerHTML = `
      ${balance}
      <section class="el-rw__section">
        <h3 class="el-rw__h">${LAUNCHER_ICONS.redeem}<span>Redeem points</span></h3>
        ${redeemBody}
        ${catalogItems ? `<ul class="el-rw__earn el-rw__catalog">${catalogItems}</ul>` : ''}
      </section>
      <section class="el-rw__section">
        <h3 class="el-rw__h">${LAUNCHER_ICONS.earn}<span>Ways to earn</span></h3>
        <ul class="el-rw__earn">${earnItems}</ul>
      </section>
      ${referralSection}
      <p class="el-rw__note" data-loyalty-panel-note></p>`;

    if (this.pendingReferralMessage) {
      this.showPanelMessage(this.pendingReferralMessage);
      this.pendingReferralMessage = null;
    }
  }

  togglePanel = () => {
    const open = this.refs.panel.hidden;
    this.refs.panel.hidden = !open;
    this.refs.button.setAttribute('aria-expanded', String(open));
  };

  closePanel = () => {
    this.refs.panel.hidden = true;
    this.refs.button.setAttribute('aria-expanded', 'false');
  };

  applyTheme(widget = {}) {
    if (widget.primaryColor) this.style.setProperty('--loyalty-primary', widget.primaryColor);
    if (widget.accentColor) this.style.setProperty('--loyalty-accent', widget.accentColor);
    if (widget.backgroundColor) this.style.setProperty('--loyalty-background', widget.backgroundColor);
  }
}

if (!customElements.get('earthen-loyalty-launcher')) {
  customElements.define('earthen-loyalty-launcher', EarthenLoyaltyLauncher);
}
