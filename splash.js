/* Hidden Gem entry splash, the same one the homepage opens with.
   Add to any page: <script src="splash.js" data-tagline="Your Ring Options Are Ready"></script>
   Shows once per visit for each page, with a Skip button, and respects reduced motion. */
(function () {
  var me = document.currentScript;
  var tagline = (me && me.getAttribute('data-tagline')) || 'Engagement Rings, Built Around Your Story';
  var storeKey = 'hgSplash:' + location.pathname;
  try { if (sessionStorage.getItem(storeKey)) return; } catch (e) {}

  var css = '.hg-splash{position:fixed;inset:0;z-index:9999;background:#F6F3EC;display:flex;align-items:center;justify-content:center;transition:opacity .6s ease;}' +
    '.hg-splash.hide{opacity:0;pointer-events:none;}' +
    '.hg-splash-skip{position:absolute;top:24px;right:28px;background:none;border:none;font-family:"Work Sans",sans-serif;text-transform:uppercase;letter-spacing:.14em;font-size:12px;color:#776C5C;cursor:pointer;opacity:.7;padding:6px;}' +
    '.hg-splash-skip:hover{opacity:1;color:#B99C5F;}' +
    '.hg-splash-inner{text-align:center;padding:0 20px;}' +
    '.hg-splash-logo{width:min(46vw,220px);height:auto;margin:0 auto 22px;display:block;opacity:0;transform:scale(.92);filter:drop-shadow(0 2px 16px rgba(92,77,64,.18));}' +
    '.hg-splash-logo.go{animation:hgLogoIn 1.1s cubic-bezier(.19,1,.22,1) forwards;}' +
    '@keyframes hgLogoIn{to{opacity:1;transform:scale(1);}}' +
    '.hg-splash-tag{font-family:"Work Sans",sans-serif;text-transform:uppercase;letter-spacing:.28em;font-size:clamp(12px,1.6vw,15px);color:#423529;margin:0;opacity:0;filter:blur(6px);transform:translateY(6px);}' +
    '.hg-splash-tag.go{animation:hgWIn .7s ease forwards;}' +
    '@keyframes hgWIn{0%{opacity:0;filter:blur(6px);transform:translateY(6px);}55%{opacity:1;filter:blur(0);transform:translateY(0);text-shadow:0 0 14px rgba(185,156,95,.75);}100%{opacity:1;filter:blur(0);transform:translateY(0);text-shadow:0 0 0 rgba(185,156,95,0);}}' +
    '@media(prefers-reduced-motion: reduce){.hg-splash-logo,.hg-splash-tag{animation:none!important;opacity:1!important;filter:none!important;transform:none!important;}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var el = document.createElement('div');
  el.className = 'hg-splash';
  el.innerHTML = '<button class="hg-splash-skip" type="button">Skip</button><div class="hg-splash-inner">' +
    '<img class="hg-splash-logo" src="logo-brown.png" alt="Hidden Gem"><p class="hg-splash-tag"></p></div>';
  el.querySelector('.hg-splash-tag').textContent = tagline;
  window.__hgSplashOn = true;

  function close() {
    if (el.classList.contains('hide')) return;
    el.classList.add('hide');
    window.__hgSplashOn = false;
    try { sessionStorage.setItem(storeKey, '1'); } catch (e) {}
    setTimeout(function () { el.remove(); document.dispatchEvent(new Event('hg:splashdone')); }, 650);
  }
  function start() {
    document.body.appendChild(el);
    el.querySelector('.hg-splash-skip').addEventListener('click', close);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { close(); return; }
    requestAnimationFrame(function () {
      el.querySelector('.hg-splash-logo').classList.add('go');
      setTimeout(function () { el.querySelector('.hg-splash-tag').classList.add('go'); }, 650);
    });
    setTimeout(close, 2200);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
