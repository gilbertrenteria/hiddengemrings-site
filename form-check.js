/* Hidden Gem form checks: names, US phone numbers and real emails.
   Used by start.html (Start Your Ring Journey) and the footer newsletter.
   The Worker repeats the same checks, so nothing gets around them. */
(function () {
  var API = 'https://long-bar-d49d.gilbertrenteria.workers.dev';

  // ---- names: first letter of every word capitalized (also after - and ')
  function capName(v) {
    return String(v || '').replace(/(^|[\s\-'’])([a-zà-öø-ÿ])/g, function (m, sep, ch) { return sep + ch.toUpperCase(); });
  }
  function nameOk(v) {
    v = String(v || '').trim();
    return v.length >= 2 && /[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/.test(v) && !/\d/.test(v);
  }
  function attachName(input) {
    input.setAttribute('autocapitalize', 'words');
    input.addEventListener('input', function () {
      var pos = input.selectionStart, nv = capName(input.value);
      if (nv !== input.value) { input.value = nv; try { input.setSelectionRange(pos, pos); } catch (e) {} }
    });
    input.addEventListener('blur', function () { input.value = capName(input.value.replace(/\s+/g, ' ').trim()); });
  }

  // ---- phones: real 10 digit US number, formatted (832) 555-0123
  function phoneDigits(v) { return String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function phoneOk(v) {
    var d = phoneDigits(v);
    if (d.length !== 10) return false;
    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return false;      // area code and exchange can't start with 0 or 1
    if (/^(\d)\1{9}$/.test(d)) return false;                    // 2222222222
    if (/^\d11/.test(d)) return false;                           // 211, 311, 911 ...
    if (d.slice(3, 6) === '555' && /^01/.test(d.slice(6))) return false; // 555-01xx is reserved for movies
    if ('01234567890123456789'.indexOf(d) > -1 || '98765432109876543210'.indexOf(d) > -1) return false; // 2345678901
    return true;
  }
  function formatPhone(v) {
    var d = phoneDigits(v).slice(0, 10);
    if (d.length > 6) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
    if (d.length > 3) return '(' + d.slice(0, 3) + ') ' + d.slice(3);
    return d;
  }

  // ---- emails: right format, no fake or throwaway addresses, domain accepts mail
  var FAKE_LOCAL = /^(test|testing|tester|asdf|asdfgh|qwerty|fake|none|noemail|nomail|no|na|n\/a|abc|abcd|abc123|123|1234|12345|example|sample|email|user|aaa+|xxx+|zzz+|nobody|noreply|no-reply|donotreply|a|b|x)$/i;
  var FAKE_DOMAIN = /^(example\.(com|org|net)|test\.com|testing\.com|fake\.com|email\.test|domain\.com|mailinator\.com|guerrillamail\.com|10minutemail\.com|tempmail\.com|temp-mail\.org|yopmail\.com|trashmail\.com|sharklasers\.com|getnada\.com|dispostable\.com|throwawaymail\.com|maildrop\.cc)$/i;
  var TYPOS = {
    'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmal.com': 'gmail.com',
    'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yhoo.com': 'yahoo.com', 'yahho.com': 'yahoo.com',
    'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'hotmal.com': 'hotmail.com',
    'outlok.com': 'outlook.com', 'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com', 'outloo.com': 'outlook.com',
    'icloud.co': 'icloud.com', 'icloud.con': 'icloud.com', 'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com',
    'aol.co': 'aol.com', 'aol.con': 'aol.com', 'att.ne': 'att.net', 'comcast.ne': 'comcast.net'
  };
  // Returns { ok, msg, fix } using only the address itself (no network).
  function emailShape(v) {
    v = String(v || '').trim().toLowerCase();
    if (!v) return { ok: false, msg: '' };
    var m = v.match(/^([a-z0-9._%+'-]+)@([a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})$/);
    if (!m || /\.\./.test(v) || /^\./.test(m[1]) || /\.$/.test(m[1])) return { ok: false, msg: 'Please enter a full email, like name@gmail.com.' };
    if (TYPOS[m[2]]) return { ok: false, msg: 'Did you mean ' + m[1] + '@' + TYPOS[m[2]] + '?', fix: m[1] + '@' + TYPOS[m[2]] };
    if (FAKE_LOCAL.test(m[1]) || FAKE_DOMAIN.test(m[2])) return { ok: false, msg: 'Please use your real email.' };
    return { ok: true, email: v };
  }
  // Asks the Worker whether the domain can actually receive email.
  var cache = {};
  function emailReal(v) {
    var s = emailShape(v);
    if (!s.ok) return Promise.resolve(s);
    var domain = s.email.split('@')[1];
    if (cache[domain]) return Promise.resolve(cache[domain] === 'bad' ? { ok: false, msg: 'That email domain can\'t receive email. Please check it.' } : s);
    return fetch(API + '/email/check?email=' + encodeURIComponent(s.email))
      .then(function (r) { return r.ok ? r.json() : { ok: true, unknown: true }; })
      .then(function (j) {
        if (j && j.ok === false) { cache[domain] = 'bad'; return { ok: false, msg: j.error || 'That email can\'t receive email. Please check it.' }; }
        if (!j.unknown) cache[domain] = 'good';
        return s;
      })
      .catch(function () { return s; }); // never block a customer because our check is down
  }

  window.HGCheck = { capName: capName, nameOk: nameOk, attachName: attachName, phoneDigits: phoneDigits, phoneOk: phoneOk, formatPhone: formatPhone, emailShape: emailShape, emailReal: emailReal };
})();
