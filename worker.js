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

const TO_ADDRESS = 'hello@hiddengemrings.com';
const OWNER_ADDRESS = 'gilbertrenteria@yahoo.com';
const FROM_ADDRESS = 'Hidden Gem Website <forms@mail.gilbertrenteria.dev>';
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

function contactLine(c) {
  if (c === 'Call me') return 'Wants a CALL. Text first, then call within 5 minutes.';
  if (c === 'Text me') return 'Wants TEXT only. Text within 5 minutes with 2 to 3 ring photos.';
  if (c === 'Design it online') return 'Chose DESIGN IT ONLINE. Their design picks arrive in a second email. Text a concept and price within 24 hours.';
  return 'Reach out within 5 minutes.';
}
function contactShort(c) {
  return c === 'Call me' ? 'CALL' : c === 'Text me' ? 'TEXT' : c === 'Design it online' ? 'ONLINE' : 'ANY';
}

const DESIGN_FIELDS = [
  ['style', 'Ring style'], ['shape', 'Stone shape'], ['carat', 'Stone size'], ['stoneType', 'Stone type'],
  ['metal', 'Metal'], ['band', 'Band style'], ['ringSize', 'Ring size'], ['engraving', 'Engraving'], ['designNotes', 'Notes'],
];

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
    .concat([['Budget', lead.budget], ['Pay', lead.pay], ['Proposing', lead.timeline], ['Phone', fmtPhone(lead.phone)]]);
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">` +
    `<div style="display:inline-block;background:#B99C5F;color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:.06em">ONLINE DESIGN</div>` +
    `<h2 style="margin:14px 0 6px">${escapeHtml(lead.name)} designed a ring online</h2>` +
    `<p style="margin:0 0 14px;color:#333"><strong>Text a concept and exact price within 24 hours.</strong></p>` +
    `<table cellpadding="7" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table><p style="margin-top:18px"><a href="sms:+1${tel}" style="background:#54453A;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">Text ${escapeHtml(lead.name.split(' ')[0])}</a></p></div>`;
  const sent = await sendEmail(env, { to: [OWNER_ADDRESS, TO_ADDRESS], subject: `ONLINE DESIGN: ${lead.name} (${lead.design.style || 'custom'}, ${lead.budget || 'budget not set'})`, html });
  if (!sent.ok) return json({ ok: false, error: sent.error, saved: true }, 502, origin);
  lead.designEmailed = true;
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
  if (existing && existing.emailed) return json({ ok: true, duplicate: true }, 200, origin);

  const pick = (k) => String(fields[k] || '').slice(0, 80);
  const lead = existing || {
    id, name, phone,
    budget: pick('budget'), pay: pick('pay'), monthly: pick('monthly'),
    timeline: pick('timeline'), credit: pick('credit'), contact: pick('contact'),
    page: pick('page'), receivedAt: Date.now(), status: 'new',
    ua: (request.headers.get('User-Agent') || '').slice(0, 200),
  };
  lead.label = leadLabel(lead);
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
    ['Received', chicagoTime(lead.receivedAt)],
  ];
  const color = { 'READY': '#1f7a3a', 'WARM': '#b07a12', 'PLANNING': '#5b6b8a', 'JUST LOOKING': '#777' }[lead.label] || '#54453A';
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:560px">` +
    `<div style="display:inline-block;background:${color};color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:.06em">${lead.label}</div>` +
    `<h2 style="margin:14px 0 6px">New payment options lead: ${escapeHtml(lead.name)}</h2>` +
    `<p style="margin:0 0 14px;color:#333;font-size:16px"><strong>${escapeHtml(contactLine(lead.contact))}</strong></p>` +
    `<table cellpadding="7" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:600;color:#6B5B4C;vertical-align:top">${escapeHtml(k)}</td><td>${k === 'Phone' ? v : escapeHtml(v)}</td></tr>`).join('') +
    `</table>` +
    `<p style="margin-top:18px"><a href="sms:+1${tel}" style="background:#54453A;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700;margin-right:8px">Text ${escapeHtml(lead.name.split(' ')[0])}</a> <a href="tel:+1${tel}" style="background:#fff;color:#54453A;border:2px solid #54453A;padding:10px 20px;border-radius:999px;text-decoration:none;font-weight:700">Call</a></p>` +
    `</div>`;

  const sent = await sendEmail(env, {
    to: [OWNER_ADDRESS, TO_ADDRESS],
    subject: `${lead.label} lead (${contactShort(lead.contact)}): ${lead.name}, ${lead.budget || 'budget not set'}`,
    html,
  });
  if (!sent.ok) return json({ ok: false, error: sent.error, saved: true }, 502, origin);
  lead.emailed = true;
  lead.emailedAt = Date.now();
  await env.IG_KV.put(key, JSON.stringify(lead));
  return json({ ok: true }, 200, origin);
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
      html: `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>Thank you, ${escapeHtml(o.customerName.split(' ')[0])}!</h2><p>Here is a copy of the design you approved. We'll keep you updated while your ring is being made.</p>${imgTag}${table}<p>Questions? Call or text (832) 474-6344 or email hello@hiddengemrings.com.</p></div>`,
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

async function sendEmail(env, { to, subject, html, replyTo }) {
  try {
    const payload = { from: FROM_ADDRESS, to: to || [TO_ADDRESS], subject, html };
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
