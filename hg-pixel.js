/* Hidden Gem: Meta Pixel (one file for every page).
   - Turns on only when PIXEL_ID is set.
   - Never runs with ?preview=1.
   - No names, phones or emails go to Meta (no advanced matching, no automatic form scanning).
   - Private links (?t=, ?id=, ?lead=, ?token=) are hidden from Meta: events fire with the bare page path.
   - Conversion events are skipped for test names (Test Check, Zara Checkpoint, anything with "test"). */
(function () {
  var PIXEL_ID = '';
  var q = new URLSearchParams(location.search);
  var TEST = /\btest\b|zara checkpoint/i;
  window.hgPixel = function () {};
  if (!PIXEL_ID || q.get('preview') === '1') return;

  var n = window.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
  if (!window._fbq) window._fbq = n;
  n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];

  var ready = false, pending = [];
  var hidden = /[?&](t|id|lead|token)=/i.test(location.search);
  function send(args) {
    if (!hidden) { window.fbq.apply(null, args); return; }
    var full = location.pathname + location.search + location.hash;
    try { history.replaceState(history.state, '', location.pathname); window.fbq.apply(null, args); }
    finally { history.replaceState(history.state, '', full); }
  }
  function fire(args) { if (ready) send(args); else pending.push(args); }

  window.fbq('set', 'autoConfig', false, PIXEL_ID);
  window.fbq('init', PIXEL_ID);
  var s = document.createElement('script');
  s.async = true; s.src = 'https://connect.facebook.net/en_US/fbevents.js';
  s.onload = function () { ready = true; pending.splice(0).forEach(send); };
  document.head.appendChild(s);

  fire(['track', 'PageView']);

  // hgPixel('Lead', {content_name: 'Start form'}, {name: 'Jane Doe', id: 'lead-id'})
  // name is only used to skip test leads; it is never sent to Meta.
  window.hgPixel = function (ev, params, opts) {
    opts = opts || {};
    if (opts.name && TEST.test(opts.name)) return;
    var a = ['track', ev, params || {}];
    if (opts.id) a.push({ eventID: String(opts.id) + '-' + ev });
    fire(a);
  };
})();
