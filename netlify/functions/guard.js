// Shared sign-in check for SanketRisk Netlify functions.
// A request is allowed only if it carries a valid Supabase session token
// (Authorization: Bearer <token>, or ?t=<token> for image URLs such as maps-proxy),
// OR the optional server-to-server header x-internal-key matching the INTERNAL_API_KEY env variable.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lzsfmqbhrpsmnivxhggi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_C5KWTHt84OMXif4javqeOQ_rjFK0t83'; // public key, safe to include

const _cache = new Map(); // token -> { exp, user }  (kept for 60 s to avoid a lookup on every call)

function deny(status, message) {
  return {
    ok: false,
    response: {
      statusCode: status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: message }),
    },
  };
}

async function requireAuth(event) {
  const h = event.headers || {};
  const internal = process.env.INTERNAL_API_KEY;
  if (internal && h['x-internal-key'] && h['x-internal-key'] === internal) return { ok: true, user: { id: 'internal' } };

  let token = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) token = String((event.queryStringParameters || {}).t || '').trim();
  if (!token) return deny(401, 'Sign in required.');

  const hit = _cache.get(token);
  if (hit && hit.exp > Date.now()) return { ok: true, user: hit.user };

  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return deny(401, 'Session expired. Please sign in again.');
    const user = await r.json();
    if (!user || !user.id) return deny(401, 'Sign in required.');
    if (_cache.size > 500) _cache.clear();
    _cache.set(token, { exp: Date.now() + 60000, user });
    return { ok: true, user };
  } catch (e) {
    return deny(503, 'Could not verify sign-in. Please try again.');
  }
}

module.exports = { requireAuth };
