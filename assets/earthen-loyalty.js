import { DiscountUpdateEvent } from '@theme/events';
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

    this.load();
  }

  disconnectedCallback() {
    this.refs?.range?.removeEventListener('input', this.updateSelected);
    this.refs?.apply?.removeEventListener('click', this.applyPoints);
    this.refs?.remove?.removeEventListener('click', this.removePoints);
  }

  async load() {
    try {
      const customer = await this.request('/apps/loyalty/customer');
      if (!customer.ok) return;

      this.hidden = false;

      if (!customer.loggedIn) {
        this.renderMessage('Sign in to see your Earthen Points and unlock cart rewards.', '');
        return;
      }

      this.renderMessage(
        customer.message ||
          `You have ${customer.availablePoints} points worth ${formatMoney(customer.availableValue)}.`,
        `${customer.availablePoints} pts`,
      );

      if (this.dataset.context === 'cart') {
        await this.loadCartRedemption(customer);
      }
    } catch (error) {
      this.hidden = true;
    }
  }

  async loadCartRedemption(customer) {
    if (customer.availablePoints <= 0) return;

    const cart = await this.getCart();
    const preview = await this.request('/apps/loyalty/cart-preview', {
      method: 'POST',
      body: {
        cartToken: cart.token,
        subtotal: centsToMoney(cart.items_subtotal_price),
      },
    });

    if (!preview.ok || preview.maxRedeemablePoints <= 0) {
      this.refs.message.textContent = 'Earn or migrate more points to redeem on this cart.';
      return;
    }

    this.refs.redeem.hidden = false;
    this.refs.range.max = String(preview.maxRedeemablePoints);
    this.refs.range.value = String(preview.maxRedeemablePoints);
    this.refs.range.step = '10';
    this.updateSelected();

    const stored = readStoredRedemption();
    if (stored?.discountCode) {
      this.refs.remove.hidden = false;
      if (stored.pointsReserved && stored.discountAmount) {
        this.refs.message.textContent = `${stored.pointsReserved} points applied for ${formatMoney(stored.discountAmount)} off.`;
        this.refs.range.value = String(Math.min(Number(stored.pointsReserved), preview.maxRedeemablePoints));
        this.updateSelected();
      }
    }
  }

  updateSelected = () => {
    const points = Number(this.refs.range?.value || 0);
    this.refs.selected.textContent = `${points} pts`;
  };

  applyPoints = async () => {
    const points = Number(this.refs.range?.value || 0);
    if (points <= 0) return;

    await this.withBusy(async () => {
      const cart = await this.getCart();
      const redemption = await this.request('/apps/loyalty/redeem', {
        method: 'POST',
        body: {
          cartToken: cart.token,
          subtotal: centsToMoney(cart.items_subtotal_price),
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
