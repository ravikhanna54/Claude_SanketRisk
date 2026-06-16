// SanketRisk ONE — Netlify Function: send-report-email
// Sends the assessment report via Resend API (server-side, no CORS issues)

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { to, subject, body, html, attachment_b64, attachment_name } = JSON.parse(event.body);

    if (!to || !subject) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: to, subject' }) };
    }

    // ── CONFIG — update RESEND_FROM after domain verification ──
    const RESEND_API_KEY = 're_JeyjNXkX_BhQRjCmmh6R1oHFyaZ5dzimu';
    const RESEND_FROM    = 'SanketRisk ONE <onboarding@resend.dev>';

    const payload = {
      from:    RESEND_FROM,
      to:      Array.isArray(to) ? to : [to],
      subject: subject,
      text:    body   || '',
      html:    html   || (body || '').replace(/\n/g, '<br>'),
    };

    // Attach report HTML if provided
    if (attachment_b64 && attachment_name) {
      payload.attachments = [{
        filename: attachment_name,
        content:  attachment_b64,
      }];
    }

    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({ error: data.message || data.name || 'Resend API error' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, id: data.id }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
