// SanketRisk SCAN ONE — Background Function
// Returns 202 immediately, processes async, stores result in Supabase scan_results table

const SUPABASE_URL = 'https://lzsfmqbhrpsmnivxhggi.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_publishable_C5KWTHt84OMXif4javqeOQ_rjFK0t83';
const BUCKET       = 'scan-uploads';

async function fetchPublicFile(path, timeoutMs) {
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) { console.log(`Skip ${path}: ${res.status}`); return null; }
    const buf = await res.arrayBuffer();
    return { buf, ct: res.headers.get('content-type') || 'image/jpeg' };
  } catch(e) { clearTimeout(timer); console.log(`Fetch error ${path}: ${e.message}`); return null; }
}

async function storeResult(jobId, result, error) {
  const row = {
    job_id:     jobId,
    status:     error ? 'error' : 'done',
    result:     error ? null : JSON.stringify(result),
    error:      error || null,
    created_at: new Date().toISOString(),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/scan_results`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) console.log('Store result error:', await res.text());
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { job_id, storage_paths, prompt, max_tokens } = body;

    if (!job_id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing job_id' }) };
    if (!process.env.ANTHROPIC_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

    // Fetch files in parallel
    const results = await Promise.all(
      (storage_paths || []).map(p => fetchPublicFile(p, 20000))
    );

    const validTypes = ['image/jpeg','image/png','image/gif','image/webp'];
    const contentBlocks = [];
    let hasPDF = false;

    for (const r of results) {
      if (!r) continue;
      const b64 = Buffer.from(r.buf).toString('base64');
      if (r.ct.includes('pdf')) {
        hasPDF = true;
        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
      } else {
        const mt = validTypes.includes(r.ct) ? r.ct : 'image/jpeg';
        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: b64 } });
      }
    }

    if (prompt) contentBlocks.push({ type: 'text', text: prompt });

    const apiHdrs = {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    if (hasPDF) apiHdrs['anthropic-beta'] = 'pdfs-2024-09-25';

    console.log(`Job ${job_id}: calling Anthropic with ${contentBlocks.length} blocks`);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: apiHdrs,
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: max_tokens || 2000,
        messages:   [{ role: 'user', content: contentBlocks }],
      }),
    });

    const txt = await resp.text();
    let data;
    try { data = JSON.parse(txt); } catch(e) {
      await storeResult(job_id, null, 'Non-JSON from Anthropic: ' + txt.substring(0, 200));
      return { statusCode: 200, body: JSON.stringify({ status: 'error' }) };
    }

    if (!resp.ok) {
      await storeResult(job_id, null, data?.error?.message || 'Anthropic error ' + resp.status);
      return { statusCode: 200, body: JSON.stringify({ status: 'error' }) };
    }

    const textBlock = data.content?.find(c => c.type === 'text');
    const raw = textBlock?.text || '';
    await storeResult(job_id, { raw }, null);
    console.log(`Job ${job_id}: done, stored result`);
    return { statusCode: 200, body: JSON.stringify({ status: 'done' }) };

  } catch(err) {
    console.log('Background function error:', err.message);
    try {
      const body = JSON.parse(event.body || '{}');
      if (body.job_id) await storeResult(body.job_id, null, err.message);
    } catch(e) {}
    return { statusCode: 200, body: JSON.stringify({ status: 'error', error: err.message }) };
  }
};
