// SanketRisk ONE — Netlify Function: send-report-email
// Sends a report email via Resend. Requires a signed-in SanketRisk user.
// Secrets live in Netlify environment variables, never in this file:
//   SanketriskAPIKEY  (Resend API key; RESEND_API_KEY is also accepted)
//   RESEND_FROM       (optional, e.g.  SanketRisk ONE <reports@sanketrisk.com>)

const SUPABASE_URL = 'https://lzsfmqbhrpsmnivxhggi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_C5KWTHt84OMXif4javqeOQ_rjFK0t83'; // publishable key (safe to be public)

const ALLOWED_ORIGINS = [
  'https://commercial.sanketrisk.com',
  'https://sanketrisk.com',
  'https://sanketrisk.netlify.app',
];

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

exports.handler = async function (event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  try {
    // ── 1. The caller must be a signed-in SanketRisk user ──
    const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return reply(401, { error: 'Not signed in' });

    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!userRes.ok) return reply(401, { error: 'Session not valid. Please sign in again.' });

    // ── 2. Validate the request ──
    const RESEND_API_KEY = process.env.SanketriskAPIKEY || process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) return reply(500, { error: 'Email is not configured (missing API key).' });
    const RESEND_FROM = process.env.RESEND_FROM || 'SanketRisk ONE <onboarding@resend.dev>';

    const { to, subject, body, pdf_path, inspection_id } = JSON.parse(event.body || '{}');
    if (!to || !subject) return reply(400, { error: 'Missing required fields: to, subject' });

    const recipients = (Array.isArray(to) ? to : [to]).map(function (x) { return String(x).trim(); });
    if (recipients.length < 1 || recipients.length > 5 || !recipients.every(function (x) { return EMAIL_RE.test(x) && x.length <= 200; })) {
      return reply(400, { error: 'Invalid recipient email address.' });
    }
    if (String(subject).length > 250) return reply(400, { error: 'Subject too long.' });
    if (String(body || '').length > 20000) return reply(400, { error: 'Message too long.' });

    // ── 3. Fetch the stored PDF as the signed-in user (storage rules apply) ──
    const attachments = [];
    if (pdf_path) {
      try {
        const cleanPath = String(pdf_path).replace(/^\//, '').replace(/^reports\//, '');
        if (!/\.\./.test(cleanPath)) {
          const pdfUrl = SUPABASE_URL + '/storage/v1/object/authenticated/reports/' + cleanPath;
          const pdfRes = await fetch(pdfUrl, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token } });
          if (pdfRes.ok) {
            const pdfB64 = Buffer.from(await pdfRes.arrayBuffer()).toString('base64');
            const fileName = 'SanketRisk_SCAN_ONE_' + String(inspection_id || 'Report').replace(/[^a-zA-Z0-9]/g, '_') + '.pdf';
            attachments.push({ filename: fileName, content: pdfB64 });
          }
        }
      } catch (e) {
        console.warn('PDF fetch error:', e.message); // continue without the attachment
      }
    }

    // ── 4. Send via Resend ──
    const payload = {
      from: RESEND_FROM,
      to: recipients,
      subject: String(subject),
      text: String(body || ''),
      html: esc(body || '').replace(/\n/g, '<br>'),
    };
    if (attachments.length) payload.attachments = attachments;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) return reply(res.status, { error: data.message || 'Resend error' });

    return reply(200, { success: true, id: data.id, has_pdf: attachments.length > 0 });
  } catch (err) {
    return reply(500, { error: err.message });
  }
};
