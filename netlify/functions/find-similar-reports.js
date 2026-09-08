// netlify/functions/find-similar-reports.js
// Given one already-embedded report (scan_submissions or inspections),
// finds its nearest neighbors per COPE section across BOTH tables, and
// flags a simple grade deviation for QA pre-review use.
//
// POST body:
//   {
//     source_table: 'scan_submissions' | 'inspections',
//     id: '<uuid>',            // the report to find neighbors for
//     k: 5,                    // optional, neighbors per section (default 5, max 10)
//     cross_table: true        // optional, false = only search within source_table
//   }
//
// The target report must already be embedded (via embed-report.js) —
// this function reads existing vectors, it doesn't create new ones.
//
// Environment variables required:
//   SUPABASE_DB_URL   (direct Postgres connection — needed for the
//                      pgvector <=> distance operator)

const { Client } = require('pg');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Per-table metadata + normalized-score lookup ──
// scan_submissions scores are 0-100; inspections scores are 0-5. Both are
// normalized to 0-1 here so a deviation check can compare across tables.
async function fetchMetadata(client, sourceTable, ids) {
  if (!ids.length) return {};
  const out = {};

  if (sourceTable === 'scan_submissions') {
    const res = await client.query(
      `select id, insured_name, city, province, occupancy, scan_result
       from scan_submissions where id = any($1::uuid[])`,
      [ids]
    );
    res.rows.forEach(row => {
      let r = {};
      try { r = typeof row.scan_result === 'string' ? JSON.parse(row.scan_result) : (row.scan_result || {}); } catch (e) {}
      const overall = parseFloat(r.score_overall);
      // A raw score of exactly 0 is treated as missing rather than real —
      // seen in practice paired with risk_quality "Acceptable", which is
      // an impossible combination for a genuinely 0/100 property. That
      // pairing means the field was never populated for these rows
      // (likely older or archive-converted reports), not an actual score.
      const hasScore = !isNaN(overall) && overall !== 0;
      out[row.id] = {
        insured_name: row.insured_name, city: row.city, province: row.province, occupancy: row.occupancy,
        risk_label: r.risk_quality || null,
        overall_score_raw: hasScore ? overall : null,
        overall_score_normalized: hasScore ? overall / 100 : null,
      };
    });
  }

  if (sourceTable === 'inspections') {
    const res = await client.query(
      `select id, insured_name, city, province_state as province, occupancy_class as occupancy, risk_quality, form_data
       from inspections where id = any($1::uuid[])`,
      [ids]
    );
    res.rows.forEach(row => {
      let fd = {};
      try { fd = typeof row.form_data === 'string' ? JSON.parse(row.form_data) : (row.form_data || {}); } catch (e) {}
      const overall = parseFloat(fd.scores && fd.scores.overall);
      const hasScore = !isNaN(overall) && overall !== 0;
      out[row.id] = {
        insured_name: row.insured_name, city: row.city, province: row.province, occupancy: row.occupancy,
        risk_label: row.risk_quality || null,
        overall_score_raw: hasScore ? overall : null,
        overall_score_normalized: hasScore ? overall / 5 : null,
      };
    });
  }

  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const sourceTable = body.source_table;
  if (!['scan_submissions', 'inspections'].includes(sourceTable)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "source_table must be 'scan_submissions' or 'inspections'" }) };
  }
  if (!body.id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id required' }) };
  }
  const k = Math.min(parseInt(body.k) || 5, 10);
  const crossTable = body.cross_table !== false; // default true

  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });

  try {
    await client.connect();

    // Target's own embeddings, one row per section
    const targetRes = await client.query(
      `select section, embedding from report_embeddings where source_table = $1 and source_id = $2`,
      [sourceTable, body.id]
    );
    if (!targetRes.rows.length) {
      return {
        statusCode: 404, headers: CORS,
        body: JSON.stringify({ error: 'This report has no embeddings yet — call embed-report (mode: single) first.' }),
      };
    }

    const sections = {};
    const allNeighborIdsByTable = { scan_submissions: new Set(), inspections: new Set() };

    for (const row of targetRes.rows) {
      const section = row.section;
      const query = crossTable
        ? `select e.source_table, e.source_id, e.embedding <=> $1::vector as distance
           from report_embeddings e
           where e.section = $2
             and not (e.source_table = $3 and e.source_id = $4)
           order by e.embedding <=> $1::vector asc
           limit $5`
        : `select e.source_table, e.source_id, e.embedding <=> $1::vector as distance
           from report_embeddings e
           where e.section = $2 and e.source_table = $3
             and not (e.source_table = $3 and e.source_id = $4)
           order by e.embedding <=> $1::vector asc
           limit $5`;
      const qParams = [row.embedding, section, sourceTable, body.id, k];

      const nbrRes = await client.query(query, qParams);
      sections[section] = nbrRes.rows.map(n => ({
        source_table: n.source_table,
        source_id: n.source_id,
        distance: parseFloat(n.distance), // cosine distance — 0 = identical, 2 = opposite
      }));
      nbrRes.rows.forEach(n => allNeighborIdsByTable[n.source_table].add(n.source_id));
    }

    // Fetch metadata for target + all neighbors, batched per table
    const scanIds = Array.from(allNeighborIdsByTable.scan_submissions);
    const inspIds = Array.from(allNeighborIdsByTable.inspections);
    const [scanMeta, inspMeta, targetMetaWrap] = await Promise.all([
      fetchMetadata(client, 'scan_submissions', scanIds),
      fetchMetadata(client, 'inspections', inspIds),
      fetchMetadata(client, sourceTable, [body.id]),
    ]);
    const metaByTable = { scan_submissions: scanMeta, inspections: inspMeta };
    const targetMeta = targetMetaWrap[body.id] || {};

    // Attach metadata to each neighbor, and compute a per-section score
    // comparison. Every section gets an entry in score_comparison — even
    // when there wasn't enough scored data to compare — so the caller can
    // tell "checked, no deviation" apart from "couldn't check, too few
    // scored neighbors." That distinction matters here specifically:
    // the vast majority of embedded reports are archive conversions with
    // no AI-generated score at all, so most similarity searches will turn
    // up few or zero scored neighbors, and silently omitting a flag in
    // that case would read as a false "all clear."
    const MIN_SCORED_NEIGHBORS = 2;
    const DEVIATION_THRESHOLD = 0.2; // >20 points on a 100-scale, or >1 point on a 5-scale

    const deviationFlags = [];
    const scoreComparison = {};

    Object.keys(sections).forEach(section => {
      sections[section] = sections[section].map(n => ({
        ...n,
        ...(metaByTable[n.source_table][n.source_id] || {}),
      }));

      const hasTargetScore = targetMeta.overall_score_normalized !== null && targetMeta.overall_score_normalized !== undefined;
      const neighborScores = sections[section]
        .map(n => n.overall_score_normalized)
        .filter(s => s !== null && s !== undefined);

      if (!hasTargetScore) {
        scoreComparison[section] = { available: false, reason: 'target report has no score' };
        return;
      }
      if (neighborScores.length < MIN_SCORED_NEIGHBORS) {
        scoreComparison[section] = {
          available: false,
          reason: 'too few scored neighbors to compare',
          scored_neighbor_count: neighborScores.length,
          total_neighbor_count: sections[section].length,
        };
        return;
      }

      const avg = neighborScores.reduce((a, b) => a + b, 0) / neighborScores.length;
      const diff = targetMeta.overall_score_normalized - avg;
      const deviates = Math.abs(diff) > DEVIATION_THRESHOLD;
      scoreComparison[section] = {
        available: true,
        target_score_normalized: targetMeta.overall_score_normalized,
        neighbor_avg_normalized: Math.round(avg * 1000) / 1000,
        scored_neighbor_count: neighborScores.length,
        total_neighbor_count: sections[section].length,
        deviates,
        direction: deviates ? (diff > 0 ? 'higher_than_similar_past_reports' : 'lower_than_similar_past_reports') : null,
      };
      if (deviates) {
        deviationFlags.push({
          section,
          target_score_normalized: targetMeta.overall_score_normalized,
          neighbor_avg_normalized: scoreComparison[section].neighbor_avg_normalized,
          direction: scoreComparison[section].direction,
          neighbor_count: neighborScores.length,
        });
      }
    });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        target: { source_table: sourceTable, id: body.id, ...targetMeta },
        sections,
        score_comparison: scoreComparison,
        deviation_flags: deviationFlags,
      }),
    };

  } catch (e) {
    console.error('find-similar-reports error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  } finally {
    await client.end();
  }
};
