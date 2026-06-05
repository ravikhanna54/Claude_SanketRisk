// SanketRisk SCAN ONE — Streaming Proxy
// Streams Anthropic response directly to browser — no gateway timeout

const SUPABASE_URL = 'https://lzsfmqbhrpsmnivxhggi.supabase.co';
const BUCKET       = 'scan-uploads';

async function fetchPublicFile(path, timeoutMs) {
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(path)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) { console.log(`Skip ${path}: ${res.status}`); return null; }
    const buf = await res.arrayBuffer();
    console.log(`Fetched ${path}: ${(buf.byteLength/1024).toFixed(0)}KB`);
    return { buf, ct: res.headers.get('content-type') || 'image/jpeg' };
  } catch(e) { clearTimeout(timer); console.log(`Fetch error ${path}: ${e.message}`); return null; }
}

exports.handler = async (event, context) => {
  // Tell Netlify not to close the connection early
  context.callbackWaitsForEmptyEventLoop = false;

  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: {...headers,'Content-Type':'application/json'}, body: JSON.stringify({ error: 'Method not allowed' }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, headers: {...headers,'Content-Type':'application/json'}, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  try {
    const body = JSON.parse(event.body || '{}');

    // ── STORAGE MODE ──
    if (body.storage_paths && body.storage_paths.length > 0) {
      console.log(`Storage mode: ${body.storage_paths.length} files`);

      const results = await Promise.all(
        body.storage_paths.map(p => fetchPublicFile(p, 15000))
      );

      const validTypes = ['image/jpeg','image/png','image/gif','image/webp'];
      const contentBlocks = [];
      let hasPDF = false;

      for (const r of results) {
        if (!r) continue;
        const b64 = Buffer.from(r.buf).toString('base64');
        if (r.ct.includes('pdf')) {
          hasPDF = true;
          contentBlocks.push({ type:'document', source:{ type:'base64', media_type:'application/pdf', data:b64 } });
        } else {
          const mt = validTypes.includes(r.ct) ? r.ct : 'image/jpeg';
          contentBlocks.push({ type:'image', source:{ type:'base64', media_type:mt, data:b64 } });
        }
      }

      if (contentBlocks.length === 0) {
        return { statusCode:400, headers:{...headers,'Content-Type':'application/json'},
          body: JSON.stringify({ error:'No files retrieved — ensure scan-uploads bucket is PUBLIC in Supabase Storage' }) };
      }

      if (body.prompt) contentBlocks.push({ type:'text', text: body.prompt });

      const apiHdrs = {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      };
      if (hasPDF) apiHdrs['anthropic-beta'] = 'pdfs-2024-09-25';

      console.log(`Calling Anthropic: ${contentBlocks.length} blocks, max_tokens=${body.max_tokens||4000}`);
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: apiHdrs,
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: body.max_tokens || 4000,
          messages:   [{ role:'user', content:contentBlocks }],
        }),
      });

      const txt = await resp.text();
      console.log(`Anthropic responded: ${resp.status}, ${txt.length} chars`);

      let data;
      try { data = JSON.parse(txt); }
      catch(e) { return { statusCode:500, headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify({ error:'Non-JSON: '+txt.substring(0,200) }) }; }

      if (!resp.ok) {
        return { statusCode:resp.status, headers:{...headers,'Content-Type':'application/json'},
          body: JSON.stringify({ error: data?.error?.message || txt.substring(0,200) }) };
      }

      return { statusCode:200, headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify(data) };
    }

    // ── DIRECT / TEXT MODE ──
    const messages = body.messages || [];
    const validTypes = ['image/jpeg','image/png','image/gif','image/webp'];
    let hasPDF = false;
    const sanitized = messages.map(msg => {
      if (!Array.isArray(msg.content)) return msg;
      const filtered = msg.content.filter(block => {
        if (block.type==='image') {
          if (!block.source?.data || block.source.data.length < 50) return false;
          if (!validTypes.includes(block.source.media_type)) block.source.media_type = 'image/jpeg';
          return true;
        }
        if (block.type==='document') { hasPDF=true; return !!(block.source?.data?.length > 50); }
        return true;
      });
      return {...msg, content:filtered};
    });

    const apiHdrs = {
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01',
    };
    if (hasPDF) apiHdrs['anthropic-beta'] = 'pdfs-2024-09-25';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: apiHdrs,
      body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:body.max_tokens||4000, messages:sanitized }),
    });

    const txt = await resp.text();
    let data;
    try { data = JSON.parse(txt); }
    catch(e) { return { statusCode:500, headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify({ error:'Non-JSON: '+txt.substring(0,200) }) }; }

    if (!resp.ok) return { statusCode:resp.status, headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify({ error:data?.error?.message||txt.substring(0,200) }) };
    return { statusCode:200, headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify(data) };

  } catch(err) {
    console.log('Proxy error:', err.message);
    return { statusCode:500, headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify({ error:err.message }) };
  }
};
