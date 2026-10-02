// SanketRisk — 2026-10-02 — New Netlify function: e2Value streaming PDF report.
// Takes a PropertyID (returned by an earlier e2value-estimate call) and returns e2Value's
// own valuation report as base64 PDF for app.html to store and embed in the Formal Report.
//
// Uses the same Netlify environment variables as e2value-estimate.js:
//   E2VALUE_USERNAME, E2VALUE_PASSWORD
//
// Endpoint reference (e2Value pdf.xsd, version 1.0):
//   POST https://evs.e2value.ca/evs/xml/1_0/pdf/index.asp
//   <estimate version="1.0" username="" password="" propertyid=""/>   (propertyid: digits, max 10)
//   PDF is returned in Base64 format.
// e2Value's schema notes this service is intended for their Portico integration — access for
// our Pronto Commercial Lite account is pending their confirmation. Posted the same way as
// e2value-estimate.js (form field "xml"); the response is parsed tolerantly because its exact
// shape (bare base64, base64 inside XML, or binary PDF) has not been confirmed yet.

const POSTING_URL = 'https://evs.e2value.ca/evs/xml/1_0/pdf/index.asp';

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Same 12am-6am Eastern blackout as e2value-estimate.js.
function isInE2ValueBlackoutWindow(now) {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false
  }).format(now || new Date());
  const hour = parseInt(hourStr, 10) % 24;
  return hour >= 0 && hour < 6;
}

function buildPdfXml(propertyId, credentials) {
  return '<?xml version="1.0"?>\n' +
    '<estimate version="1.0" username="' + escapeXml(credentials.username) +
    '" password="' + escapeXml(credentials.password) +
    '" propertyid="' + escapeXml(propertyId) + '">\n</estimate>';
}

// Base64 of any PDF starts with "JVBER" (= "%PDF"). Accepts the response as:
//   1. a binary PDF, 2. bare base64 text, or 3. base64 wrapped in an XML element.
// Returns base64 string or null.
function extractPdfBase64(buffer) {
  if (buffer.length >= 4 && buffer.slice(0, 4).toString('latin1') === '%PDF') {
    return buffer.toString('base64');
  }
  const text = buffer.toString('utf8');
  const compact = text.replace(/\s+/g, '');
  if (/^JVBER[A-Za-z0-9+/=]+$/.test(compact)) return compact;
  // Inside XML (element text or CDATA): take the run starting with JVBER.
  const m = text.replace(/<!\[CDATA\[|\]\]>/g, '').match(/JVBER[A-Za-z0-9+/=\s]+/);
  if (m) {
    const b64 = m[0].replace(/\s+/g, '');
    if (b64.length > 100) return b64;
  }
  return null;
}

// A short, credential-free preview of a non-PDF response so the user sees e2Value's message.
function previewOf(buffer) {
  return buffer.toString('utf8')
    .replace(/password="[^"]*"/gi, 'password="***"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

exports.handler = async function (event) {
  const jsonHeaders = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed. Use POST.' }) };
  }

  const username = process.env.E2VALUE_USERNAME;
  const password = process.env.E2VALUE_PASSWORD;
  if (!username || !password) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'E2VALUE_USERNAME / E2VALUE_PASSWORD are not configured in Netlify environment variables.' }) };
  }

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Request body must be valid JSON.' }) };
  }

  const propertyId = String(input.propertyId || '').trim();
  if (!/^[0-9]{1,10}$/.test(propertyId)) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'propertyId is required and must be 1-10 digits (per e2Value pdf.xsd).' }) };
  }

  if (isInE2ValueBlackoutWindow()) {
    return { statusCode: 503, headers: jsonHeaders, body: JSON.stringify({ error: 'e2Value asks that no requests be submitted between 12am and 6am Eastern time. Please try again after 6am ET.' }) };
  }

  const requestXml = buildPdfXml(propertyId, { username: username, password: password });

  let upstream;
  try {
    upstream = await fetch(POSTING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'xml=' + encodeURIComponent(requestXml)
    });
  } catch (networkErr) {
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'Could not reach e2Value.', details: networkErr.message }) };
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());

  if (!upstream.ok) {
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'e2Value returned HTTP ' + upstream.status + '.', rawPreview: previewOf(buffer) }) };
  }

  const pdfBase64 = extractPdfBase64(buffer);
  if (!pdfBase64) {
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'e2Value response did not contain a PDF.', rawPreview: previewOf(buffer) }) };
  }

  // Netlify's synchronous function response limit is 6 MB; base64 adds ~33%.
  if (pdfBase64.length > 5.5 * 1024 * 1024) {
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'e2Value PDF is too large to return through a Netlify function (' + Math.round(pdfBase64.length / 1048576) + ' MB base64).' }) };
  }

  return {
    statusCode: 200,
    headers: jsonHeaders,
    body: JSON.stringify({ status: 'success', propertyId: propertyId, pdfBase64: pdfBase64 })
  };
};

exports._internal = { buildPdfXml, extractPdfBase64, previewOf };
