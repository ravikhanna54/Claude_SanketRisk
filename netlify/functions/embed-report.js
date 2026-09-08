// netlify/functions/embed-report.js
// Embeds a report's COPE sections (construction, protection, occupancy,
// hazards) via Voyage AI and upserts them into report_embeddings — now
// source-agnostic across the platform's two report tables:
//   - scan_submissions  (SCAN ONE — AI-generated scan_result JSON)
//   - inspections       (manual COPE form in app.html — form_data JSON
//                        of raw field values, pill selections, and
//                        recommendation items; no AI-structured schema)
// Run 001_report_embeddings.sql then 002_report_embeddings_source_table.sql
// before deploying this version.
//
// Two modes:
//   POST { mode: 'single',   source_table: 'scan_submissions'|'inspections', id: '<uuid>' }
//     — (re)embeds one report. Call this fire-and-forget after
//       saveToDashboard() in scan.html, after archive conversion, and
//       after saveInspection()/submitForQA() in app.html.
//   POST { mode: 'backfill', source_table: '...', limit: 10 }
//     — embeds up to `limit` reports from that one table that don't have
//       embeddings yet. Call repeatedly per table until remaining: 0.
//
// Environment variables required:
//   SUPABASE_DB_URL   (direct Postgres connection — pgvector columns
//                      aren't reachable the same way through the REST API)
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

// ── scan_submissions: sections from the AI-generated scan_result JSON ──
function buildSectionTextsScan(r) {
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
  return trimEmptySections(sections);
}

// ── inspections: sections from the manual form's raw field/pill data ──
// This is an approximate mapping (the form has no AI-structured schema to
// key off of) — built from field ids and fuzzy-matched pill-selection
// keys (pill keys are auto-derived slugs of each field's label text, so
// exact keys can vary; substring matching is more robust than hardcoding
// the derived slug). Worth spot-checking a few embedded rows after the
// first backfill and refining the id/substring lists below if any
// section is consistently thin.
function buildSectionTextsInspection(formDataRaw) {
  let fd;
  try { fd = typeof formDataRaw === 'string' ? JSON.parse(formDataRaw) : formDataRaw; } catch (e) { return {}; }
  if (!fd) return {};

  const fields = fd.fields || {};
  const pills = fd.pills || {};
  const recItems = fd.rec_items || [];

  function fieldsText(ids) {
    return ids.map(id => fields[id]).filter(v => v && String(v).trim()).join('\n');
  }
  function pillsText(substrings) {
    const out = [];
    Object.keys(pills).forEach(k => {
      if (substrings.some(s => k.indexOf(s) !== -1)) {
        const v = pills[k];
        if (Array.isArray(v) && v.length) out.push(v.join(', '));
      }
    });
    return out.join('\n');
  }

  const constructionIds = ['year-built', 'year-renovated', 'stories-above-grade', 'building-height', 'total-area',
    'roof-year', 'roof-condition', 'roof-drains', 'electrical-panel', 'electrical-amperage', 'wiring-type',
    'hvac-condition', 'plumbing-material', 'hot-water-system', 'construction-notes'];
  const occupancyIds = ['occupancy-class-select', 'primary-sic-naics-code', 'owner-occupied', 'pct-occupied',
    'hours-of-operation', '24hr-operations', 'description-operations', 'hazard-notes', 'nfpa-hazard-category'];
  const protectionIds = ['sprinkler-type', 'sprinkler-condition', 'sprinkler-monitoring', 'fire-alarm-system',
    'smoke-detection', 'heat-detectors', 'extinguishers-present', 'fus-distance-firehall', 'fus-dept-type',
    'fus-grade', 'security-notes', 'fus-notes'];
  const exposureIds = ['north-exposure', 'south-exposure', 'east-exposure', 'west-exposure', 'exposure-rating',
    'flood-zone', 'earthquake-zone', 'wind-zone', 'wildfire-risk', 'exposure-notes'];

  const recText = recItems.map(r => `${r.priority || ''}: ${r.title || ''} — ${r.desc || ''}`).join('\n');

  const sections = {
    construction: [fieldsText(constructionIds), pillsText(['construction', 'iso', 'wall', 'roof', 'frame', 'deck'])]
      .filter(Boolean).join('\n\n'),
    occupancy: [fieldsText(occupancyIds), pillsText(['occupancy', 'hazardous_process'])]
      .filter(Boolean).join('\n\n'),
    protection: [fieldsText(protectionIds), pillsText(['sprinkler', 'fire_alarm', 'security'])]
      .filter(Boolean).join('\n\n'),
    hazards: [fieldsText(exposureIds), recText]
      .filter(Boolean).join('\n\n'),
  };
  return trimEmptySections(sections);
}

function trimEmptySections(sections) {
  Object.keys(sections).forEach(k => {
    if (!sections[k] || sections[k].trim().length < 15) delete sections[k];
  });
  return sections;
}

// Per-table config: which column holds the report data, and which
// builder turns it into section texts.
const TABLE_CONFIG = {
  scan_submissions: { dataColumn: 'scan_result', dateColumn: 'submitted_at', buildSections: buildSectionTextsScan },
  inspections:       { dataColumn: 'form_data',   dateColumn: 'updated_at',   buildSections: buildSectionTextsInspection },
};

async function embedTexts(texts) {
  const resp = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.VOYAGE_AI,
    },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: 'document' }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Voyage API error ' + resp.status + ': ' + errText.substring(0, 300));
  }
  const data = await resp.json();
  return data.data.map(d => d.embedding);
}

async function embedOneReport(client, sourceTable, id, dataRaw) {
  const config = TABLE_CONFIG[sourceTable];
  const sections = config.buildSections(dataRaw);
  const sectionNames = Object.keys(sections);
  if (!sectionNames.length) {
    return { id, skipped: true, reason: 'no usable section text' };
  }

  const vectors = await embedTexts(sectionNames.map(s => sections[s]));

  for (let i = 0; i < sectionNames.length; i++) {
    const section = sectionNames[i];
    const vec = '[' + vectors[i].join(',') + ']';
    await client.query(
      `insert into report_embeddings (source_table, source_id, section, embedding, source_text, model)
       values ($1, $2, $3, $4::vector, $5, $6)
       on conflict (source_table, source_id, section)
       do update set embedding = excluded.embedding, source_text = excluded.source_text, created_at = now()`,
      [sourceTable, id, section, vec, sections[section].substring(0, 4000), VOYAGE_MODEL]
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

  const sourceTable = body.source_table;
  if (!TABLE_CONFIG[sourceTable]) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "source_table must be 'scan_submissions' or 'inspections'" }) };
  }
  const config = TABLE_CONFIG[sourceTable];

  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });

  try {
    await client.connect();

    if (body.mode === 'single') {
      if (!body.id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id required' }) };
      }
      const res = await client.query(
        `select id, ${config.dataColumn} as data from ${sourceTable} where id = $1`,
        [body.id]
      );
      if (!res.rows.length) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'row not found' }) };
      }
      const result = await embedOneReport(client, sourceTable, res.rows[0].id, res.rows[0].data);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
    }

    if (body.mode === 'backfill') {
      const limit = Math.min(parseInt(body.limit) || 10, 25); // keep each call small — Netlify function timeout
      const pending = await client.query(
        `select s.id, s.${config.dataColumn} as data
         from ${sourceTable} s
         where s.${config.dataColumn} is not null
           and not exists (
             select 1 from report_embeddings e
             where e.source_table = $1 and e.source_id = s.id
           )
         order by s.${config.dateColumn} asc nulls last
         limit $2`,
        [sourceTable, limit]
      );

      const results = [];
      for (const row of pending.rows) {
        try {
          results.push(await embedOneReport(client, sourceTable, row.id, row.data));
        } catch (e) {
          results.push({ id: row.id, error: e.message });
        }
      }

      const remainingRes = await client.query(
        `select count(*)::int as n
         from ${sourceTable} s
         where s.${config.dataColumn} is not null
           and not exists (
             select 1 from report_embeddings e
             where e.source_table = $1 and e.source_id = s.id
           )`,
        [sourceTable]
      );

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ source_table: sourceTable, processed: results.length, results, remaining: remainingRes.rows[0].n }),
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
