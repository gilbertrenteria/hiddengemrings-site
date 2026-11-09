// Hidden Gem — consultation + newsletter form backend.
// Fully self-owned: a Cloudflare Worker on Gilbert's own account, no
// third-party form product in the loop. Sends email via the Resend API
// (an email-delivery API, not a form tool) using mail.gilbertrenteria.dev,
// a domain already verified in his Resend account for other projects.

const ALLOWED_ORIGINS = new Set([
  'https://hiddengemrings.com',
  'https://www.hiddengemrings.com',
]);

const TO_ADDRESS = 'hello@hiddengemrings.com';
const FROM_ADDRESS = 'Hidden Gem Website <forms@mail.gilbertrenteria.dev>';

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://hiddengemrings.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// === Instagram live feed ===
// Pulls the account's own recent posts via the Instagram API (Instagram
// Login flow) and caches them in KV, so the site reads a fast local cache
// rather than hitting Instagram on every page load. No third-party embed
// widget — this is Gilbert's own account, his own API credentials, fetched
// server-side by his own Worker.
const IG_REDIRECT_URI = 'https://long-bar-d49d.gilbertrenteria.workers.dev/instagram/callback';

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

async function refreshTokenIfNeeded(env) {
  const token = await env.IG_KV.get('access_token');
  if (!token) return;
  const obtainedAt = Number((await env.IG_KV.get('token_obtained_at')) || 0);
  const ageDays = (Date.now() - obtainedAt) / 86400000;
  if (ageDays < 1) return; // Instagram requires the token be >=24h old to refresh
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
  const data = await res.json();
  if (res.ok && data.access_token) {
    await env.IG_KV.put('access_token', data.access_token);
    await env.IG_KV.put('token_obtained_at', String(Date.now()));
  }
}

async function refreshMediaCache(env) {
  const token = await env.IG_KV.get('access_token');
  if (!token) return;
  const res = await fetch(`https://graph.instagram.com/me/media?fields=id,media_type,media_url,thumbnail_url,permalink,timestamp&limit=12&access_token=${token}`);
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET') {
      if (url.pathname === '/instagram/callback') return handleInstagramCallback(url, env);
      if (url.pathname === '/instagram/feed') return handleInstagramFeed(env, origin);
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

    // generic: email every submitted field except internal/bookkeeping ones,
    // so this keeps working if the form's fields ever change.
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

  // Cron Trigger: keeps the Instagram token alive indefinitely (refreshes
  // it well inside the 60-day window) and keeps the cached feed fresh.
  async scheduled(event, env, ctx) {
    await refreshTokenIfNeeded(env);
    await refreshMediaCache(env);
  },
};

async function sendEmail(env, { subject, html, replyTo }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [TO_ADDRESS],
        reply_to: replyTo,
        subject,
        html,
      }),
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
