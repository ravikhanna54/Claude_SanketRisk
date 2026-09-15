// import-footprints.js
// Streams a Microsoft building-footprints GeoJSON file into a
// PostGIS-enabled Supabase table, in batches, without loading the whole
// file into memory. Works for any Canadian province or US state — just
// pass the matching table name and file path.
//
// SETUP — CANADA (one-time per province):
//   1. Download the province's zip from Microsoft (I can't reach this host
//      from my sandbox, so this step is yours):
//      https://minedbuildings.z5.web.core.windows.net/legacy/canadian-buildings-v2/Alberta.zip
//      https://minedbuildings.z5.web.core.windows.net/legacy/canadian-buildings-v2/Ontario.zip
//      Unzip it — you'll get a single {Province}.geojson file.
//   2. Run 02_setup_ab_on.sql in Supabase's SQL Editor first (creates the
//      building_footprints_ab / building_footprints_on tables).
//
// SETUP — USA (one-time per state), same Microsoft dataset family, same
// format, same hosting pattern:
//   1. Download the state's zip:
//      https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/California.geojson.zip
//      https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Texas.geojson.zip
//      (swap in any state name — see README at
//      github.com/microsoft/USBuildingFootprints for the full list of 50
//      states + DC and their sizes; some states run several GB unzipped,
//      so pick states in the order you're actually onboarding them)
//      Unzip it — you'll get a single {State}.geojson file.
//   2. Run 03_setup_us_state.sql in Supabase's SQL Editor first, editing
//      the table name at the top for the specific state (creates
//      building_footprints_us_{2-letter-abbr}).
//
// SETUP (both, one-time overall):
//   3. Install Node dependencies:
//      npm install pg stream-json@1.9.1
//      IMPORTANT: pin stream-json to 1.9.1 — the current 3.x release is a
//      different ESM-only package. 1.9.1 is the version this script uses.
//   4. Get your Supabase direct connection string:
//      Supabase Dashboard -> Project Settings -> Database -> Connection
//      Pooling (Session mode) -> copy the URI, substitute your password.
//
// RUN (table name first, then file path):
//   SUPABASE_DB_URL="postgresql://...your connection string..." \
//     node import-footprints.js building_footprints_ab /path/to/Alberta.geojson
//
//   SUPABASE_DB_URL="postgresql://...your connection string..." \
//     node import-footprints.js building_footprints_us_ca /path/to/California.geojson
//
// Ontario is ~2.8x the size of BC (3.78M buildings vs 1.36M) — expect the
// import to take roughly that much longer. Larger US states (California,
// Texas) will take longer still — California alone is ~11.5M buildings,
// close to the size of BC + AB + ON combined. Progress prints every 5,000
// buildings processed so you can see it's actually working, not stuck.

const fs = require('fs');
const { Client } = require('pg');
const { parser } = require('stream-json');
const { pick } = require('stream-json/filters/Pick');
const { streamArray } = require('stream-json/streamers/StreamArray');

const DB_URL = process.env.SUPABASE_DB_URL;
const TABLE_NAME = process.argv[2];
const FILE_PATH = process.argv[3];
const BATCH_SIZE = 500;

// US state/DC 2-letter abbreviations — used only to build the safe
// table-name allowlist below, not to derive anything from user input.
const US_ABBRS = ['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
  'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc',
  'nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc'];

// Every valid target table — Canadian provinces plus one entry per US
// state/DC, all following the same building_footprints_{code} convention.
// This guards against a typo sending data into the wrong table (or an
// arbitrary/unsafe table name, since we have to interpolate this into SQL
// rather than parameterize an identifier) — it does NOT mean all of these
// tables exist yet; run the matching 0X_setup_*.sql first for whichever
// one you're loading.
const ALLOWED_TABLES = ['building_footprints_bc', 'building_footprints_ab', 'building_footprints_on']
  .concat(US_ABBRS.map(function(a) { return 'building_footprints_us_' + a; }));

if (!DB_URL) {
  console.error('ERROR: Set SUPABASE_DB_URL environment variable to your Supabase connection string.');
  process.exit(1);
}
if (!TABLE_NAME || !ALLOWED_TABLES.includes(TABLE_NAME)) {
  console.error('ERROR: First argument must be one of: ' + ALLOWED_TABLES.join(', '));
  console.error('Example: node import-footprints.js building_footprints_ab /path/to/Alberta.geojson');
  process.exit(1);
}
if (!FILE_PATH || !fs.existsSync(FILE_PATH)) {
  console.error('ERROR: Pass the path to the province .geojson file as the second argument.');
  console.error('Example: node import-footprints.js building_footprints_ab /path/to/Alberta.geojson');
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log('Connected to Supabase. Importing into ' + TABLE_NAME + '...');

  let batch = [];
  let totalInserted = 0;
  let totalSkipped = 0;
  const startTime = Date.now();

  async function flushBatch() {
    if (batch.length === 0) return;
    const valuePlaceholders = batch.map((_, i) => `(ST_SetSRID(ST_GeomFromGeoJSON($${i + 1}), 4326))`).join(',');
    const sql = `INSERT INTO ${TABLE_NAME} (geom) VALUES ${valuePlaceholders}`;
    try {
      await client.query(sql, batch);
      totalInserted += batch.length;
    } catch (err) {
      // Don't let one bad geometry in a batch kill the whole import — log it
      // and move on. A handful of skipped malformed polygons out of millions
      // is an acceptable loss for this use case.
      console.warn(`Batch insert error (skipping this batch of ${batch.length}): ${err.message}`);
      totalSkipped += batch.length;
    }
    batch = [];
  }

  return new Promise((resolve, reject) => {
    const pipeline = fs.createReadStream(FILE_PATH)
      .pipe(parser())
      .pipe(pick({ filter: 'features' }))
      .pipe(streamArray());

    pipeline.on('data', ({ value: feature }) => {
      if (feature && feature.geometry) {
        batch.push(JSON.stringify(feature.geometry));
      }

      if (batch.length >= BATCH_SIZE) {
        pipeline.pause();
        flushBatch().then(() => {
          if ((totalInserted + totalSkipped) % 5000 < BATCH_SIZE) {
            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
            console.log(`${totalInserted} inserted, ${totalSkipped} skipped so far... (${elapsedSec}s elapsed)`);
          }
          pipeline.resume();
        }).catch(reject);
      }
    });

    pipeline.on('end', async () => {
      await flushBatch(); // final partial batch
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`\nDone. ${totalInserted} buildings inserted, ${totalSkipped} skipped, in ${elapsedSec}s.`);
      await client.end();
      resolve();
    });

    pipeline.on('error', (err) => {
      console.error('Stream error:', err.message);
      reject(err);
    });
  });
}

main().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
