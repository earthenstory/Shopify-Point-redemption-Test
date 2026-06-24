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

let customerCache = null;
let customerRequest = null;

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
    if (!dialog) return;
    this.drawerObserver = new MutationObserver(() => {
      if (dialog.hasAttribute('open')) this.scheduleLoad();
    });
    this.drawerObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
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
    // Refresh refs in case a cart-section morph replaced the inner DOM.
    this.cacheRefs();
    const isCart = this.dataset.context === 'cart';
    // The server-rendered cart is the source of truth for whether a loyalty
    // discount is applied, so the Remove control always shows when one is on the
    // cart — even if localStorage was cleared or lost between sessions.
    const serverApplied = isCart ? this.getServerAppliedRedemption() : null;
    const storedRedemption = isCart ? getActiveStoredRedemption() : null;

    // Drop a stale localStorage reservation if the cart no longer carries the
    // discount (e.g. removed elsewhere), so we don't show a phantom applied state.
    if (isCart && !serverApplied && storedRedemption) {
      clearStoredRedemption();
    }

    const applied = serverApplied
      ? { ...serverApplied, pointsReserved: storedRedemption?.pointsReserved, sessionId: storedRedemption?.sessionId }
      : null;

    try {
      if (applied) {
        this.hidden = false;
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
        this.hidden = true;
        return;
      }

      this.applyTheme(customer.widget);

      this.hidden = false;
      if (this.dataset.context === 'cart') this.resetRedeemControls();

      if (!customer.loggedIn) {
        this.renderMessage(customer.message || 'Sign in to see your Earthen Points and unlock cart rewards.', '');
        return;
      }

      this.renderMessage(
        customer.message ||
          `You have ${customer.availablePoints} points worth ${formatMoney(customer.availableValue)}.`,
        `${customer.availablePoints} pts`,
      );

      if (this.dataset.context === 'cart') {
        await this.loadCartRedemption(customer, requestId);
      }
    } catch (error) {
      if (this.dataset.context === 'cart') {
        this.hidden = false;
        this.resetRedeemControls();
        this.renderMessage(
          'Your Earthen Points are refreshing. Please try again in a moment.',
          this.refs.value?.textContent || '',
        );
        return;
      }
      this.hidden = true;
    }
  }

  async loadCartRedemption(customer, requestId) {
    const stored = getActiveStoredRedemption();

    if (customer.redemption && !customer.redemption.enabled) {
      if (stored?.discountCode) this.renderStoredRedemption(stored, 0);
      return;
    }

    if (customer.availablePoints <= 0) {
      if (stored?.discountCode) this.renderStoredRedemption(stored, 0);
      return;
    }

    try {
      const cart = await this.getCartSnapshot();
      if (requestId !== this.loadRequestId || !this.isConnected) return;

      // Preferred path: compute the slider maximum locally from the rules the
      // customer endpoint already returned. No network round trip on cart
      // changes. Falls back to the server preview only if an older backend
      // revision did not send `redemption` rules yet.
      const preview = customer.redemption
        ? previewFromRules(customer, cart)
        : await this.fetchCartPreview(cart);
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
      this.resetRedeemControls();
      this.refs.message.textContent = 'Cart rewards are refreshing. Please try again in a moment.';
    }
  }

  async fetchCartPreview(cart) {
    return this.request('/apps/loyalty/cart-preview', {
      method: 'POST',
      body: {
        cartToken: cart.token,
        subtotal: cart.subtotal,
      },
    });
  }

  handleCartRefresh = () => {
    if (this.dataset.context !== 'cart') return;
    this.scheduleLoad();
  };

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
    this.hidden = false;
    const pointsReserved = Number(stored.pointsReserved || 0);
    const discountAmount = Number(stored.discountAmount || pointsReserved || 0);
    this.dataset.applied = 'true';
    this.refs.redeem.hidden = false;
    if (this.refs.applied) {
      this.refs.applied.hidden = false;
      if (this.refs.appliedText) {
        this.refs.appliedText.textContent = `Discount applied: ${formatMoney(discountAmount)} off`;
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
      writeStoredRedemption(redemption);
      await this.applyDiscountCode(redemption.discountCode);
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
    const body = { discount: code };
    if (sectionId) body.sections = [sectionId];

    const response = await fetch(Theme.routes.cart_update_url, fetchConfig('json', { body: JSON.stringify(body) }));
    const data = await response.json();

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

  async getCart() {
    const response = await fetch(`${Theme.routes.cart_url}.js`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) throw new Error('Could not load cart.');

    return response.json();
  }

  async getCartSnapshot() {
    const fallback = {
      token: this.dataset.cartToken || null,
      subtotal: Math.max(0, Number(this.dataset.cartSubtotal || 0)),
    };

    if (fallback.token || fallback.subtotal > 0) {
      return fallback;
    }

    try {
      const cart = await this.getCart();
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

function readStoredRedemption() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
  } catch (error) {
    return null;
  }
}

function getActiveStoredRedemption() {
  const stored = readStoredRedemption();
  if (!stored?.discountCode) return null;

  if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) {
    clearStoredRedemption();
    return null;
  }

  return stored;
}

function writeStoredRedemption(redemption) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      sessionId: redemption.sessionId,
      discountCode: redemption.discountCode,
      pointsReserved: redemption.pointsReserved,
      discountAmount: redemption.discountAmount,
      expiresAt: redemption.expiresAt,
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
    this.load();
  }

  disconnectedCallback() {
    this.refs?.button?.removeEventListener('click', this.togglePanel);
    this.refs?.close?.removeEventListener('click', this.closePanel);
  }

  async load() {
    try {
      const customer = await fetchCustomerSnapshot();
      if (!customer.ok) return;

      this.applyTheme(customer.widget);
      this.hidden = false;
      this.refs.value.textContent = customer.loggedIn ? `${customer.availablePoints || 0} pts` : '';
      this.renderBody(customer);
    } catch (error) {
      this.hidden = true;
    }
  }

  renderBody(customer) {
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

    const balance = customer.loggedIn
      ? `<div class="el-rw__balance">
           <span class="el-rw__balance-num">${customer.availablePoints || 0}</span>
           <span class="el-rw__balance-meta">${pointName}<br><strong>${formatMoney(customer.availableValue || 0)}</strong> to spend</span>
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

    const earnItems = [
      signupPoints
        ? `<li><span>Create an account</span><strong>+${signupPoints} pts</strong></li>`
        : '',
      pointsPerSpend && spendAmount
        ? `<li><span>Every ${formatMoney(spendAmount)} you spend</span><strong>+${pointsPerSpend} pts</strong></li>`
        : '',
    ].join('');

    this.refs.body.innerHTML = `
      ${balance}
      <section class="el-rw__section">
        <h3 class="el-rw__h">${LAUNCHER_ICONS.redeem}<span>Redeem points</span></h3>
        ${redeemBody}
      </section>
      <section class="el-rw__section">
        <h3 class="el-rw__h">${LAUNCHER_ICONS.earn}<span>Ways to earn</span></h3>
        <ul class="el-rw__earn">${earnItems}</ul>
      </section>`;
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
