// netlify/functions/analytics-overview.js
// Fixed, deterministic portfolio-overview stats — NOT AI-generated SQL.
// This is the "ground truth" reference panel that sits alongside the
// natural-language query tool: same auth boundary and same read-only
// analytics_reader role, but every query here is hand-written and fixed,
// so there's nothing to validate the way analytics-query.js's AI-generated
// SQL needs validating. Purpose: let an admin cross-check what the AI
// summarizer says against a plain, unopinionated view of the same data.
//
// GET request, no body. Auth same as analytics-query.js.
//
// Environment variables required:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   (existing — session/access check)
//   ANALYTICS_DB_URL                     (existing — read-only role)

const { Client } = require('pg');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function verifyAccess(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { statusCode: 401, message: 'Missing or invalid Authorization header' };
  }
  const token = authHeader.slice(7);
  const userResp = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
    headers: { 'Authorization': 'Bearer ' + token, 'apikey': process.env.SUPABASE_SERVICE_KEY },
  });
  if (!userResp.ok) throw { statusCode: 401, message: 'Invalid or expired session' };
  const user = await userResp.json();

  const profResp = await fetch(
    process.env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user.id) + '&select=analytics_access',
    { headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY } }
  );
  const profiles = await profResp.json();
  if (!profiles || !profiles[0] || !profiles[0].analytics_access) {
    throw { statusCode: 403, message: 'Analytics access is not enabled for this account' };
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    await verifyAccess(event.headers.authorization || event.headers.Authorization);
  } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  const db = new Client({ connectionString: process.env.ANALYTICS_DB_URL });

  try {
    await db.connect();

    const [
      totals,
      riskQuality,
      occupancyTop,
      provinceTop,
      requestStatus,
      archiveStatus,
      avgScoresScan,
      avgScoresInsp,
      recentScans,
    ] = await Promise.all([
      db.query(`
        select
          (select count(*) from v_analytics_scan_submissions) as scan_submissions,
          (select count(*) from v_analytics_inspections) as inspections,
          (select count(*) from v_analytics_requests) as requests,
          (select count(*) from v_analytics_archived_files) as archived_files
      `),
      db.query(`
        select risk_quality, count(*) as n from (
          select risk_quality from v_analytics_scan_submissions where risk_quality is not null
          union all
          select risk_quality from v_analytics_inspections where risk_quality is not null
        ) t group by risk_quality order by n desc
      `),
      db.query(`
        select occ, count(*) as n from (
          select coalesce(ai_occupancy_class, occupancy) as occ from v_analytics_scan_submissions
          union all
          select occupancy_class as occ from v_analytics_inspections
        ) t where occ is not null group by occ order by n desc limit 10
      `),
      db.query(`
        select prov, count(*) as n from (
          select province as prov from v_analytics_scan_submissions
          union all
          select province_state as prov from v_analytics_inspections
        ) t where prov is not null group by prov order by n desc limit 10
      `),
      db.query(`select status, count(*) as n from v_analytics_requests group by status order by n desc`),
      db.query(`
        select coalesce(conversion_status, 'not yet converted') as status, count(*) as n
        from v_analytics_archived_files group by 1 order by n desc
      `),
      db.query(`
        select
          round(avg(score_construction)::numeric, 1) as construction,
          round(avg(score_protection)::numeric, 1) as protection,
          round(avg(score_safety)::numeric, 1) as safety,
          round(avg(score_overall)::numeric, 1) as overall,
          count(*) filter (where score_overall is not null) as n
        from v_analytics_scan_submissions
      `),
      db.query(`
        select
          round(avg(score_construction)::numeric, 2) as construction,
          round(avg(score_protection)::numeric, 2) as protection,
          round(avg(score_safety)::numeric, 2) as safety,
          round(avg(score_overall)::numeric, 2) as overall,
          count(*) filter (where score_overall is not null) as n
        from v_analytics_inspections
      `),
      db.query(`
        select insured_name, city, province, occupancy, risk_quality, score_overall, submitted_at
        from v_analytics_scan_submissions order by submitted_at desc nulls last limit 10
      `),
    ]);

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        status: 'ok',
        generated_at: new Date().toISOString(),
        totals: totals.rows[0],
        risk_quality_distribution: riskQuality.rows,
        top_occupancy_classes: occupancyTop.rows,
        top_provinces: provinceTop.rows,
        request_status: requestStatus.rows,
        archive_conversion_status: archiveStatus.rows,
        avg_scores_scan_submissions: avgScoresScan.rows[0],   // 0-100 scale
        avg_scores_inspections: avgScoresInsp.rows[0],        // 0-5 scale — do not compare directly
        recent_scan_submissions: recentScans.rows,
      }),
    };

  } catch (e) {
    console.error('analytics-overview error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  } finally {
    await db.end();
  }
};
