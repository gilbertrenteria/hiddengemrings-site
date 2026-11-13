// Meta Pixel for Hidden Gem (dataset "Hidden Gem Website").
// Loaded by track.js on every public page. Sends no names, phones or emails to Meta.
// Events: PageView (load), ViewContent (first answer on the start form),
// Lead (name and phone saved), CompleteRegistration (full form sent),
// Schedule (call booked). Skipped for preview=1 and for test names.
(function () {
  var PIXEL_ID = '1943076276671722';
  if (!/^\d{6,}$/.test(PIXEL_ID)) return;
  var q = new URLSearchParams(location.search);
  if (q.get('preview') === '1' || q.get('nopixel') === '1') return;
  var page = location.pathname.replace(/\.html$/, '') || '/';
  if (/^\/(call|team|admin|approve-admin|font-preview)\b/.test(page)) return;
  if (window.fbq) return;

  /* standard Meta Pixel base code */
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', PIXEL_ID);
  // Private links (?t=, ?id=, ?lead=, ?token=) never reach Meta: once fbevents.js
  // has loaded, PageView fires while the address shows only the bare path.
  var hidden = /[?&](t|id|lead|token)=/i.test(location.search);
  if (!hidden) fbq('track', 'PageView');
  else (function wait(n) {
    if (!window.fbq.callMethod) { if (n < 100) setTimeout(function () { wait(n + 1); }, 100); return; }
    var full = location.pathname + location.search + location.hash;
    try { history.replaceState(history.state, '', location.pathname); fbq('track', 'PageView'); }
    finally { history.replaceState(history.state, '', full); }
  })(0);

  var TEST = /\b(test|checkpoint)\b/i;
  function once(key) { try { if (sessionStorage.getItem('hgpx_' + key)) return false; sessionStorage.setItem('hgpx_' + key, '1'); } catch (e) {} return true; }
  function evId(name) { return name + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function fire(name, params, key) {
    if (key && !once(key)) return;
    try { fbq('track', name, params || {}, { eventID: evId(name) }); } catch (e) {}
  }
  var BUDGET = { 'Under $2,000': 1500, '$2,000 to $4,000': 3000, '$4,000 to $7,000': 5500, '$7,000 to $10,000': 8500, '$10,000+': 10000 };

  // first answer on the start form
  function hookTrack() {
    var orig = window.HGTrack;
    if (!orig || orig.__px) return;
    var w = function (ev) {
      if (ev === 'quiz_start') fire('ViewContent', { content_name: 'Start form', content_category: 'Engagement ring' }, 'vc');
      return orig.apply(this, arguments);
    };
    w.__px = true; w.isHuman = orig.isHuman; window.HGTrack = w;
  }
  hookTrack(); document.addEventListener('DOMContentLoaded', hookTrack);

  // watch the lead calls the start form already makes
  if (!window.fetch || window.fetch.__px) return;
  var of = window.fetch;
  var wf = function (url, opts) {
    var u = String(url && url.url || url || ''), b = null;
    var m = /\/lead(\/partial)?$/.exec(u.split('?')[0]);
    if (m && opts && opts.method === 'POST') { try { b = JSON.parse(opts.body); } catch (e) {} }
    var p = of.apply(this, arguments);
    if (!b || TEST.test(b.name || '')) return p;
    return p.then(function (r) {
      if (r && r.ok) {
        var val = BUDGET[b.budget];
        var params = val ? { value: val, currency: 'USD', content_name: b.shape || '' } : { content_name: b.shape || '' };
        if (m[1]) fire('Lead', params, 'lead');
        else {
          fire('Lead', params, 'lead');
          fire('CompleteRegistration', params, 'done');
          if (/book a call/i.test(b.contactPref || b.contact || '')) fire('Schedule', {}, 'sched');
        }
      }
      return r;
    });
  };
  wf.__px = true; window.fetch = wf;
})();
