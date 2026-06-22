import { DiscountUpdateEvent, ThemeEvents } from '@theme/events';
import { morphSection } from '@theme/section-renderer';
import { fetchConfig } from '@theme/utilities';

const STORAGE_KEY = 'earthen_loyalty_redemption';
const CURRENCY_FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

class EarthenLoyaltyWidget extends HTMLElement {
  connectedCallback() {
    this.refs = {
      value: this.querySelector('[data-loyalty-value]'),
      message: this.querySelector('[data-loyalty-message]'),
      redeem: this.querySelector('[data-loyalty-redeem]'),
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

    try {
      const customer = await this.request('/apps/loyalty/customer');
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
    const stored = readStoredRedemption();

    if (customer.availablePoints <= 0) {
      if (stored?.discountCode) this.renderStoredRedemption(stored, 0);
      return;
    }

    try {
      const cart = await this.getCartSnapshot();
      if (requestId !== this.loadRequestId || !this.isConnected) return;

      const preview = await this.request('/apps/loyalty/cart-preview', {
        method: 'POST',
        body: {
          cartToken: cart.token,
          subtotal: cart.subtotal,
        },
      });
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
    const selectedPoints = maxRedeemablePoints > 0 ? Math.min(pointsReserved, maxRedeemablePoints) : pointsReserved;

    this.refs.remove.hidden = false;
    if (selectedPoints > 0) {
      this.refs.redeem.hidden = false;
      this.refs.range.step = this.refs.range.step || '10';
      this.refs.range.max = String(Math.max(maxRedeemablePoints, selectedPoints));
      this.refs.range.value = String(selectedPoints);
      this.updateSelected();
    }

    if (pointsReserved && stored.discountAmount) {
      this.refs.message.textContent = `${pointsReserved} points applied for ${formatMoney(stored.discountAmount)} off.`;
    }
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

      writeStoredRedemption(redemption);
      await this.applyDiscountCode(redemption.discountCode);
      this.refs.remove.hidden = false;
      this.refs.message.textContent = `${redemption.pointsReserved} points applied for ${formatMoney(redemption.discountAmount)} off.`;
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
      document.dispatchEvent(new DiscountUpdateEvent(data, this.id));
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
    if (this.refs.redeem) this.refs.redeem.hidden = true;
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
    this.refs.apply.disabled = true;
    this.refs.remove.disabled = true;
    try {
      await callback();
    } catch (error) {
      this.refs.message.textContent = error instanceof Error ? error.message : 'Loyalty action failed.';
    } finally {
      this.refs.apply.disabled = false;
      this.refs.remove.disabled = false;
    }
  }
}

function centsToMoney(value) {
  return Math.max(0, Number(value || 0) / 100);
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

if (!customElements.get('earthen-loyalty-widget')) {
  customElements.define('earthen-loyalty-widget', EarthenLoyaltyWidget);
}
