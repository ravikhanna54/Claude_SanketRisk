// SanketRisk ONE — Netlify Function: maps-proxy
// Server-side proxy for Google Static Maps API and Street View Static API.
// Fetching images through this same-origin endpoint (instead of
// maps.googleapis.com directly from the browser) avoids the CORS/canvas-
// tainting issue that causes map images to render as blank space when
// html2canvas captures the report for PDF export — Google's endpoints do
// not reliably send Access-Control-Allow-Origin headers, so useCORS/
// allowTaint on the client can't fully work around it. A same-origin image
// has no such restriction.
//
// Two modes, auto-detected from query params:
//   - Street View: pass `location` (matches Google's own Street View
//     Static API parameter name)
//   - Static Map: pass `center` (matches Google's own Maps Static API
//     parameter name) — this is the original, unchanged behavior.

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'public, max-age=3600',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // ── CONFIG ──
    const GOOGLE_MAPS_API_KEY = 'AIzaSyDAHNS9_C-NLzVhAUDhD9HfSP-7X-xTVkI';

    const q = event.queryStringParameters || {};
    const size = q.size || '640x420';
    var url;

    if (q.location) {
      // Street View Static API
      const location = q.location;
      const fov      = q.fov     || '90';
      const heading   = q.heading || '0';
      const pitch     = q.pitch   || '0';
      url = 'https://maps.googleapis.com/maps/api/streetview'
        + '?location=' + encodeURIComponent(location)
        + '&size=' + encodeURIComponent(size)
        + '&fov=' + encodeURIComponent(fov)
        + '&heading=' + encodeURIComponent(heading)
        + '&pitch=' + encodeURIComponent(pitch)
        + '&key=' + GOOGLE_MAPS_API_KEY;
    } else {
      // Static Maps API — original behavior, unchanged
      const center   = q.center   || '';
      const zoom     = q.zoom     || '18';
      const scale    = q.scale   || '2';
      const maptype  = q.maptype || 'hybrid';
      const markers  = q.markers || '';

      if (!center) {
        return { statusCode: 400, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing required parameter: center (static map) or location (street view)' }) };
      }

      url = 'https://maps.googleapis.com/maps/api/staticmap'
        + '?center=' + encodeURIComponent(center)
        + '&zoom=' + encodeURIComponent(zoom)
        + '&size=' + encodeURIComponent(size)
        + '&scale=' + encodeURIComponent(scale)
        + '&maptype=' + encodeURIComponent(maptype)
        + (markers ? '&markers=' + encodeURIComponent(markers) : '')
        + '&key=' + GOOGLE_MAPS_API_KEY;
    }

    var res = await fetch(url);
    if (!res.ok) {
      return { statusCode: res.status, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Google Maps API returned ' + res.status }) };
    }
    var buf = await res.arrayBuffer();
    var b64 = Buffer.from(buf).toString('base64');

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': res.headers.get('content-type') || 'image/png' },
      body: b64,
      isBase64Encoded: true,
    };
  } catch (e) {
    return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message || 'Unknown error' }) };
  }
};

