// netlify/functions/hydrant-lookup.js
// Finds nearby fire hydrants via OpenStreetMap's Overpass API — free, no
// key required. Built for SCAN ONE specifically: unlike the manual
// Inspections form (where the inspector is physically on site and should
// simply record what they see), SCAN ONE has no inspector on site, so an
// automated best-effort lookup is genuinely useful there.
//
// IMPORTANT — read before relying on this: unlike the USGS/FEMA/NOAA
// lookups elsewhere in this project, OSM hydrant data is entirely
// crowdsourced. Coverage is excellent in some cities (often where a fire
// department or municipal GIS team bulk-imported their own inventory) and
// sparse-to-empty in others. A "no hydrants found" result means no data
// has been mapped near this address — it does NOT mean no hydrants exist
// there. This is a best-effort convenience cross-check, not an
// authoritative source, and the response says so explicitly.
//
// POST body:
//   { address: "123 Main St, Springfield, IL" }   — geocoded via Google first
//   OR
//   { lat: 39.78, lon: -89.65 }                    — used directly, no geocoding
//   Optional: { radius_m: 300 }                     — search radius in metres (default 300, max 1000)
//
// Environment variables required:
//   GOOGLE_MAPS_API_KEY   (only needed when an address is passed —
//                          same server-side key used by the other lookup
//                          functions in this project)

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

async function geocode(address) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY env var not set — required to geocode an address (pass lat/lon directly to skip this)');
  }
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
    encodeURIComponent(address) + '&key=' + process.env.GOOGLE_MAPS_API_KEY;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.status !== 'OK' || !data.results.length) {
    throw new Error('Could not geocode address: ' + (data.status || 'unknown error'));
  }
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lon: loc.lng, formatted_address: data.results[0].formatted_address };
}

// Haversine distance in metres
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    let lat = parseFloat(body.lat);
    let lon = parseFloat(body.lon);
    let resolvedAddress = null;

    if (isNaN(lat) || isNaN(lon)) {
      if (!body.address) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide either { lat, lon } or { address }' }) };
      }
      const geo = await geocode(body.address);
      lat = geo.lat; lon = geo.lon; resolvedAddress = geo.formatted_address;
    }

    const radius = Math.min(parseInt(body.radius_m) || 300, 1000);

    const query = '[out:json][timeout:25];' +
      'node["emergency"="fire_hydrant"](around:' + radius + ',' + lat + ',' + lon + ');' +
      'out body;';

    const overpassResp = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });

    if (!overpassResp.ok) {
      // Overpass is a shared, free, best-effort public service — it does
      // occasionally rate-limit or time out under load. Fail gracefully
      // rather than blocking the report.
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          status: 'ok',
          lat: lat, lon: lon,
          resolved_address: resolvedAddress,
          hydrants: [],
          note: 'The OpenStreetMap Overpass service did not respond (it is a free, shared public service and occasionally rate-limits or times out) — this is not a confirmed absence of hydrants. Try again, or note hydrant distance manually if this persists.',
          source: 'OpenStreetMap (Overpass API)',
        }),
      };
    }

    const overpassData = await overpassResp.json();
    const elements = overpassData.elements || [];

    const hydrants = elements.map(function (el) {
      const tags = el.tags || {};
      return {
        lat: el.lat, lon: el.lon,
        distance_m: Math.round(distanceMeters(lat, lon, el.lat, el.lon)),
        diameter: tags['fire_hydrant:diameter'] || null,
        pressure: tags['fire_hydrant:pressure'] || null,
        type: tags['fire_hydrant:type'] || null,
        flow_capacity: tags['fire_hydrant:flow_capacity'] || null,
      };
    }).sort(function (a, b) { return a.distance_m - b.distance_m; });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        status: 'ok',
        lat: lat, lon: lon,
        resolved_address: resolvedAddress,
        search_radius_m: radius,
        hydrant_count: hydrants.length,
        nearest_distance_m: hydrants.length ? hydrants[0].distance_m : null,
        hydrants: hydrants,
        note: hydrants.length
          ? 'Sourced from OpenStreetMap, a crowdsourced dataset — coverage varies significantly by area and is not authoritative. Verify on site where hydrant access is a material underwriting factor.'
          : 'No hydrants found in OpenStreetMap data within ' + radius + 'm. OpenStreetMap is crowdsourced and coverage varies significantly by area — this does NOT confirm hydrants are actually absent, only that none have been mapped near this address. Do not treat this as a finding of no hydrant protection.',
        source: 'OpenStreetMap (Overpass API)',
      }),
    };

  } catch (e) {
    console.error('hydrant-lookup error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
