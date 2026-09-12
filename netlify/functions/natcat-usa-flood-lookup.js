// netlify/functions/natcat-usa-flood-lookup.js
// Live flood zone lookup by coordinate, against FEMA's own authoritative
// nationwide National Flood Hazard Layer (NFHL) — the same source data
// FEMA's own Flood Map Service Center uses. No API key required.
//   https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28
// Layer 28 = Flood Hazard Zones. Field names (FLD_ZONE, ZONE_SUBTY,
// SFHA_TF) confirmed directly against FEMA-sourced ArcGIS REST metadata.
//
// POST body:
//   { address: "123 Main St, Houston, TX" }   — geocoded via Google first
//   OR
//   { lat: 29.76, lon: -95.36 }                — used directly, no geocoding
//
// Environment variables required:
//   GOOGLE_MAPS_API_KEY   (only needed when an address is passed —
//                          same server-side key used by natcat-usa-lookup.js)

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const NFHL_QUERY_URL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';

// FEMA's own plain-language zone descriptions — SanketRisk's own summary
// wording, not FEMA's official text verbatim, but based on their published
// zone definitions (fema.gov/glossary/flood-zones).
const ZONE_DESCRIPTIONS = {
  'A':    'Special Flood Hazard Area (1% annual chance / 100-year flood) — no base flood elevation determined.',
  'AE':   'Special Flood Hazard Area (1% annual chance / 100-year flood) — base flood elevation determined.',
  'AH':   'Special Flood Hazard Area — shallow flooding (ponding), 1-3 ft typical depth.',
  'AO':   'Special Flood Hazard Area — shallow flooding (sheet flow), 1-3 ft typical depth.',
  'AR':   'Special Flood Hazard Area — area with reduced risk due to a flood-control system being restored.',
  'A99':  'Special Flood Hazard Area — to be protected by a flood-control system under construction.',
  'V':    'Special Flood Hazard Area — coastal high-hazard area (wave action), no base flood elevation determined.',
  'VE':   'Special Flood Hazard Area — coastal high-hazard area (wave action), base flood elevation determined.',
  'X':    'Minimal flood hazard — outside the 0.2% annual chance floodplain (or protected by levee).',
  'D':    'Undetermined flood hazard — flood risk has not been studied for this area.',
};

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

    const queryUrl = NFHL_QUERY_URL +
      '?geometry=' + encodeURIComponent(lon + ',' + lat) +
      '&geometryType=esriGeometryPoint' +
      '&inSR=4326' +
      '&spatialRel=esriSpatialRelIntersects' +
      '&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF' +
      '&returnGeometry=false' +
      '&f=json';

    const nfhlResp = await fetch(queryUrl);
    const nfhlData = await nfhlResp.json();

    if (nfhlData.error) {
      console.error('FEMA NFHL raw error response:', JSON.stringify(nfhlData).substring(0, 1000));
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ error: 'FEMA NFHL service returned an error', fema_error: nfhlData.error }),
      };
    }

    // No feature returned at this point = FEMA has no digitized flood data
    // for this location yet (NFHL covers >90% of the US population, not
    // 100% of land area) — this is a real, distinct outcome, not a failure.
    if (!nfhlData.features || !nfhlData.features.length) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          status: 'ok',
          lat: lat, lon: lon,
          resolved_address: resolvedAddress,
          flood_zone: null,
          flood_zone_subtype: null,
          in_special_flood_hazard_area: null,
          description: 'No digitized FEMA flood hazard data is available for this location. This does not necessarily mean the property is at minimal risk — coverage gaps exist, particularly in some rural areas. A manual check at msc.fema.gov is recommended.',
          source: 'FEMA National Flood Hazard Layer (NFHL)',
        }),
      };
    }

    const attrs = nfhlData.features[0].attributes || {};
    const zone = attrs.FLD_ZONE || null;
    const sfha = attrs.SFHA_TF === 'T' || attrs.SFHA_TF === true;

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        status: 'ok',
        lat: lat, lon: lon,
        resolved_address: resolvedAddress,
        flood_zone: zone,
        flood_zone_subtype: attrs.ZONE_SUBTY || null,
        in_special_flood_hazard_area: sfha,
        description: ZONE_DESCRIPTIONS[zone] || ('FEMA flood zone ' + zone + ' — see FEMA glossary for definition.'),
        source: 'FEMA National Flood Hazard Layer (NFHL)',
      }),
    };

  } catch (e) {
    console.error('natcat-usa-flood-lookup error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
