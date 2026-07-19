(() => {
  if (customElements.get('earthen-subscription-widget')) return;
  const STORAGE_KEY = 'earthen-subscription-basket-v1';
  const labels = {
    weekly: 'Once a week', fortnightly: 'Once in two weeks', monthly: 'Once a month',
    bimonthly: 'Once in two months', quarterly: 'Once in three months', half_yearly: 'Once in six months'
  };
  class EarthenSubscriptionWidget extends HTMLElement {
    async connectedCallback() {
      if (this.dataset.ready) return;
      this.dataset.ready = 'true';
      this.product = JSON.parse(this.querySelector('[data-product-json]').textContent);
      try {
        const response = await fetch(`/apps/subscriptions/config?product_id=${encodeURIComponent(this.dataset.productId)}`, {credentials:'same-origin'});
        this.config = await response.json();
        if (!this.config.ok || !this.config.enabled) return;
        this.querySelector('[data-interval]').innerHTML = this.config.intervals.map(value => `<option value="${value}">${labels[value] || value}</option>`).join('');
        this.querySelector('[data-saving-copy]').textContent = `Save ${this.formatPercent(this.config.baseDiscountBps)} or more on renewals. Your first order is charged at today’s normal price.`;
        this.querySelector('[data-add]').addEventListener('click', () => this.add());
        this.querySelector('[data-checkout]').addEventListener('click', () => this.checkout());
        this.querySelector('[data-clear]').addEventListener('click', () => { this.writeBasket([]); this.renderBasket(); });
        this.hidden = false;
        this.renderBasket();
      } catch (_) { /* Signup remains safely hidden when configuration is unavailable. */ }
    }
    selectedVariant() {
      const idInput = document.querySelector('form[action*="/cart/add"] [name="id"]');
      const id = String(idInput?.value || this.product.selected_or_first_available_variant?.id || '');
      return this.product.variants.find(variant => String(variant.id) === id);
    }
    add() {
      const variant = this.selectedVariant();
      const quantity = Math.max(1, Number(this.querySelector('[data-quantity]').value || 1));
      if (!variant || !variant.available) return this.feedback('This variant is currently unavailable.');
      const basket = this.readBasket();
      const existing = basket.find(line => String(line.variantId) === String(variant.id));
      if (existing) existing.quantity += quantity;
      else basket.push({
        productId: String(this.product.id), variantId: String(variant.id), sku: variant.sku || null,
        productTitle: this.product.title, variantTitle: variant.title, quantity,
        unitPricePaise: Number(variant.price)
      });
      this.writeBasket(basket);
      this.feedback('Added to your subscription basket.');
      this.renderBasket();
    }
    async checkout() {
      const basket = this.readBasket();
      if (!basket.length) return this.feedback('Your subscription basket is empty.');
      const button = this.querySelector('[data-checkout]');
      button.disabled = true;
      try {
        const intervalCode = this.querySelector('[data-interval]').value;
        const response = await fetch('/apps/subscriptions/intent', {
          method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({intervalCode, lines:basket})
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'Could not start subscription checkout');
        const cart = await fetch('/cart/add.js', {
          method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({items:basket.map(line => ({
            id:line.variantId, quantity:line.quantity,
            properties:{
              '_earthen_subscription_intent':result.signedCartReference,
              '_earthen_subscription_interval':intervalCode,
              'Purchase option':'Subscribe (activates after checkout)'
            }
          }))})
        });
        if (!cart.ok) throw new Error('Shopify could not add the subscription basket');
        this.writeBasket([]);
        window.location.assign('/cart');
      } catch (error) {
        button.disabled = false;
        this.feedback(error.message || 'Please try again.');
      }
    }
    renderBasket() {
      const basket = this.readBasket();
      const units = basket.reduce((sum, line) => sum + Number(line.quantity), 0);
      const box = this.querySelector('[data-basket]');
      box.hidden = units === 0;
      this.querySelector('[data-count]').textContent = String(units);
      if (!this.config) return;
      const tiers = [...this.config.tiers].sort((a,b) => a.minimumQuantity-b.minimumQuantity);
      const current = [...tiers].reverse().find(tier => units >= tier.minimumQuantity);
      const next = tiers.find(tier => units < tier.minimumQuantity);
      const effective = this.config.baseDiscountBps + Number(current?.additionalDiscountBps || 0);
      this.querySelector('[data-progress]').textContent = next
        ? `Future deliveries save ${this.formatPercent(effective)}. Add ${next.minimumQuantity-units} more unit(s) to unlock ${this.formatPercent(this.config.baseDiscountBps+next.additionalDiscountBps)}.`
        : `Future deliveries save ${this.formatPercent(effective)} at the highest configured tier.`;
    }
    readBasket(){ try { const value=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]'); return Array.isArray(value)?value:[]; } catch(_){ return []; } }
    writeBasket(value){ localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); document.querySelectorAll('earthen-subscription-widget').forEach(widget => widget.renderBasket?.()); }
    feedback(message){ this.querySelector('[data-feedback]').textContent=message; }
    formatPercent(bps){ return `${(Number(bps)/100).toFixed(Number(bps)%100?2:0)}%`; }
  }
  customElements.define('earthen-subscription-widget', EarthenSubscriptionWidget);
})();
