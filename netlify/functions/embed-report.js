// netlify/functions/embed-report.js
// Embeds a SCAN ONE report's COPE sections (construction, protection,
// occupancy, hazards) via Voyage AI and upserts them into report_embeddings.
// Works identically for a fresh AI analysis or an archive-converted legacy
// report, since both land in scan_submissions.scan_result with the same
// JSON shape.
//
// Two modes:
//   POST { mode: 'single',   scan_submission_id: '<uuid>' }
//     — (re)embeds one report. Call this after saveToDashboard() in
//       scan.html and after a successful archive conversion, fire-and-forget.
//   POST { mode: 'backfill', limit: 10 }
//     — embeds up to `limit` reports that don't have embeddings yet.
//       Call this repeatedly (e.g. from a small loop script) until it
//       reports remaining: 0 — each call stays inside Netlify's function
//       timeout by only processing a small batch.
//
// Environment variables required:
//   SUPABASE_DB_URL   (same direct Postgres connection used elsewhere —
//                      needed because pgvector columns aren't reachable
//                      through the REST API the same way plain columns are)
//   VOYAGE_AI         (Voyage AI API key)

const { Client } = require('pg');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const VOYAGE_URL   = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-4-lite';

// ── Build the text for each COPE section from a scan_result JSON blob ──
// Mirrors the fields scan.html's AI prompt schema actually populates
// (see buildPrompt()/renderResults() in scan.html).
function buildSectionTexts(r) {
  if (!r) return {};

  const hazardsText = Array.isArray(r.hazards)
    ? r.hazards.map(h => typeof h === 'string' ? h : (h.description || h.text || JSON.stringify(h))).join('\n')
    : (r.hazards || '');

  const recsText = Array.isArray(r.recommendations)
    ? r.recommendations.map(rec => `${rec.priority || ''}: ${rec.title || ''} — ${rec.text || rec.description || ''}`).join('\n')
    : '';

  const sections = {
    construction: [r.construction_class, r.construction, r.roof_type, r.year_built_assessed]
      .filter(Boolean).join('\n\n'),
    protection: [r.sprinkler_type, r.alarm_type, r.protection]
      .filter(Boolean).join('\n\n'),
    occupancy: [r.occupancy_class, r.occupancy]
      .filter(Boolean).join('\n\n'),
    hazards: [hazardsText, recsText]
      .filter(Boolean).join('\n\n'),
  };

  // Drop sections with too little text to embed meaningfully
  Object.keys(sections).forEach(k => {
    if (!sections[k] || sections[k].trim().length < 15) delete sections[k];
  });
  return sections;
}

async function embedTexts(texts) {
  // texts: array of strings, in order — Voyage batches in one call
  const resp = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.VOYAGE_AI,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: 'document',
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Voyage API error ' + resp.status + ': ' + errText.substring(0, 300));
  }
  const data = await resp.json();
  return data.data.map(d => d.embedding); // array of float arrays, same order as input
}

async function embedOneReport(client, id, scanResultRaw) {
  let scanResult;
  try {
    scanResult = typeof scanResultRaw === 'string' ? JSON.parse(scanResultRaw) : scanResultRaw;
  } catch (e) {
    return { id, skipped: true, reason: 'scan_result not valid JSON' };
  }

  const sections = buildSectionTexts(scanResult);
  const sectionNames = Object.keys(sections);
  if (!sectionNames.length) {
    return { id, skipped: true, reason: 'no usable section text' };
  }

  const vectors = await embedTexts(sectionNames.map(s => sections[s]));

  for (let i = 0; i < sectionNames.length; i++) {
    const section = sectionNames[i];
    const vec = '[' + vectors[i].join(',') + ']'; // pgvector literal format
    await client.query(
      `insert into report_embeddings (scan_submission_id, section, embedding, source_text, model)
       values ($1, $2, $3::vector, $4, $5)
       on conflict (scan_submission_id, section)
       do update set embedding = excluded.embedding, source_text = excluded.source_text, created_at = now()`,
      [id, section, vec, sections[section].substring(0, 4000), VOYAGE_MODEL]
    );
  }

  return { id, embedded: sectionNames };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!process.env.VOYAGE_AI) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'VOYAGE_AI env var not set' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });

  try {
    await client.connect();

    if (body.mode === 'single') {
      if (!body.scan_submission_id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'scan_submission_id required' }) };
      }
      const res = await client.query(
        'select id, scan_result from scan_submissions where id = $1',
        [body.scan_submission_id]
      );
      if (!res.rows.length) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'scan_submission not found' }) };
      }
      const result = await embedOneReport(client, res.rows[0].id, res.rows[0].scan_result);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
    }

    if (body.mode === 'backfill') {
      const limit = Math.min(parseInt(body.limit) || 10, 25); // keep each call small — Netlify function timeout
      const pending = await client.query(
        `select s.id, s.scan_result
         from scan_submissions s
         where s.scan_result is not null
           and not exists (select 1 from report_embeddings e where e.scan_submission_id = s.id)
         order by s.submitted_at asc nulls last
         limit $1`,
        [limit]
      );

      const results = [];
      for (const row of pending.rows) {
        try {
          results.push(await embedOneReport(client, row.id, row.scan_result));
        } catch (e) {
          results.push({ id: row.id, error: e.message });
        }
      }

      const remainingRes = await client.query(
        `select count(*)::int as n
         from scan_submissions s
         where s.scan_result is not null
           and not exists (select 1 from report_embeddings e where e.scan_submission_id = s.id)`
      );

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ processed: results.length, results, remaining: remainingRes.rows[0].n }),
      };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "mode must be 'single' or 'backfill'" }) };

  } catch (e) {
    console.error('embed-report error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  } finally {
    await client.end();
  }
};
