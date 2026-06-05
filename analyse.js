const LAMBDA = 'https://zxvw3d7fxhstl6ye5tdsru3pna0lbomh.lambda-url.ap-southeast-2.on.aws/'

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }

  try {
    const isGet = event.httpMethod === 'GET'
    const body = isGet ? undefined : (
      event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64').toString('utf8')
        : (event.body || '{}')
    )

    if (!isGet) console.log('Body length:', (body||'').length)

    const r = await fetch(LAMBDA, {
      method: isGet ? 'GET' : 'POST',
      headers: isGet ? {} : { 'Content-Type': 'application/json' },
      body: isGet ? undefined : body,
    })

    const t = await r.text()
    console.log('Lambda status:', r.status, 'len:', t.length)
    return { statusCode: r.status, headers, body: t }

  } catch(e) {
    console.log('Error:', e.message)
    return { statusCode: 202, headers, body: JSON.stringify({ status: 'processing' }) }
  }
}
