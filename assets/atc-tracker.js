(function () {
  var WEB_APP_URL = '';
  var lastSent = {};
  var SPAM_MS  = 5000; // block same variant re-sent within 5 s (double-click guard)

  function sessionId() {
    var id = sessionStorage.getItem('es_sid');
    if (!id) { id = Math.random().toString(36).slice(2); sessionStorage.setItem('es_sid', id); }
    return id;
  }

  function process(entry) {
    if (!window.__esCustomer || !window.__esCustomer.id) return;
    var item = entry.item;
    if (!item || !item.product_id) return;
    var key = String(item.variant_id || item.product_id);
    var now = Date.now();
    if (lastSent[key] && (now - lastSent[key]) < SPAM_MS) return;
    lastSent[key] = now;
    fetch(WEB_APP_URL, {
      method: 'POST',
      mode:   'no-cors',
      body:   JSON.stringify({
        secret:         '',
        timestamp:      entry.ts || new Date().toISOString(),
        customer_id:    String(window.__esCustomer.id),
        customer_email: window.__esCustomer.email || '',
        product_id:     String(item.product_id),
        product_title:  item.product_title || item.title || '',
        variant_id:     String(item.variant_id || ''),
        variant_title:  item.variant_title || '',
        quantity:       item.quantity || '',
        page_url:       entry.pageUrl || window.location.href,
        session_id:     sessionId()
      })
    }).catch(function () {});
  }

  // Drain anything captured before this script loaded
  var q = window.__esAtcQueue || [];
  for (var i = 0; i < q.length; i++) process(q[i]);

  // Replace the array with a live processor so future captures are sent immediately
  window.__esAtcQueue = { push: function (e) { process(e); } };
})();
