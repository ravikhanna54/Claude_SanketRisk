// SanketRisk ONE — Netlify Function: notify-job
// Sends job emails through Resend. Only a signed-in ADMIN (or, for reviewer notices, a reviewer) may trigger it.
// The page sends only an event name and a record id; recipients and wording come from the database here,
// so this cannot be used to send arbitrary mail from the SanketRisk domain.
// Events: inspector_assigned {request_id | inspection_id}, client_assigned {request_id},
//         reviewer_assigned {inspection_id}, client_released {inspection_id, to}, suggest_client {inspection_id}
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SanketriskAPIKEY (or RESEND_API_KEY), RESEND_FROM (optional)

const { requireAuth } = require('./guard');

const SITE = 'https://commercial.sanketrisk.com';
const ALLOWED_ORIGINS = ['https://commercial.sanketrisk.com', 'https://sanketrisk.com', 'https://sanketrisk.netlify.app'];
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function dbHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
  return h;
}
async function dbGet(path) {
  const r = await fetch(process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path, { headers: dbHeaders() });
  if (!r.ok) throw new Error('Database read failed');
  return r.json();
}
async function dbInsert(table, row) {
  try {
    await fetch(process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + table, {
      method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, dbHeaders()), body: JSON.stringify(row),
    });
  } catch (e) { /* logging must never block the job */ }
}
const q = (v) => encodeURIComponent(String(v));

async function sendMail(to, subject, text, html) {
  const key = process.env.SanketriskAPIKEY || process.env.RESEND_API_KEY;
  if (!key) throw new Error('Email is not configured (missing API key).');
  const from = process.env.RESEND_FROM || 'SanketRisk ONE <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || 'Email service error');
  return d.id;
}
function wrap(title, lines, button) {
  const body = lines.map((l) => '<p style="margin:0 0 12px">' + esc(l) + '</p>').join('');
  const btn = button ? '<p style="margin:18px 0"><a href="' + esc(button.url) + '" style="background:#c9a84c;color:#1a2433;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">' + esc(button.label) + '</a></p>' : '';
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a2433;max-width:560px"><h2 style="font-size:18px;margin:0 0 14px">' + esc(title) + '</h2>' + body + btn +
    '<p style="color:#667;font-size:12px;margin-top:22px">Sanket Risk Consultants</p></div>';
}
function plain(lines, button) { return lines.join('\n\n') + (button ? '\n\n' + button.label + ': ' + button.url : '') + '\n\nSanket Risk Consultants'; }
const addr = (r) => [r.address || r.location, r.city, r.province || r.province_state].filter(Boolean).join(', ');

async function profileEmail(name) {
  if (!name) return null;
  const rows = await dbGet('profiles?full_name=eq.' + q(name) + '&select=email,full_name&limit=3');
  if (rows.length !== 1 || !EMAIL_RE.test(rows[0].email || '')) return null;
  return rows[0].email;
}

exports.handler = async function (event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0], Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  };
  const reply = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  try {
    const auth = await requireAuth(event);
    if (!auth.ok) return Object.assign({}, auth.response, { headers: Object.assign({}, auth.response.headers, headers) });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return reply(500, { error: 'Server is not configured.' });

    const me = (await dbGet('profiles?id=eq.' + q(auth.user.id) + '&select=role,full_name,email&limit=1'))[0];
    if (!me) return reply(403, { error: 'Not permitted.' });

    let b = {}; try { b = JSON.parse((event.body || '{}').slice(0, 4000)); } catch (e) { return reply(400, { error: 'Bad request.' }); }
    const ev = String(b.event || '');
    const allowed = me.role === 'admin' || (me.role === 'reviewer' && ev === 'reviewer_assigned');
    if (!allowed) return reply(403, { error: 'Only an administrator can send job emails.' });
    const actor = me.full_name || me.email || 'Admin';
    const sent = [], skipped = [];

    const getRequest = async () => {
      if (!UUID_RE.test(b.request_id || '')) throw new Error('Bad request id.');
      const r = (await dbGet('inspection_requests?id=eq.' + q(b.request_id) + '&select=*&limit=1'))[0];
      if (!r) throw new Error('Request not found.');
      return r;
    };
    const getInspection = async () => {
      if (!UUID_RE.test(b.inspection_id || '')) throw new Error('Bad inspection id.');
      const r = (await dbGet('inspections?id=eq.' + q(b.inspection_id) + '&select=id,inspection_id,insured_name,location,city,province_state,inspector_name,qa_reviewer,report_published&limit=1'))[0];
      if (!r) throw new Error('Inspection not found.');
      return r;
    };
    const logEmail = (kind, to, reqId, inspId) => dbInsert('job_events', {
      request_id: reqId || null, inspection_id: inspId || null, event_type: 'email',
      note: kind + ' email sent to ' + to, actor_name: actor,
    });

    if (ev === 'inspector_assigned') {
      const isReq = !!b.request_id;
      const r = isReq ? await getRequest() : await getInspection();
      const name = isReq ? r.assigned_to : r.inspector_name;
      const to = await profileEmail(name);
      if (!to) { skipped.push('No unique email address found for ' + (name || 'the inspector') + '.'); }
      else {
        const lines = ['You have been assigned a ' + (isReq ? 'new inspection request' : 'job') + '.',
          'Insured: ' + (r.insured_name || '—'), 'Location: ' + (addr(r) || '—')]
          .concat(isReq ? ['Reference: ' + (r.request_ref || '—'), 'Urgency: ' + (r.urgency || '—'), 'Preferred date: ' + (r.preferred_date || '—'), r.special_instructions ? 'Notes: ' + String(r.special_instructions).slice(0, 500) : null].filter(Boolean)
                        : ['Reference: ' + (r.inspection_id || '—')]);
        const btn = { label: 'Open SanketRisk', url: SITE + '/dashboard' };
        await sendMail(to, 'New assignment: ' + (r.insured_name || 'inspection'), plain(lines, btn), wrap('New assignment', lines, btn));
        sent.push('inspector'); await logEmail('Assignment', to, isReq ? r.id : null, isReq ? null : r.id);
      }
    } else if (ev === 'reviewer_assigned') {
      const r = await getInspection();
      const to = await profileEmail(r.qa_reviewer);
      if (!to) skipped.push('No unique email address found for ' + (r.qa_reviewer || 'the reviewer') + '.');
      else {
        const lines = ['A report has been assigned to you for QA review.', 'Insured: ' + (r.insured_name || '—'),
          'Location: ' + (addr(r) || '—'), 'Reference: ' + (r.inspection_id || '—')];
        const btn = { label: 'Open SanketRisk', url: SITE + '/dashboard' };
        await sendMail(to, 'QA review assigned: ' + (r.insured_name || 'report'), plain(lines, btn), wrap('QA review assigned', lines, btn));
        sent.push('reviewer'); await logEmail('QA review', to, null, r.id);
      }
    } else if (ev === 'client_assigned') {
      const r = await getRequest();
      const to = String(r.requestor_email || '').trim();
      if (!EMAIL_RE.test(to)) skipped.push('The request has no valid client email address.');
      else {
        const lines = ['Hello' + (r.requestor_name ? ' ' + r.requestor_name : '') + ',',
          'Your inspection request ' + (r.request_ref || '') + ' for ' + (r.insured_name || 'the property') + ' has been assigned' + (r.assigned_to ? ' to ' + r.assigned_to : '') + '.',
          'We will be in touch to confirm the visit. You can check the progress at any time with your reference number and this email address.'];
        const btn = { label: 'Check request status', url: SITE + '/status?ref=' + encodeURIComponent(r.request_ref || '') };
        await sendMail(to, 'Your inspection request ' + (r.request_ref || '') + ' has been assigned', plain(lines, btn), wrap('Your inspection has been assigned', lines, btn));
        sent.push('client'); await logEmail('Client assignment', to, r.id, null);
      }
    } else if (ev === 'client_released') {
      const r = await getInspection();
      const to = String(b.to || '').trim();
      if (!EMAIL_RE.test(to) || to.length > 200) return reply(400, { error: 'Please enter a valid email address.' });
      if (!r.report_published) return reply(400, { error: 'The report is not published.' });
      const lines = ['Hello,', 'Your inspection report for ' + (r.insured_name || 'the property') + (addr(r) ? ' (' + addr(r) + ')' : '') + ' is now ready.',
        'Use the button below to view it online with reference ' + (r.inspection_id || '') + '.'];
      const btn = { label: 'View your report', url: SITE + '/report?ref=' + encodeURIComponent(r.inspection_id || '') };
      await sendMail(to, 'Your inspection report is ready: ' + (r.insured_name || ''), plain(lines, btn), wrap('Your inspection report is ready', lines, btn));
      sent.push('client'); await logEmail('Report-ready', to, null, r.id);
    } else if (ev === 'suggest_client') {
      const r = await getInspection();
      const name = String(r.insured_name || '').trim();
      let out = [];
      if (name) {
        const rows = await dbGet('inspection_requests?insured_name=ilike.' + q(name.replace(/[%_*]/g, '')) + '&select=requestor_email,requestor_name,request_ref,status,submitted_at&order=submitted_at.desc&limit=5');
        const seen = {};
        rows.forEach((x) => { const e = String(x.requestor_email || '').trim().toLowerCase(); if (EMAIL_RE.test(e) && !seen[e]) { seen[e] = 1; out.push({ email: e, name: x.requestor_name || '', ref: x.request_ref || '' }); } });
      }
      return reply(200, { suggestions: out.slice(0, 3) });
    } else {
      return reply(400, { error: 'Unknown event.' });
    }
    return reply(200, { sent, skipped });
  } catch (e) {
    return reply(500, { error: e.message || 'Could not send the email.' });
  }
};
