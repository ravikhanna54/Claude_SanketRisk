// netlify/functions/building-footprint-lookup.js
// Queries the appropriate province/state's PostGIS building_footprints_*
// table for the building polygon at (or nearest to) a given lat/lon, and
// returns its footprint area.
//
// Canada: BC, AB, ON tables currently loaded (Microsoft CanadianBuildingFootprints).
// USA: table names are pre-registered below for ALL 50 states + DC, using
// the same naming convention — but only tables that actually exist (i.e.
// have been loaded via import-footprints.js) will ever be queried. Loading
// a new state is purely a data step (see import-footprints.js) — no code
// change needed here when a new one is added.
//   Download: https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/{State}.geojson.zip
//   (same Microsoft dataset family as the Canadian data — 129.5M US building
//   footprints across all 50 states, same GeoJSON format, same ODbL license)
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

// Canadian provinces — existing, unchanged.
const CANADA_TABLE_MAP = {
  'bc': 'building_footprints_bc', 'british columbia': 'building_footprints_bc',
  'ab': 'building_footprints_ab', 'alberta': 'building_footprints_ab',
  'on': 'building_footprints_on', 'ontario': 'building_footprints_on',
};

// US states + DC — table name is pre-registered for every one, using the
// building_footprints_us_{abbr} convention, matching import-footprints.js.
// Whether the table actually has data loaded is irrelevant here — the
// query loop below (see queryTable) skips any table that doesn't exist yet.
const US_STATES = {
  'alabama':'al','alaska':'ak','arizona':'az','arkansas':'ar','california':'ca',
  'colorado':'co','connecticut':'ct','delaware':'de','florida':'fl','georgia':'ga',
  'hawaii':'hi','idaho':'id','illinois':'il','indiana':'in','iowa':'ia',
  'kansas':'ks','kentucky':'ky','louisiana':'la','maine':'me','maryland':'md',
  'massachusetts':'ma','michigan':'mi','minnesota':'mn','mississippi':'ms','missouri':'mo',
  'montana':'mt','nebraska':'ne','nevada':'nv','new hampshire':'nh','new jersey':'nj',
  'new mexico':'nm','new york':'ny','north carolina':'nc','north dakota':'nd','ohio':'oh',
  'oklahoma':'ok','oregon':'or','pennsylvania':'pa','rhode island':'ri','south carolina':'sc',
  'south dakota':'sd','tennessee':'tn','texas':'tx','utah':'ut','vermont':'vt',
  'virginia':'va','washington':'wa','west virginia':'wv','wisconsin':'wi','wyoming':'wy',
  'district of columbia':'dc',
};
const US_TABLE_MAP = {};
Object.keys(US_STATES).forEach(function(name) {
  const abbr = US_STATES[name];
  US_TABLE_MAP[name] = 'building_footprints_us_' + abbr;
  US_TABLE_MAP[abbr] = 'building_footprints_us_' + abbr; // also match by 2-letter abbreviation
});

const PROVINCE_TABLE_MAP = Object.assign({}, CANADA_TABLE_MAP, US_TABLE_MAP);

// Fallback list when no province/state is supplied — every registered
// table, Canada first (existing behaviour unchanged), then every US state.
// queryTable() below skips any table that doesn't exist without failing
// the whole request, so this list can safely include states that haven't
// been loaded yet.
const ALL_TABLES = Object.values(CANADA_TABLE_MAP).filter(function(v, i, a) { return a.indexOf(v) === i; })
  .concat(Object.keys(US_STATES).map(function(name) { return 'building_footprints_us_' + US_STATES[name]; }));

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

  const provinceKey = (body.province || '').trim().toLowerCase();
  const tablesToTry = PROVINCE_TABLE_MAP[provinceKey] ? [PROVINCE_TABLE_MAP[provinceKey]] : ALL_TABLES;

  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });

  try {
    await client.connect();

    for (const table of tablesToTry) {
      try {
        // Step 1: does a building polygon actually CONTAIN this point? This is
        // the accurate case — the geocoded point lands inside a mapped building.
        const containsResult = await client.query(
          `SELECT id, ST_Area(geom::geography) AS area_sq_m
           FROM ${table}
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
              table: table,
              footprint_area_sq_m: row.area_sq_m,
              footprint_area_sq_ft: row.area_sq_m * 10.7639,
            }),
          };
        }

        // Step 2: no polygon contains the exact point (common when a geocode
        // lands on a road centreline, parking lot entrance, or parcel
        // centroid rather than the building itself — especially on the
        // larger commercial/industrial sites this platform is built for,
        // where the address point can legitimately sit 100m+ from the
        // actual structure). 200m matches the wider end of the radius
        // range scan.html's own OSM/Overpass building search already uses
        // for the same reason.
        const nearestResult = await client.query(
          `SELECT id, ST_Area(geom::geography) AS area_sq_m,
                  ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
           FROM ${table}
           WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 200)
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
              table: table,
              distance_m: row.distance_m,
              footprint_area_sq_m: row.area_sq_m,
              footprint_area_sq_ft: row.area_sq_m * 10.7639,
            }),
          };
        }
        // No match in this table — try the next one (if province wasn't known).
      } catch (tableErr) {
        // 42P01 = "relation does not exist" — this state/province hasn't
        // been loaded yet. Skip it and keep trying the rest of the list,
        // rather than failing the whole request over one missing table.
        if (tableErr.code === '42P01') continue;
        throw tableErr;
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'not_found' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  } finally {
    await client.end();
  }
};
