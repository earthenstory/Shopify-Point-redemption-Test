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

    this.refs.range?.addEventListener('input', this.updateSelected);
    this.refs.apply?.addEventListener('click', this.applyPoints);
    this.refs.remove?.addEventListener('click', this.removePoints);

    if (this.dataset.context === 'cart') {
      document.addEventListener(ThemeEvents.cartUpdate, this.handleCartRefresh);
      document.addEventListener(ThemeEvents.discountUpdate, this.handleCartRefresh);
    }

    this.load();
  }

  disconnectedCallback() {
    this.refs?.range?.removeEventListener('input', this.updateSelected);
    this.refs?.apply?.removeEventListener('click', this.applyPoints);
    this.refs?.remove?.removeEventListener('click', this.removePoints);
    document.removeEventListener(ThemeEvents.cartUpdate, this.handleCartRefresh);
    document.removeEventListener(ThemeEvents.discountUpdate, this.handleCartRefresh);
    clearTimeout(this.reloadTimer);
  }

  async load() {
    const requestId = (this.loadRequestId || 0) + 1;
    this.loadRequestId = requestId;
    const storedRedemption = this.dataset.context === 'cart' ? getActiveStoredRedemption() : null;

    try {
      if (storedRedemption?.discountCode) {
        this.hidden = false;
        const cachedCustomer = getCachedCustomer();
        if (cachedCustomer?.widget) this.applyTheme(cachedCustomer.widget);
        this.resetRedeemControls();
        this.renderStoredRedemption(storedRedemption, 0);
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

    await this.withBusy(async () => {
      await this.request('/apps/loyalty/remove', {
        method: 'POST',
        body: {
          sessionId: stored?.sessionId,
          discountCode: stored?.discountCode,
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

class EarthenLoyaltyLauncher extends HTMLElement {
  connectedCallback() {
    this.refs = {
      button: this.querySelector('[data-loyalty-launcher-button]'),
      panel: this.querySelector('[data-loyalty-launcher-panel]'),
      close: this.querySelector('[data-loyalty-launcher-close]'),
      value: this.querySelector('[data-loyalty-launcher-value]'),
      message: this.querySelector('[data-loyalty-launcher-message]'),
      signin: this.querySelector('[data-loyalty-launcher-signin]'),
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

      if (!customer.loggedIn) {
        this.refs.value.textContent = 'Rewards';
        this.refs.message.textContent = customer.message || 'Sign in to see your Earthen Points and earn rewards on every order.';
        this.refs.signin.hidden = false;
        return;
      }

      this.refs.value.textContent = `${customer.availablePoints || 0} pts`;
      this.refs.message.textContent =
        customer.message ||
        `You have ${customer.availablePoints || 0} Earthen Points worth ${formatMoney(customer.availableValue || 0)}.`;
      this.refs.signin.hidden = true;
    } catch (error) {
      this.hidden = true;
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

  async request(path) {
    const response = await fetch(path, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Loyalty request failed.');
    return response.json();
  }

  applyTheme(widget = {}) {
    if (widget.primaryColor) this.style.setProperty('--loyalty-primary', widget.primaryColor);
    if (widget.accentColor) this.style.setProperty('--loyalty-accent', widget.accentColor);
    if (widget.backgroundColor) this.style.setProperty('--loyalty-background', widget.backgroundColor);
  }
}

if (!customElements.get('earthen-loyalty-launcher')) {
  customElements.define('earthen-loyalty-launcher', EarthenLoyaltyLauncher);
}
