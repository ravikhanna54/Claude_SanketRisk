// SanketRisk — Insured Profile Search
// Uses scan-proxy (already working) to call Claude with a text prompt
// No web_search tool needed — Claude uses training knowledge

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { insured_name, city, province } = body;

    if (!insured_name || insured_name.length < 3) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'insured_name required' }) };
    }

    const locationStr = [city, province].filter(Boolean).join(', ');
    const prompt = `Provide a concise public company profile for insurance underwriting purposes for: "${insured_name}"` +
      (locationStr ? `, located in ${locationStr}` : '') + '.\n\n' +
      'Include in your response:\n' +
      '1. Business description and primary operations\n' +
      '2. Years in operation or founding date (if known)\n' +
      '3. Approximate company size (employees or revenue range if known)\n' +
      '4. Parent company or major subsidiaries (if any)\n' +
      '5. Industry classification (SIC/NAICS if determinable)\n' +
      '6. Any publicly known incidents, losses, regulatory actions, or news from recent years\n\n' +
      'Write as a single professional paragraph. If information is limited or uncertain, say so clearly. Do not fabricate facts.';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 600,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.log('Anthropic error:', JSON.stringify(data).substring(0, 200));
      return { statusCode: resp.status, headers: CORS, body: JSON.stringify({ error: data?.error?.message || 'API error' }) };
    }

    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    const result = textBlocks.map(b => b.text).join('\n').trim();

    console.log('Profile result length:', result.length);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ result: result || 'No public information found.' }),
    };

  } catch (err) {
    console.log('Profile search error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
