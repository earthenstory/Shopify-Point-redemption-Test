/* Estimated delivery date widget. Asks for a pincode, calls the Earthen
   Delivery app's /apps/delivery/estimate proxy endpoint (Shiprocket surface
   serviceability behind it), and shows the estimated delivery date. The
   pincode is remembered in localStorage and re-checked automatically on
   future visits.

   Contexts:
   - product: uses the variant's weight (data-weight-grams).
   - cart: uses the TOTAL cart weight from /cart.js and silently re-checks
     when the cart changes (quantity edits move the weight bucket).

   If the feature is disabled server-side or the API fails, the widget stays
   in its quiet input state — never a broken UI. */

import { ThemeEvents } from '@theme/events';

const PINCODE_STORAGE_KEY = 'earthen_pincode';
const PINCODE_RE = /^[1-9][0-9]{5}$/;

class EarthenDeliveryEstimate extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = 'true';

    this.context = this.dataset.context || 'product';
    this.input = this.querySelector('[data-delivery-input]');
    this.button = this.querySelector('[data-delivery-check]');
    this.form = this.querySelector('[data-delivery-form]');
    this.result = this.querySelector('[data-delivery-result]');

    this.form?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.check();
    });
    this.input?.addEventListener('input', () => {
      this.input.value = this.input.value.replace(/\D/g, '').slice(0, 6);
    });
    this.addEventListener('click', (event) => {
      if (event.target.closest('[data-delivery-change]')) {
        this.showForm();
        this.input?.focus();
      }
    });

    if (this.context === 'cart') {
      this.handleCartChange = () => {
        // Re-estimate with the new total weight, but only when a pincode is
        // already known — never interrupt a customer mid-typing.
        clearTimeout(this.cartChangeTimer);
        this.cartChangeTimer = setTimeout(() => {
          if (this.storedPincode()) this.check({ silent: true });
        }, 600);
      };
      document.addEventListener(ThemeEvents.cartUpdate, this.handleCartChange);
      document.addEventListener(ThemeEvents.discountUpdate, this.handleCartChange);
    }

    const stored = this.storedPincode();
    if (stored) {
      if (this.input) this.input.value = stored;
      this.check({ silent: true });
    }
  }

  disconnectedCallback() {
    if (this.handleCartChange) {
      document.removeEventListener(ThemeEvents.cartUpdate, this.handleCartChange);
      document.removeEventListener(ThemeEvents.discountUpdate, this.handleCartChange);
    }
  }

  storedPincode() {
    try {
      const value = window.localStorage.getItem(PINCODE_STORAGE_KEY) || '';
      return PINCODE_RE.test(value) ? value : '';
    } catch (error) {
      return '';
    }
  }

  rememberPincode(pincode) {
    try {
      window.localStorage.setItem(PINCODE_STORAGE_KEY, pincode);
    } catch (error) {
      /* private mode — fine */
    }
  }

  async weightKg() {
    if (this.context === 'cart') {
      try {
        const response = await fetch(`${window.Theme?.routes?.cart_url || '/cart'}.js`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        const cart = await response.json();
        const grams = Number(cart?.total_weight || 0);
        this.cartWeightKg = grams > 0 ? Math.round(grams / 10) / 100 : 0;
        return this.cartWeightKg;
      } catch (error) {
        return this.cartWeightKg || 0;
      }
    }
    const grams = Number(this.dataset.weightGrams || 0);
    return grams > 0 ? grams / 1000 : 0;
  }

  async check(options = {}) {
    const pincode = (this.input?.value || '').trim() || this.storedPincode();
    if (!PINCODE_RE.test(pincode)) {
      if (!options.silent) {
        this.renderError('Please enter a valid 6-digit pincode.');
      }
      return;
    }

    this.abortController?.abort();
    this.abortController = new AbortController();
    this.setBusy(true);
    if (!options.silent) this.renderLoading();

    try {
      const params = new URLSearchParams({ pincode });
      const weight = await this.weightKg();
      if (weight > 0) params.set('weight', String(weight));

      const response = await fetch(
        `/apps/delivery/estimate?${params}`,
        {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: this.abortController.signal,
        },
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.ok === false) {
        if (response.status === 400) {
          this.renderError('Please enter a valid 6-digit pincode.');
        } else if (options.silent) {
          this.showForm();
        } else {
          this.renderError('Could not check delivery right now — please try again.');
        }
        return;
      }

      if (data.enabled === false) {
        // Feature switched off in the admin: hide the whole widget.
        this.hidden = true;
        return;
      }

      if (!data.serviceable) {
        this.renderUnserviceable(pincode);
        return;
      }

      this.rememberPincode(pincode);
      this.renderEstimate(data, pincode, weight);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (options.silent) {
        this.showForm();
      } else {
        this.renderError('Could not check delivery right now — please try again.');
      }
    } finally {
      this.setBusy(false);
    }
  }

  setBusy(busy) {
    if (this.button) this.button.disabled = busy;
  }

  showForm() {
    if (this.form) this.form.hidden = false;
    if (this.result) {
      this.result.hidden = true;
      this.result.innerHTML = '';
    }
  }

  renderLoading() {
    if (!this.result) return;
    if (this.form) this.form.hidden = false;
    this.result.hidden = false;
    this.result.innerHTML =
      '<span class="earthen-delivery__loading">' +
      '<span class="earthen-delivery__spinner" aria-hidden="true"></span>' +
      'Checking delivery date…</span>';
  }

  renderError(message) {
    if (!this.result) return;
    if (this.form) this.form.hidden = false;
    this.result.hidden = false;
    this.result.innerHTML = '';
    const error = document.createElement('span');
    error.className = 'earthen-delivery__error';
    error.textContent = message;
    this.result.appendChild(error);
  }

  renderUnserviceable(pincode) {
    if (!this.result) return;
    if (this.form) this.form.hidden = false;
    this.result.hidden = false;
    this.result.innerHTML = '';
    const error = document.createElement('span');
    error.className = 'earthen-delivery__error';
    error.textContent = `Sorry, we can't deliver to ${pincode} yet.`;
    this.result.appendChild(error);
  }

  renderEstimate(data, pincode, weightKg) {
    if (!this.result) return;
    if (this.form) this.form.hidden = true;
    this.result.hidden = false;
    this.result.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'earthen-delivery__date-row';

    const date = document.createElement('span');
    date.className = 'earthen-delivery__date';
    date.textContent =
      this.context === 'cart'
        ? `Estimated delivery: ${data.deliveryText}`
        : `Estimated delivery date: ${data.deliveryText}`;
    row.appendChild(date);

    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'earthen-delivery__change';
    change.setAttribute('data-delivery-change', '');
    change.textContent = `${pincode} · Change`;
    row.appendChild(change);

    this.result.appendChild(row);

    // Product page keeps the "Ships … from our Bengaluru warehouse" subline;
    // the cart drawer/page shows a single compact line only (date + pincode).
    if (this.context !== 'cart') {
      const meta = document.createElement('div');
      meta.className = 'earthen-delivery__meta';
      const shipDay = this.formatDispatch(data.dispatchDate);
      meta.textContent = shipDay
        ? `Ships ${shipDay} from our Bengaluru warehouse`
        : 'Ships from our Bengaluru warehouse';
      this.result.appendChild(meta);
    }
  }

  formatDispatch(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const [year, month, day] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${names[date.getUTCDay()]}, ${day} ${months[month - 1]}`;
  }
}

if (!customElements.get('earthen-delivery-estimate')) {
  customElements.define('earthen-delivery-estimate', EarthenDeliveryEstimate);
}
