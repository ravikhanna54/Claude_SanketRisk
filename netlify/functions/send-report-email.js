// SanketRisk ONE — Netlify Function: send-report-email
// Fetches stored PDF from Supabase and sends via Resend API

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { to, subject, body, pdf_path, inspection_id } = JSON.parse(event.body);
    if (!to || !subject) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: to, subject' }) };

    // ── CONFIG — update RESEND_FROM after domain verification ──
    const RESEND_API_KEY  = 're_JeyjNXkX_BhQRjCmmh6R1oHFyaZ5dzimu';
    const RESEND_FROM     = 'SanketRisk ONE <onboarding@resend.dev>';
    const SUPABASE_URL    = 'https://lzsfmqbhrpsmnivxhggi.supabase.co';
    const SUPABASE_KEY    = 'sb_publishable_C5KWTHt84OMXif4javqeOQ_rjFK0t83';

    var attachments = [];

    // Fetch PDF from Supabase Storage if path provided
    if (pdf_path) {
      try {
        // Private bucket — use authenticated endpoint with service key
        var cleanPath = pdf_path.replace(/^\//, '').replace(/^reports\//, '');
        var pdfUrl = SUPABASE_URL + '/storage/v1/object/authenticated/reports/' + cleanPath;
        var pdfRes = await fetch(pdfUrl, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
        });
        if (pdfRes.ok) {
          var pdfBuf  = await pdfRes.arrayBuffer();
          var pdfB64  = Buffer.from(pdfBuf).toString('base64');
          var fileName = 'SanketRisk_SCAN_ONE_' + (inspection_id || 'Report').replace(/[^a-zA-Z0-9]/g,'_') + '.pdf';
          attachments.push({ filename: fileName, content: pdfB64 });
        }
      } catch(e) {
        console.warn('PDF fetch error:', e.message);
        // Continue without attachment if PDF fetch fails
      }
    }

    // Build email payload
    var payload = {
      from:    RESEND_FROM,
      to:      Array.isArray(to) ? to : [to],
      subject: subject,
      text:    body || '',
      html:    (body || '').replace(/\n/g, '<br>'),
    };
    if (attachments.length > 0) payload.attachments = attachments;

    // Send via Resend
    var res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    var data = await res.json();
    if (!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: data.message || 'Resend error' }) };

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: data.id, has_pdf: attachments.length > 0 }) };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
