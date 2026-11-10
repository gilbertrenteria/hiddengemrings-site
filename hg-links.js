/* Shared behavior for Hidden Gem links: stepped pages with a progress bar,
   tab header, and the ESL word flash on the first headline. */
(function () {
  var HG = window.HG = window.HG || {};
  HG.API = (new URLSearchParams(location.search).get('api')) || 'https://long-bar-d49d.gilbertrenteria.workers.dev';
  HG.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  HG.cents = function (v) { var n = Number(String(v || '').replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
  HG.money = function (c) { return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 }); };

  // Split headline words so they can flash in one by one.
  HG.splitWords = function (h1) {
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3 && n.textContent.trim()) {
          var frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            var s = document.createElement('span'); s.className = 'w'; s.textContent = part; frag.appendChild(s);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1) walk(n);
      });
    })(h1);
    h1.querySelectorAll('.w').forEach(function (w, i) { w.style.animationDelay = (i * 0.09) + 's'; });
  };
  // Headline + lead stay empty until the splash closes, then flash in.
  HG.headline = function (h1, lead) {
    if (!h1) return;
    HG.splitWords(h1);
    var run = function (pause) {
      setTimeout(function () {
        h1.classList.add('go');
        var words = h1.querySelectorAll('.w').length;
        if (lead) setTimeout(function () { lead.classList.add('rv'); }, words * 90 + 250);
      }, pause * 1000);
    };
    if (window.__hgSplashOn) document.addEventListener('hg:splashdone', function () { run(0.25); }, { once: true });
    else run(0.4);
  };

  // Stepped pages: <section class="pg" data-label="...">. Returns controller.
  HG.pages = function (opts) {
    var pages = Array.prototype.slice.call(document.querySelectorAll(opts.selector || 'section.pg'));
    var bar = document.querySelector('.prog i'), lab = document.getElementById('plab'), cnt = document.getElementById('pcnt');
    var cur = -1;
    function show(i, noScroll) {
      i = Math.max(0, Math.min(pages.length - 1, i));
      if (i === cur) return;
      pages.forEach(function (p, k) { p.classList.toggle('on', k === i); });
      cur = i;
      if (bar) bar.style.width = ((i + 1) / pages.length * 100) + '%';
      if (lab) lab.textContent = pages[i].getAttribute('data-label') || '';
      if (cnt) cnt.textContent = (i + 1) + ' of ' + pages.length;
      if (!noScroll) window.scrollTo({ top: 0, behavior: 'smooth' });
      if (opts.onShow) opts.onShow(i, pages[i]);
      document.querySelectorAll('.seg button[data-go]').forEach(function (b) {
        var r = (b.getAttribute('data-go') || '').split('-').map(Number);
        b.classList.toggle('on', i >= r[0] && i <= (r[1] == null || isNaN(r[1]) ? r[0] : r[1]));
      });
    }
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-next],[data-back],[data-go]');
      if (!t) return;
      if (t.hasAttribute('data-next')) { if (!opts.canNext || opts.canNext(cur)) show(cur + 1); }
      else if (t.hasAttribute('data-back')) show(cur - 1);
      else show(Number((t.getAttribute('data-go') || '0').split('-')[0]));
    });
    show(opts.start || 0, true);
    return { show: show, get i() { return cur; }, count: pages.length, pages: pages };
  };
})();
