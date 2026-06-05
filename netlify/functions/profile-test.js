// Quick test — confirms function is deployed and API key exists
exports.handler = async (event) => {
  const key = process.env.ANTHROPIC_API_KEY;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      ok: true,
      has_key: !!key,
      key_prefix: key ? key.substring(0, 10) + '...' : 'MISSING',
      time: new Date().toISOString()
    })
  };
};
