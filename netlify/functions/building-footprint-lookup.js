// netlify/functions/building-footprint-lookup.js
// Queries the building_footprints_bc PostGIS table for the building polygon
// at (or nearest to) a given lat/lon, and returns its footprint area.
// This is the query-side counterpart to import-bc-footprints.js — that
// script loads the data once; this function is what scan.html/registry-intel
// actually calls per-address, going forward as a BC-specific alternative to
// the OSM/Google footprint fallback already in place.
//
// Environment variables required:
//   SUPABASE_DB_URL   (the same direct Postgres connection string used by
//                      the import script — NOT the REST API URL/key used
//                      elsewhere in the platform, since this function needs
//                      to run a raw PostGIS spatial query that Supabase's
//                      REST API doesn't expose directly)

const { Client } = require('pg');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const lat = parseFloat(body.lat);
  const lon = parseFloat(body.lon);
  if (isNaN(lat) || isNaN(lon)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lat and lon (numbers) are required' }) };
  }

  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });

  try {
    await client.connect();

    // Step 1: does a building polygon actually CONTAIN this point? This is
    // the accurate case — the geocoded point lands inside a mapped building.
    const containsResult = await client.query(
      `SELECT id, ST_Area(geom::geography) AS area_sq_m
       FROM building_footprints_bc
       WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
       LIMIT 1`,
      [lon, lat] // note: PostGIS point order is (lon, lat), i.e. (x, y)
    );

    if (containsResult.rows.length > 0) {
      const row = containsResult.rows[0];
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          status: 'ok',
          match_type: 'contains',
          footprint_area_sq_m: row.area_sq_m,
          footprint_area_sq_ft: row.area_sq_m * 10.7639,
        }),
      };
    }

    // Step 2: no polygon contains the exact point (common when a geocode
    // lands slightly off, e.g. on the road centreline rather than the
    // building itself) — fall back to the nearest polygon within 50m.
    const nearestResult = await client.query(
      `SELECT id, ST_Area(geom::geography) AS area_sq_m,
              ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
       FROM building_footprints_bc
       WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 50)
       ORDER BY distance_m ASC
       LIMIT 1`,
      [lon, lat]
    );

    if (nearestResult.rows.length > 0) {
      const row = nearestResult.rows[0];
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          status: 'ok',
          match_type: 'nearest',
          distance_m: row.distance_m,
          footprint_area_sq_m: row.area_sq_m,
          footprint_area_sq_ft: row.area_sq_m * 10.7639,
        }),
      };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'not_found' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  } finally {
    await client.end();
  }
};
