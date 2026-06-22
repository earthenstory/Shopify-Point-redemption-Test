import { Component } from '@theme/component';
import { morphSection } from '@theme/section-renderer';
import { DiscountUpdateEvent } from '@theme/events';
import { fetchConfig } from '@theme/utilities';
import { cartPerformance } from '@theme/performance';

const LOYALTY_STORAGE_KEY = 'earthen_loyalty_redemption';
const LOYALTY_CODE_PREFIX = 'ESPOINTS';

/**
 * A custom element that applies a discount to the cart.
 *
 * @typedef {Object} CartDiscountComponentRefs
 * @property {HTMLElement} cartDiscountError - The error element.
 * @property {HTMLElement} cartDiscountErrorDiscountCode - The discount code error element.
 * @property {HTMLElement} cartDiscountErrorShipping - The shipping error element.
 */

/**
 * @extends {Component<CartDiscountComponentRefs>}
 */
class CartDiscount extends Component {
  requiredRefs = ['cartDiscountError', 'cartDiscountErrorDiscountCode', 'cartDiscountErrorShipping'];

  /** @type {AbortController | null} */
  #activeFetch = null;

  #createAbortController() {
    if (this.#activeFetch) {
      this.#activeFetch.abort();
    }

    const abortController = new AbortController();
    this.#activeFetch = abortController;
    return abortController;
  }

  /**
   * Handles updates to the cart note.
   * @param {SubmitEvent} event - The submit event on our form.
   */
  applyDiscount = async (event) => {
    const { cartDiscountError, cartDiscountErrorDiscountCode, cartDiscountErrorShipping } = this.refs;

    event.preventDefault();
    event.stopPropagation();

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    const discountCode = form.querySelector('input[name="discount"]');
    if (!(discountCode instanceof HTMLInputElement) || typeof this.dataset.sectionId !== 'string') return;

    const discountCodeValue = discountCode.value.trim();
    if (!discountCodeValue) return;

    const abortController = this.#createAbortController();

    try {
      const existingDiscounts = this.#existingDiscounts();
      if (existingDiscounts.includes(discountCodeValue)) return;

      cartDiscountError.classList.add('hidden');
      cartDiscountErrorDiscountCode.classList.add('hidden');
      cartDiscountErrorShipping.classList.add('hidden');

      const storedLoyaltyRedemption = readStoredLoyaltyRedemption();

      const config = fetchConfig('json', {
        body: JSON.stringify({
          discount: [...existingDiscounts, discountCodeValue].join(','),
          sections: [this.dataset.sectionId],
        }),
      });

      const response = await fetch(Theme.routes.cart_update_url, {
        ...config,
        signal: abortController.signal,
      });

      const data = await response.json();

      if (
        data.discount_codes.find((/** @type {{ code: string; applicable: boolean; }} */ discount) => {
          return discount.code === discountCodeValue && discount.applicable === false;
        })
      ) {
        await this.#restoreStoredLoyaltyDiscount(storedLoyaltyRedemption, abortController.signal);
        discountCode.value = '';
        this.#handleDiscountError('discount_code');
        return;
      }

      const newHtml = data.sections[this.dataset.sectionId];
      const parsedHtml = new DOMParser().parseFromString(newHtml, 'text/html');
      const section = parsedHtml.getElementById(`shopify-section-${this.dataset.sectionId}`);
      const discountCodes = section?.querySelectorAll('.cart-discount__pill') || [];
      if (section) {
        const codes = Array.from(discountCodes)
          .map((element) => (element instanceof HTMLLIElement ? element.dataset.discountCode : null))
          .filter(Boolean);
        // Before morphing, we need to check if the shipping discount is applicable in the UI
        // we check the liquid logic compared to the cart payload to assess whether we leveraged
        // a valid shipping discount code.
        if (
          codes.length === existingDiscounts.length &&
          codes.every((/** @type {string} */ code) => existingDiscounts.includes(code)) &&
          data.discount_codes.find((/** @type {{ code: string; applicable: boolean; }} */ discount) => {
            return discount.code === discountCodeValue && discount.applicable === true;
          })
        ) {
          await this.#restoreStoredLoyaltyDiscount(storedLoyaltyRedemption, abortController.signal);
          this.#handleDiscountError('shipping');
          discountCode.value = '';
          return;
        }
      }

      await releaseStoredLoyaltyRedemption(storedLoyaltyRedemption, data.discount_codes);
      document.dispatchEvent(new DiscountUpdateEvent(data, this.id));
      morphSection(this.dataset.sectionId, newHtml);
    } catch (error) {
    } finally {
      this.#activeFetch = null;
      cartPerformance.measureFromEvent('discount-update:user-action', event);
    }
  };

  /**
   * Handles removing a discount from the cart.
   * @param {MouseEvent | KeyboardEvent} event - The mouse or keyboard event in our pill.
   */
  removeDiscount = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (
      (event instanceof KeyboardEvent && event.key !== 'Enter') ||
      !(event instanceof MouseEvent) ||
      !(event.target instanceof HTMLElement) ||
      typeof this.dataset.sectionId !== 'string'
    ) {
      return;
    }

    const pill = event.target.closest('.cart-discount__pill');
    if (!(pill instanceof HTMLLIElement)) return;

    const discountCode = pill.dataset.discountCode;
    if (!discountCode) return;

    const existingDiscounts = this.#existingDiscounts();
    const index = existingDiscounts.indexOf(discountCode);
    if (index === -1) return;

    existingDiscounts.splice(index, 1);

    const abortController = this.#createAbortController();

    try {
      const config = fetchConfig('json', {
        body: JSON.stringify({ discount: existingDiscounts.join(','), sections: [this.dataset.sectionId] }),
      });

      const response = await fetch(Theme.routes.cart_update_url, {
        ...config,
        signal: abortController.signal,
      });

      const data = await response.json();

      document.dispatchEvent(new DiscountUpdateEvent(data, this.id));
      morphSection(this.dataset.sectionId, data.sections[this.dataset.sectionId]);
    } catch (error) {
    } finally {
      this.#activeFetch = null;
    }
  };

  async #restoreStoredLoyaltyDiscount(stored, signal) {
    if (!stored?.discountCode || typeof this.dataset.sectionId !== 'string') return;

    try {
      const config = fetchConfig('json', {
        body: JSON.stringify({
          discount: stored.discountCode,
          sections: [this.dataset.sectionId],
        }),
      });

      await fetch(Theme.routes.cart_update_url, {
        ...config,
        signal,
      });
    } catch (error) {
    }
  }

  /**
   * Handles the discount error.
   *
   * @param {'discount_code' | 'shipping'} type - The type of discount error.
   */
  #handleDiscountError(type) {
    const { cartDiscountError, cartDiscountErrorDiscountCode, cartDiscountErrorShipping } = this.refs;
    const target = type === 'discount_code' ? cartDiscountErrorDiscountCode : cartDiscountErrorShipping;
    cartDiscountError.classList.remove('hidden');
    target.classList.remove('hidden');
  }

  /**
   * Returns an array of existing discount codes.
   * @returns {string[]}
   */
  #existingDiscounts() {
    /** @type {string[]} */
    const discountCodes = [];
    const discountPills = this.querySelectorAll('.cart-discount__pill');
    for (const pill of discountPills) {
      if (pill instanceof HTMLLIElement && typeof pill.dataset.discountCode === 'string') {
        if (!isLoyaltyDiscountCode(pill.dataset.discountCode)) {
          discountCodes.push(pill.dataset.discountCode);
        }
      }
    }

    return discountCodes;
  }
}

async function releaseStoredLoyaltyRedemption(stored, cartDiscountCodes = []) {
  if (!stored?.sessionId && !stored?.discountCode) return;
  const storedDiscountCode = String(stored.discountCode || '').toUpperCase();
  const loyaltyStillApplied = cartDiscountCodes.some((discount) => {
    return String(discount?.code || '').toUpperCase() === storedDiscountCode;
  });
  if (loyaltyStillApplied) return;

  try {
    await fetch('/apps/loyalty/remove', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: stored.sessionId,
        discountCode: stored.discountCode,
      }),
      cache: 'no-store',
    });
  } catch (error) {
  } finally {
    clearStoredLoyaltyRedemption();
  }
}

function readStoredLoyaltyRedemption() {
  try {
    return JSON.parse(window.localStorage.getItem(LOYALTY_STORAGE_KEY) || 'null');
  } catch (error) {
    return null;
  }
}

function clearStoredLoyaltyRedemption() {
  try {
    window.localStorage.removeItem(LOYALTY_STORAGE_KEY);
    window.EarthenLoyalty?.clearCustomerCache?.();
  } catch (error) {
  }
}

function isLoyaltyDiscountCode(code) {
  return code.toUpperCase().startsWith(LOYALTY_CODE_PREFIX);
}

if (!customElements.get('cart-discount-component')) {
  customElements.define('cart-discount-component', CartDiscount);
}
