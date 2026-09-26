// SanketRisk — Deploy pending — 2026-09-26 — New Netlify function: e2Value Pronto Commercial Lite
// replacement-cost integration. Builds the request XML, posts it as a URL-encoded form field
// (per e2Value support: Content-Type application/x-www-form-urlencoded, field name "xml"),
// and parses their XML response into a normalized JSON shape for scan.html/app.html to consume.
//
// SETUP REQUIRED before first use:
//   In Netlify site settings -> Environment variables, add:
//     E2VALUE_USERNAME = <the username e2Value gave you>
//     E2VALUE_PASSWORD = <the password e2Value gave you>
//   Do NOT hardcode these in this file or commit them to GitHub.
//
// Endpoint reference (from e2Value's Pronto Commercial Lite schema, Sept 2026):
//   POST https://evs.e2value.ca/evs/xml/1_0/p3c/default.aspx
//   Body: xml=<url-encoded XML>
//   e2Value's own notice: "Do not submit requests between 12-6 am EST. Limit calls to
//   10 TPS or WAF will block." — this function refuses the call itself between 12-6am
//   Eastern rather than let e2Value's WAF silently reject it.

const POSTING_URL = 'https://evs.e2value.ca/evs/xml/1_0/p3c/default.aspx';

// Full structuretype enum from e2Value's Pronto Commercial Lite schema (tSTRUCTURETYPE).
// This is the one field e2Value's schema marks as truly required alongside square footage
// and address, so we validate it strictly rather than let a typo reach their API as a
// silent mismatch.
const STRUCTURE_TYPES = [
  'Apartment','Auditorium','Auto, mini-lube','Auto, sales','Auto, service center',
  'Auto, service repair','Bakery','Bank, branch','Bar/Tavern','Beauty Salon/Barber Shop',
  'Bowling alley','Cannabis, bakery','Cannabis, cultivation/extraction','Cannabis, retail',
  'Car wash, automatic','Car wash, self service','Church','Cold storage facility',
  'College, dormitory','Community Center','Concession stand','Condominium',
  'Convenience market','Country club','Courthouse','Day care center',
  'Dispensary/urgent care','Dressing and shower facility','Fire station, paid',
  'Fire station, volunteer','Fraternal building','Funeral home','Garage, parking',
  'Garage, underground parking','Government building','Greenhouse',
  'Handball/racquetball club','Hangar, aircraft','Health club','Hemp drying facility',
  'Home improvement center','Hospital, convalescent','Hospital, general',
  'Hospital, veterinary','Hotel','Indoor tennis club','Jail','Laboratory','Laundromat',
  'Library, public','Manufacturing, heavy','Manufacturing, light','Medical office',
  'Mini-storage, steel','Motel','Multi-family residence','Multiple residence, elderly',
  'Office','Pavilion, open','Police station','Post office, branch','Post office, main',
  'Prison','Restaurant','Restaurant, fast food','Restroom building','Rink, hockey',
  'School, elementary','School, gymnasium','School, secondary','School, vocational',
  'Shopping center, strip','Social club','Store, department','Store, discount',
  'Store, retail','Supermarket','Surgical center','Swimming pool, enclosed',
  'Terminal, airport','Terminal, bus','Theater, movie','Warehouse',
  'Warehouse, self storage'
];

// Optional construction-detail enums (tCONSTRUCTIONQUALITY / tCONSTRUCTIONTYPE / tEXTERIOR /
// tROOFCOVERING). e2Value's own model does not require these — it infers construction from
// the occupancy code and address — so these are only validated if the caller supplies one
// (e.g. passing through a value SanketRisk already captured during a COPE inspection).
const CONSTRUCTION_QUALITY = ['Basic','Average','Above Average','Expensive','Very Expensive','Exceptional'];

// Canadian postal code, per e2Value's tPOSTALCODE pattern. Their province enum (tProvince) and
// this postal-code pattern are Canada-only in the current schema — flag for review if this
// function is ever reused for US properties.
const POSTAL_CODE_PATTERN = /^[A-Z][0-9][A-Z] [0-9][A-Z][0-9]$/;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// e2Value's stated blackout window is 12am-6am Eastern time, which shifts with EST/EDT.
// Using Intl with the America/New_York zone lets Node resolve the correct UTC offset for
// today's date automatically, rather than hardcoding UTC-5 and breaking every summer.
function isInE2ValueBlackoutWindow(now) {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false
  }).format(now || new Date());
  const hour = parseInt(hourStr, 10) % 24; // Intl can return "24" for midnight
  return hour >= 0 && hour < 6;
}

function parseCurrency(str) {
  if (str === undefined || str === null || str === '') return null;
  const cleaned = String(str).replace(/[$,]/g, '').trim();
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

// Extracts the text of the first <tagName>...</tagName> found, or null if absent/empty.
// A small dependency-free helper rather than pulling in an XML parsing library for a
// response shape this flat and well known.
function extractTag(xml, tagName) {
  const match = xml.match(new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>'));
  if (!match) return null;
  const text = match[1].trim();
  return text === '' ? null : text;
}

function extractAttr(xml, tagName, attrName) {
  const match = xml.match(new RegExp('<' + tagName + '[^>]*\\s' + attrName + '="([^"]*)"'));
  return match ? match[1] : null;
}

function extractCostTier(xml, tierTag) {
  const tierMatch = xml.match(new RegExp('<' + tierTag + '>([\\s\\S]*?)</' + tierTag + '>'));
  if (!tierMatch) return null;
  const block = tierMatch[1];
  return {
    costPerSqft: parseCurrency(extractTag(block, 'cost_per_sqft')),
    totalReplacementCost: parseCurrency(extractTag(block, 'total_replacement_cost'))
  };
}

// Parses e2Value's response XML into a normalized JSON shape. Field names/tags are taken
// from the actual sample response e2Value's support team sent back (Sept 2026) — there is
// no published response schema, so this is intentionally tolerant: every extractor returns
// null on a missing tag rather than throwing, so an unexpected e2Value response still comes
// back as a mostly-populated object instead of a hard failure.
function parseE2ValueResponse(xmlText) {
  const status = extractAttr(xmlText, 'response', 'status') || 'unknown';

  const result = {
    status: status,
    raw: xmlText,
    costDetails: {
      low: extractCostTier(xmlText, 'structure_cost_range_low'),
      med: extractCostTier(xmlText, 'structure_cost_range_med'),
      high: extractCostTier(xmlText, 'structure_cost_range_high')
    },
    constructionQuality: extractTag(xmlText, 'construction_quality'),
    constructionType: extractTag(xmlText, 'construction_type'),
    exterior: extractTag(xmlText, 'exterior'),
    roofCovering: extractTag(xmlText, 'roof_covering'),
    yearBuilt: extractTag(xmlText, 'year_built'),
    // Tag name for the returned ID is unconfirmed — e2Value support says adding
    // <ReturnPropertyID>Y</ReturnPropertyID> to the request returns it, but the sample
    // response they sent didn't include one. Trying both the request's own casing
    // (PropertyID) and a lowercase variant until a real response confirms which is used.
    propertyId: extractTag(xmlText, 'PropertyID') || extractTag(xmlText, 'propertyid') || extractTag(xmlText, 'property_id')
  };

  if (status !== 'success') {
    result.errorMessage = extractTag(xmlText, 'message') || extractTag(xmlText, 'error') || extractTag(xmlText, 'error_message');
  }

  return result;
}

// Builds the request XML in the exact element order e2Value's XSD specifies — some XML
// parsers are order-sensitive even when a schema marks fields optional, so this follows
// the schema's <xs:sequence> order rather than an arbitrary one.
function buildEstimateXml(input, credentials) {
  var lines = [];
  lines.push('<?xml version="1.0"?>');
  lines.push('<estimate username="' + escapeXml(credentials.username) + '" password="' + escapeXml(credentials.password) + '">');
  lines.push('  <property>');
  lines.push('    <structuretype>' + escapeXml(input.structureType) + '</structuretype>');
  lines.push('    <total_square_footage>' + escapeXml(input.totalSquareFootage) + '</total_square_footage>');
  lines.push('    <address1>' + escapeXml(input.address1) + '</address1>');
  if (input.address2) lines.push('    <address2>' + escapeXml(input.address2) + '</address2>');
  if (input.city) lines.push('    <city>' + escapeXml(input.city) + '</city>');
  lines.push('    <postalcode>' + escapeXml(input.postalCode) + '</postalcode>');
  if (input.coverageA !== undefined && input.coverageA !== null) lines.push('    <coverage_a>' + escapeXml(input.coverageA) + '</coverage_a>');
  if (input.constructionQuality) lines.push('    <construction_quality>' + escapeXml(input.constructionQuality) + '</construction_quality>');
  if (input.constructionType) lines.push('    <construction_type>' + escapeXml(input.constructionType) + '</construction_type>');
  if (input.exterior) lines.push('    <exterior>' + escapeXml(input.exterior) + '</exterior>');
  if (input.roofCovering) lines.push('    <roof_covering>' + escapeXml(input.roofCovering) + '</roof_covering>');
  if (input.propertyId) lines.push('    <PropertyID>' + escapeXml(input.propertyId) + '</PropertyID>');
  if (input.returnPropertyId) lines.push('    <ReturnPropertyID>Y</ReturnPropertyID>');
  lines.push('  </property>');
  lines.push('</estimate>');
  return lines.join('\n');
}

function validate(input) {
  var errors = [];
  if (!input || typeof input !== 'object') return ['Request body must be a JSON object.'];

  if (!input.structureType || STRUCTURE_TYPES.indexOf(input.structureType) === -1) {
    errors.push('structureType is required and must be one of e2Value\'s Pronto Commercial Lite structure types.');
  }
  if (!input.totalSquareFootage || !Number.isInteger(input.totalSquareFootage) || input.totalSquareFootage <= 0) {
    errors.push('totalSquareFootage is required and must be a positive whole number.');
  }
  if (!input.address1 || typeof input.address1 !== 'string' || input.address1.length > 150) {
    errors.push('address1 is required (max 150 characters).');
  }
  if (!input.postalCode || !POSTAL_CODE_PATTERN.test(input.postalCode)) {
    errors.push('postalCode is required and must be a Canadian postal code in "A1A 1A1" format.');
  }
  if (input.constructionQuality && CONSTRUCTION_QUALITY.indexOf(input.constructionQuality) === -1) {
    errors.push('constructionQuality, if provided, must be one of e2Value\'s recognized values.');
  }
  return errors;
}

exports.handler = async function (event) {
  const jsonHeaders = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed. Use POST.' }) };
  }

  const username = process.env.E2VALUE_USERNAME;
  const password = process.env.E2VALUE_PASSWORD;
  if (!username || !password) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'E2VALUE_USERNAME / E2VALUE_PASSWORD are not configured in Netlify environment variables.' }) };
  }

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Request body must be valid JSON.' }) };
  }

  const validationErrors = validate(input);
  if (validationErrors.length > 0) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Validation failed.', details: validationErrors }) };
  }

  if (isInE2ValueBlackoutWindow()) {
    return { statusCode: 503, headers: jsonHeaders, body: JSON.stringify({ error: 'e2Value asks that no requests be submitted between 12am and 6am Eastern time. Please try again after 6am ET.' }) };
  }

  // returnPropertyId defaults to true so a PropertyID is captured for later revisions
  // under the same credit (per e2Value: one credit covers revisions within the window).
  if (input.returnPropertyId === undefined) input.returnPropertyId = true;

  const requestXml = buildEstimateXml(input, { username: username, password: password });

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(POSTING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'xml=' + encodeURIComponent(requestXml)
    });
  } catch (networkErr) {
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'Could not reach e2Value.', details: networkErr.message }) };
  }

  const responseText = await upstreamResponse.text();

  if (!upstreamResponse.ok) {
    return {
      statusCode: 502,
      headers: jsonHeaders,
      body: JSON.stringify({ error: 'e2Value returned an error status.', httpStatus: upstreamResponse.status, raw: responseText })
    };
  }

  const parsed = parseE2ValueResponse(responseText);

  return {
    statusCode: parsed.status === 'success' ? 200 : 502,
    headers: jsonHeaders,
    body: JSON.stringify(parsed)
  };
};

// Exported for local/unit testing only — Netlify only calls exports.handler.
exports._internal = { buildEstimateXml, parseE2ValueResponse, validate, isInE2ValueBlackoutWindow, parseCurrency };
