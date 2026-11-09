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

// Public contact email (switch to hello@hiddengemrings.com once that inbox works).
const PUBLIC_EMAIL = 'hiddengembridalrings@gmail.com';
const TO_ADDRESS = PUBLIC_EMAIL;
const OWNER_ADDRESS = 'gilbertrenteria@yahoo.com';
const FROM_ADDRESS = 'Hidden Gem Website <forms@mail.gilbertrenteria.dev>';
const CUSTOMER_FROM = 'Hidden Gem Engagement Rings <rings@mail.gilbertrenteria.dev>';
const SITE = 'https://hiddengemrings.com';

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

// === Team status, lead routing and call booking ===
// The team page (team.html, password = ADMIN_KEY) sets who is Online, who
// gets leads first, the weekly call hours and the rep names and emails.
// Everything lives in IG_KV:
//   team:config        reps, lead order, round-robin pointer
//   team:avail         weekly call hours + blocked dates
//   book:YYYY-MM-DD    { 'HH:MM': { leadId, name, phone } }
//   index:bookdates    list of dates that have bookings

const TZ = 'America/Chicago';
const SLOT_MIN = 15;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DEFAULT_CONFIG = {
  reps: [
    { id: 'gilbert', name: 'Gilbert', email: OWNER_ADDRESS, online: false },
    { id: 'partner', name: 'Partner', email: PUBLIC_EMAIL, online: false },
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

// Open 15 minute slots for one date (Chicago time), minus booked ones.
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
    if (!booked[hm]) out.push(hm);
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
  return Array.from(new Set(reps.map((r) => r.email).concat([OWNER_ADDRESS]).filter(Boolean)));
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
  if (l.contact === 'Call me') return 'CALL NOW. Text first, then call within 5 minutes.';
  if (l.contact === 'Text me') return 'TEXT NOW. Text within 5 minutes with 2 to 3 matching designs from the Canva library.';
  return 'Reach out within 5 minutes.';
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
  return Array.from(new Set((lead.routedEmails || []).concat([OWNER_ADDRESS])));
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
  const email = String(fields.email || '').trim().slice(0, 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'Please check your email address' }, 400, origin);
  const key = `lead:${id}`;
  const lead = await env.IG_KV.get(key, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  if (lead.recapSent && lead.email === email) return json({ ok: true, duplicate: true }, 200, origin);
  lead.email = email;
  await env.IG_KV.put(key, JSON.stringify(lead));

  const first = escapeHtml(lead.name.split(' ')[0]);
  let howNext;
  if (lead.contact === 'Book a call') howNext = `Your 15 minute call is booked for <strong>${labelDate(lead.slotDate)} at ${labelTime(lead.slotTime)}</strong> (Central). One of our ring specialists will call you then.`;
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
    `<h3 style="font-family:Arial,sans-serif;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#776C5C;margin:22px 0 8px">What happens next</h3>` +
    `<ol style="font-size:16px;line-height:1.55;padding-left:20px"><li>We send ring designs that match your style and budget.</li><li>You get a secure link to check your payment options with our lending partner, right on your phone.</li><li>You approve your final design and we start making your ring. Delivered within 6 weeks.</li></ol>` +
    `<p style="margin:24px 0"><a href="${SITE}/collection.html" style="background:#54453A;color:#fff;padding:13px 26px;border-radius:999px;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;letter-spacing:.08em;font-size:13px;text-transform:uppercase">Browse the collection</a></p>` +
    `<p style="font-family:Arial,sans-serif;font-size:12.5px;color:#776C5C;line-height:1.55">Questions? Just reply to this email. Financing is offered through our approved lending partners and is subject to their credit approval. Hidden Gem never asks for your Social Security number, income or bank details. <a href="${SITE}/policies.html" style="color:#776C5C">Our policies</a></p></div>`;
  const sent = await sendEmail(env, { to: [email], subject: `Your Hidden Gem ring picks, ${lead.name.split(' ')[0]}`, html, replyTo: PUBLIC_EMAIL, from: CUSTOMER_FROM });
  if (!sent.ok) return json({ ok: false, error: sent.error, saved: true }, 502, origin);
  lead.recapSent = true;
  await env.IG_KV.put(key, JSON.stringify(lead));
  return json({ ok: true }, 200, origin);
}

async function handleLead(fields, request, env, origin) {
  if (fields._honey) return json({ ok: true }, 200, origin);
  const id = String(fields.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 48);
  const name = String(fields.name || '').trim().slice(0, 120);
  const phone = String(fields.phone || '').trim().slice(0, 40);
  if (!id || name.length < 2 || digits(phone).length < 10) {
    return json({ ok: false, error: 'Name and a 10 digit phone are required' }, 400, origin);
  }
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
    `<p style="color:#777;font-size:13px">Team page: <a href="${SITE}/team.html">${SITE}/team.html</a></p>` +
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

// === Design approvals ===
// Gilbert creates an order from approve-admin.html (needs ADMIN_KEY). The
// customer opens approve.html?id=..., checks the final-sale box, types
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
    hasImage: !!o.hasImage, delivery: 'Within 6 weeks of approval and completed payment or financing',
    createdAt: o.createdAt, approved: !!o.approval,
    approval: o.approval ? { name: o.approval.name, at: o.approval.at } : null,
  };
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
  return json({ ok: true, id: order.id, link: `${SITE}/approve.html?id=${order.id}` }, 200, origin);
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
    ['Delivery', 'Within 6 weeks of approval and completed payment or financing'],
    ['Approved by (typed name)', o.approval.name], ['Approved at', chicagoTime(o.approval.at)],
    ['Agreement', o.approval.terms], ['Order ID', o.id],
  ];
  const table = `<table cellpadding="7" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('') + `</table>`;
  const imgTag = o.hasImage ? `<p><img src="https://long-bar-d49d.gilbertrenteria.workers.dev/order/${o.id}/image" alt="Approved design" style="max-width:100%;border-radius:12px"></p>` : '';

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
      html: `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>Thank you, ${escapeHtml(o.customerName.split(' ')[0])}!</h2><p>Here is a copy of the design you approved. We'll keep you updated while your ring is being made.</p>${imgTag}${table}<p>Questions? Reply to this email or write to ${PUBLIC_EMAIL}.</p></div>`,
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
  return json({ ok: true, order: publicOrder(o) }, 200, origin);
}

async function handleAdminList(url, env, origin) {
  if (!isAdmin(null, url, env)) return json({ ok: false, error: 'Wrong admin key' }, 403, origin);
  const leadIds = ((await env.IG_KV.get('index:leads', 'json')) || []).slice(0, 50);
  const orderIds = ((await env.IG_KV.get('index:orders', 'json')) || []).slice(0, 50);
  const leads = (await Promise.all(leadIds.map((id) => env.IG_KV.get(`lead:${id}`, 'json')))).filter(Boolean);
  const orders = (await Promise.all(orderIds.map((id) => env.IG_KV.get(`order:${id}`, 'json')))).filter(Boolean)
    .map((o) => ({ ...publicOrder(o), customerPhone: o.customerPhone, link: `${SITE}/approve.html?id=${o.id}` }));
  return json({ ok: true, leads, orders }, 200, origin);
}

async function handleLeadStatus(fields, url, env, origin) {
  if (!isAdmin(fields, url, env)) return json({ ok: false, error: 'Wrong admin key' }, 403, origin);
  const id = String(fields.id || '');
  const lead = await env.IG_KV.get(`lead:${id}`, 'json');
  if (!lead) return json({ ok: false, error: 'Lead not found' }, 404, origin);
  lead.status = String(fields.status || 'new').slice(0, 30);
  lead.statusAt = Date.now();
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
      if (path === '/team/public') return handlePublicStatus(env, origin);
      if (path === '/team/state') return handleTeamState(url, env, origin);
      if (path === '/book/slots') return handleSlots(env, origin);
      let m = path.match(/^\/order\/([a-z0-9]{6,32})\/image$/);
      if (m) return handleOrderImage(m[1], env);
      m = path.match(/^\/order\/([a-z0-9]{6,32})$/);
      if (m) return handleOrderGet(m[1], env, origin);
      return new Response('Not found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405, origin);
    }

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
    if (path === '/admin/lead-status') return handleLeadStatus(fields, url, env, origin);
    const am = path.match(/^\/order\/([a-z0-9]{6,32})\/approve$/);
    if (am) return handleOrderApprove(am[1], fields, request, env, origin);

    // honeypot — silently accept so a bot can't tell it was rejected
    if (fields._honey) {
      return json({ ok: true }, 200, origin);
    }

    const formType = fields.Form === 'Newsletter Signup' ? 'newsletter' : 'consultation';

    if (formType === 'newsletter') {
      const email = (fields.Email || '').trim();
      if (!email || !email.includes('@')) {
        return json({ ok: false, error: 'A valid email is required' }, 400, origin);
      }
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
