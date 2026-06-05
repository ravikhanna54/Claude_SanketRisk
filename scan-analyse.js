const LAMBDA_URL = 'https://zxvw3d7fxhstl6ye5tdsru3pna0lbomh.lambda-url.ap-southeast-2.on.aws/'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Content-Type': 'application/json',
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' }
  }

  try {
    if (event.httpMethod === 'GET') {
      const r = await fetch(LAMBDA_URL)
      const t = await r.text()
      return { statusCode: 200, headers: CORS, body: t }
    }

    const bodyStr = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '{}')

    console.log('Body length:', bodyStr.length)

    const r = await fetch(LAMBDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
    })

    const t = await r.text()
    console.log('Lambda status:', r.status, 'len:', t.length)
    return { statusCode: r.status, headers: CORS, body: t }

  } catch(e) {
    console.log('Error:', e.message)
    // If timeout/error, tell browser to poll
    return { statusCode: 202, headers: CORS, body: JSON.stringify({ status: 'processing' }) }
  }
}
