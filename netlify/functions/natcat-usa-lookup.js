// netlify/functions/natcat-usa-lookup.js
// US equivalent of the climatic_design_data lookup used for Canada (NBC
// 2025 Appendix C) — but live-queried per coordinate against the USGS
// ASCE 7-22 seismic design web service, rather than a pre-loaded table of
// fixed locations. This is actually more precise than the Canadian setup:
// it works for ANY US address, not just a list of pre-loaded cities.
//
// Source: USGS Earthquake Hazards Program, "Design Ground Motions" web
// service — the same government data source behind the ASCE Hazard Tool
// (ascehazardtool.org). No API key required for this endpoint.
//   https://earthquake.usgs.gov/ws/designmaps/asce7-22.json
//
// Flood and wind are NOT included yet — see notes at the bottom of this
// file for what each would take to add.
//
// POST body:
//   { address: "123 Main St, Springfield, IL" }   — geocoded via Google first
//   OR
//   { lat: 39.78, lon: -89.65 }                    — used directly, no geocoding
//   Optional: { riskCategory: "II", siteClass: "D" }  — defaults shown are the
//   most common choices (Risk Category II = standard commercial/residential;
//   Site Class D = code default when no geotechnical report is available).
//
// Environment variables required:
//   GOOGLE_MAPS_API_KEY   (only needed when an address, not lat/lon, is
//                          passed in — same key already used by
//                          maps-proxy.js for Street View/Static Maps;
//                          reuse that same value as this env var rather
//                          than provisioning a new key)

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const USGS_URL = 'https://earthquake.usgs.gov/ws/designmaps/asce7-22.json';

// SanketRisk's own Low/Moderate/High/Very High bucketing of the USGS
// Seismic Design Category (A-F), for consistency with the demerit-weighting
// scheme already used for the Canadian smax-based tier (cddTier() in
// app.html). This mapping is SanketRisk's convention, not an official ASCE
// or USGS classification — ASCE 7 itself doesn't rank A-F into four bands.
function sdcTier(sdc) {
  if (!sdc) return '';
  var v = String(sdc).toUpperCase();
  if (v === 'A' || v === 'B') return 'Low';
  if (v === 'C') return 'Moderate';
  if (v === 'D') return 'High';
  if (v === 'E' || v === 'F') return 'Very High';
  return '';
}

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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const riskCategory = body.riskCategory || 'II';
  const siteClass    = body.siteClass || 'D';

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

    const usgsUrl = USGS_URL +
      '?latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lon) +
      '&riskCategory=' + encodeURIComponent(riskCategory) +
      '&siteClass=' + encodeURIComponent(siteClass) +
      '&title=' + encodeURIComponent('SanketRisk lookup');

    const usgsResp = await fetch(usgsUrl);
    const usgsData = await usgsResp.json();

    if (!usgsData.request || usgsData.request.status !== 'success' || !usgsData.data) {
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ error: 'USGS design maps service did not return a valid result', usgs_status: (usgsData.request && usgsData.request.status) || null }),
      };
    }

    const d = usgsData.data;

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        status: 'ok',
        lat: lat, lon: lon,
        resolved_address: resolvedAddress,   // only set when address was geocoded
        reference_document: 'ASCE7-22',
        risk_category: riskCategory,
        site_class: siteClass,
        // Short-period (0.2s) values
        ss: d.ss, sms: d.sms, sds: d.sds,
        // 1-second period values
        s1: d.s1, sm1: d.sm1, sd1: d.sd1,
        // Peak ground acceleration (pgam = site-modified; pga may be absent
        // depending on location/edition — pgam is the design-relevant value)
        pga: d.pga, pgam: d.pgam,
        // Final seismic design category and SanketRisk's tier bucket for it
        seismic_design_category: d.sdc,
        seismic_tier: sdcTier(d.sdc),
        long_period_transition: d.tl,
        source: 'USGS Earthquake Hazards Program — Design Ground Motions web service (ASCE 7-22)',
      }),
    };

  } catch (e) {
    console.error('natcat-usa-lookup error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

// ── Notes on what this function does NOT cover yet ──
//
// WIND: ASCE 7-22 design wind speeds come from NOAA's Hydrometeorological
// Design Studies Center data, which — unlike the USGS seismic service — does
// not have a simple public per-coordinate REST endpoint as clean as this
// one. Adding it would mean either scraping/calling ASCE's own tool
// (ascehazardtool.org has no documented public API) or loading NOAA's
// published wind speed contour data into a table and doing our own
// point-in-polygon lookup — closer in effort to how the Canadian
// climatic_design_data table was built than to this live-query approach.
//
// FLOOD: FEMA's National Flood Hazard Layer IS live-queryable via an
// ArcGIS REST MapServer (point-in-polygon flood zone lookup), which is a
// genuinely addable second piece — different API shape and error handling
// than USGS's JSON service though, so worth its own function or a clearly
// separated second block in this one, once this seismic piece is confirmed
// working end to end.
//
// WILDFIRE / broader risk score: FEMA's National Risk Index is a bulk
// downloadable dataset (county/census-tract level), not a live API —
// adding it means an import/load step similar to how the 680-location
// Canadian table was populated, not a per-request API call.
