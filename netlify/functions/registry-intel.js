// netlify/functions/registry-intel.js
// Sanket Registry Intel — server-side proxy for registry API calls
// Avoids CORS restrictions on browser direct API calls.
// Deploy to: netlify/functions/registry-intel.js

exports.handler = async function(event, context) {
  var headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  var body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch(e) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  var service  = body.service  || '';
  var insured  = body.insured  || '';
  var address  = body.address  || '';
  var city     = body.city     || '';
  var province = body.province || '';

  // ── Corporations Canada via OpenCorporates ─────────────────────────────────
  if (service === 'corporations_canada') {
    if (!insured || insured.length < 2) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Business name required' }) };
    }

    var fetch = require('node-fetch');

    // Search Canadian companies — try federal + provincial jurisdictions
    var searchUrl = 'https://api.opencorporates.com/v0.4/companies/search' +
      '?q=' + encodeURIComponent(insured) +
      '&jurisdiction_code=ca' +
      '&per_page=10' +
      '&order=score';

    var resp = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SanketRiskInspector/1.0'
      }
    });

    if (!resp.ok) {
      // Try without jurisdiction filter
      var searchUrl2 = 'https://api.opencorporates.com/v0.4/companies/search' +
        '?q=' + encodeURIComponent(insured) +
        '&per_page=10&order=score';
      resp = await fetch(searchUrl2, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'SanketRiskInspector/1.0' }
      });
    }

    if (!resp.ok) {
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({ service: 'corporations_canada', status: 'error', message: 'OpenCorporates returned HTTP ' + resp.status })
      };
    }

    var data = await resp.json();
    var results = (data.results && data.results.companies) || [];

    // Filter to Canadian jurisdictions only
    var caResults = results.filter(function(r) {
      var jur = (r.company && r.company.jurisdiction_code) || '';
      return jur.startsWith('ca') || jur === '';
    });

    if (!caResults.length && results.length) caResults = results; // fallback to all results

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        service: 'corporations_canada',
        status: 'ok',
        results: caResults,
        total: caResults.length
      })
    };
  }

  // ── BC Assessment ──────────────────────────────────────────────────────────
  if (service === 'bc_assessment') {
    if (!address || !city) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Address and city required' }) };
    }

    var fetch = require('node-fetch');
    var fullAddress = address + ' ' + city + ' BC';

    // BC Assessment eValue API
    var bcUrl = 'https://evaluebc.bcassessment.ca/api/address/suggest?q=' +
      encodeURIComponent(fullAddress) + '&maxResults=5';

    var bcResp = await fetch(bcUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SanketRiskInspector/1.0'
      }
    });

    if (!bcResp.ok) {
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({ service: 'bc_assessment', status: 'error', message: 'BC Assessment API returned HTTP ' + bcResp.status })
      };
    }

    var suggestions = await bcResp.json();

    if (!suggestions || !suggestions.length) {
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({ service: 'bc_assessment', status: 'not_found', message: 'No property found for: ' + address + ', ' + city })
      };
    }

    // Try to get full property details
    var folio = suggestions[0].pid || suggestions[0].rollNumber || suggestions[0].parcelId || suggestions[0].folioId;
    var property = null;

    if (folio) {
      var detailUrl = 'https://evaluebc.bcassessment.ca/api/property/' + encodeURIComponent(folio);
      var detailResp = await fetch(detailUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'SanketRiskInspector/1.0' }
      });
      if (detailResp.ok) {
        property = await detailResp.json();
      }
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        service: 'bc_assessment',
        status: 'ok',
        suggestion: suggestions[0],
        property: property,
        all_suggestions: suggestions
      })
    };
  }

  return {
    statusCode: 400,
    headers: headers,
    body: JSON.stringify({ error: 'Unknown service: ' + service })
  };
};
