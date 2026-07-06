// netlify/functions/kb-ocr.js
// Sanket Knowledge Base — OCR for scanned PDFs via Google Cloud Vision
// Triggered explicitly per-document from the ESI Document Library (not automatic)
// so OCR cost stays visible and under manual control.
//
// Requires environment variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (service role key — needed to read Storage + update kb_documents)
//   GOOGLE_CLOUD_VISION_KEY (a Google API key with the Cloud Vision API enabled on your
//                            existing Google Cloud project — the same project used for
//                            Maps/Geocoding works fine, just enable Vision on it too)

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VISION_KEY    = process.env.GOOGLE_CLOUD_VISION_KEY;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_PAGES = 100; // hard cap to control cost/time on very large documents
const BATCH_SIZE = 5;  // Google Vision's synchronous files.annotate limit per request

function httpsRequest(url, options, body) {
  return new Promise(function(resolve, reject) {
    var req = https.request(url, options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve({ status: res.statusCode, text: data }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function sbDownload(bucket, path) {
  var url = SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + path;
  var res = await new Promise(function(resolve, reject) {
    https.get(url, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }, function(r) {
      var chunks = [];
      r.on('data', function(c) { chunks.push(c); });
      r.on('end', function() { resolve({ status: r.statusCode, buffer: Buffer.concat(chunks) }); });
    }).on('error', reject);
  });
  if (res.status !== 200) throw new Error('Storage download failed: HTTP ' + res.status);
  return res.buffer;
}

async function sbUpdateDocument(id, fields) {
  var url = SUPABASE_URL + '/rest/v1/kb_documents?id=eq.' + encodeURIComponent(id);
  await httpsRequest(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      Prefer: 'return=minimal',
    },
  }, JSON.stringify(fields));
}

async function visionAnnotatePdfBatch(base64Pdf, pageNumbers) {
  var body = JSON.stringify({
    requests: [{
      inputConfig: { content: base64Pdf, mimeType: 'application/pdf' },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      pages: pageNumbers,
    }],
  });
  var res = await httpsRequest(
    'https://vision.googleapis.com/v1/files:annotate?key=' + VISION_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    body
  );
  var data;
  try { data = JSON.parse(res.text); } catch (e) { throw new Error('Vision API returned invalid JSON'); }
  if (data.error) throw new Error('Vision API error: ' + data.error.message);
  var responses = (data.responses && data.responses[0] && data.responses[0].responses) || [];
  return responses.map(function(r) {
    return (r.fullTextAnnotation && r.fullTextAnnotation.text) || '';
  }).join('\n');
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!VISION_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GOOGLE_CLOUD_VISION_KEY not configured on this Netlify site' }) };
  }

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  var documentId = body.document_id;
  var filePath = body.file_path;
  var bucket = body.bucket || 'kb-documents';

  if (!documentId || !filePath) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'document_id and file_path are required' }) };
  }

  try {
    var pdfBuffer = await sbDownload(bucket, filePath);
    var base64Pdf = pdfBuffer.toString('base64');

    // Get page count via a lightweight first call (Vision needs explicit page
    // numbers per batch — we don't know the count up front, so probe first).
    var probeText = await visionAnnotatePdfBatch(base64Pdf, [1]);
    var allText = probeText;

    // Fetch remaining pages in batches until we hit MAX_PAGES or run out.
    // Vision returns an empty response array (not an error) for out-of-range
    // pages, which we use as the stop condition.
    var page = 2;
    while (page <= MAX_PAGES) {
      var batchPages = [];
      for (var i = 0; i < BATCH_SIZE && page <= MAX_PAGES; i++, page++) batchPages.push(page);
      var batchText;
      try {
        batchText = await visionAnnotatePdfBatch(base64Pdf, batchPages);
      } catch (batchErr) {
        // Likely ran past the actual last page — stop rather than fail the whole job
        break;
      }
      if (!batchText || !batchText.trim()) break;
      allText += '\n' + batchText;
    }

    var trimmed = allText.trim();
    if (!trimmed) {
      await sbUpdateDocument(documentId, { extraction_status: 'ocr_failed' });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ocr_failed', message: 'No text detected' }) };
    }

    await sbUpdateDocument(documentId, {
      text_content: trimmed.substring(0, 500000),
      extraction_status: 'ocr_complete',
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ocr_complete', chars: trimmed.length }) };
  } catch (err) {
    try { await sbUpdateDocument(documentId, { extraction_status: 'ocr_failed' }); } catch (e2) {}
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
