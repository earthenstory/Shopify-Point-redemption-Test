/* ============================================================
   assets/bundle.js
   Interactive behaviour for templates/product.bundle.json
   ============================================================ */

(function () {
  'use strict';

  // ── Purchase option toggle (One-time / Subscribe & Save) ──
  var options = document.querySelectorAll('.purchase-option');
  var freqBox = document.getElementById('freq-box');
  var sellingPlanInput = document.getElementById('bundle-selling-plan');

  options.forEach(function (opt) {
    opt.addEventListener('click', function () {
      options.forEach(function (o) { o.classList.remove('active'); });
      opt.classList.add('active');

      var type = opt.getAttribute('data-type');
      if (freqBox) {
        freqBox.classList.toggle('visible', type === 'sub');
      }

      // Clear selling plan when switching back to one-time
      if (type === 'once' && sellingPlanInput) {
        sellingPlanInput.value = '';
        sellingPlanInput.disabled = true;
      } else if (type === 'sub' && sellingPlanInput) {
        sellingPlanInput.disabled = false;
        // Auto-select the first active freq pill's plan
        var activePill = document.querySelector('.freq-pill.active');
        if (activePill) {
          sellingPlanInput.value = activePill.getAttribute('data-selling-plan-id') || '';
        }
      }
    });
  });

  // ── Frequency pill selection ──
  var freqPills = document.querySelectorAll('.freq-pill');
  freqPills.forEach(function (pill) {
    pill.addEventListener('click', function () {
      freqPills.forEach(function (p) { p.classList.remove('active'); });
      pill.classList.add('active');
      if (sellingPlanInput) {
        sellingPlanInput.value = pill.getAttribute('data-selling-plan-id') || '';
      }
    });
  });

  // ── Quantity stepper ──
  var qtyDisplay = document.getElementById('bundle-qty');
  var qtyInput   = document.getElementById('bundle-qty-input');
  var qtyMinus   = document.getElementById('bundle-qty-minus');
  var qtyPlus    = document.getElementById('bundle-qty-plus');
  var qty = 1;

  if (qtyMinus && qtyPlus) {
    qtyMinus.addEventListener('click', function () {
      qty = Math.max(1, qty - 1);
      updateQty();
    });
    qtyPlus.addEventListener('click', function () {
      qty = qty + 1;
      updateQty();
    });
  }

  function updateQty() {
    if (qtyDisplay) qtyDisplay.textContent = qty;
    if (qtyInput)   qtyInput.value = qty;
  }
})();
