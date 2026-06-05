exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const key = process.env.ANTHROPIC_API_KEY;

  const results = {};

  // Test 1: Netlify → Anthropic text (measures Netlify latency + timeout)
  try {
    const t1 = Date.now();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:20, messages:[{role:'user',content:'Say OK'}] }),
    });
    const d = await r.json();
    results.netlify_to_anthropic_ms = Date.now()-t1;
    results.netlify_ok = r.ok;
  } catch(e) { results.netlify_error = e.message; }

  // Test 2: What timeout does Netlify actually enforce?
  results.actual_timeout_env = process.env.AWS_LAMBDA_FUNCTION_TIMEOUT || 'not set';
  results.region = process.env.AWS_REGION || 'unknown';
  results.node = process.version;

  // Test 3: Check if Lambda URL is reachable (GET ping)
  try {
    const t3 = Date.now();
    const LAMBDA = 'https://zxvw3d7fxhstl6ye5tdsru3pna0lbomh.lambda-url.ap-southeast-2.on.aws/';
    const r = await fetch(LAMBDA, { method: 'GET', signal: AbortSignal.timeout(8000) });
    const txt = await r.text();
    results.lambda_ping_ms = Date.now()-t3;
    results.lambda_ping_status = r.status;
    results.lambda_ping_response = txt.substring(0,100);
  } catch(e) { results.lambda_error = e.message; }

  return { statusCode: 200, headers, body: JSON.stringify(results, null, 2) };
};
