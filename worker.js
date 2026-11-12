// Hidden Gem — form backend (consultation, newsletter, payment options form,
// design approvals) + Instagram feed cache.
// Fully self-owned: a Cloudflare Worker on Gilbert's own account, no
// third-party form product in the loop. Sends email via the Resend API
// (an email-delivery API, not a form tool) using mail.gilbertrenteria.dev,
// a domain already verified in his Resend account for other projects.
//
// Storage: everything is saved in the existing IG_KV namespace with key
// prefixes (lead:, order:, img:), so no new binding is needed.
// Admin routes need the ADMIN_KEY secret (Settings > Variables and Secrets).

const ALLOWED_ORIGINS = new Set([
  'https://hiddengemrings.com',
  'https://www.hiddengemrings.com',
]);

// Public contact email (live Google Workspace inbox).
const PUBLIC_EMAIL = 'hello@hiddengemrings.com';
const TO_ADDRESS = PUBLIC_EMAIL;
const CLAUDE_COPY = 'gilbertrenteriaboxing@gmail.com';
const PUBLIC_PHONE = '(832) 743-7657';
const PUBLIC_TEL = '+18327437657';
const OWNER_ADDRESS = 'gilbertrenteria@yahoo.com';
const FROM_ADDRESS = 'Hidden Gem Website <forms@mail.gilbertrenteria.dev>';
const CUSTOMER_FROM = 'Hidden Gem Engagement Rings <rings@mail.gilbertrenteria.dev>';
// Surprise leads: sender name with no ring words (the inbox may be shared).
const HG_FROM = 'Hidden Gem <hello@hiddengemrings.com>';
const CUSTOMER_FROM_PRIVATE = 'Hidden Gem <team@mail.gilbertrenteria.dev>';
const SITE = 'https://hiddengemrings.com';

// Stripe — deposit is charged at checkout once the customer approves their
// design on /approve. Needs two secrets added in the Cloudflare
// dashboard (Workers > long-bar-d49d > Settings > Variables and Secrets):
//   STRIPE_SECRET_KEY      the Secret key from the Stripe Dashboard
//   STRIPE_WEBHOOK_SECRET  the signing secret for the /stripe/webhook endpoint
// Card is always offered; Affirm/Klarna/Afterpay show up automatically for
// eligible orders once turned on in Stripe Dashboard > Settings > Payment methods.
const STRIPE_API = 'https://api.stripe.com/v1';
const DEPOSIT_RATE = 0.5; // 50% non-refundable deposit, matches site policy

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://hiddengemrings.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

function newId(len = 14) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function digits(s) { return String(s || '').replace(/\D/g, ''); }

function fmtPhone(s) {
  const d = digits(s).replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(s || '');
}

function chicagoTime(ms) {
  return new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' CT';
}

// === Instagram live feed ===
// NOTE (2026-11): Hidden Gem's Instagram account was connected through
// Meta's "Unified Login" / Business Portfolio flow, so the token is a
// Facebook Graph token and media is fetched from graph.facebook.com using
// the Instagram Business Account ID below. The old graph.instagram.com
// code exchange path is kept only as a harmless fallback.

const IG_BUSINESS_ACCOUNT_ID = '17841438765221258'; // @hiddengemrings
const IG_REDIRECT_URI = 'https://long-bar-d49d.gilbertrenteria.workers.dev/instagram/callback';

// One-time manual token hand-off: open
//   https://long-bar-d49d.gilbertrenteria.workers.dev/instagram/set-token?key=YOUR_ADMIN_KEY&token=PASTE_TOKEN_HERE
// (uses the ADMIN_KEY secret, so no key lives in this public file)

async function handleSetToken(url, env) {
  const key = url.searchParams.get('key');
  const token = url.searchParams.get('token');
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response('Forbidden', { status: 403 });
  if (!token) return new Response('Missing ?token param', { status: 400 });

  await env.IG_KV.put('access_token', token);
  await env.IG_KV.put('token_obtained_at', String(Date.now()));
  await refreshMediaCache(env);

  const cached = await env.IG_KV.get('media_cache');
  const count = cached ? JSON.parse(cached).length : 0;
  return new Response(
    `Token saved. Cached ${count} image(s) from the live feed.` +
      (count === 0 ? ' If this stays at 0, the token may be missing Instagram permissions — double check it has instagram_basic access to @hiddengemrings.' : ''),
    { headers: { 'Content-Type': 'text/plain' } }
  );
}

async function handleInstagramCallback(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('Missing ?code param', { status: 400 });

  const form = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    client_secret: env.INSTAGRAM_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: IG_REDIRECT_URI,
    code,
  });
  const shortRes = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
  const shortData = await shortRes.json();
  if (!shortRes.ok || !shortData.access_token) {
    return new Response('Short-lived token exchange failed: ' + JSON.stringify(shortData), { status: 502 });
  }

  const longRes = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${env.INSTAGRAM_APP_SECRET}&access_token=${shortData.access_token}`);
  const longData = await longRes.json();
  if (!longRes.ok || !longData.access_token) {
    return new Response('Long-lived token exchange failed: ' + JSON.stringify(longData), { status: 502 });
  }

  await env.IG_KV.put('access_token', longData.access_token);
  await env.IG_KV.put('token_obtained_at', String(Date.now()));
  await refreshMediaCache(env);

  return new Response('Instagram connected — the live feed is active. You can close this tab.', {
    headers: { 'Content-Type': 'text/plain' },
  });
}

async function refreshMediaCache(env) {
  const token = await env.IG_KV.get('access_token');
  if (!token) return;
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${IG_BUSINESS_ACCOUNT_ID}/media?fields=id,media_type,media_url,thumbnail_url,permalink,timestamp&limit=12&access_token=${token}`
  );
  const data = await res.json();
  if (!res.ok || !data.data) return;
  const images = data.data
    .map((m) => ({ id: m.id, url: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url, permalink: m.permalink }))
    .filter((m) => m.url)
    .slice(0, 6);
  await env.IG_KV.put('media_cache', JSON.stringify(images));
  await env.IG_KV.put('media_cached_at', String(Date.now()));
}

async function handleInstagramFeed(env, origin) {
  const cached = await env.IG_KV.get('media_cache');
  const images = cached ? JSON.parse(cached) : [];
  return json({ ok: true, images }, 200, origin);
}

// === Input checks (same rules as form-check.js on the site) ===
function capName(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().replace(/(^|[\s\-'’])([a-zà-öø-ÿ])/g, (m, sep, ch) => sep + ch.toUpperCase());
}
function phoneOkServer(v) {
  const d = digits(v).replace(/^1(?=\d{10}$)/, '');
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return false;
  if (/^(\d)\1{9}$/.test(d) || /^\d11/.test(d)) return false;
  if (d.slice(3, 6) === '555' && /^01/.test(d.slice(6))) return false;
  if ('01234567890123456789'.includes(d) || '98765432109876543210'.includes(d)) return false;
  return true;
}
const FAKE_LOCAL = /^(test|testing|tester|asdf|asdfgh|qwerty|fake|none|noemail|nomail|no|na|abc|abcd|abc123|123|1234|12345|example|sample|email|user|aaa+|xxx+|zzz+|nobody|noreply|no-reply|donotreply|a|b|x)$/i;
const FAKE_DOMAIN = /^(example\.(com|org|net)|test\.com|testing\.com|fake\.com|email\.test|domain\.com|mailinator\.com|guerrillamail\.com|10minutemail\.com|tempmail\.com|temp-mail\.org|yopmail\.com|trashmail\.com|sharklasers\.com|getnada\.com|dispostable\.com|throwawaymail\.com|maildrop\.cc)$/i;
// Returns { ok, email } or { ok:false, error }. Looks up the domain's mail
// servers (MX) over Cloudflare DNS; if that lookup itself fails we allow it.
async function checkEmailReal(raw, env) {
  const v = String(raw || '').trim().toLowerCase();
  const m = v.match(/^([a-z0-9._%+'-]+)@([a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})$/);
  if (!m || v.includes('..') || m[1].startsWith('.') || m[1].endsWith('.')) return { ok: false, error: 'Please enter a full email, like name@gmail.com.' };
  if (FAKE_LOCAL.test(m[1]) || FAKE_DOMAIN.test(m[2])) return { ok: false, error: 'Please use your real email.' };
  const domain = m[2];
  const cached = await env.IG_KV.get(`mx:${domain}`);
  if (cached === 'good') return { ok: true, email: v };
  if (cached === 'bad') return { ok: false, error: 'That email domain can\'t receive email. Please check it.' };
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, { headers: { accept: 'application/dns-json' } });
    const j = await r.json();
    const hasMx = (j.Answer || []).some((a) => a.type === 15 && !/^0\s+\.?$/.test(String(a.data).trim()));
    if (j.Status === 0 && hasMx) { await env.IG_KV.put(`mx:${domain}`, 'good', { expirationTtl: 86400 * 30 }); return { ok: true, email: v }; }
    if (j.Status === 3 || (j.Status === 0 && !hasMx)) { await env.IG_KV.put(`mx:${domain}`, 'bad', { expirationTtl: 86400 }); return { ok: false, error: 'That email domain can\'t receive email. Please check it.' }; }
  } catch (e) { /* DNS lookup failed: don't block the customer */ }
  return { ok: true, email: v, unknown: true };
}
async function handleEmailCheck(url, env, origin) {
  const r = await checkEmailReal(url.searchParams.get('email'), env);
  return json(r.ok ? { ok: true, unknown: !!r.unknown } : { ok: false, error: r.error }, 200, origin);
}

// === Team status, lead routing and call booking ===
// The team page (/team, password = ADMIN_KEY) sets who is Online, who
// gets leads first, the weekly call hours and the rep names and emails.
// Everything lives in IG_KV:
//   team:config        reps, lead order, round-robin pointer
//   team:avail         weekly call hours + blocked dates
//   book:YYYY-MM-DD    { 'HH:MM': { leadId, name, phone } }
//   index:bookdates    list of dates that have bookings

const TZ = 'America/Chicago';
const SLOT_MIN = 30;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DEFAULT_CONFIG = {
  reps: [
    { id: 'gilbert', name: 'Gilbert', email: OWNER_ADDRESS, online: false },
    { id: 'partner', name: 'Kim', email: PUBLIC_EMAIL, online: false },
  ],
  order: 'turns', // 'turns' or a rep id
  turn: 0,
};

const DEFAULT_AVAIL = {
  days: {
    0: { on: false, from: '09:00', to: '21:00' },
    1: { on: true, from: '09:00', to: '21:00' },
    2: { on: true, from: '09:00', to: '21:00' },
    3: { on: true, from: '09:00', to: '21:00' },
    4: { on: true, from: '09:00', to: '21:00' },
    5: { on: true, from: '09:00', to: '21:00' },
    6: { on: true, from: '09:00', to: '21:00' },
  },
  blocked: [],
};

async function getConfig(env) {
  const c = await env.IG_KV.get('team:config', 'json');
  return c && Array.isArray(c.reps) ? c : JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
async function getAvail(env) {
  const a = await env.IG_KV.get('team:avail', 'json');
  return a && a.days ? a : JSON.parse(JSON.stringify(DEFAULT_AVAIL));
}

// Current Chicago date and minutes past midnight.
function chiNow(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute) };
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { date: t.toISOString().slice(0, 10), wd: t.getUTCDay() };
}
function toMins(hm) { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); }
function toHM(mins) { return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'); }
function labelTime(hm) {
  const m = toMins(hm); let h = Math.floor(m / 60); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${String(m % 60).padStart(2, '0')} ${ap}`;
}
function labelDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

// Open 30 minute slots for one date (Chicago time), minus booked ones.
async function openSlotsFor(env, dateStr, wd, avail, now) {
  const day = avail.days[wd];
  if (!day || !day.on || (avail.blocked || []).includes(dateStr)) return [];
  const booked = (await env.IG_KV.get(`book:${dateStr}`, 'json')) || {};
  const from = toMins(day.from), to = toMins(day.to);
  const earliest = dateStr === now.date ? now.mins + 60 : -1; // at least 1 hour notice today
  const out = [];
  for (let t = from; t + SLOT_MIN <= to; t += SLOT_MIN) {
    if (t < earliest) continue;
    const hm = toHM(t);
    // skip if any booked call (including older 15 minute bookings) overlaps this slot
    if (!Object.keys(booked).some((b) => { const bm = toMins(b); return bm > t - SLOT_MIN && bm < t + SLOT_MIN; })) out.push(hm);
  }
  return out;
}

async function handleSlots(env, origin) {
  const avail = await getAvail(env);
  const now = chiNow();
  const days = [];
  for (let i = 0; i < 21 && days.length < 7; i++) {
    const { date, wd } = addDays(now.date, i);
    const times = await openSlotsFor(env, date, wd, avail, now);
    if (times.length) days.push({ date, label: labelDate(date), times: times.map((t) => ({ t, label: labelTime(t) })) });
  }
  return json({ ok: true, days }, 200, origin);
}

async function handlePublicStatus(env, origin) {
  const cfg = await getConfig(env);
  return json({ ok: true, online: cfg.reps.some((r) => r.online) }, 200, origin);
}

// Picks who gets a lead right now. Returns { reps:[...], reason }.
async function routeLead(env, contact) {
  const cfg = await getConfig(env);
  const online = cfg.reps.filter((r) => r.online && r.email);
  if (contact === 'Book a call') return { reps: cfg.reps.filter((r) => r.email), reason: 'booked call, sent to everyone', mode: 'booked' };
  if (!online.length) return { reps: cfg.reps.filter((r) => r.email), reason: 'everyone was offline, sent to everyone', mode: 'offline' };
  let pick;
  if (cfg.order === 'turns') {
    pick = online[(cfg.turn || 0) % online.length];
    cfg.turn = ((cfg.turn || 0) + 1) % 1000;
    await env.IG_KV.put('team:config', JSON.stringify(cfg));
    return { reps: [pick], reason: online.length > 1 ? 'online, taking turns' : 'the only one online', mode: 'online' };
  }
  pick = online.find((r) => r.id === cfg.order) || online[0];
  return { reps: [pick], reason: pick.id === cfg.order ? 'online and first in line' : 'online (first in line was offline)', mode: 'online' };
}

function recipients(reps) {
  return Array.from(new Set([PUBLIC_EMAIL].concat(reps.map((r) => r.email), [OWNER_ADDRESS]).filter(Boolean)));
}

function teamAuth(fields, url, env) { return isAdmin(fields, url, env); }

async function handleTeamState(url, env, origin) {
  if (!teamAuth(null, url, env)) return json({ ok: false, error: 'Wrong password' }, 403, origin);
  const [cfg, avail] = await Promise.all([getConfig(env), getAvail(env)]);
  const now = chiNow();
  const leadIds = ((await env.IG_KV.get('index:leads', 'json')) || []).slice(0, 60);
  const leads = (await Promise.all(leadIds.map((id) => env.IG_KV.get(`lead:${id}`, 'json')))).filter(Boolean)
    .filter((l) => chiNow(l.receivedAt).date === now.date)
    .map((l) => ({
      name: l.name, phone: fmtPhone(l.phone), label: l.label, contact: l.contact, budget: l.budget,
      at: labelTime(toHM(chiNow(l.receivedAt).mins)), routedTo: (l.routedNames || []).join(', '), reason: l.routeReason || '',
      slot: l.slotDate ? `${labelDate(l.slotDate)} at ${labelTime(l.slotTime)}` : '',
      stage: l.stage || 'Form sent', id: l.id,
    }));
  const dates = ((await env.IG_KV.get('index:bookdates', 'json')) || []).filter((d) => d >= now.date).sort();
  const bookings = [];
  for (const d of dates.slice(0, 30)) {
    const b = (await env.IG_KV.get(`book:${d}`, 'json')) || {};
    Object.keys(b).sort().forEach((t) => bookings.push({ date: d, time: t, label: `${labelDate(d)} at ${labelTime(t)}`, name: b[t].name, phone: fmtPhone(b[t].phone) }));
  }
  return json({ ok: true, config: cfg, avail, leads, bookings, today: now.date }, 200, origin);
}

async function handleTeamUpdate(fields, url, env, origin) {
  if (!teamAuth(fields, url, env)) return json({ ok: false, error: 'Wrong password' }, 403, origin);
  const action = String(fields.action || '');
  const cfg = await getConfig(env);
  if (action === 'online') {
    const r = cfg.reps.find((x) => x.id === fields.rep);
    if (!r) return json({ ok: false, error: 'Unknown rep' }, 400, origin);
    r.online = fields.online === true || fields.online === 'true';
    r.changedAt = Date.now();
  } else if (action === 'order') {
    const o = String(fields.order || '');
    if (o !== 'turns' && !cfg.reps.some((r) => r.id === o)) return json({ ok: false, error: 'Unknown order' }, 400, origin);
    cfg.order = o;
  } else if (action === 'reps') {
    (fields.reps || []).forEach((u) => {
      const r = cfg.reps.find((x) => x.id === u.id);
      if (!r) return;
      if (u.name) r.name = String(u.name).trim().slice(0, 40);
      if (u.email && String(u.email).includes('@')) r.email = String(u.email).trim().slice(0, 120);
    });
  } else if (action === 'avail') {
    const a = fields.avail || {};
    const clean = { days: {}, blocked: [] };
    for (let i = 0; i < 7; i++) {
      const d = (a.days || {})[i] || {};
      const ok = (s) => /^\d{2}:\d{2}$/.test(String(s || ''));
      clean.days[i] = { on: !!d.on, from: ok(d.from) ? d.from : '09:00', to: ok(d.to) ? d.to : '21:00' };
    }
    clean.blocked = (a.blocked || []).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)).slice(0, 60);
    await env.IG_KV.put('team:avail', JSON.stringify(clean));
    return json({ ok: true }, 200, origin);
  } else if (action === 'cancelBooking') {
    const d = String(fields.date || ''), t = String(fields.time || '');
    const b = (await env.IG_KV.get(`book:${d}`, 'json')) || {};
    delete b[t];
    await env.IG_KV.put(`book:${d}`, JSON.stringify(b));
    return json({ ok: true }, 200, origin);
  } else {
    return json({ ok: false, error: 'Unknown action' }, 400, origin);
  }
  await env.IG_KV.put('team:config', JSON.stringify(cfg));
  return json({ ok: true, config: cfg }, 200, origin);
}

// === Payment options form (leads) ===
// Saved to KV the moment it arrives, then emailed. Idempotent on the
// client-generated id, so the page's automatic retries and the backup Send
// button can never create duplicate leads or duplicate emails.

function leadLabel(l) {
  const t = l.timeline || '';
  if (t === 'ASAP') return 'READY';
  if (t === '1-3 months') return 'WARM';
  if (t === '3-6 months') return 'PLANNING';
  if (t === 'Just looking') return 'JUST LOOKING';
  return 'NEW';
}

function isSurprise(l) { return /^yes/i.test(l.surprise || ''); }
// Customer picks windows in their own US zone; reps work in Central, so show both.
const TZ_TO_CENTRAL = { Central: 0, Eastern: -1, Mountain: 1, Pacific: 2, Alaska: 3, Hawaii: 4 };
function windowsForRep(w) {
  const m = String(w || '').match(/^(.*) (Central|Eastern|Mountain|Pacific|Alaska|Hawaii)$/);
  if (!m || m[2] === 'Central') return w || '';
  const shift = TZ_TO_CENTRAL[m[2]];
  const to24 = (h, ap) => (h % 12) + (ap === 'PM' ? 12 : 0);
  const fmt = (h) => { h = ((h % 24) + 24) % 24; return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); };
  const conv = m[1].split(', ').map((r) => {
    const x = r.match(/^(\d+)(?: (AM|PM))? to (\d+) (AM|PM)$/);
    if (!x) return r;
    const a = to24(+x[1], x[2] || x[4]), b = to24(+x[3], x[4]);
    return `${fmt(a + shift)} to ${fmt(b + shift)}`;
  }).join(', ');
  return `${w} (${conv} Central)`;
}
function contactLine(l) {
  if (isSurprise(l) && l.contact !== 'Book a call') return `SURPRISE: keep it private. Reach by ${l.reach || 'text'}${l.windows ? ', only ' + windowsForRep(l.windows) : ''}. Keep the first line neutral, no ring words.`;
  if (l.contact === 'Book a call') return `BOOKED CALL: ${labelDate(l.slotDate)} at ${labelTime(l.slotTime)} (Central). Call them at that time.`;
  if (l.routeMode === 'offline') return `Everyone was offline. ${l.contact === 'Text me' ? 'Text' : 'Call'} them first thing during business hours (9 AM to 9 PM).`;
  if (l.contact === 'Call me') return 'CALL NOW. Text first, then call within 15 minutes.';
  if (l.contact === 'Text me') return 'TEXT NOW. Text within 15 minutes with 2 to 3 matching designs from the Canva library.';
  return 'Reach out within 15 minutes.';
}
function contactShort(l) {
  if (l.contact === 'Book a call') return isSurprise(l) ? 'SURPRISE BOOKED CALL' : 'BOOKED CALL';
  const r = String(l.reach || '');
  if (isSurprise(l)) return 'SURPRISE ' + (r ? r.toUpperCase().replace(/, /g, ' + ') : 'TEXT');
  if (r && !/call/i.test(r)) return l.routeMode === 'offline' ? r.toUpperCase().replace(/, /g, ' + ') + ' AT OPENING' : r.toUpperCase().replace(/, /g, ' + ') + ' NOW';
  if (l.routeMode === 'offline') return l.contact === 'Text me' ? 'TEXT AT OPENING' : 'CALL AT OPENING';
  return l.contact === 'Call me' ? 'CALL NOW' : l.contact === 'Text me' ? 'TEXT NOW' : 'ANY';
}

const DESIGN_FIELDS = [
  ['style', 'Ring style'], ['shape', 'Stone shape'], ['carat', 'Stone size'], ['stoneType', 'Stone type'],
  ['metal', 'Metal'], ['band', 'Band style'], ['ringSize', 'Ring size'], ['engraving', 'Engraving'], ['designNotes', 'Notes'],
];

function leadRecipients(lead) {
  return Array.from(new Set([PUBLIC_EMAIL].concat(lead.routedEmails || [], [OWNER_ADDRESS]).filter(Boolean)));
}

const ABOUT_FIELDS = [['buyer', 'Who is buying'], ['surprise', 'Surprise or open'], ['decides', 'Who decides'], ['shopped', 'Shopped elsewhere']];

// Call tips built from the About you answers, so the rep knows how to open the call.
function aboutTips(a) {
  const t = [];
  if (a.buyer === 'Hoping to be proposed to') t.push('She is shopping for herself. Help her pick and offer to send the options to her partner.');
  if (a.buyer === 'Shopping together') t.push('They are choosing together. Talk to both and keep it fun.');
  if (/surprise|^yes/i.test(a.surprise || '')) t.push('Surprise proposal. Keep texts discreet and help with her ring size.');
  if (/dropping hints/i.test(a.surprise || '')) t.push('Partner does not know yet. Ask if she wants us to share options with him.');
  if (/family|friend/i.test(a.decides || '')) t.push('Someone else is helping decide. Offer to send photos they can share.');
  if (a.shopped === 'Found one but want better') t.push('HOT: already found a ring elsewhere. Ask what she liked and beat it on design and price.');
  if (a.shopped === 'Not yet') t.push('We are the first stop. Build trust and set the next call.');
  return t;
}

async function handleAbout(fields, env, origin) {
  const id = String(fields.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const key = `lead:${id}`;
  const lead = await env.IG_KV.get(key, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  if (lead.about && lead.aboutEmailed) return json({ ok: true, duplicate: true }, 200, origin);
  lead.about = Object.fromEntries(ABOUT_FIELDS.map(([k]) => [k, String(fields[k] || '').slice(0, 120)]));
  if (!lead.about.surprise && lead.surprise) lead.about.surprise = lead.surprise;
  if (!lead.about.buyer && /together/i.test(lead.surprise || '')) lead.about.buyer = 'Shopping together';
  lead.aboutAt = Date.now();
  await env.IG_KV.put(key, JSON.stringify(lead));
  const tel = digits(lead.phone).replace(/^1(?=\d{10}$)/, '');
  const rows = ABOUT_FIELDS.map(([k, label]) => [label, lead.about[k] || 'not answered'])
    .concat([['Proposing', lead.timeline], ['Budget', lead.budget], ['Phone', fmtPhone(lead.phone)]]);
  const tips = aboutTips(lead.about);
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">` +
    `<div style="display:inline-block;background:#54453A;color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:.06em">ABOUT THE BUYER</div>` +
    `<h2 style="margin:14px 0 6px">Who ${escapeHtml(lead.name)} is</h2>` +
    `<p style="margin:0 0 14px;color:#777">Lead is with: ${escapeHtml((lead.routedNames || []).join(', ') || 'everyone')}</p>` +
    `<table cellpadding="7" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v || 'n/a')}</td></tr>`).join('') + `</table>` +
    (tips.length ? `<div style="background:#F7F0E1;border-radius:10px;padding:12px 16px;margin-top:14px"><strong>How to open the call</strong><ul style="margin:6px 0 0;padding-left:18px">${tips.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '') +
    `<p style="margin-top:18px"><a href="tel:+1${tel}" style="background:#54453A;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">Call ${escapeHtml(lead.name.split(' ')[0])}</a></p></div>`;
  const sent = await sendEmail(env, { to: leadRecipients(lead), subject: `ABOUT THE BUYER: ${lead.name} (${lead.about.buyer || 'n/a'}, ${lead.about.surprise || 'n/a'})`, html });
  if (!sent.ok) return json({ ok: false, error: sent.error, saved: true }, 502, origin);
  lead.aboutEmailed = true;
  await env.IG_KV.put(key, JSON.stringify(lead));
  return json({ ok: true }, 200, origin);
}

async function handleDesign(fields, env, origin) {
  const id = String(fields.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const key = `lead:${id}`;
  const lead = await env.IG_KV.get(key, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found, send the first form again' }, 404, origin);
  if (lead.design && lead.designEmailed) return json({ ok: true, duplicate: true }, 200, origin);
  lead.design = lead.design || Object.fromEntries(DESIGN_FIELDS.map(([k]) => [k, String(fields[k] || '').slice(0, 300)]));
  if (!lead.design.shape && lead.shape) lead.design.shape = lead.shape;
  lead.designAt = lead.designAt || Date.now();
  await env.IG_KV.put(key, JSON.stringify(lead));
  const tel = digits(lead.phone).replace(/^1(?=\d{10}$)/, '');
  const rows = DESIGN_FIELDS.map(([k, label]) => [label, lead.design[k] || 'not answered'])
    .concat(lead.about ? ABOUT_FIELDS.filter(([k]) => lead.about[k]).map(([k, label]) => [label, lead.about[k]]) : [])
    .concat([['Budget', lead.budget], ['Pay', lead.pay], ['Proposing', lead.timeline], ['Reach by', lead.contact || 'n/a'], ['Phone', fmtPhone(lead.phone)]]);
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">` +
    `<div style="display:inline-block;background:#B99C5F;color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:.06em">RING STYLE</div>` +
    `<h2 style="margin:14px 0 6px">What ${escapeHtml(lead.name)} is looking for</h2>` +
    `<p style="margin:0 0 6px;color:#333"><strong>Pick 2 to 3 matching designs from the Canva library and send them by hand (${escapeHtml(contactShort(lead))}).</strong></p>` +
    `<p style="margin:0 0 14px;color:#777">Lead is with: ${escapeHtml((lead.routedNames || []).join(', ') || 'everyone')}</p>` +
    `<table cellpadding="7" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table><p style="margin-top:18px"><a href="sms:+1${tel}" style="background:#54453A;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">Text ${escapeHtml(lead.name.split(' ')[0])}</a></p></div>`;
  const sent = await sendEmail(env, { to: leadRecipients(lead), subject: `RING STYLE: ${lead.name} (${lead.design.style || 'custom'}, ${lead.design.shape || 'any shape'}, ${lead.budget || 'budget not set'})`, html });
  if (!sent.ok) return json({ ok: false, error: sent.error, saved: true }, 502, origin);
  lead.designEmailed = true;
  await env.IG_KV.put(key, JSON.stringify(lead));
  return json({ ok: true }, 200, origin);
}

// Optional: the customer leaves an email at the end, and gets a branded recap.
async function handleLeadEmail(fields, env, origin) {
  const id = String(fields.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const chk = await checkEmailReal(String(fields.email || '').slice(0, 160), env);
  if (!chk.ok) return json({ ok: false, error: chk.error }, 400, origin);
  const email = chk.email;
  const key = `lead:${id}`;
  const lead = await env.IG_KV.get(key, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  if (lead.recapSent && lead.email === email) return json({ ok: true, duplicate: true }, 200, origin);
  lead.email = email;
  await env.IG_KV.put(key, JSON.stringify(lead));

  const first = escapeHtml(lead.name.split(' ')[0]);
  const surprise = isSurprise(lead);
  const howNext = customerHowNext(lead);
  const picks = [['Ring budget', lead.budget], ['How you want to pay', lead.pay], ['Proposing', lead.timeline === 'ASAP' ? 'As soon as possible' : lead.timeline]]
    .concat(lead.design ? DESIGN_FIELDS.filter(([k]) => lead.design[k]).map(([k, l]) => [l, lead.design[k]]) : [])
    .filter(([, v]) => v);
  // Surprise: the inbox may be shared, so the sender name, subject, top line and
  // preview text say nothing about rings or proposing, and there are no photos.
  const preview = surprise ? 'Thanks for reaching out. Here is what happens next.' : 'Your picks and what happens next.';
  const html = `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preview}</div>` +
    `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;background:#F6F3EC;padding:28px;border-radius:18px;color:#453E37">` +
    `<p style="font-family:Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;font-size:12px;color:#B99C5F;margin:0 0 8px">${surprise ? 'Hidden Gem' : 'Hidden Gem Engagement Rings'}</p>` +
    `<h1 style="font-weight:500;color:#423529;margin:0 0 12px">You're all set, ${first}!</h1>` +
    `<p style="font-size:17px;line-height:1.55">${howNext}</p>` +
    `<h3 style="font-family:Arial,sans-serif;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#776C5C;margin:22px 0 8px">Your picks</h3>` +
    `<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:15px">` +
    picks.map(([k, v]) => `<tr><td style="color:#776C5C;padding-right:14px">${escapeHtml(k)}</td><td style="color:#423529;font-weight:600">${escapeHtml(v)}</td></tr>`).join('') + `</table>` +
    `<div style="background:#fff;border:1px solid #E4DACB;border-radius:14px;padding:16px 18px;margin:22px 0 0"><p style="margin:0 0 6px;font-size:17px;color:#423529"><strong>Thank you for choosing Hidden Gem.</strong></p><p style="margin:0;font-size:15.5px;line-height:1.55">Have photos or links of rings she loves? Text them to <a href="sms:${PUBLIC_TEL}" style="color:#423529">${PUBLIC_PHONE}</a> or reply to this email. We'll use them to design her perfect ring.</p></div>` +
    `<h3 style="font-family:Arial,sans-serif;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#776C5C;margin:22px 0 8px">What happens next</h3>` +
    `<ol style="font-size:16px;line-height:1.55;padding-left:20px"><li>We send ring designs that match your style and budget.</li><li>You get a secure link to check your payment options with our lending partner, right on your phone.</li><li>You approve your final design and we start making your ring. Delivered within 6 weeks.</li></ol>` +
    `<p style="margin:24px 0"><a href="${SITE}/collection" style="background:#54453A;color:#fff;padding:13px 26px;border-radius:999px;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;letter-spacing:.08em;font-size:13px;text-transform:uppercase">Browse the collection</a></p>` +
    `<p style="font-family:Arial,sans-serif;font-size:12.5px;color:#776C5C;line-height:1.55">Questions? Call or text <a href="tel:${PUBLIC_TEL}" style="color:#776C5C">${PUBLIC_PHONE}</a> or just reply to this email. Financing is offered through our approved lending partners and is subject to their credit approval. Hidden Gem never asks for your Social Security number, income or bank details. <a href="${SITE}/policies" style="color:#776C5C">Our policies</a></p></div>`;
  const subject = surprise ? 'Your Hidden Gem request' : `Your Hidden Gem ring picks, ${lead.name.split(' ')[0]}`;
  const sent = await sendEmail(env, { to: [email], subject, html, replyTo: PUBLIC_EMAIL, from: surprise ? CUSTOMER_FROM_PRIVATE : CUSTOMER_FROM });
  if (!sent.ok) return json({ ok: false, error: sent.error, saved: true }, 502, origin);
  lead.recapSent = true;
  await env.IG_KV.put(key, JSON.stringify(lead));
  return json({ ok: true }, 200, origin);
}

async function handleLead(fields, request, env, origin) {
  if (fields._honey) return json({ ok: true }, 200, origin);
  const id = String(fields.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const name = capName(fields.name).slice(0, 120);
  const phone = fmtPhone(String(fields.phone || '').trim().slice(0, 40));
  if (!id || name.length < 2 || /\d/.test(name)) return json({ ok: false, error: 'Please enter your first and last name.' }, 400, origin);
  if (!phoneOkServer(phone)) return json({ ok: false, error: 'Please enter a real 10 digit mobile number.' }, 400, origin);
  const key = `lead:${id}`;
  const existing = await env.IG_KV.get(key, 'json');
  if (existing && existing.emailed) return json({ ok: true, duplicate: true, mode: existing.routeMode, slot: existing.slotDate ? { date: existing.slotDate, time: existing.slotTime, label: `${labelDate(existing.slotDate)} at ${labelTime(existing.slotTime)}` } : null }, 200, origin);

  const pick = (k) => String(fields[k] || '').slice(0, 80);
  const lead = existing || {
    id, name, phone,
    budget: pick('budget'), pay: pick('pay'), monthly: pick('monthly'),
    timeline: pick('timeline'), credit: pick('credit'), contact: pick('contact'), shape: pick('shape'),
    surprise: pick('surprise'), reach: pick('reach'), windows: String(fields.windows || '').slice(0, 160),
    windowsCentral: windowsForRep(String(fields.windows || '').slice(0, 160)),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(fields.email || '')) ? String(fields.email).slice(0, 160) : '',
    tzName: /^[A-Za-z_]+\/[A-Za-z_\/-]+$/.test(String(fields.tzName || '')) ? String(fields.tzName).slice(0, 40) : '',
    page: pick('page'), receivedAt: Date.now(), status: 'new',
    ua: (request.headers.get('User-Agent') || '').slice(0, 200),
  };
  lead.label = leadLabel(lead);
  if (!lead.journey) stampStage(lead, 'Form sent');

  // Book the call slot (first time only).
  if (lead.contact === 'Book a call' && !lead.slotDate) {
    const d = String(fields.slotDate || ''), t = String(fields.slotTime || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(t)) return json({ ok: false, error: 'Please pick a call time' }, 400, origin);
    const avail = await getAvail(env);
    const [y, m, dd] = d.split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    const open = await openSlotsFor(env, d, wd, avail, chiNow());
    if (!open.includes(t)) return json({ ok: false, error: 'slot_taken' }, 409, origin);
    const booked = (await env.IG_KV.get(`book:${d}`, 'json')) || {};
    booked[t] = { leadId: id, name, phone };
    await env.IG_KV.put(`book:${d}`, JSON.stringify(booked));
    const dates = (await env.IG_KV.get('index:bookdates', 'json')) || [];
    if (!dates.includes(d)) { dates.push(d); await env.IG_KV.put('index:bookdates', JSON.stringify(dates.sort().slice(-200))); }
    lead.slotDate = d; lead.slotTime = t;
    stampStage(lead, 'Call booked');
  }

  if (!lead.routedEmails) {
    const r = await routeLead(env, lead.contact);
    lead.routedEmails = r.reps.map((x) => x.email);
    lead.routedNames = r.reps.map((x) => x.name);
    lead.routeReason = r.reason;
    lead.routeMode = r.mode;
  }
  if (!lead.portalToken) {
    // every new lead gets their Ring Portal link right away
    const pt = newId(16);
    await env.IG_KV.put(`portal:${pt}`, JSON.stringify({ t: pt, leadId: id, createdAt: Date.now(), answers: {}, msgs: [], inspo: [] }));
    lead.portalToken = pt;
  }
  await env.IG_KV.put(key, JSON.stringify(lead));
  await addToIndex(env, 'index:leads', id);

  const tel = digits(phone).replace(/^1(?=\d{10}$)/, '');
  const rows = [
    ['Name', lead.name],
    ...(lead.shape ? [['Shape she loves', lead.shape]] : []),
    ['Phone', `<a="tel:+1${tel}">${escapeHtml(fmtPhone(lead.phone))}</a> (tap to call)`],
    ['Ring budget', lead.budget],
    ['How they want to pay', lead.pay],
    ...(lead.surprise ? [['Surprise?', lead.surprise]] : []),
    ['Reach by', lead.reach || lead.contact || 'not answered'],
    ...(lead.windows ? [['Best times', windowsForRep(lead.windows)]] : []),
    ...(lead.email ? [['Email', lead.email]] : []),
    ['Comfortable monthly', lead.monthly || 'n/a'],
    ['Proposing', lead.timeline],
    ['Credit (self reported)', lead.credit || 'not answered'],
    ['Sent to', `${(lead.routedNames || []).join(', ')} (${lead.routeReason})`],
    ['Ring Portal', lead.portalToken ? `${portalLink(lead.portalToken)} (preview: add &preview=1)` : ''],
    ['Received', chicagoTime(lead.receivedAt)],
    ['Approximate location', (() => { const c = request.cf || {}; const t = [c.city, c.regionCode || c.region].filter(Boolean).join(', '); return t ? t + (c.postalCode ? ' (near ' + c.postalCode + ')' : '') : 'Unknown'; })()],
  ];
  const color = { 'READY': '#1f7a3a', 'WARM': '#b07a12', 'PLANNING': '#5b6b8a', 'JUST LOOKING': '#777' }[lead.label] || '#54453A';
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:560px">` +
    `<div style="display:inline-block;background:${color};color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:.06em">${lead.label}</div> ` +
    `<div style="display:inline-block;background:#423529;color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:.06em">${escapeHtml(contactShort(lead))}</div>` +
    `<h2 style="margin:14px 0 6px">New lead: ${escapeHtml(lead.name)}</h2>` +
    `<p style="margin:0 0 14px;color:#333;font-size:16px"><strong>${escapeHtml(contactLine(lead))}</strong></p>` +
    `<table cellpadding="7" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${k === 'Phone' ? v : escapeHtml(v)}</td></tr>`).join('') +
    `</table>` +
    `<p style="margin-top:18px"><a href="sms:+1${tel}" style="background:#54453A;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700;margin-right:8px">Text ${escapeHtml(lead.name.split(' ')[0])}</a> <a href="tel:+1${tel}" style="background:#fff;color:#54453A;border:2px solid #54453A;padding:10px 20px;border-radius:999px;text-decoration:none;font-weight:700">Call</a></p>` +
    `<p style="color:#777;font-size:13px">Team page: <a href="${SITE}/team">${SITE}/team</a></p>` +
    `</div>`;

  const who = (lead.routedNames || []).length === 1 ? ` for ${lead.routedNames[0]}` : '';
  const sent = await sendEmail(env, {
    to: leadRecipients(lead),
    subject: `${contactShort(lead)}${who}: ${lead.label} lead, ${lead.name}, ${lead.budget || 'budget not set'}`,
    html,
  });
  const slot = lead.slotDate ? { date: lead.slotDate, time: lead.slotTime, label: `${labelDate(lead.slotDate)} at ${labelTime(lead.slotTime)}` } : null;
  if (!sent.ok) return json({ ok: false, error: sent.error, saved: true }, 502, origin);
  lead.emailed = true;
  lead.emailedAt = Date.now();
  await env.IG_KV.put(key, JSON.stringify(lead));
  return json({ ok: true, mode: lead.routeMode, slot }, 200, origin);
}

// Safety net: every 10 minutes, any saved lead whose email never went out is
// emailed again, so a filled form can never be missed.
async function resendUnsentLeads(env) {
  const ids = ((await env.IG_KV.get('index:leads', 'json')) || []).slice(0, 25);
  for (const id of ids) {
    const lead = await env.IG_KV.get(`lead:${id}`, 'json');
    if (!lead || lead.emailed || !lead.name || !lead.phone) continue;
    if (Date.now() - (lead.receivedAt || 0) > 3 * 86400000) continue;
    if ((lead.receivedAt || 0) < 1794436000000) continue; // skip old test leads from before the safety check existed
    const tel = digits(lead.phone).replace(/^1(?=\d{10}$)/, '');
    const rows = [['Name', lead.name], ['Phone', lead.phone], ['Prefers', lead.contact || ''], ['Budget', lead.budget || ''], ['Received', chicagoTime(lead.receivedAt)]];
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h2 style="margin:0 0 10px">New lead (resent by the safety check)</h2><table cellpadding="6">` +
      rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C">${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('') +
      `</table><p><a href="tel:+1${tel}">Call ${escapeHtml(lead.name.split(' ')[0])}</a> · <a href="${SITE}/team">Team page</a></p></div>`;
    const sent = await sendEmail(env, { to: leadRecipients(lead), subject: `RESENT: ${lead.label || 'Website'} lead, ${lead.name}`, html });
    if (sent.ok) { lead.emailed = true; lead.emailedAt = Date.now(); lead.resent = true; await env.IG_KV.put(`lead:${id}`, JSON.stringify(lead)); }
  }
}

async function addToIndex(env, indexKey, id) {
  const list = (await env.IG_KV.get(indexKey, 'json')) || [];
  if (!list.includes(id)) {
    list.unshift(id);
    await env.IG_KV.put(indexKey, JSON.stringify(list.slice(0, 500)));
  }
}

// === Stripe payments ===
// Minimal hand-rolled Stripe client (form-encoded REST calls) — no SDK/build
// step needed, matches how this Worker is deployed (plain worker.js).

// Turns a free-typed price like "$4,500" or "4500.00" into whole cents.
function parseMoneyCents(str) {
  const m = String(str || '').match(/[\d,]+(\.\d{1,2})?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// Flattens a nested object/array into Stripe's bracket form-encoding,
// e.g. { a: { b: 1 } } -> "a[b]=1", { a: [{ b: 1 }] } -> "a[0][b]=1".
function toStripeForm(params, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') out.push(...toStripeForm(item, `${key}[${i}]`));
        else out.push([`${key}[${i}]`, item]);
      });
    } else if (typeof v === 'object') {
      out.push(...toStripeForm(v, key));
    } else {
      out.push([key, v]);
    }
  }
  return out;
}

async function stripeRequest(env, path, params) {
  const body = new URLSearchParams(toStripeForm(params));
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: (data.error && data.error.message) || `Stripe ${res.status}` };
  return { ok: true, data };
}

// Verifies the Stripe-Signature header per Stripe's documented scheme
// (HMAC-SHA256 of "timestamp.payload" using the webhook signing secret).
async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = Object.fromEntries(String(sigHeader || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(`${parts.t}.${payload}`));
  const hex = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === parts.v1;
}

// Creates a Checkout Session for the order's deposit and returns its URL.
// Requires the order to already be approved, matching the site's existing
// "approve first, then pay" flow.
function orderTotalCents(o) { return parseMoneyCents(o.price); }
function money(c) { return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Creates a Checkout Session and returns its URL. plan:
//   full    = whole price (card, Cash App, Apple Pay, Klarna, Affirm)
//   deposit = 50% non-refundable deposit, balance before shipping
//   balance = the remaining 50% after a deposit
// Requires the design to be approved first ("approve first, then pay").
async function handleOrderCheckout(id, fields, env, origin) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ ok: false, error: `Payments are not turned on yet. Please call ${PUBLIC_PHONE}.` }, 503, origin);
  }
  const key = `order:${id}`;
  const o = await env.IG_KV.get(key, 'json');
  if (!o) return json({ ok: false, error: 'Order not found' }, 404, origin);
  if (!o.approval) return json({ ok: false, error: 'Please approve your design first.' }, 400, origin);
  if (o.paidInFull) return json({ ok: true, alreadyPaid: true }, 200, origin);

  const totalCents = orderTotalCents(o);
  if (!totalCents) return json({ ok: false, error: `We could not read the price on this order. Please call ${PUBLIC_PHONE}.` }, 400, origin);
  const depositCents = Math.round(totalCents * DEPOSIT_RATE);
  let plan = String((fields && fields.plan) || 'deposit');
  if (o.paid) plan = 'balance'; // deposit already in: only the balance is left
  if (!['full', 'finance', 'deposit', 'balance'].includes(plan)) plan = 'deposit';
  const amount = plan === 'full' || plan === 'finance' ? totalCents : plan === 'deposit' ? depositCents : totalCents - (o.amountPaidCents || depositCents);
  if (amount < 50) return json({ ok: false, error: 'Nothing left to pay on this order.' }, 400, origin);
  const label = plan === 'finance' ? 'Monthly payments' : plan === 'full' ? 'Paid in full' : plan === 'deposit' ? '50% deposit' : 'Remaining balance';
  const page = o.options ? 'rings' : 'approve';

  const base = {
    mode: 'payment',
    billing_address_collection: 'required',
    shipping_address_collection: { allowed_countries: ['US'] },
    client_reference_id: o.id,
    customer_email: o.customerEmail || undefined,
    success_url: `${SITE}/${page}?id=${o.id}&paid=1`,
    cancel_url: `${SITE}/${page}?id=${o.id}`,
    metadata: { order_id: o.id, plan },
    payment_intent_data: { metadata: { order_id: o.id, plan }, description: `Hidden Gem ${label} — ${o.ring || 'custom ring'} (Order ${o.id})` },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amount,
        product_data: { name: `Hidden Gem — ${label} — ${o.ring || 'custom ring'}`, description: `Order ${o.id} · ${o.customerName}` },
      },
    }],
  };
  // Monthly payments: show only the financing options at checkout. Tries
  // Affirm + Klarna, then Klarna alone (Affirm may still be in review),
  // then falls back to the normal checkout with every method.
  const tries = plan === 'finance' ? [['affirm', 'klarna'], ['klarna'], null] : [null];
  let session;
  for (const types of tries) {
    session = await stripeRequest(env, '/checkout/sessions', types ? { ...base, payment_method_types: types } : base);
    if (session.ok) break;
  }
  if (!session.ok) return json({ ok: false, error: session.error }, 502, origin);
  return json({ ok: true, url: session.data.url }, 200, origin);
}

// Stripe calls this directly (server-to-server) once a Checkout Session
// completes. Marks the order paid in KV and emails the team.
async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response('Webhook not configured', { status: 500 });
  const sig = request.headers.get('Stripe-Signature') || '';
  const payload = await request.text();
  const valid = await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Invalid signature', { status: 400 });

  let event;
  try { event = JSON.parse(payload); } catch (e) { return new Response('Bad JSON', { status: 400 }); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = (session.metadata && session.metadata.order_id) || session.client_reference_id;
    if (orderId) {
      const key = `order:${orderId}`;
      const o = await env.IG_KV.get(key, 'json');
      const plan = (session.metadata && session.metadata.plan) || 'deposit';
      const already = o && (o.payments || []).some((p) => p.session === session.id);
      if (o && !already) {
        o.payments = (o.payments || []).concat([{ session: session.id, plan, cents: session.amount_total, at: Date.now() }]);
        o.amountPaidCents = (o.amountPaidCents || 0) + (session.amount_total || 0);
        o.paid = true;
        o.paidAt = o.paidAt || Date.now();
        o.stripeSessionId = session.id;
        o.plan = o.plan && plan === 'balance' ? o.plan : plan;
        if (plan === 'full' || plan === 'finance' || plan === 'balance' || o.amountPaidCents >= (orderTotalCents(o) || Infinity)) o.paidInFull = true;
        await env.IG_KV.put(key, JSON.stringify(o));
        await markStage(env, o.leadId, plan === 'deposit' ? 'Deposit paid' : plan === 'finance' ? 'Financed' : 'Paid in full');
        const total = orderTotalCents(o) || 0;
        const left = Math.max(0, total - o.amountPaidCents);
        const what = plan === 'finance' ? 'FINANCED IN FULL' : plan === 'full' ? 'PAID IN FULL' : plan === 'deposit' ? 'DEPOSIT PAID' : 'BALANCE PAID';
        await sendEmail(env, {
          to: [OWNER_ADDRESS, TO_ADDRESS],
          subject: `${what}: ${o.customerName} paid ${money(session.amount_total)} (${o.ring})`,
          html: `<div style="font-family:Arial,sans-serif;max-width:560px"><div style="display:inline-block;background:#1f7a3a;color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:.06em">${what}</div><h2 style="margin:14px 0 6px">${escapeHtml(o.customerName)} paid ${money(session.amount_total)}</h2><p>${escapeHtml(o.ring)} · ${escapeHtml(o.metal || '')} · size ${escapeHtml(o.size || 'n/a')}</p><p>Order total ${money(total)} · paid so far ${money(o.amountPaidCents)} · <strong>${left ? 'balance due before shipping ' + money(left) : 'nothing left to pay'}</strong></p><p>Financing or card is shown in Stripe: <a href="https://dashboard.stripe.com/payments">dashboard.stripe.com/payments</a></p><p style="color:#777;font-size:13px">Order ${o.id} · Stripe session ${escapeHtml(session.id)}</p></div>`,
        });
      }
    }
  }
  return new Response('ok', { status: 200 });
}

// === Design approvals ===
// Gilbert creates an order from /admin (needs ADMIN_KEY). The
// customer opens /approve?id=..., checks the final-sale box, types
// their full name and approves. The approval is saved with the date, time,
// IP and device, and a copy is emailed to Gilbert and to the customer.

function isAdmin(fields, url, env) {
  const key = (fields && fields.key) || url.searchParams.get('key') || '';
  return !!env.ADMIN_KEY && key === env.ADMIN_KEY;
}

function publicOrder(o) {
  return {
    id: o.id, customerName: o.customerName, ring: o.ring, metal: o.metal, stone: o.stone,
    size: o.size, engraving: o.engraving, price: o.price, payment: o.payment, notes: o.notes,
    hasImage: !!o.hasImage, delivery: o.ready ? 'Ships within 3 to 5 business days after payment' : 'Within 6 weeks of approval and completed payment or financing',
    createdAt: o.createdAt, approved: !!o.approval,
    approval: o.approval ? { name: o.approval.name, at: o.approval.at } : null,
    paid: !!o.paid, paidInFull: !!o.paidInFull, plan: o.plan || '', amountPaidCents: o.amountPaidCents || 0,
    payPref: o.payPref || '', ready: !!o.ready,
    options: o.options ? o.options.map((x, i) => ({ i, name: x.name, metal: x.metal, stone: x.stone, price: x.price, ready: !!x.ready, noResize: !!x.noResize, hasImage: !!x.hasImage, imageUrl: x.imageUrl || '' })) : null,
    imageUrl: o.imageUrl || '',
    brief: o.brief || [], chosen: o.chosen == null ? null : o.chosen, sizeMethod: o.sizeMethod || '', sizeEstimated: !!o.sizeEstimated,
  };
}

const READY_DELIVERY = 'Ships within 3 to 5 business days after payment';
const CUSTOM_DELIVERY = 'Within 6 weeks of approval and completed payment or financing';

// Ring options: up to 10 rings for one customer on one link (/rings).
async function handleOptionsCreate(fields, env, origin, url) {
  if (!isAdmin(fields, url, env)) return json({ ok: false, error: 'Wrong admin key' }, 403, origin);
  const s = (v, n = 200) => String(v || '').trim().slice(0, n);
  const raw = Array.isArray(fields.options) ? fields.options.slice(0, 10) : [];
  const okUrl = (u) => /^https:\/\/(ring\.gilbertrenteria\.dev|hiddengemrings\.com)\/[\w\-./]+\.(webp|jpg|jpeg|png)$/i.test(u) ? u : '';
  const options = raw.map((x) => ({ name: s(x.name, 120), metal: s(x.metal, 60), stone: s(x.stone, 300), price: s(x.price, 40), ready: !!x.ready, noResize: !!x.noResize, image: String(x.image || ''), imageUrl: okUrl(String(x.imageUrl || '')) }))
    .filter((x) => x.name && parseMoneyCents(x.price));
  const order = {
    id: newId(), type: 'options',
    customerName: s(fields.customerName, 120), customerPhone: s(fields.customerPhone, 40), customerEmail: s(fields.customerEmail, 160),
    payPref: s(fields.payPref, 40), leadId: s(fields.leadId, 48), notes: s(fields.notes, 800), engraving: s(fields.engraving, 120),
    createdAt: Date.now(), hasImage: false, ring: '', price: '', metal: '', stone: '', size: '', chosen: null,
  };
  // Everything gathered on the form and the call, shown to the customer as
  // "Built from what you told us" on their Pick Your Ring page.
  const brief = fields.brief && typeof fields.brief === 'object' ? fields.brief : {};
  order.brief = Object.keys(brief).slice(0, 16).map((k) => [String(k).slice(0, 40), String(brief[k] || '').slice(0, 160)]).filter((x) => x[1]);
  if (order.leadId) {
    const lead = await env.IG_KV.get(`lead:${order.leadId}`, 'json');
    if (lead) {
      if (!order.customerEmail && lead.email) order.customerEmail = lead.email;
      if (!order.customerPhone) order.customerPhone = lead.phone || '';
      if (!order.payPref) order.payPref = lead.pay || '';
      lead.orderId = order.id; lead.status = 'link sent'; lead.statusAt = Date.now();
      stampStage(lead, 'Options sent');
      await env.IG_KV.put(`lead:${order.leadId}`, JSON.stringify(lead));
    }
  }
  if (!order.customerName) return json({ ok: false, error: 'Customer name is required' }, 400, origin);
  if (!options.length) return json({ ok: false, error: 'Add at least one ring with a name and a price' }, 400, origin);
  for (let i = 0; i < options.length; i++) {
    const img = options[i].image;
    if (img.startsWith('data:image/')) {
      if (img.length > 6_000_000) return json({ ok: false, error: `Ring ${i + 1} photo is too large` }, 400, origin);
      await env.IG_KV.put(`img:${order.id}:${i}`, img);
      options[i].hasImage = true;
    }
    delete options[i].image;
  }
  order.options = options;
  await env.IG_KV.put(`order:${order.id}`, JSON.stringify(order));
  await addToIndex(env, 'index:orders', order.id);
  return json({ ok: true, id: order.id, link: `${SITE}/rings?id=${order.id}` }, 200, origin);
}

// The customer picks a ring and a size. Allowed until the design is signed.
async function handleOptionsChoose(id, fields, env, origin) {
  const key = `order:${id}`;
  const o = await env.IG_KV.get(key, 'json');
  if (!o || !o.options) return json({ ok: false, error: 'Order not found' }, 404, origin);
  await clearTestApproval(o, key, env);
  if (o.approval) return json({ ok: false, error: 'This design is already approved.' }, 400, origin);
  const i = Number(fields.index);
  const opt = o.options[i];
  if (!opt) return json({ ok: false, error: 'Please pick a ring' }, 400, origin);
  const size = Number(fields.size);
  if (!isFinite(size) || size < 3 || size > 13) return json({ ok: false, error: 'Please pick a ring size between 3 and 13' }, 400, origin);
  const method = String(fields.sizeMethod || 'known');
  if (!['known', 'measured', 'estimate'].includes(method)) return json({ ok: false, error: 'Please choose how you found the size' }, 400, origin);
  if (method === 'estimate' && opt.noResize) return json({ ok: false, error: 'This ring can\'t be resized, so we need her exact size. Please measure a ring she wears or tell us her size.' }, 400, origin);
  o.chosen = i;
  o.ring = opt.name; o.metal = opt.metal; o.stone = opt.stone; o.price = opt.price; o.ready = !!opt.ready;
  o.sizeMethod = method;
  o.sizeEstimated = method !== 'known';
  const detail = String(fields.sizeDetail || '').trim().slice(0, 160);
  const how = method === 'known' ? 'known size' : method === 'measured' ? `measured from her ring${detail ? ', ' + detail : ''}` : `estimated${detail ? ', ' + detail : ''}`;
  o.size = `${size} (${how})${o.sizeEstimated && !opt.noResize ? ' · free resize within 1 year, up to 2 sizes' : ''}`;
  o.imageUrl = opt.imageUrl || '';
  if (opt.hasImage) {
    const img = await env.IG_KV.get(`img:${id}:${i}`);
    if (img) { await env.IG_KV.put(`img:${id}`, img); o.hasImage = true; }
  } else o.hasImage = false;
  const photo = String(fields.sizePhoto || '');
  if (photo.startsWith('data:image/') && photo.length < 6_000_000) { await env.IG_KV.put(`img:${id}:size`, photo); o.hasSizePhoto = true; }
  await env.IG_KV.put(key, JSON.stringify(o));
  await markStage(env, o.leadId, 'Ring picked');
  return json({ ok: true, order: publicOrder(o) }, 200, origin);
}

async function handleOrderSeen(id, env, origin) {
  const o = await env.IG_KV.get(`order:${id}`, 'json');
  if (!o) return json({ ok: false }, 404, origin);
  if (!o.seenAt) { o.seenAt = Date.now(); await env.IG_KV.put(`order:${id}`, JSON.stringify(o)); await markStage(env, o.leadId, 'Options opened'); }
  return json({ ok: true }, 200, origin);
}

async function handleOptionImage(id, i, env) {
  const data = await env.IG_KV.get(`img:${id}:${i}`);
  if (!data) return new Response('Not found', { status: 404 });
  const m = data.match(/^data:(image\/[a-z+]+);base64,(.*)$/);
  if (!m) return new Response('Bad image', { status: 500 });
  const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' } });
}

async function handleOrderCreate(fields, env, origin, url) {
  if (!isAdmin(fields, url, env)) return json({ ok: false, error: 'Wrong admin key' }, 403, origin);
  const s = (k, n = 200) => String(fields[k] || '').trim().slice(0, n);
  const order = {
    id: newId(),
    customerName: s('customerName', 120), customerPhone: s('customerPhone', 40), customerEmail: s('customerEmail', 160),
    ring: s('ring', 120), metal: s('metal', 60), stone: s('stone', 300), size: s('size', 20),
    engraving: s('engraving', 120), price: s('price', 40), payment: s('payment', 60), notes: s('notes', 800),
    createdAt: Date.now(), hasImage: false,
  };
  if (!order.customerName || !order.ring || !order.price) {
    return json({ ok: false, error: 'Customer name, ring and price are required' }, 400, origin);
  }
  const img = String(fields.image || '');
  if (img.startsWith('data:image/')) {
    if (img.length > 6_000_000) return json({ ok: false, error: 'Image too large' }, 400, origin);
    await env.IG_KV.put(`img:${order.id}`, img);
    order.hasImage = true;
  }
  await env.IG_KV.put(`order:${order.id}`, JSON.stringify(order));
  await addToIndex(env, 'index:orders', order.id);
  return json({ ok: true, id: order.id, link: `${SITE}/approve?id=${order.id}` }, 200, origin);
}

// A rep test approval (typed name starting with "Test") never locks the customer's link.
async function clearTestApproval(o, key, env) {
  if (!o || !o.approval || !/^\s*test\b/i.test(o.approval.name || '')) return false;
  o.approval = null;
  if (o.options) { o.chosen = null; o.ring = ''; o.metal = ''; o.stone = ''; o.price = ''; o.size = ''; o.sizeMethod = ''; o.sizeEstimated = false; o.hasImage = false; o.imageUrl = ''; }
  await env.IG_KV.put(key, JSON.stringify(o));
  return true;
}

async function handleOrderGet(id, env, origin) {
  const o = await env.IG_KV.get(`order:${id}`, 'json');
  await clearTestApproval(o, `order:${id}`, env);
  if (!o) return json({ ok: false, error: 'Order not found' }, 404, origin);
  return json({ ok: true, order: publicOrder(o) }, 200, origin);
}

async function handleOrderImage(id, env) {
  const data = await env.IG_KV.get(`img:${id}`);
  if (!data) return new Response('Not found', { status: 404 });
  const m = data.match(/^data:(image\/[a-z+]+);base64,(.*)$/);
  if (!m) return new Response('Bad image', { status: 500 });
  const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' } });
}

async function handleOrderApprove(id, fields, request, env, origin) {
  const key = `order:${id}`;
  const o = await env.IG_KV.get(key, 'json');
  if (!o) return json({ ok: false, error: 'Order not found' }, 404, origin);
  await clearTestApproval(o, key, env);
  if (o.approval && o.approval.emailed) return json({ ok: true, order: publicOrder(o), duplicate: true }, 200, origin);

  if (o.options && o.chosen == null) return json({ ok: false, error: 'Please pick your ring and size first.' }, 400, origin);
  const typed = String(fields.name || '').trim().slice(0, 120);
  const agreed = fields.agree === true || fields.agree === 'true';
  if (!agreed || typed.length < 3) {
    return json({ ok: false, error: 'Please check the box and type your full name' }, 400, origin);
  }
  if (!o.approval) {
    o.approval = {
      name: typed, agree: true, at: Date.now(),
      ip: request.headers.get('CF-Connecting-IP') || '',
      ua: (request.headers.get('User-Agent') || '').slice(0, 300),
      terms: 'I approve this design, metal, stone, size and price. I understand this is a custom order made just for me and is final sale once approved, as described in the Hidden Gem Policies (hiddengemrings.com/policies.html).',
    };
    await env.IG_KV.put(key, JSON.stringify(o));
  }

  const rows = [
    ['Ring', o.ring], ['Metal', o.metal], ['Stone', o.stone], ['Ring size', o.size],
    ['Engraving', o.engraving || 'None'], ['Price', o.price], ['Payment', o.payment || 'n/a'],
    ['Delivery', o.ready ? READY_DELIVERY : CUSTOM_DELIVERY],
    ['Approved by (typed name)', o.approval.name], ['Approved at', chicagoTime(o.approval.at)],
    ['Agreement', o.approval.terms], ['Order ID', o.id],
  ];
  const table = `<table cellpadding="7" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('') + `</table>`;
  if (o.hasSizePhoto) rows.splice(4, 0, ['Size photo', `https://long-bar-d49d.gilbertrenteria.workers.dev/order/${o.id}/image/size`]);
  if (o.payPref) rows.push(['Payment preference (form)', o.payPref]);
  const imgSrc = o.hasImage ? `https://long-bar-d49d.gilbertrenteria.workers.dev/order/${o.id}/image` : o.imageUrl;
  const imgTag = imgSrc ? `<p><img src="${imgSrc}" alt="Approved design" style="max-width:100%;border-radius:12px"></p>` : '';

  const ownerSent = await sendEmail(env, {
    to: [OWNER_ADDRESS, TO_ADDRESS],
    subject: `APPROVED design: ${o.customerName} (${o.ring}, ${o.price})`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>Design approved by ${escapeHtml(o.customerName)}</h2>${imgTag}${table}<p style="color:#777;font-size:12px">IP ${escapeHtml(o.approval.ip)} · ${escapeHtml(o.approval.ua)}</p></div>`,
    replyTo: o.customerEmail || undefined,
  });
  const isTestApproval = /^\s*test\b/i.test(o.approval.name || '');
  if (!isTestApproval && o.customerEmail && o.customerEmail.includes('@') && !o.approval.customerEmailed) {
    const c = await sendEmail(env, {
      to: [o.customerEmail],
      subject: 'Your Hidden Gem design approval', from: CUSTOMER_FROM,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>Thank you, ${escapeHtml(o.customerName.split(' ')[0])}!</h2><p>Here is a copy of the design you approved. We'll keep you updated while your ring is being made.</p>${imgTag}${table}<p>Questions? Call or text ${PUBLIC_PHONE}, or reply to this email.</p></div>`,
      replyTo: TO_ADDRESS,
    });
    if (c.ok) o.approval.customerEmailed = true;
  }
  if (!ownerSent.ok) {
    await env.IG_KV.put(key, JSON.stringify(o));
    return json({ ok: false, error: ownerSent.error, saved: true }, 502, origin);
  }
  o.approval.emailed = true;
  await env.IG_KV.put(key, JSON.stringify(o));
  await markStage(env, o.leadId, 'Approved');
  return json({ ok: true, order: publicOrder(o) }, 200, origin);
}

// === Customer journey ===
// One timeline per lead so every link knows where the customer is.
const STAGES = ['Form sent', 'Call booked', 'Called', 'Intro opened', 'Loved rings', 'Options sent', 'Options opened', 'Ring picked', 'Approved', 'Deposit paid', 'Financed', 'Paid in full', 'In production', 'Shipped', 'Delivered', 'Not ready', 'Lost'];
function stampStage(lead, stage) {
  if (!lead || !STAGES.includes(stage)) return lead;
  lead.journey = lead.journey || [];
  const last = lead.journey[lead.journey.length - 1];
  if (!last || last.stage !== stage) lead.journey.push({ stage, at: Date.now() });
  lead.journey = lead.journey.slice(-40);
  lead.stage = stage; lead.stageAt = Date.now();
  return lead;
}
async function markStage(env, leadId, stage) {
  if (!leadId) return;
  const lead = await env.IG_KV.get(`lead:${leadId}`, 'json');
  if (!lead) return;
  stampStage(lead, stage);
  await env.IG_KV.put(`lead:${leadId}`, JSON.stringify(lead));
}

// === Customer Intro + Call Link ===
const INTRO_RINGS = ['penelope', 'selah', 'nova', 'allison', 'souline', 'aurora', 'setlla'];
async function handleIntroHeart(fields, env, origin) {
  const id = String(fields.lead || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const d = String(fields.design || '');
  if (!INTRO_RINGS.includes(d) && !/^(round|oval|pear|emerald|cushion|elcushion|marquise|radiant|princess|asscher)-(solitaire|hidden|halo|side|three|five|bezel|toi)$/.test(d)) return json({ ok: false }, 400, origin);
  const lead = await env.IG_KV.get(`lead:${id}`, 'json');
  if (!lead) return json({ ok: false }, 404, origin);
  const set = new Set(lead.hearts || []);
  if (fields.on === true || fields.on === 'true') set.add(d); else set.delete(d);
  lead.hearts = Array.from(set);
  lead.heartsAt = Date.now();
  if (lead.hearts.length) stampStage(lead, 'Loved rings');
  await env.IG_KV.put(`lead:${id}`, JSON.stringify(lead));
  return json({ ok: true }, 200, origin);
}
async function handleIntroSeen(fields, env, origin) {
  const id = String(fields.lead || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const lead = await env.IG_KV.get(`lead:${id}`, 'json');
  if (!lead) return json({ ok: false }, 404, origin);
  lead.introSeenAt = lead.introSeenAt || Date.now();
  lead.introLastAt = Date.now();
  if (!(lead.journey || []).some((j) => j.stage === 'Intro opened')) stampStage(lead, 'Intro opened');
  await env.IG_KV.put(`lead:${id}`, JSON.stringify(lead));
  return json({ ok: true }, 200, origin);
}
async function handleAdminLead(url, env, origin) {
  const ok = isAdmin(null, url, env) || teamAuth(null, url, env);
  if (!ok) return json({ ok: false, error: 'Wrong key' }, 403, origin);
  const id = String(url.searchParams.get('id') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const lead = await env.IG_KV.get(`lead:${id}`, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  return json({ ok: true, lead }, 200, origin);
}
async function handleCallSave(fields, url, env, origin) {
  if (!isAdmin(fields, url, env)) return json({ ok: false, error: 'Wrong key' }, 403, origin);
  const id = String(fields.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const lead = await env.IG_KV.get(`lead:${id}`, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  const call = fields.call && typeof fields.call === 'object' ? fields.call : {};
  const clean = {};
  Object.keys(call).slice(0, 40).forEach((k) => { clean[String(k).slice(0, 40)] = String(call[k] == null ? '' : call[k]).slice(0, k === 'inspoLinks' || k === 'notes' || k === 'story' ? 3000 : 600); });
  lead.call = { ...(lead.call || {}), ...clean, savedAt: Date.now(), rep: String(fields.rep || '').slice(0, 40) };
  if (fields.status) { lead.status = String(fields.status).slice(0, 30); lead.statusAt = Date.now(); }
  if (fields.orderId) lead.orderId = String(fields.orderId).slice(0, 40);
  if (fields.stage) stampStage(lead, String(fields.stage));
  await env.IG_KV.put(`lead:${id}`, JSON.stringify(lead));
  return json({ ok: true }, 200, origin);
}

// Inspiration photos the customer texted or emailed, added by the rep on the Call Link.
async function handleInspoGet(url, env, origin) {
  if (!(isAdmin(null, url, env) || teamAuth(null, url, env))) return json({ ok: false, error: 'Wrong key' }, 403, origin);
  const id = String(url.searchParams.get('id') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const list = (await env.IG_KV.get(`inspo:${id}`, 'json')) || [];
  return json({ ok: true, pics: list }, 200, origin);
}
async function handleInspoSave(fields, url, env, origin) {
  if (!(isAdmin(fields, url, env) || teamAuth(fields, url, env))) return json({ ok: false, error: 'Wrong key' }, 403, origin);
  const id = String(fields.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  if (!(await env.IG_KV.get(`lead:${id}`))) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  let list = (await env.IG_KV.get(`inspo:${id}`, 'json')) || [];
  if (fields.remove != null) list = list.filter((_, i) => i !== Number(fields.remove));
  const img = String(fields.image || '');
  if (img) {
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > 400000) return json({ ok: false, error: 'Photo too large' }, 400, origin);
    if (list.length >= 12) return json({ ok: false, error: 'Up to 12 photos' }, 400, origin);
    list.push(img);
  }
  await env.IG_KV.put(`inspo:${id}`, JSON.stringify(list));
  return json({ ok: true, pics: list }, 200, origin);
}


// === Ring Portal Creator ===
// One private link per lead (/portal?t=TOKEN). The customer designs the ring
// step by step (answers they already gave are prefilled and never asked again),
// adds notes and inspiration, and messages the team back and forth. No prices
// here: price and payment come after the design is created.
const PORTAL_KEYS = ['shape', 'setting', 'carat', 'stoneType', 'metal', 'band', 'bandWidth', 'prongs', 'ringSize', 'engraving', 'engravingText', 'herStyle', 'story', 'notes', 'when', 'extras'];
const PORTAL_LABELS = { shape: 'Shape', setting: 'Setting', carat: 'Stone size', stoneType: 'Stone type', metal: 'Metal', band: 'Band', bandWidth: 'Band width', prongs: 'Prongs', ringSize: 'Ring size', engraving: 'Engraving', engravingText: 'Engraving words', herStyle: 'Her style', story: 'Their story', notes: 'Notes', when: 'Proposal timing', extras: 'Extras' };
const portalLink = (t) => `https://hiddengemrings.com/portal?t=${t}`;

// Turn what the lead already told us into portal answers so nothing is asked twice.
function portalPrefill(lead) {
  const d = lead.design || {}, a = {};
  const ok = (v) => v && !/^not sure/i.test(v);
  const shape = ok(d.shape) ? d.shape : ok(lead.shape) ? lead.shape : '';
  if (shape) a.shape = shape;
  if (ok(d.carat)) a.carat = d.carat;
  if (ok(d.stoneType)) a.stoneType = d.stoneType;
  if (ok(d.metal)) a.metal = d.metal;
  if (d.band === 'Plain band') a.band = 'Plain polished'; else if (d.band === 'Diamond band') a.band = 'Pavé diamonds';
  if (d.band === 'Hidden halo') a.setting = 'Hidden Halo';
  if (ok(d.ringSize) && !/secret/i.test(d.ringSize)) a.ringSize = d.ringSize;
  if (d.engraving === 'No') a.engraving = 'No engraving';
  if (lead.timeline) a.when = lead.timeline;
  if (d.style && /^The /.test(d.style)) a.inspiredBy = d.style;
  return a;
}

// Until the team loads their own 10 rings, suggest 10 from the ring library that fit
// what the lead told us (shape, metal, stone size or budget). Frozen once the customer acts.
const LIB = 'https://ring.gilbertrenteria.dev/img/ring/';
const LIB_HAS = {
  asscher: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel'], cushion: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'],
  elcushion: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'], emerald: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'],
  marquise: ['solitaire', 'hidden', 'halo', 'side', 'three', 'bezel', 'toi'], oval: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'],
  pear: ['solitaire', 'hidden', 'halo', 'side', 'three', 'bezel', 'toi'], princess: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel'],
  radiant: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'], round: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel'] };
const LIB_SHAPE = { oval: 'Oval', round: 'Round', pear: 'Pear', emerald: 'Emerald', elcushion: 'Elongated Cushion', cushion: 'Cushion', radiant: 'Radiant', princess: 'Princess', marquise: 'Marquise', asscher: 'Asscher' };
const LIB_STYLE = { solitaire: 'Solitaire', hidden: 'Hidden Halo', halo: 'Halo', side: 'Pavé Band', three: 'Three Stone', five: 'Five Stone', bezel: 'Bezel', toi: 'Toi et Moi' };
function libShape(s) { s = String(s || '').toLowerCase(); if (/elongated/.test(s)) return 'elcushion'; return Object.keys(LIB_SHAPE).find((k) => k !== 'elcushion' && s.includes(k)) || ''; }
function libMetal(m) { m = String(m || '').toLowerCase(); return m.includes('rose') ? 'rose' : (m.includes('white') || m.includes('platinum')) ? 'white' : m.includes('yellow') ? 'yellow' : ''; }
const METAL_LABEL = { yellow: 'Yellow gold', white: 'White gold', rose: 'Rose gold' };
function budgetCarat(b) {
  b = String(b || '');
  if (/under \$2/i.test(b)) return '1 ct'; if (/\$2,000 to/i.test(b)) return '1.5 ct'; if (/\$4,000 to/i.test(b)) return '2 ct';
  if (/\$7,000 to/i.test(b)) return '2.5 ct'; if (/\$10,000/i.test(b)) return '3 ct'; return '1.5 ct';
}
function suggestRings(lead) {
  const a = portalPrefill(lead);
  const sh = libShape(a.shape) || 'oval', mt = libMetal(a.metal) || 'yellow';
  const carat = a.carat ? a.carat.replace(/carats?/i, 'ct').replace('Under 1 ct', '0.75 ct') : budgetCarat(lead.budget);
  const order = ['solitaire', 'hidden', 'halo', 'three', 'bezel', 'side', 'toi', 'five'].filter((s) => LIB_HAS[sh].includes(s));
  const out = order.map((st) => ({ shape: LIB_SHAPE[sh], style: LIB_STYLE[st], carat, metal: METAL_LABEL[mt], img: `${LIB}${sh}-${st}-${mt}.webp`, auto: true }));
  // fill to 10 with the two most loved looks in the other metals
  const others = ['yellow', 'white', 'rose'].filter((x) => x !== mt);
  for (const st of ['hidden', 'solitaire']) for (const m of others) if (out.length < 10) out.push({ shape: LIB_SHAPE[sh], style: LIB_STYLE[st], carat, metal: METAL_LABEL[m], img: `${LIB}${sh}-${st}-${m}.webp`, auto: true });
  return out.slice(0, 10);
}
function ringsFor(p, lead) { return (p.rings && p.rings.length) ? p.rings : suggestRings(lead); }
function freezeRings(p, lead) { if (!p.rings || !p.rings.length) p.rings = suggestRings(lead); }

function portalView(p, lead, online) {
  // No team member names ever reach the customer.
  return {
    first: String(lead.name || '').split(' ')[0], rep: 'Hidden Gem',
    surprise: /^yes/i.test(lead.surprise || ''), buyer: (lead.about || {}).buyer || '',
    prefill: portalPrefill(lead), answers: p.answers || {}, step: p.step || 0,
    submittedAt: p.submittedAt || 0, version: p.version || 0,
    msgs: (p.msgs || []).map((m, i) => ({ from: m.from, name: m.from === 'team' ? 'Hidden Gem' : m.name, text: m.text, at: m.at, img: m.img ? `/portal/${p.t}/img/${m.img}` : '' })),
    inspo: (p.inspo || []).map((x) => (x.img ? { img: `/portal/${p.t}/img/${x.img}` } : { link: x.link })),
    rings: ringsFor(p, lead).map((r, i) => ({ n: i + 1, img: r.img ? (/^https:/.test(r.img) ? r.img : `/portal/${p.t}/img/${r.img}`) : '', shape: r.shape || '', style: r.style || '', carat: r.carat || '', metal: r.metal || '', title: r.title || '' })),
    pick: p.pick || null, contact: (p.contact || []).slice(-1)[0] || null, online: !!online,
    tz: lead.tz || '', budget: lead.budget || '',
  };
}

async function portalLoad(t, env) {
  if (!/^[a-z0-9]{10,32}$/.test(t || '')) return {};
  const p = await env.IG_KV.get(`portal:${t}`, 'json');
  if (!p) return {};
  const lead = await env.IG_KV.get(`lead:${p.leadId}`, 'json');
  return { p, lead };
}

async function portalSaveImg(t, p, data, env) {
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(data) || data.length > 900000) return '';
  p.imgN = (p.imgN || 0) + 1;
  await env.IG_KV.put(`pimg:${t}:${p.imgN}`, data);
  return String(p.imgN);
}

function portalDesignRows(p, lead) {
  const a = Object.assign({}, portalPrefill(lead), p.answers || {});
  return PORTAL_KEYS.filter((k) => a[k]).map((k) => [PORTAL_LABELS[k], Array.isArray(a[k]) ? a[k].join(', ') : a[k]]);
}

function portalEmail(lead, title, intro, rows, p, extra) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px">` +
    `<div style="display:inline-block;background:#54453A;color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:.06em">RING PORTAL</div>` +
    `<h2 style="margin:14px 0 6px">${escapeHtml(title)}</h2><p style="margin:0 0 14px;color:#333">${intro}</p>` +
    (rows && rows.length ? `<table cellpadding="7" style="border-collapse:collapse">` + rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('') + `</table>` : '') +
    (extra || '') +
    `<p style="margin-top:16px">Phone: ${escapeHtml(fmtPhone(lead.phone))}${/^yes/i.test(lead.surprise || '') ? ' · <b>SURPRISE, keep it private</b>' : ''}${lead.windowsCentral ? ' · Best times: ' + escapeHtml(lead.windowsCentral) : ''}</p>` +
    `<p><a href="https://hiddengemrings.com/call?lead=${encodeURIComponent(lead.id)}" style="background:#54453A;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:700">Open their call page to reply</a></p></div>`;
}

async function handlePortalCreate(fields, url, env, origin) {
  if (!(isAdmin(fields, url, env) || teamAuth(fields, url, env))) return json({ ok: false, error: 'Wrong key' }, 403, origin);
  const leadId = String(fields.leadId || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const lead = await env.IG_KV.get(`lead:${leadId}`, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  if (!lead.portalToken) {
    const t = newId(16);
    await env.IG_KV.put(`portal:${t}`, JSON.stringify({ t, leadId, createdAt: Date.now(), answers: {}, msgs: [], inspo: [] }));
    lead.portalToken = t; stampStage(lead, 'Ring Portal sent');
    await env.IG_KV.put(`lead:${leadId}`, JSON.stringify(lead));
  }
  return json({ ok: true, token: lead.portalToken, link: portalLink(lead.portalToken) }, 200, origin);
}

async function handlePortalGet(t, env, origin) {
  const { p, lead } = await portalLoad(t, env);
  if (!p || !lead) return json({ ok: false, error: 'Not found' }, 404, origin);
  const cfg = await getConfig(env);
  return json({ ok: true, portal: portalView(p, lead, cfg.reps.some((r) => r.online)) }, 200, origin);
}

async function handlePortalImg(t, n, env) {
  const data = await env.IG_KV.get(`pimg:${t}:${n}`);
  const m = data && data.match(/^data:(image\/[a-z+]+);base64,(.*)$/);
  if (!m) return new Response('Not found', { status: 404 });
  const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=86400', 'Access-Control-Allow-Origin': '*' } });
}

// open (real person only, sent by the page after a real tap or scroll), start, leave
async function handlePortalEvent(t, fields, env, origin) {
  const { p, lead } = await portalLoad(t, env);
  if (!p || !lead) return json({ ok: false }, 404, origin);
  const type = String(fields.type || ''), now = Date.now(), who = lead.name;
  let subject = '', html = '';
  if (type === 'open' && (!p.openedAt || now - p.openedAt > 6 * 3600e3)) {
    p.openedAt = now; stampStage(lead, 'Ring Portal opened');
    subject = `RING PORTAL OPENED: ${who}`;
    html = portalEmail(lead, `${who} just opened their Ring Portal`, `Opened ${chicagoTime(now)}. Good moment for a quick text if they asked for text.`, null, p);
  } else if (type === 'start' && !p.startedAt) {
    p.startedAt = now; stampStage(lead, 'Designing in portal');
    subject = `RING PORTAL STARTED: ${who} is designing`;
    html = portalEmail(lead, `${who} started designing`, `Started ${chicagoTime(now)}.`, null, p);
  } else if (type === 'leave' && !p.submittedAt && !(p.pick && p.pick.sentAt) && p.startedAt && (!p.leaveAt || now - p.leaveAt > 3 * 3600e3)) {
    p.leaveAt = now;
    if (fields.answers && typeof fields.answers === 'object') p.answers = cleanAnswers(fields.answers, p.answers);
    if (fields.draft && typeof fields.draft === 'object') { freezeRings(p, lead); p.draft = cleanPick(fields.draft, p); }
    subject = `RING PORTAL PAUSED: ${who} left partway`;
    html = portalEmail(lead, `${who} stepped away partway through`, `Left ${chicagoTime(now)} on ${escapeHtml(String(fields.stepName || fields.step || ''))}. Here is where they were:`, (p.rings || []).length ? pickRows(p.draft || {}, p) : portalDesignRows(p, lead), p);
  } else return json({ ok: true }, 200, origin);
  await env.IG_KV.put(`portal:${t}`, JSON.stringify(p));
  await env.IG_KV.put(`lead:${p.leadId}`, JSON.stringify(lead));
  await sendEmail(env, { to: leadRecipients(lead), subject, html });
  return json({ ok: true }, 200, origin);
}

function cleanAnswers(inp, prev) {
  const out = Object.assign({}, prev || {});
  PORTAL_KEYS.forEach((k) => { if (inp[k] != null) out[k] = Array.isArray(inp[k]) ? inp[k].slice(0, 10).map((x) => String(x).slice(0, 80)) : String(inp[k]).slice(0, k === 'story' || k === 'notes' ? 2000 : 200); });
  return out;
}

// autosave on every answer; final=true sends the finished design to the team
async function handlePortalSave(t, fields, env, origin) {
  const { p, lead } = await portalLoad(t, env);
  if (!p || !lead) return json({ ok: false }, 404, origin);
  p.answers = cleanAnswers(fields.answers || {}, p.answers);
  p.step = Number(fields.step) || 0;
  let emailed = false;
  if (fields.final) {
    const sig = JSON.stringify(p.answers);
    if (sig !== p.lastSentSig) {
      p.version = (p.version || 0) + 1; p.submittedAt = Date.now(); p.lastSentSig = sig;
      stampStage(lead, p.version > 1 ? 'Design updated' : 'Design created');
      lead.portalDesign = Object.assign({}, portalPrefill(lead), p.answers);
      const sent = await sendEmail(env, { to: leadRecipients(lead), subject: `${p.version > 1 ? 'DESIGN UPDATED' : 'DESIGN CREATED'}: ${lead.name}${/^yes/i.test(lead.surprise || '') ? ' (SURPRISE)' : ''}`,
        html: portalEmail(lead, `${lead.name} ${p.version > 1 ? 'updated' : 'created'} their ring`, `Version ${p.version}, ${chicagoTime(p.submittedAt)}. Next: send their price and financing options.`, portalDesignRows(p, lead), p,
          (p.inspo || []).length ? `<p>${p.inspo.length} inspiration item(s) in the portal.</p>` : '') });
      if (!sent.ok) { await env.IG_KV.put(`portal:${t}`, JSON.stringify(p)); return json({ ok: false, error: 'Saved but the email did not send', saved: true }, 502, origin); }
      emailed = true;
    }
  }
  await env.IG_KV.put(`portal:${t}`, JSON.stringify(p));
  await env.IG_KV.put(`lead:${p.leadId}`, JSON.stringify(lead));
  return json({ ok: true, emailed, version: p.version || 0 }, 200, origin);
}

// customer message or inspiration (photo or link)
async function handlePortalMsg(t, fields, env, origin) {
  const { p, lead } = await portalLoad(t, env);
  if (!p || !lead) return json({ ok: false }, 404, origin);
  const text = String(fields.text || '').trim().slice(0, 2000), link = String(fields.link || '').trim().slice(0, 500);
  const isInspo = !!fields.inspo;
  let img = '';
  if (fields.image) { img = await portalSaveImg(t, p, String(fields.image), env); if (!img) return json({ ok: false, error: 'That photo is too large' }, 400, origin); }
  if (!text && !img && !link) return json({ ok: false, error: 'Empty' }, 400, origin);
  if (isInspo) { p.inspo = p.inspo || []; if (p.inspo.length >= 20) return json({ ok: false, error: 'Up to 20 inspiration items' }, 400, origin); p.inspo.push(img ? { img } : { link: /^https?:\/\//.test(link) ? link : '' }); }
  else { p.msgs = p.msgs || []; p.msgs.push({ from: 'customer', name: String(lead.name || '').split(' ')[0], text, img, at: Date.now() }); }
  await env.IG_KV.put(`portal:${t}`, JSON.stringify(p));
  const what = isInspo ? (img ? 'added an inspiration photo' : 'added an inspiration link') : 'sent you a message';
  await sendEmail(env, { to: leadRecipients(lead), subject: `RING PORTAL MESSAGE: ${lead.name} ${what}`,
    html: portalEmail(lead, `${lead.name} ${what}`, text ? `"${escapeHtml(text)}"` : link ? escapeHtml(link) : 'See the photo in their portal.', null, p) });
  return json({ ok: true, portal: portalView(p, lead) }, 200, origin);
}

// team reply or design update (text and an optional photo of the updated design)
async function handlePortalTeamMsg(fields, url, env, origin) {
  if (!(isAdmin(fields, url, env) || teamAuth(fields, url, env))) return json({ ok: false, error: 'Wrong key' }, 403, origin);
  const leadId = String(fields.leadId || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const lead = await env.IG_KV.get(`lead:${leadId}`, 'json');
  if (!lead || !lead.portalToken) return json({ ok: false, error: 'No portal for this customer yet' }, 404, origin);
  const t = lead.portalToken, p = await env.IG_KV.get(`portal:${t}`, 'json');
  const text = String(fields.text || '').trim().slice(0, 2000);
  let img = '';
  if (fields.image) { img = await portalSaveImg(t, p, String(fields.image), env); if (!img) return json({ ok: false, error: 'That photo is too large' }, 400, origin); }
  if (!text && !img) return json({ ok: false, error: 'Type a message or add a photo' }, 400, origin);
  p.msgs = p.msgs || [];
  p.msgs.push({ from: 'team', name: String(fields.rep || (lead.routedNames || [])[0] || 'Kim').slice(0, 30), text, img, at: Date.now() });
  await env.IG_KV.put(`portal:${t}`, JSON.stringify(p));
  if (lead.email && fields.notify) {
    await sendEmail(env, { to: [lead.email], from: CUSTOMER_FROM, replyTo: PUBLIC_EMAIL, subject: 'You have an update from Hidden Gem',
      html: `<div style="font-family:Arial,sans-serif;max-width:520px"><p>Hi ${escapeHtml(String(lead.name).split(' ')[0])},</p><p>There is a new update waiting for you.</p><p><a href="${portalLink(t)}" style="background:#54453A;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">Open my portal</a></p><p style="color:#777">Hidden Gem</p></div>` });
  }
  return json({ ok: true, portal: portalView(p, lead), link: portalLink(t) }, 200, origin);
}


// ---------- Ring Portal v2: 10 rings we design for them, pick, and talk ----------
const PICK_WHY = ['Stones look too big', 'Stones look too small', 'Not the shape I want', 'Wrong metal color', 'Want a different setting', 'Too plain', 'Too flashy', 'Not her style', 'Want more sparkle on the band', 'Something else'];
const BUILD_KEYS = { shape: 'Shape', carat: 'Stone size', metal: 'Metal', setting: 'Setting', band: 'Band', stoneType: 'Stone type', style: 'Her style' };
function ringLabel(r, i) { return `Ring ${i + 1}` + [r.title || [r.shape, r.style].filter(Boolean).join(' '), r.carat, r.metal].filter(Boolean).map((x) => ' · ' + x).join(''); }
function cleanPick(f, p) {
  const n = (p.rings || []).length;
  const num = (x) => { x = Number(x); return x >= 1 && x <= n ? x : 0; };
  const out = { mode: ['one', 'favs', 'none'].includes(f.mode) ? f.mode : '' };
  out.ring = num(f.ring);
  out.favs = Array.isArray(f.favs) ? [...new Set(f.favs.map(num).filter(Boolean))].slice(0, 3) : [];
  out.all = !!f.all;
  out.why = Array.isArray(f.why) ? f.why.filter((w) => PICK_WHY.includes(w)) : [];
  out.build = {};
  if (f.build && typeof f.build === 'object') Object.keys(BUILD_KEYS).forEach((k) => { if (f.build[k]) out.build[k] = String(f.build[k]).slice(0, 80); });
  out.notes = String(f.notes || '').slice(0, 2000);
  return out;
}
function pickRows(k, p) {
  const R = p.rings || [], rows = [];
  if (k.ring) rows.push(['Their ring', ringLabel(R[k.ring - 1], k.ring - 1)]);
  if (k.favs && k.favs.length) rows.push(['Favorites', k.favs.map((x) => ringLabel(R[x - 1], x - 1)).join('\n')]);
  if (k.all) rows.push(['Wants', 'Full mockups of all their favorites']);
  if (k.why && k.why.length) rows.push(['Why none fit', k.why.join(', ')]);
  Object.keys(k.build || {}).forEach((b) => rows.push([BUILD_KEYS[b], k.build[b]]));
  if (k.notes) rows.push(['Notes', k.notes]);
  return rows;
}
function ringThumbs(k, p, t) {
  const ids = k.ring ? [k.ring] : (k.favs || []);
  return ids.map((x) => { const r = (p.rings || [])[x - 1]; if (!r || !r.img) return ''; const src = /^https:/.test(r.img) ? r.img : `https://long-bar-d49d.gilbertrenteria.workers.dev/portal/${t}/img/${r.img}`; return `<img src="${src}" width="150" style="border-radius:10px;margin:6px 6px 0 0">`; }).join('');
}

// team loads the 10 rings (photo as data URL, or an https link we fetch and keep)
async function handlePortalTeamRings(fields, url, env, origin) {
  if (!teamAuth(fields, url, env)) return json({ ok: false, error: 'Wrong key' }, 403, origin);
  const leadId = String(fields.leadId || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const lead = await env.IG_KV.get(`lead:${leadId}`, 'json');
  if (!lead || !lead.portalToken) return json({ ok: false, error: 'Create the portal link first' }, 404, origin);
  const t = lead.portalToken, p = await env.IG_KV.get(`portal:${t}`, 'json');
  const list = Array.isArray(fields.rings) ? fields.rings.slice(0, 12) : [];
  const out = [];
  for (const r of list) {
    let img = String(r.img || '');
    if (/^data:image\//.test(img)) {
      if (img.length > 6e6) return json({ ok: false, error: 'A photo is too large (max about 4 MB)' }, 400, origin);
      p.imgN = (p.imgN || 0) + 1; await env.IG_KV.put(`pimg:${t}:${p.imgN}`, img); img = String(p.imgN);
    } else if (/^https:\/\//.test(img) && !/^https:\/\/(hiddengemrings\.com|ring\.gilbertrenteria\.dev)\//.test(img)) {
      try {
        const res = await fetch(img); const type = res.headers.get('Content-Type') || '';
        if (!res.ok || !/^image\//.test(type)) return json({ ok: false, error: 'Could not load a photo link' }, 400, origin);
        const buf = new Uint8Array(await res.arrayBuffer()); if (buf.length > 4.5e6) return json({ ok: false, error: 'A photo is too large' }, 400, origin);
        let bin = ''; for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
        p.imgN = (p.imgN || 0) + 1; await env.IG_KV.put(`pimg:${t}:${p.imgN}`, `data:${type.split(';')[0]};base64,${btoa(bin)}`); img = String(p.imgN);
      } catch (e) { return json({ ok: false, error: 'Could not load a photo link' }, 400, origin); }
    } else if (/^\d{1,4}$/.test(img) || /^https:\/\/(hiddengemrings\.com|ring\.gilbertrenteria\.dev)\//.test(img)) { /* already stored, our site or our ring library */ }
    else img = '';
    const c = (v) => String(v || '').slice(0, 60);
    out.push({ img, shape: c(r.shape), style: c(r.style), carat: c(r.carat), metal: c(r.metal), title: c(r.title) });
  }
  p.rings = out; p.ringsAt = Date.now(); p.pick = null; p.draft = null;
  stampStage(lead, 'Rings loaded in portal');
  await env.IG_KV.put(`portal:${t}`, JSON.stringify(p));
  await env.IG_KV.put(`lead:${leadId}`, JSON.stringify(lead));
  return json({ ok: true, count: out.length, link: portalLink(t), portal: portalView(p, lead, false) }, 200, origin);
}

// customer sends their pick, their favorites, or "none of these" with why and ideas
async function handlePortalPick(t, fields, env, origin) {
  const { p, lead } = await portalLoad(t, env);
  if (!p || !lead) return json({ ok: false }, 404, origin);
  freezeRings(p, lead);
  const k = cleanPick(fields, p);
  if (!k.mode || (k.mode === 'one' && !k.ring) || (k.mode === 'favs' && !k.favs.length)) return json({ ok: false, error: 'Pick a ring first' }, 400, origin);
  const sig = JSON.stringify(k);
  if (p.pick && p.pick.sig === sig && p.pick.emailed) return json({ ok: true, emailed: true, dup: true }, 200, origin);
  k.sentAt = Date.now(); k.sig = sig; p.pick = k; p.draft = null;
  stampStage(lead, k.mode === 'none' ? 'Wants new designs' : 'Picked in portal');
  const sur = /^yes/i.test(lead.surprise || '') ? ' (SURPRISE)' : '';
  const subject = k.mode === 'one' ? `RING PICKED: ${lead.name} chose Ring ${k.ring}${sur}` : k.mode === 'favs' ? `FAVORITES SAVED: ${lead.name} (${k.favs.length})${sur}` : `NEW DESIGNS NEEDED: ${lead.name}${sur}`;
  const intro = (k.mode === 'none' ? 'None of the 10 felt right. Here is why and what they want.' : 'They are excited right now. Reach out within the hour.') + ` Sent ${chicagoTime(k.sentAt)}. Promised: full mockup within 24 hours.`;
  const sent = await sendEmail(env, { to: leadRecipients(lead), subject, html: portalEmail(lead, subject.split(':')[0] === 'RING PICKED' ? `${lead.name} picked their ring` : subject, intro, pickRows(k, p), p, ringThumbs(k, p, t)) });
  p.pick.emailed = !!sent.ok;
  await env.IG_KV.put(`portal:${t}`, JSON.stringify(p));
  await env.IG_KV.put(`lead:${p.leadId}`, JSON.stringify(lead));
  if (!sent.ok) return json({ ok: false, saved: true, error: 'Saved, still sending' }, 502, origin);
  return json({ ok: true, emailed: true }, 200, origin);
}

// text, schedule a call, or talk now (talk now only when someone is online)
async function handlePortalContact(t, fields, env, origin) {
  const { p, lead } = await portalLoad(t, env);
  if (!p || !lead) return json({ ok: false }, 404, origin);
  const type = String(fields.type || ''), now = Date.now();
  if (!['text', 'schedule', 'now'].includes(type)) return json({ ok: false }, 400, origin);
  const cfg = await getConfig(env), online = cfg.reps.some((r) => r.online);
  if (type === 'now' && !online) return json({ ok: false, offline: true, error: 'We are away right now. Pick a time instead.' }, 409, origin);
  const c = { type, at: now, day: String(fields.day || '').slice(0, 40), window: String(fields.window || '').slice(0, 60), tz: String(fields.tz || '').slice(0, 40), central: String(fields.central || '').slice(0, 80) };
  const last = (p.contact || []).slice(-1)[0];
  if (type === 'text' && last && last.type === 'text' && now - last.at < 3600e3) return json({ ok: true }, 200, origin);
  freezeRings(p, lead);
  p.contact = (p.contact || []).concat([c]).slice(-20);
  stampStage(lead, type === 'now' ? 'Wants a call now' : type === 'schedule' ? 'Call scheduled' : 'Texting us');
  await env.IG_KV.put(`portal:${t}`, JSON.stringify(p));
  await env.IG_KV.put(`lead:${p.leadId}`, JSON.stringify(lead));
  const sur = /^yes/i.test(lead.surprise || '') ? ' (SURPRISE)' : '';
  let subject, intro;
  if (type === 'now') { subject = `URGENT CALL NOW: ${lead.name}${sur}`; intro = `<b>Call ${escapeHtml(fmtPhone(lead.phone))} within 30 to 45 minutes.</b> They tapped Talk now at ${chicagoTime(now)}. We promised the call by ${chicagoTime(now + 45 * 60e3)}.`; }
  else if (type === 'schedule') { subject = `CALL SCHEDULED: ${lead.name}, ${c.central || c.day + ' ' + c.window}${sur}`; intro = `They asked for a call ${escapeHtml(c.day)} ${escapeHtml(c.window)}${c.central ? ' (' + escapeHtml(c.central) + ' Central)' : ''}.`; }
  else { subject = `TEXTING YOU: ${lead.name}${sur}`; intro = `They tapped Text us at ${chicagoTime(now)}. A text from them should arrive at (832) 743-7657. If it does not, text them first.`; }
  const k = p.pick || p.draft;
  await sendEmail(env, { to: leadRecipients(lead), subject, html: portalEmail(lead, subject, intro, k ? pickRows(k, p) : null, p, k ? ringThumbs(k, p, t) : '') });
  return json({ ok: true }, 200, origin);
}

async function handleAdminList(url, env, origin) {
  if (!isAdmin(null, url, env)) return json({ ok: false, error: 'Wrong admin key' }, 403, origin);
  const leadIds = ((await env.IG_KV.get('index:leads', 'json')) || []).slice(0, 50);
  const orderIds = ((await env.IG_KV.get('index:orders', 'json')) || []).slice(0, 50);
  const leads = (await Promise.all(leadIds.map((id) => env.IG_KV.get(`lead:${id}`, 'json')))).filter(Boolean);
  const orders = (await Promise.all(orderIds.map((id) => env.IG_KV.get(`order:${id}`, 'json')))).filter(Boolean)
    .map((o) => ({ ...publicOrder(o), customerPhone: o.customerPhone, link: `${SITE}/${o.options ? 'rings' : 'approve'}?id=${o.id}` }));
  return json({ ok: true, leads, orders }, 200, origin);
}

// Admin: delete a lead for good (lead, its portal, portal photos, and the index entry)
async function handleLeadDelete(fields, url, env, origin) {
  if (!isAdmin(fields, url, env)) return json({ ok: false, error: 'Wrong admin key' }, 403, origin);
  const id = String(fields.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const lead = await env.IG_KV.get(`lead:${id}`, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  if (lead.portalToken) {
    const p = await env.IG_KV.get(`portal:${lead.portalToken}`, 'json');
    for (let n = 1; n <= ((p && p.imgN) || 0); n++) await env.IG_KV.delete(`pimg:${lead.portalToken}:${n}`);
    await env.IG_KV.delete(`portal:${lead.portalToken}`);
  }
  await env.IG_KV.delete(`lead:${id}`);
  const idx = (await env.IG_KV.get('index:leads', 'json')) || [];
  await env.IG_KV.put('index:leads', JSON.stringify(idx.filter((x) => x !== id)));
  return json({ ok: true }, 200, origin);
}

async function handleLeadStatus(fields, url, env, origin) {
  if (!isAdmin(fields, url, env)) return json({ ok: false, error: 'Wrong admin key' }, 403, origin);
  const id = String(fields.id || '');
  const lead = await env.IG_KV.get(`lead:${id}`, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  lead.status = String(fields.status || 'new').slice(0, 30);
  lead.statusAt = Date.now();
  if (fields.stage) stampStage(lead, String(fields.stage));
  await env.IG_KV.put(`lead:${id}`, JSON.stringify(lead));
  return json({ ok: true }, 200, origin);
}

const app = {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET') {
      if (path === '/instagram/callback') return handleInstagramCallback(url, env);
      if (path === '/instagram/set-token') return handleSetToken(url, env);
      if (path === '/instagram/feed') return handleInstagramFeed(env, origin);
      if (path === '/track/stats') return handleTrackStats(url, env, origin);
      if (path === '/email/log') return handleEmailLog(url, env, origin);
      if (path === '/activity') return handleActivity(url, env, origin);
      if (path === '/admin/list') return handleAdminList(url, env, origin);
      if (path === '/admin/lead') return handleAdminLead(url, env, origin);
      if (path === '/admin/inspo') return handleInspoGet(url, env, origin);
      if (path === '/team/public') return handlePublicStatus(env, origin);
      if (path === '/team/state') return handleTeamState(url, env, origin);
      if (path === '/book/slots') return handleSlots(env, origin);
      if (path === '/email/check') return handleEmailCheck(url, env, origin);
      let m = path.match(/^\/order\/([a-z0-9]{6,32})\/image\/([0-9]|size)$/);
      if (m) return handleOptionImage(m[1], m[2], env);
      m = path.match(/^\/order\/([a-z0-9]{6,32})\/image$/);
      if (m) return handleOrderImage(m[1], env);
      m = path.match(/^\/order\/([a-z0-9]{6,32})$/);
      if (m) return handleOrderGet(m[1], env, origin);
      m = path.match(/^\/portal\/([a-z0-9]{10,32})\/img\/(\d{1,4})$/);
      if (m) return handlePortalImg(m[1], m[2], env);
      m = path.match(/^\/portal\/([a-z0-9]{10,32})$/);
      if (m) return handlePortalGet(m[1], env, origin);
      return new Response('Not found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405, origin);
    }

    // Stripe posts here directly with a raw body + signature header — must
    // be read before the generic JSON/formData parsing below.
    if (path === '/stripe/webhook') return handleStripeWebhook(request, env);
    if (path === '/track') return handleTrack(request, env, origin);

    let fields;
    try {
      const ct = request.headers.get('Content-Type') || '';
      if (ct.includes('application/json')) {
        fields = await request.json();
      } else {
        const fd = await request.formData();
        fields = Object.fromEntries(fd.entries());
      }
    } catch (err) {
      return json({ ok: false, error: 'Could not read form data' }, 400, origin);
    }

    if (path === '/lead') return handleLead(fields, request, env, origin);
    if (path === '/lead/design') return handleDesign(fields, env, origin);
    if (path === '/lead/about') return handleAbout(fields, env, origin);
    if (path === '/lead/email') return handleLeadEmail(fields, env, origin);
    if (path === '/team/update') return handleTeamUpdate(fields, url, env, origin);
    if (path === '/order/create') return handleOrderCreate(fields, env, origin, url);
    if (path === '/order/create-options') return handleOptionsCreate(fields, env, origin, url);
    if (path === '/portal/create') return handlePortalCreate(fields, url, env, origin);
    if (path === '/portal/team-msg') return handlePortalTeamMsg(fields, url, env, origin);
    if (path === '/portal/team-rings') return handlePortalTeamRings(fields, url, env, origin);
    const pm = path.match(/^\/portal\/([a-z0-9]{10,32})\/(event|save|msg|pick|contact)$/);
    if (pm && pm[2] === 'pick') return handlePortalPick(pm[1], fields, env, origin);
    if (pm && pm[2] === 'contact') return handlePortalContact(pm[1], fields, env, origin);
    if (pm) return pm[2] === 'event' ? handlePortalEvent(pm[1], fields, env, origin) : pm[2] === 'save' ? handlePortalSave(pm[1], fields, env, origin) : handlePortalMsg(pm[1], fields, env, origin);
    const sm = path.match(/^\/order\/([a-z0-9]{6,32})\/seen$/);
    if (sm) return handleOrderSeen(sm[1], env, origin);
    const chm = path.match(/^\/order\/([a-z0-9]{6,32})\/choose$/);
    if (chm) return handleOptionsChoose(chm[1], fields, env, origin);
    if (path === '/admin/lead-status') return handleLeadStatus(fields, url, env, origin);
    if (path === '/admin/lead-delete') return handleLeadDelete(fields, url, env, origin);
    if (path === '/admin/call-save') return handleCallSave(fields, url, env, origin);
    if (path === '/admin/inspo') return handleInspoSave(fields, url, env, origin);
    if (path === '/intro/heart') return handleIntroHeart(fields, env, origin);
    if (path === '/intro/seen') return handleIntroSeen(fields, env, origin);
    const am = path.match(/^\/order\/([a-z0-9]{6,32})\/approve$/);
    if (am) return handleOrderApprove(am[1], fields, request, env, origin);
    const cm = path.match(/^\/order\/([a-z0-9]{6,32})\/checkout$/);
    if (cm) return handleOrderCheckout(cm[1], fields, env, origin);

    // honeypot — silently accept so a bot can't tell it was rejected
    if (fields._honey) {
      return json({ ok: true }, 200, origin);
    }

    const formType = fields.Form === 'Newsletter Signup' ? 'newsletter' : 'consultation';

    if (formType === 'newsletter') {
      const chk = await checkEmailReal(fields.Email, env);
      if (!chk.ok) return json({ ok: false, error: chk.error }, 400, origin);
      const email = chk.email;
      const html = `<h2>New newsletter signup</h2><p><strong>Email:</strong> ${escapeHtml(email)}</p>`;
      const sent = await sendEmail(env, {
        subject: 'New newsletter signup — Hidden Gem website',
        html,
        replyTo: email,
      });
      if (!sent.ok) return json({ ok: false, error: sent.error }, 502, origin);
      return json({ ok: true }, 200, origin);
    }

    // consultation form
    const name = (fields.Name || '').trim();
    const email = (fields.Email || '').trim();
    if (!name || !email || !email.includes('@')) {
      return json({ ok: false, error: 'Name and a valid email are required' }, 400, origin);
    }

    const skip = new Set(['_honey', '_subject', '_template', '_captcha', '_next', 'Form']);
    const rows = Object.entries(fields).filter(([k, v]) => !skip.has(k) && v);
    const html = `<h2>New consultation inquiry — Hidden Gem</h2><table cellpadding="6" style="border-collapse:collapse">` +
      rows.map(([k, v]) =>
        `<tr><td style="font-weight:600;vertical-align:top;color:#6B5B4C">${escapeHtml(k)}</td><td>${escapeHtml(v).replace(/\n/g, '<br>')}</td></tr>`
      ).join('') + `</table>`;

    const sent = await sendEmail(env, {
      subject: `New consultation inquiry from ${name}`,
      html,
      replyTo: email,
    });
    if (!sent.ok) return json({ ok: false, error: sent.error }, 502, origin);
    return json({ ok: true }, 200, origin);
  },

  // Cron Trigger: keeps the cached Instagram feed fresh.
  async scheduled(event, env, ctx) {
    if (event.cron === '*/10 * * * *') { await resendUnsentLeads(env); return; }
    if (event.cron === '0 14 * * *') { await sendDailySummary(env); return; }
    await refreshMediaCache(env);
  },
};


// ===== Customer wording: always from what they picked (reach + windows) =====
// The internal "contact" field stays for routing and booking only.
function zoneWordFor(tz) {
  try {
    const z = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName').value;
    return { EST: 'Eastern', EDT: 'Eastern', CST: 'Central', CDT: 'Central', MST: 'Mountain', MDT: 'Mountain', PST: 'Pacific', PDT: 'Pacific', AKST: 'Alaska', AKDT: 'Alaska', HST: 'Hawaii' }[z] || z;
  } catch (e) { return 'Central'; }
}
function slotForCustomer(lead) {
  const d = lead.slotDate, t = lead.slotTime;
  if (!d || !t) return '';
  const [y, m, dd] = d.split('-').map(Number), [hh, mm] = t.split(':').map(Number);
  let ms = Date.UTC(y, m - 1, dd, hh + 6, mm);
  const ch = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
  let diff = hh - ch; if (diff > 12) diff -= 24; if (diff < -12) diff += 24; ms += diff * 3600000;
  const tz = lead.tzName || 'America/Chicago', dt = new Date(ms);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric' }).format(dt);
  const tm = (z) => new Intl.DateTimeFormat('en-US', { timeZone: z, hour: 'numeric', minute: '2-digit' }).format(dt);
  const zw = zoneWordFor(tz);
  return zw === 'Central' ? `${day} at ${tm(tz)} Central` : `${day} at ${tm(tz)} ${zw} (${tm('America/Chicago')} Central)`;
}
function customerHowNext(lead) {
  const r = String(lead.reach || '').toLowerCase().split(/,\s*/).filter(Boolean);
  const words = r.map((x) => (x === 'call' ? 'a call' : x));
  const joinOr = (a) => (a.length > 1 ? a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1] : a[0] || '');
  const byWords = r.length === 1 ? (r[0] === 'call' ? 'call you' : r[0] === 'text' ? 'text you' : 'email you') : r.length ? 'reach out by ' + joinOr(words) : 'reach out';
  const surprise = isSurprise(lead);
  if (lead.contact === 'Book a call' && lead.slotDate) return `Your 30 minute call is booked for <strong>${escapeHtml(slotForCustomer(lead))}</strong>. ${surprise ? "We'll call you then." : 'One of our ring specialists will call you then.'}`;
  if (surprise) {
    const how = r.length ? ' by ' + joinOr(words) : '';
    const w = String(lead.windows || '');
    if (w && !/^Anytime/i.test(w)) return `We'll reach out privately${how} during the times you picked (${escapeHtml(w)}).`;
    return `We'll reach out privately${how}${lead.routeMode === 'offline' ? ' during business hours (Mon to Sat, 9 AM to 9 PM Central)' : ' soon'}.`;
  }
  if (lead.routeMode === 'offline') return `Our ring specialists are away right now. We'll ${byWords} during business hours (Mon to Sat, 9 AM to 9 PM Central).`;
  return `One of our ring specialists will ${byWords} shortly.`;
}

// ===== Activity log: every customer submission from every form, in one list =====
// Open /activity (or ?format=json, &day=YYYY-MM-DD). Kept 60 days.
const ACTIVITY_ROUTES = [
  [/^\/lead$/, 'Start form: lead (step 1)'], [/^\/lead\/about$/, 'Start form: About you'], [/^\/lead\/design$/, 'Start form: Ring style'],
  [/^\/lead\/email$/, 'Start form: recap email'], [/^\/portal\/[a-z0-9]+\/save$/, 'Ring Portal: design saved'], [/^\/portal\/[a-z0-9]+\/msg$/, 'Ring Portal: customer message or inspiration'],
  [/^\/order\/[a-z0-9]+\/choose$/, 'Ring picks: ring chosen'], [/^\/order\/[a-z0-9]+\/approve$/, 'Approval: design approved'], [/^\/order\/[a-z0-9]+\/checkout$/, 'Approval: payment started'],
  [/^\/$/, 'Website form'],
];
async function logActivity(env, path, fields, resBody) {
  try {
    let type = null; for (const [re, label] of ACTIVITY_ROUTES) if (re.test(path)) { type = label; break; }
    if (!type || !resBody || !resBody.ok || resBody.duplicate) return;
    if (fields && fields._honey) return;
    const f = fields || {};
    let leadId = String(f.id || f.leadId || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48), name = String(f.name || f.Name || '').slice(0, 80), orderId = '';
    const pm = path.match(/^\/portal\/([a-z0-9]+)\//);
    if (pm) { const p = await env.IG_KV.get(`portal:${pm[1]}`, 'json'); if (p) leadId = p.leadId || leadId; }
    const om = path.match(/^\/order\/([a-z0-9]+)\//);
    if (om) { orderId = om[1]; const o = await env.IG_KV.get(`order:${orderId}`, 'json'); if (o) { name = name || o.customerName || ''; leadId = o.leadId || ''; } }
    let lead = null;
    if (leadId && !om) { lead = await env.IG_KV.get(`lead:${leadId}`, 'json'); if (lead && !name) name = lead.name || ''; }
    if (type === 'Website form') type = f.Form === 'Newsletter Signup' ? 'Website: newsletter signup' : 'Website: consultation form';
    const skip = new Set(['id', 'leadId', '_honey', 'page', 'Form', 'image', 'img', 'signature', 'tzName']);
    const detail = Object.entries(f).filter(([k, v]) => !skip.has(k) && v !== '' && v != null && (typeof v !== 'object' || (Array.isArray(v) && v.length)))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`.slice(0, 160)).join(' | ').slice(0, 1200);
    const entry = { at: Date.now(), time: centralTime(), type, name, leadId, orderId, test: /^\s*test\b/i.test(name), detail };
    // one key per submission (no lost entries when forms arrive at the same moment)
    entry.detail = entry.detail.slice(0, 700);
    const k = `act:${centralDay()}:${String(9999999999999 - entry.at).padStart(13, '0')}-${Math.random().toString(36).slice(2, 7)}`;
    await env.IG_KV.put(k, '1', { expirationTtl: 86400 * 60, metadata: entry });
  } catch (e) {}
}
async function handleActivity(url, env, origin) {
  const day = url.searchParams.get('day') || centralDay();
  const list = [];
  let cursor;
  do { const r = await env.IG_KV.list({ prefix: `act:${day}:`, cursor }); r.keys.forEach((k) => k.metadata && list.push(k.metadata)); cursor = r.list_complete ? null : r.cursor; } while (cursor);
  if (url.searchParams.get('format') === 'json') return json({ ok: true, day, count: list.length, activity: list }, 200, origin);
  const prev = new Date(new Date(day + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const row = (x) => `<tr${x.test ? ' style="opacity:.55"' : ''}><td>${escapeHtml(x.time.replace(/^\w+, /, ''))}</td><td><b>${escapeHtml(x.type)}</b>${x.test ? ' (test)' : ''}</td><td>${escapeHtml(x.name || '')}${x.leadId ? `<br><a href="${SITE}/call?lead=${encodeURIComponent(x.leadId)}">call page</a>` : ''}</td><td style="font-size:12.5px;color:#5c4d40">${escapeHtml(x.detail || '')}</td></tr>`;
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Hidden Gem activity</title>` +
    `<style>body{font-family:-apple-system,Arial,sans-serif;background:#F2EEE6;color:#3b322a;margin:0;padding:18px}h1{font-size:22px;margin:0 0 4px}p{margin:4px 0 14px;color:#6B5B4C}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;font-size:14px}td,th{padding:9px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{background:#8A7F6E;color:#fff}a{color:#8a5a00}</style></head><body>` +
    `<h1>Hidden Gem customer activity</h1><p>${escapeHtml(day)} · Central time · ${list.length} submissions · refresh to update · <a href="?day=${prev}">previous day</a></p>` +
    `<table><tr><th>Time</th><th>What</th><th>Customer</th><th>Answers</th></tr>${list.map(row).join('') || '<tr><td colspan="4">Nothing yet today</td></tr>'}</table></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Every email the site sends is logged (time, type, which inboxes, delivered or not)
// so delivery can be checked. Names, phones and amounts are never stored in the log.
function emailType(subject) {
  const s = String(subject || '');
  const map = [
    [/Someone is on your site/i, 'Visit alert'], [/started the quiz/i, 'Quiz started'], [/left the quiz/i, 'Quiz left unfinished'],
    [/browsing rings/i, 'Browsing rings'], [/Pick Your Ring link/i, 'Ring picks link opened'], [/design approval link/i, 'Approval link opened'],
    [/daily summary/i, 'Daily summary'], [/RING STYLE/i, 'Ring style details'], [/ABOUT THE BUYER/i, 'About the buyer'], [/RING PORTAL OPENED/i, 'Ring Portal opened'], [/RING PORTAL STARTED/i, 'Ring Portal started'], [/RING PORTAL PAUSED/i, 'Ring Portal left partway'], [/RING PORTAL MESSAGE/i, 'Ring Portal message'], [/DESIGN (CREATED|UPDATED)/i, 'Ring Portal design'], [/update from Hidden Gem/i, 'Portal update to customer'], [/RESENT: /i, 'NEW LEAD (resent by safety check)'], [/ lead, /i, 'NEW LEAD (form filled)'],
    [/paid /i, 'Payment received'], [/APPROVED design/i, 'Design approved'], [/Your Hidden Gem ring picks/i, 'Ring picks sent to customer'], [/Your Hidden Gem request/i, 'Recap sent to customer (private)'],
    [/Your Hidden Gem design approval/i, 'Approval sent to customer'], [/newsletter/i, 'Newsletter signup'], [/consultation inquiry/i, 'Consultation inquiry'],
  ];
  for (const [re, label] of map) if (re.test(s)) return label;
  return 'Other';
}
async function logEmail(env, entry) {
  try {
    const k = `emaillog:${centralDay()}`;
    const list = (await env.IG_KV.get(k, 'json')) || [];
    list.unshift(entry);
    await env.IG_KV.put(k, JSON.stringify(list.slice(0, 300)), { expirationTtl: 86400 * 30 });
  } catch (e) {}
}
async function handleEmailLog(url, env, origin) {
  const day = url.searchParams.get('day') || centralDay();
  const list = (await env.IG_KV.get(`emaillog:${day}`, 'json')) || [];
  const failed = list.filter((x) => !x.ok).length;
  if (url.searchParams.get('format') === 'json') return json({ ok: true, day, sent: list.length - failed, failed, emails: list }, 200, origin);
  const leads = list.filter((x) => /LEAD/.test(x.type)).length;
  const row = (x) => `<tr><td>${escapeHtml(x.time.replace(/^\w+, /, ''))}</td><td${/LEAD/.test(x.type) ? ' style="font-weight:700;color:#8a5a00"' : ''}>${escapeHtml(x.type)}</td><td>${escapeHtml((x.to || []).join(', '))}</td><td style="font-weight:700;color:${x.ok ? '#2e7d32' : '#c62828'}">${x.ok ? 'Sent' : 'FAILED'}</td></tr>`;
  const prev = new Date(new Date(day + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Hidden Gem email log</title>` +
    `<style>body{font-family:-apple-system,Arial,sans-serif;background:#F2EEE6;color:#3b322a;margin:0;padding:18px}h1{font-size:22px;margin:0 0 4px}p{margin:4px 0 14px;color:#6B5B4C}` +
    `.cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}.c{background:#fff;border-radius:12px;padding:10px 14px;min-width:90px}.c b{display:block;font-size:22px}` +
    `table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;font-size:14px}td,th{padding:9px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{background:#8A7F6E;color:#fff;font-weight:600}a{color:#8a5a00}</style></head><body>` +
    `<h1>Hidden Gem email log</h1><p>${escapeHtml(day)} · Central time · refresh to update · <a href="?day=${prev}">previous day</a></p>` +
    `<div class="cards"><div class="c"><b>${list.length - failed}</b>Sent</div><div class="c"><b style="color:${failed ? '#c62828' : 'inherit'}">${failed}</b>Failed</div><div class="c"><b>${leads}</b>Lead emails</div></div>` +
    `<table><tr><th>Time</th><th>Type</th><th>Sent to</th><th>Status</th></tr>${list.map(row).join('') || '<tr><td colspan="4">No emails yet today</td></tr>'}</table>` +
    `<p style="margin-top:14px;font-size:12px">If something shows Sent but is not in your inbox, check Spam. Logging started Nov 11, 4:30 PM.</p></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function sendEmail(env, { to, subject, html, replyTo, from }) {
  const payload = { from: from || FROM_ADDRESS, to: to || [OWNER_ADDRESS, TO_ADDRESS], subject, html };
  // Team alerts are also copied to the inbox Claude can read, so every form and pick is on record.
  if (payload.to.some((x) => x === OWNER_ADDRESS || x === PUBLIC_EMAIL)) payload.bcc = [CLAUDE_COPY];
  if (replyTo) payload.reply_to = replyTo;
  let result = { ok: false, error: 'not sent' };
  // Hidden Gem's own Resend account sends from hello@hiddengemrings.com once its
  // key is saved (RESEND_HG_KEY). If that send fails for any reason (for example
  // the domain is not verified yet), the old sender is used so nothing is lost.
  const routes = [];
  if (env.RESEND_HG_KEY) routes.push([env.RESEND_HG_KEY, Object.assign({}, payload, { from: HG_FROM, reply_to: payload.reply_to || PUBLIC_EMAIL })]);
  routes.push([env.RESEND_API_KEY, payload]);
  for (let attempt = 1; attempt <= routes.length + 1; attempt++) {
    const [key, body0] = routes[Math.min(attempt - 1, routes.length - 1)];
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body0),
      });
      if (res.ok) {
        const b = await res.json().catch(() => ({}));
        result = { ok: true, id: b.id || '', via: body0.from };
        break;
      }
      const body = await res.text().catch(() => '');
      result = { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
    } catch (err) {
      result = { ok: false, error: String(err && err.message || err) };
    }
  }
  const etype = emailType(subject);
  const toCustomer = /to customer/i.test(etype);
  const inboxes = (Array.isArray(payload.to) ? payload.to : [payload.to]).map((a) => toCustomer ? 'customer (' + (String(a).split('@')[1] || '') + ')' : String(a));
  await logEmail(env, { time: centralTime(), at: Date.now(), type: etype, to: inboxes, ok: result.ok, resendId: result.id || '', from: result.via || '', error: result.ok ? '' : String(result.error || '').slice(0, 160) });
  return result;
}


// ----- Visit alerts and daily summary (track.js on the site) -----
// Alerts go to the public inbox and the owner inbox. track.js only sends
// after a real tap, scroll, click or keypress, and crawlers are filtered here
// too, so link previews never alert.
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|meta-externalagent|whatsapp|telegram|discord|slack|skype|headless|lighthouse|python|curl|wget|httpclient|okhttp|go-http/i;
const TRACK_EVENTS = {
  view: null,
  quiz_start: 'Someone started the quiz',
  quiz_abandon: 'Someone left the quiz before finishing',
  rings_open: 'opened their Pick Your Ring link',
  approve_open: 'opened their design approval link',
  collection_hot: 'Someone is browsing rings (3+ rings looked at)',
};
function centralDay(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts || new Date());
}
function centralTime(ts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ts || new Date());
}
// Diagnostic counters (no IPs stored): why each /track hit was kept or dropped.
async function trackDiag(env, reason, cf, ua) {
  try {
    const k = `trackdiag:${centralDay()}`;
    const d = (await env.IG_KV.get(k, 'json')) || { reasons: {}, recent: [] };
    d.reasons[reason] = (d.reasons[reason] || 0) + 1;
    d.recent.unshift({ t: centralTime(), reason, org: String(cf.asOrganization || '').slice(0, 40), asn: cf.asn || 0, city: cf.city || '', ua: /Instagram/i.test(ua) ? 'Instagram app' : /FBAN|FBAV/i.test(ua) ? 'Facebook app' : /iPhone|iPad/i.test(ua) ? 'iPhone browser' : /Android/i.test(ua) ? 'Android browser' : 'Computer' });
    d.recent = d.recent.slice(0, 40);
    await env.IG_KV.put(k, JSON.stringify(d), { expirationTtl: 86400 * 7 });
  } catch (e) {}
}
async function handleTrackStats(url, env, origin) {
  const day = url.searchParams.get('day') || centralDay();
  const st = (await env.IG_KV.get(`stats:${day}`, 'json')) || {};
  const leadIds = (await env.IG_KV.get('index:leads', 'json')) || [];
  const latest = leadIds.length ? await env.IG_KV.get(`lead:${leadIds[0]}`, 'json') : null;
  return json({ ok: true, day, total_leads: leadIds.length, latest_lead_at: latest ? (latest.receivedAt || null) : null, latest_lead_id: leadIds[0] || null, alerted_visitors: Object.keys(st.visitors || {}).length, sources: st.sources || {}, places: st.places || {}, events: st.events || {}, ...((await env.IG_KV.get(`trackdiag:${day}`, 'json')) || {}) }, 200, origin);
}
async function handleTrack(request, env, origin) {
  const ok = () => json({ ok: true }, 200, origin);
  const ua = request.headers.get('User-Agent') || '';
  const cf = request.cf || {};
  if (BOT_UA.test(ua)) { await trackDiag(env, 'bot_ua', cf, ua); return ok(); }
  // drop crawlers, verified bots and traffic from cloud/data center networks
  if (cf.botManagement && (cf.botManagement.verifiedBot || (cf.botManagement.score && cf.botManagement.score < 30))) { await trackDiag(env, 'bot_score', cf, ua); return ok(); }
  if (/facebook|meta platforms|instagram|amazon|aws|google cloud|googlebot|microsoft|azure|digitalocean|linode|akamai|ovh|hetzner|oracle|alibaba|tencent|cloudflare|fastly|vultr|scaleway|leaseweb|choopa|m247|datacamp|hostinger|contabo/i.test(String(cf.asOrganization || ''))) { await trackDiag(env, 'datacenter_org', cf, ua); return ok(); }
  if (cf.asn === 32934 || cf.asn === 63293 || cf.asn === 54115) { await trackDiag(env, 'meta_asn', cf, ua); return ok(); } // Meta crawler and ad review networks (Prineville, Oregon)
  // one alert per network address every 6 hours, so repeat hits never flood the inbox
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip) {
    const ik = `ipseen:${ip}`;
    const n = Number(await env.IG_KV.get(ik) || 0);
    if (n >= 3) { await trackDiag(env, 'ip_cap', cf, ua); return ok(); }
    await env.IG_KV.put(ik, String(n + 1), { expirationTtl: 21600 });
  }
  await trackDiag(env, 'passed_filters', cf, ua);
  const city = [cf.city, cf.regionCode || cf.region].filter(Boolean).join(', ');
  const place = city ? `${city}${cf.postalCode ? ' (near ' + cf.postalCode + ')' : ''}${cf.country && cf.country !== 'US' ? ' ' + cf.country : ''}` : 'Unknown';
  let t;
  try { t = JSON.parse(await request.text()); } catch (e) { return ok(); }
  const ev = String(t.ev || '');
  if (!(ev in TRACK_EVENTS) || !t.sid) return ok();
  const sid = String(t.sid).replace(/[^a-z0-9]/gi, '').slice(0, 40);
  const page = String(t.page || '/').slice(0, 60);
  const src = String(t.src || 'Unknown').slice(0, 60);
  const data = (t.data && typeof t.data === 'object') ? t.data : {};

  // one alert per visitor per event (12 hours)
  const dk = `trk:${sid}:${ev}:${ev === 'view' ? page : ''}`;
  if (await env.IG_KV.get(dk)) return ok();
  await env.IG_KV.put(dk, '1', { expirationTtl: 43200 });

  // daily counts for the summary email
  const sk = `stats:${centralDay()}`;
  const st = (await env.IG_KV.get(sk, 'json')) || { pages: {}, events: {}, sources: {}, visitors: {} };
  st.events[ev] = (st.events[ev] || 0) + 1;
  if (ev === 'view' || ev === 'rings_open' || ev === 'approve_open') st.pages[page] = (st.pages[page] || 0) + 1;
  if (!st.visitors[sid]) { st.visitors[sid] = 1; st.sources[src] = (st.sources[src] || 0) + 1; st.places = st.places || {}; st.places[place] = (st.places[place] || 0) + 1; }
  await env.IG_KV.put(sk, JSON.stringify(st), { expirationTtl: 86400 * 40 });

  let label = TRACK_EVENTS[ev];
  if (ev === 'view') {
    // one "someone is on your site" alert per visitor visit (12 hours)
    const vk = `vis:${sid}`;
    if (await env.IG_KV.get(vk)) return ok();
    await env.IG_KV.put(vk, '1', { expirationTtl: 43200 });
    label = 'Someone is on your site';
  }
  if (!label) return ok();

  let who = '', ring = '';
  const id = String(t.id || '').replace(/[^a-z0-9]/g, '').slice(0, 32);
  if (id && (ev === 'rings_open' || ev === 'approve_open')) {
    const o = await env.IG_KV.get(`order:${id}`, 'json');
    if (o) { who = o.customerName || ''; ring = o.ring || ''; }
  }
  const title = who ? `${who} ${label}` : (label.charAt(0).toUpperCase() + label.slice(1));
  const rows = [['When', centralTime()], ['Approximate location', place], ['Page', 'hiddengemrings.com' + page], ['Came from', src]];
  if (ring) rows.push(['Ring', ring]);
  Object.entries(data).slice(0, 14).forEach(([k, v]) => { if (v) rows.push([k, String(v).slice(0, 200)]); });
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h2 style="margin:0 0 10px">${escapeHtml(title)}</h2><table cellpadding="6" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table><p style="color:#777;font-size:12px">Real visitors only. Bots and link previews are filtered out.</p></div>`;
  await sendEmail(env, { to: [PUBLIC_EMAIL, OWNER_ADDRESS], subject: `Hidden Gem: ${title}${city ? ' (' + city + ')' : ''}`, html });
  return ok();
}
async function sendDailySummary(env) {
  const day = centralDay(new Date(Date.now() - 86400000));
  const st = await env.IG_KV.get(`stats:${day}`, 'json');
  const e = (st && st.events) || {};
  const visitors = st ? Object.keys(st.visitors || {}).length : 0;
  const list = (obj) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li>${escapeHtml(k)}: ${v}</li>`).join('') || '<li>None</li>';
  const elog = (await env.IG_KV.get(`emaillog:${day}`, 'json')) || [];
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>Hidden Gem daily summary for ${day}</h2>` +
    `<p><strong>${visitors}</strong> real visitors</p><ul>` +
    `<li>Quiz started: ${e.quiz_start || 0}</li><li>Quiz left unfinished: ${e.quiz_abandon || 0}</li>` +
    `<li>Pick Your Ring links opened: ${e.rings_open || 0}</li><li>Design approval links opened: ${e.approve_open || 0}</li>` +
    `<li>Ring browsers (3+ rings): ${e.collection_hot || 0}</li></ul>` +
    `<h3>Where visitors came from</h3><ul>${list(st && st.sources)}</ul><h3>Approximate visitor locations</h3><ul>${list(st && st.places)}</ul><h3>Pages viewed</h3><ul>${list(st && st.pages)}</ul>` +
    `<h3>Every email the site sent (${elog.length})</h3>` +
    (elog.length ? `<table cellpadding="4" style="border-collapse:collapse;font-size:13px">` + elog.slice().reverse().map((x) => `<tr><td>${escapeHtml(x.time)}</td><td>${escapeHtml(x.type)}</td><td style="color:${x.ok ? '#2e7d32' : '#c62828'}">${x.ok ? 'Sent' : 'FAILED'}</td></tr>`).join('') + `</table>` : '<p>None</p>') +
    `<p>If any alert above is not in your inbox, check Spam. Live log: https://long-bar-d49d.gilbertrenteria.workers.dev/email/log</p>` +
    `<p style="color:#777;font-size:12px">Finished quizzes are emailed the moment they come in.</p></div>`;
  await sendEmail(env, { to: [PUBLIC_EMAIL, OWNER_ADDRESS], subject: `Hidden Gem daily summary: ${visitors} visitors on ${day}`, html });
}

// Every request goes through the app; successful customer form posts are also
// written to the activity log (after the response, so nothing slows down).
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const watch = request.method === 'POST' && ACTIVITY_ROUTES.some(([re]) => re.test(path));
    const copy = watch ? request.clone() : null;
    const res = await app.fetch(request, env);
    if (watch && res && res.ok) {
      const resCopy = res.clone(); // read our copy, the original goes to the customer untouched
      const task = (async () => {
        let fields = {};
        try { const ct = copy.headers.get('Content-Type') || ''; fields = ct.includes('application/json') ? await copy.json() : Object.fromEntries((await copy.formData()).entries()); } catch (e) {}
        let body = null; try { body = await resCopy.json(); } catch (e) {}
        await logActivity(env, path, fields, body);
      })();
      if (ctx && ctx.waitUntil) ctx.waitUntil(task); else await task;
    }
    return res;
  },
  scheduled(event, env, ctx) { return app.scheduled(event, env, ctx); },
};
