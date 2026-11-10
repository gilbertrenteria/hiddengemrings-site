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
const PUBLIC_PHONE = '(832) 743-7657';
const PUBLIC_TEL = '+18327437657';
const OWNER_ADDRESS = 'gilbertrenteria@yahoo.com';
const FROM_ADDRESS = 'Hidden Gem Website <forms@mail.gilbertrenteria.dev>';
const CUSTOMER_FROM = 'Hidden Gem Engagement Rings <rings@mail.gilbertrenteria.dev>';
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

function contactLine(l) {
  if (l.contact === 'Book a call') return `BOOKED CALL: ${labelDate(l.slotDate)} at ${labelTime(l.slotTime)} (Central). Call them at that time.`;
  if (l.routeMode === 'offline') return `Everyone was offline. ${l.contact === 'Text me' ? 'Text' : 'Call'} them first thing during business hours (9 AM to 9 PM).`;
  if (l.contact === 'Call me') return 'CALL NOW. Text first, then call within 15 minutes.';
  if (l.contact === 'Text me') return 'TEXT NOW. Text within 15 minutes with 2 to 3 matching designs from the Canva library.';
  return 'Reach out within 15 minutes.';
}
function contactShort(l) {
  if (l.contact === 'Book a call') return 'BOOKED CALL';
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

async function handleDesign(fields, env, origin) {
  const id = String(fields.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const key = `lead:${id}`;
  const lead = await env.IG_KV.get(key, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found, send the first form again' }, 404, origin);
  if (lead.design && lead.designEmailed) return json({ ok: true, duplicate: true }, 200, origin);
  lead.design = lead.design || Object.fromEntries(DESIGN_FIELDS.map(([k]) => [k, String(fields[k] || '').slice(0, 300)]));
  lead.designAt = lead.designAt || Date.now();
  await env.IG_KV.put(key, JSON.stringify(lead));
  const tel = digits(lead.phone).replace(/^1(?=\d{10}$)/, '');
  const rows = DESIGN_FIELDS.map(([k, label]) => [label, lead.design[k] || 'not answered'])
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
  let howNext;
  if (lead.contact === 'Book a call') howNext = `Your 30 minute call is booked for <strong>${labelDate(lead.slotDate)} at ${labelTime(lead.slotTime)}</strong> (Central). One of our ring specialists will call you then.`;
  else if (lead.routeMode === 'offline') howNext = `Our ring specialists are away right now. We will ${lead.contact === 'Text me' ? 'text' : 'call'} you during business hours (Mon to Sat, 9 AM to 9 PM).`;
  else if (lead.contact === 'Call me') howNext = 'One of our ring specialists will be calling you shortly.';
  else howNext = 'One of our ring specialists will be texting you shortly.';
  const picks = [['Ring budget', lead.budget], ['How you want to pay', lead.pay], ['Proposing', lead.timeline === 'ASAP' ? 'As soon as possible' : lead.timeline]]
    .concat(lead.design ? DESIGN_FIELDS.filter(([k]) => lead.design[k]).map(([k, l]) => [l, lead.design[k]]) : [])
    .filter(([, v]) => v);
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;background:#F6F3EC;padding:28px;border-radius:18px;color:#453E37">` +
    `<p style="font-family:Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;font-size:12px;color:#B99C5F;margin:0 0 8px">Hidden Gem Engagement Rings</p>` +
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
  const sent = await sendEmail(env, { to: [email], subject: `Your Hidden Gem ring picks, ${lead.name.split(' ')[0]}`, html, replyTo: PUBLIC_EMAIL, from: CUSTOMER_FROM });
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
    timeline: pick('timeline'), credit: pick('credit'), contact: pick('contact'),
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
  await env.IG_KV.put(key, JSON.stringify(lead));
  await addToIndex(env, 'index:leads', id);

  const tel = digits(phone).replace(/^1(?=\d{10}$)/, '');
  const rows = [
    ['Name', lead.name],
    ['Phone', `<a href="tel:+1${tel}">${escapeHtml(fmtPhone(lead.phone))}</a> (tap to call)`],
    ['Ring budget', lead.budget],
    ['How they want to pay', lead.pay],
    ['Wants to continue by', lead.contact || 'not answered'],
    ['Comfortable monthly', lead.monthly || 'n/a'],
    ['Proposing', lead.timeline],
    ['Credit (self reported)', lead.credit || 'not answered'],
    ['Sent to', `${(lead.routedNames || []).join(', ')} (${lead.routeReason})`],
    ['Received', chicagoTime(lead.receivedAt)],
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

// Ring options: up to 6 rings for one customer on one link (/rings).
async function handleOptionsCreate(fields, env, origin, url) {
  if (!isAdmin(fields, url, env)) return json({ ok: false, error: 'Wrong admin key' }, 403, origin);
  const s = (v, n = 200) => String(v || '').trim().slice(0, n);
  const raw = Array.isArray(fields.options) ? fields.options.slice(0, 6) : [];
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

async function handleOrderGet(id, env, origin) {
  const o = await env.IG_KV.get(`order:${id}`, 'json');
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
  if (o.customerEmail && o.customerEmail.includes('@') && !o.approval.customerEmailed) {
    const c = await sendEmail(env, {
      to: [o.customerEmail],
      subject: 'Your Hidden Gem design approval',
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

async function handleAdminList(url, env, origin) {
  if (!isAdmin(null, url, env)) return json({ ok: false, error: 'Wrong admin key' }, 403, origin);
  const leadIds = ((await env.IG_KV.get('index:leads', 'json')) || []).slice(0, 50);
  const orderIds = ((await env.IG_KV.get('index:orders', 'json')) || []).slice(0, 50);
  const leads = (await Promise.all(leadIds.map((id) => env.IG_KV.get(`lead:${id}`, 'json')))).filter(Boolean);
  const orders = (await Promise.all(orderIds.map((id) => env.IG_KV.get(`order:${id}`, 'json')))).filter(Boolean)
    .map((o) => ({ ...publicOrder(o), customerPhone: o.customerPhone, link: `${SITE}/${o.options ? 'rings' : 'approve'}?id=${o.id}` }));
  return json({ ok: true, leads, orders }, 200, origin);
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

export default {
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
      if (path === '/admin/list') return handleAdminList(url, env, origin);
      if (path === '/admin/lead') return handleAdminLead(url, env, origin);
      if (path === '/admin/inspo') return handleInspoGet(url, env, origin);
      if (path === '/team/public') return handlePublicStatus(env, origin);
      if (path === '/team/state') return handleTeamState(url, env, origin);
      if (path === '/book/slots') return handleSlots(env, origin);
      if (path === '/email/check') return handleEmailCheck(url, env, origin);
      let m = path.match(/^\/order\/([a-z0-9]{6,32})\/image\/([0-5]|size)$/);
      if (m) return handleOptionImage(m[1], m[2], env);
      m = path.match(/^\/order\/([a-z0-9]{6,32})\/image$/);
      if (m) return handleOrderImage(m[1], env);
      m = path.match(/^\/order\/([a-z0-9]{6,32})$/);
      if (m) return handleOrderGet(m[1], env, origin);
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
    if (path === '/lead/email') return handleLeadEmail(fields, env, origin);
    if (path === '/team/update') return handleTeamUpdate(fields, url, env, origin);
    if (path === '/order/create') return handleOrderCreate(fields, env, origin, url);
    if (path === '/order/create-options') return handleOptionsCreate(fields, env, origin, url);
    const sm = path.match(/^\/order\/([a-z0-9]{6,32})\/seen$/);
    if (sm) return handleOrderSeen(sm[1], env, origin);
    const chm = path.match(/^\/order\/([a-z0-9]{6,32})\/choose$/);
    if (chm) return handleOptionsChoose(chm[1], fields, env, origin);
    if (path === '/admin/lead-status') return handleLeadStatus(fields, url, env, origin);
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
    if (event.cron === '0 14 * * *') { await sendDailySummary(env); return; }
    await refreshMediaCache(env);
  },
};

async function sendEmail(env, { to, subject, html, replyTo, from }) {
  try {
    const payload = { from: from || FROM_ADDRESS, to: to || [OWNER_ADDRESS, TO_ADDRESS], subject, html };
    if (replyTo) payload.reply_to = replyTo;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
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
async function handleTrack(request, env, origin) {
  const ok = () => json({ ok: true }, 200, origin);
  if (BOT_UA.test(request.headers.get('User-Agent') || '')) return ok();
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
  if (!st.visitors[sid]) { st.visitors[sid] = 1; st.sources[src] = (st.sources[src] || 0) + 1; }
  await env.IG_KV.put(sk, JSON.stringify(st), { expirationTtl: 86400 * 40 });

  const label = TRACK_EVENTS[ev];
  if (!label) return ok();

  let who = '', ring = '';
  const id = String(t.id || '').replace(/[^a-z0-9]/g, '').slice(0, 32);
  if (id && (ev === 'rings_open' || ev === 'approve_open')) {
    const o = await env.IG_KV.get(`order:${id}`, 'json');
    if (o) { who = o.customerName || ''; ring = o.ring || ''; }
  }
  const title = who ? `${who} ${label}` : (label.charAt(0).toUpperCase() + label.slice(1));
  const rows = [['When', centralTime()], ['Page', 'hiddengemrings.com' + page], ['Came from', src]];
  if (ring) rows.push(['Ring', ring]);
  Object.entries(data).slice(0, 14).forEach(([k, v]) => { if (v) rows.push([k, String(v).slice(0, 200)]); });
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h2 style="margin:0 0 10px">${escapeHtml(title)}</h2><table cellpadding="6" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table><p style="color:#777;font-size:12px">Real visitors only. Bots and link previews are filtered out.</p></div>`;
  await sendEmail(env, { to: [PUBLIC_EMAIL, OWNER_ADDRESS], subject: `Hidden Gem: ${title}`, html });
  return ok();
}
async function sendDailySummary(env) {
  const day = centralDay(new Date(Date.now() - 86400000));
  const st = await env.IG_KV.get(`stats:${day}`, 'json');
  const e = (st && st.events) || {};
  const visitors = st ? Object.keys(st.visitors || {}).length : 0;
  const list = (obj) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li>${escapeHtml(k)}: ${v}</li>`).join('') || '<li>None</li>';
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>Hidden Gem daily summary for ${day}</h2>` +
    `<p><strong>${visitors}</strong> real visitors</p><ul>` +
    `<li>Quiz started: ${e.quiz_start || 0}</li><li>Quiz left unfinished: ${e.quiz_abandon || 0}</li>` +
    `<li>Pick Your Ring links opened: ${e.rings_open || 0}</li><li>Design approval links opened: ${e.approve_open || 0}</li>` +
    `<li>Ring browsers (3+ rings): ${e.collection_hot || 0}</li></ul>` +
    `<h3>Where visitors came from</h3><ul>${list(st && st.sources)}</ul><h3>Pages viewed</h3><ul>${list(st && st.pages)}</ul>` +
    `<p style="color:#777;font-size:12px">Finished quizzes are emailed the moment they come in.</p></div>`;
  await sendEmail(env, { to: [PUBLIC_EMAIL, OWNER_ADDRESS], subject: `Hidden Gem daily summary: ${visitors} visitors on ${day}`, html });
}
