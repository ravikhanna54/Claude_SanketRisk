// netlify/functions/natcat-usa-rain-lookup.js
// Live precipitation-frequency lookup by coordinate, against NOAA's own
// Atlas 14 Precipitation Frequency Data Server (PFDS) — the same data
// source referenced by ASCE 7's rain design provisions.
//   https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv
// No API key required. Response is CSV text (not JSON) — parsed here into
// the same duration/return-period shape used elsewhere in this project.
//
// POST body:
//   { address: "123 Main St, Springfield, IL" }   — geocoded via Google first
//   OR
//   { lat: 39.78, lon: -89.65 }                    — used directly, no geocoding
//
// Environment variables required:
//   GOOGLE_MAPS_API_KEY   (only needed when an address is passed —
//                          same server-side key used by the other natcat
//                          lookup functions)

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const NOAA_PFDS_URL = 'https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv';

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

// Parses NOAA PFDS's CSV text into { durations: { "15-min": {1: v, 2: v, ...}, ... }, ariYears: [1,2,5,...] }
function parsePfdsCsv(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let ariYears = null;
  const durations = {};

  for (const line of lines) {
    if (line.toLowerCase().startsWith('by duration for ari')) {
      const parts = line.split(',').slice(1).map(s => s.trim()).filter(Boolean);
      ariYears = parts.map(Number);
      continue;
    }
    // Duration rows look like "15-min:, 0.335,0.433,...", "24-hr:, 3.2,4.1,..."
    const m = line.match(/^([\d.]+-(?:min|hr|day)):,?\s*(.+)$/i);
    if (m && ariYears) {
      const vals = m[2].split(',').map(s => parseFloat(s.trim())).filter(v => !isNaN(v));
      if (vals.length === ariYears.length) {
        const byAri = {};
        ariYears.forEach((yr, i) => { byAri[yr] = vals[i]; });
        durations[m[1].toLowerCase()] = byAri;
      }
    }
  }
  return { durations, ariYears };
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

    const noaaUrl = NOAA_PFDS_URL +
      '?lat=' + encodeURIComponent(lat) +
      '&lon=' + encodeURIComponent(lon) +
      '&data=depth&units=english&series=pds';

    const noaaResp = await fetch(noaaUrl);
    const noaaText = await noaaResp.text();

    // NOAA returns an HTML error page (not CSV) for coordinates outside
    // Atlas 14 coverage (currently CONUS + AK/HI/PR/territories in pieces —
    // some areas, e.g. parts of the Western US at time of writing, are not
    // yet covered by a published Atlas 14 volume).
    if (!noaaText || noaaText.trim().toLowerCase().startsWith('<') || noaaText.toLowerCase().includes('<html')) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          status: 'ok',
          lat: lat, lon: lon,
          resolved_address: resolvedAddress,
          rain_15min_in: null,
          rain_1hr_in: null,
          rain_24hr_in: null,
          return_period_years: 50,
          note: 'No NOAA Atlas 14 precipitation-frequency data is published for this location yet — coverage is being rolled out by region and does not yet include the entire US. A manual figure may be needed for this location.',
          source: 'NOAA Atlas 14 — Precipitation Frequency Data Server (PFDS)',
        }),
      };
    }

    const parsed = parsePfdsCsv(noaaText);
    const RETURN_PERIOD = 50; // 1-in-50-year, matching the convention used for the Canadian rain fields

    const get = (durationKey) => {
      const row = parsed.durations[durationKey];
      return row && row[RETURN_PERIOD] !== undefined ? row[RETURN_PERIOD] : null;
    };

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        status: 'ok',
        lat: lat, lon: lon,
        resolved_address: resolvedAddress,
        // 1-in-50-year estimates, inches — matches the return period used
        // for the equivalent Canadian NBC rain fields
        rain_15min_in: get('15-min'),
        rain_1hr_in: get('60-min'),
        rain_24hr_in: get('24-hr'),
        return_period_years: RETURN_PERIOD,
        full_table: parsed.durations,  // every duration x every return period, for reference
        note: 'NOAA Atlas 14 does not publish an annual-precipitation figure (that is a separate NOAA Climate Normals dataset, not part of Atlas 14) — annual precipitation is not included here.',
        source: 'NOAA Atlas 14 — Precipitation Frequency Data Server (PFDS)',
      }),
    };

  } catch (e) {
    console.error('natcat-usa-rain-lookup error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
