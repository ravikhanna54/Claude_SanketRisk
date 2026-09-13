// netlify/functions/analytics-query.js
// Natural-language analytics query: question -> SQL -> execute -> narrative.
//
// SAFETY ARCHITECTURE (read this before changing anything below):
//   1. Claude only ever sees the schema of three curated views — never
//      the real table names or structure.
//   2. The generated SQL is validated defensively before execution:
//      must be a single SELECT, no write/DDL keywords, no semicolons,
//      and every FROM/JOIN target must be one of the three whitelisted
//      views by exact name.
//   3. Execution happens through `analytics_reader` — a Postgres role
//      with SELECT-only grants on exactly those three views and nothing
//      else. Even if steps 1-2 somehow failed, this role is physically
//      incapable of writing to anything or reading any other table.
//   4. Every request requires a valid Supabase session AND
//      profiles.analytics_access = true — checked fresh on every call,
//      not just at page load.
//
// POST body: { question: "which occupancy classes had the most sprinkler
//               deficiencies last quarter?" }
// Header: Authorization: Bearer <supabase access token>
//
// Environment variables required:
//   ANTHROPIC_API_KEY   (existing)
//   SUPABASE_URL          (existing)
//   SUPABASE_SERVICE_KEY  (existing — used ONLY to verify the caller's
//                          session and check analytics_access; never used
//                          to run the generated query itself)
//   ANALYTICS_DB_URL      (new — connection string for the analytics_reader
//                          role, see 001_analytics_foundation.sql)

const { Client } = require('pg');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';

const ALLOWED_VIEWS = ['v_analytics_scan_submissions', 'v_analytics_inspections', 'v_analytics_requests'];

const SCHEMA_DESCRIPTION = `
You may query ONLY these three views. Do not reference any other table or view under any circumstances.

v_analytics_scan_submissions (one row per SCAN ONE submission):
  id uuid, insured_name text, city text, province text, occupancy text,
  status text, qa_status text, submitted_at timestamptz, source text,
  construction_class text, ai_occupancy_class text, risk_quality text,
  uw_recommendation text, sprinkler_type text, confidence text,
  score_construction numeric, score_protection numeric,
  score_safety numeric, score_overall numeric
  -- scores are 0-100. confidence = 'Historical' means an archive-converted
  -- legacy report, not a live photo-based analysis.

v_analytics_inspections (one row per manual COPE inspection):
  id uuid, inspection_id text, insured_name text, address text, city text,
  province_state text, occupancy_class text, inspector_name text,
  report_status text, risk_quality text, inspection_date date,
  updated_at timestamptz,
  score_construction numeric, score_protection numeric,
  score_safety numeric, score_overall numeric
  -- scores are 0-5 here, NOT 0-100 — do not compare directly against
  -- v_analytics_scan_submissions scores without normalizing (divide this
  -- table's scores by 5, or the other table's by 100, to compare fairly).

v_analytics_requests (one row per inspection request from the public portal):
  id uuid, request_ref text, status text, urgency text, occupancy_type text,
  purpose text, line_of_business text, city text, province text,
  submitted_at timestamptz, preferred_date date, assigned_to text,
  report_format text
`;

async function verifyAccess(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { statusCode: 401, message: 'Missing or invalid Authorization header' };
  }
  const token = authHeader.slice(7);

  const userResp = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
    headers: {
      'Authorization': 'Bearer ' + token,
      'apikey': process.env.SUPABASE_SERVICE_KEY,
    },
  });
  if (!userResp.ok) throw { statusCode: 401, message: 'Invalid or expired session' };
  const user = await userResp.json();

  const profResp = await fetch(
    process.env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user.id) + '&select=analytics_access,full_name',
    { headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY } }
  );
  const profiles = await profResp.json();
  const profile = profiles && profiles[0];
  if (!profile || !profile.analytics_access) {
    throw { statusCode: 403, message: 'Analytics access is not enabled for this account' };
  }
  return { userId: user.id, name: profile.full_name || user.email };
}

// Defensive validation — the real safety net alongside the read-only DB role.
function validateSql(sql) {
  let s = sql.trim();
  if (s.endsWith(';')) s = s.slice(0, -1).trim();
  if (s.includes(';')) throw new Error('Multiple statements are not allowed');
  if (!/^select\s/i.test(s)) throw new Error('Only SELECT statements are allowed');

  const forbidden = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|exec|execute|call|do|vacuum|analyze|comment|listen|notify|reindex|refresh)\b/i;
  if (forbidden.test(s)) throw new Error('Query contains a disallowed keyword');
  if (/--|\/\*/.test(s)) throw new Error('Comments are not allowed in the generated query');

  // Every FROM/JOIN target must be an exact match to a whitelisted view
  const tableRefs = [...s.matchAll(/\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)].map(m => m[1].toLowerCase());
  if (!tableRefs.length) throw new Error('Query does not reference any table');
  for (const t of tableRefs) {
    if (!ALLOWED_VIEWS.includes(t)) throw new Error('Query references a table that is not allowed: ' + t);
  }

  if (!/\blimit\s+\d+/i.test(s)) s = s + ' LIMIT 500';
  return s;
}

async function callClaude(system, userMsg, maxTokens) {
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error('Anthropic API: ' + data.error.message);
  return data.content[0].text;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!body.question || !body.question.trim()) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'question is required' }) };
  }

  let access;
  try {
    access = await verifyAccess(event.headers.authorization || event.headers.Authorization);
  } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  const dbClient = new Client({ connectionString: process.env.ANALYTICS_DB_URL });

  try {
    // ── Step 1: question -> SQL ──
    const sqlSystemPrompt =
      'You translate insurance-analytics questions into a single read-only PostgreSQL SELECT statement.\n' +
      SCHEMA_DESCRIPTION +
      '\nRules:\n' +
      '- Output ONLY the raw SQL. No markdown fences, no explanation, no comments.\n' +
      '- If the question is too ambiguous to write a sensible query (e.g. an undefined date range or an undefined metric), ' +
      'instead output exactly: CLARIFY: <one short question to ask the user>\n' +
      '- Prefer aggregate queries (COUNT, AVG, GROUP BY) over dumping raw rows when the question asks for a pattern or trend.\n' +
      '- Today\'s date is ' + new Date().toISOString().slice(0, 10) + '.';

    const rawSql = (await callClaude(sqlSystemPrompt, body.question, 500)).trim();

    if (rawSql.toUpperCase().startsWith('CLARIFY:')) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ status: 'clarify', question: rawSql.slice(8).trim() }),
      };
    }

    let sql;
    try {
      sql = validateSql(rawSql);
    } catch (e) {
      console.error('Rejected generated SQL:', rawSql, '—', e.message);
      return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: 'Could not safely execute this query: ' + e.message }) };
    }

    // ── Step 2: execute against the read-only role ──
    await dbClient.connect();
    const result = await dbClient.query(sql);

    // ── Step 3: results -> plain-English narrative ──
    const sampleRows = result.rows.slice(0, 50);
    const narrativeSystemPrompt =
      'You summarize insurance-portfolio analytics query results in 2-4 concise sentences of plain English for an underwriting executive. ' +
      'State the key finding directly. Mention specific numbers from the data. Do not restate the question. Do not use markdown.';
    const narrativeUserMsg =
      'Question: ' + body.question + '\n\n' +
      'Query returned ' + result.rowCount + ' row(s). Sample data:\n' +
      JSON.stringify(sampleRows, null, 0);

    let narrative = '';
    try {
      narrative = (await callClaude(narrativeSystemPrompt, narrativeUserMsg, 300)).trim();
    } catch (e) {
      narrative = '(Narrative summary unavailable: ' + e.message + ')';
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        status: 'ok',
        question: body.question,
        sql: sql,
        columns: result.fields.map(f => f.name),
        rows: result.rows,
        row_count: result.rowCount,
        narrative: narrative,
        queried_by: access.name,
      }),
    };

  } catch (e) {
    console.error('analytics-query error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  } finally {
    await dbClient.end();
  }
};
