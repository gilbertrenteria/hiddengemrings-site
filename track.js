// Hidden Gem visit alerts. Only real people count: nothing is sent until the
// visitor taps, scrolls, clicks or types, so bots and link previews never
// trigger an alert. Usage: HGTrack('event', { details }, useBeacon)
(function () {
  // Meta Pixel (pixel.js decides when it may run)
  try { var px = document.createElement('script'); px.src = 'pixel.js?v=3'; px.async = true; document.head.appendChild(px); } catch (e) {}
  var API = 'https://long-bar-d49d.gilbertrenteria.workers.dev/track';
  var sid;
  try { sid = sessionStorage.getItem('hgSid'); if (!sid) { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('hgSid', sid); } }
  catch (e) { sid = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  var q = new URLSearchParams(location.search);
  var source = 'Direct or bookmark';
  var fromBio = q.get('src') === 'bio'; try { fromBio = fromBio || sessionStorage.getItem('hg_src') === 'bio'; } catch (e) {}
  if (fromBio) source = 'Instagram bio';
  else
  if (q.get('fbclid') || /facebook|instagram/i.test(q.get('utm_source') || '')) source = 'Facebook or Instagram';
  else if (q.get('utm_source')) source = q.get('utm_source');
  else if (document.referrer) { try { var h = new URL(document.referrer).hostname.replace(/^www\./, ''); if (h !== location.hostname.replace(/^www\./, '')) source = /instagram|facebook|fb\.|l\.instagram/i.test(h) ? 'Facebook or Instagram' : /google/i.test(h) ? 'Google' : h; else source = 'Inside the site'; } catch (e) {} }
  try { if (source !== 'Inside the site') sessionStorage.setItem('hgSrc', source); else source = sessionStorage.getItem('hgSrc') || source; } catch (e) {}

  var human = false, queue = [];
  function body(ev, data) {
    return JSON.stringify({ ev: ev, sid: sid, page: location.pathname.replace(/\.html$/, '') || '/', id: (q.get('id') || '').replace(/[^a-z0-9]/gi, '').slice(0, 40), src: source, data: data || {} });
  }
  function send(b, beacon) {
    try {
      if (beacon && navigator.sendBeacon) { navigator.sendBeacon(API, new Blob([b], { type: 'text/plain' })); return; }
      fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: b, keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  window.HGTrack = function (ev, data, beacon) {
    var b = body(ev, data);
    if (!human) { if (!beacon) queue.push(b); return; }
    send(b, beacon);
  };
  window.HGTrack.isHuman = function () { return human; };
  function onHuman() {
    if (human) return; human = true;
    var list = queue; queue = []; list.forEach(function (b) { send(b); });
  }
  ['pointerdown', 'touchstart', 'keydown', 'wheel'].forEach(function (t) {
    addEventListener(t, onHuman, { passive: true, once: true });
  });

  // every page counts toward the daily summary; some pages also alert
  var page = location.pathname.replace(/\.html$/, '') || '/';
  if (page === '/approve') HGTrack('approve_open');
  else if (page === '/rings' && q.get('id')) HGTrack('rings_open');
  else HGTrack('view');

  // ring collection: alert when someone looks at 3 or more rings
  if (page === '/collection') {
    var seen = {};
    document.addEventListener('click', function (e) {
      var card = e.target.closest && e.target.closest('[data-ring], .ring-card, .design-card, article, .card');
      if (!card) return;
      var t = card.querySelector('h3, h2, .name, .title');
      var name = t ? t.textContent.trim().slice(0, 60) : '';
      if (!name) return;
      seen[name] = 1;
      var names = Object.keys(seen);
      if (names.length === 3) HGTrack('collection_hot', { rings: names.join(', ') });
    }, true);
  }
})();
