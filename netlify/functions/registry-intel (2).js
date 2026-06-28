// netlify/functions/registry-intel.js
// Sanket Registry Intel — server-side proxy for registry API calls
// Node.js 18+ has built-in fetch — no node-fetch required
// Place this file at: netlify/functions/registry-intel.js

exports.handler = async function(event) {
  var headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  var service  = body.service  || '';
  var insured  = body.insured  || '';
  var address  = body.address  || '';
  var city     = body.city     || '';
  var province = body.province || '';

  // ── Corporations Canada via OpenCorporates ──────────────────────────────
  if (service === 'corporations_canada') {
    if (!insured || insured.length < 2) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Business name required' }) };
    }

    try {
      // Try Canadian jurisdictions first
      var url = 'https://api.opencorporates.com/v0.4/companies/search' +
        '?q=' + encodeURIComponent(insured) +
        '&jurisdiction_code=ca&per_page=10&order=score';

      var resp = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'SanketRiskInspector/1.0' }
      });

      var data = resp.ok ? await resp.json() : { results: { companies: [] } };
      var results = (data.results && data.results.companies) || [];

      // If nothing found with ca jurisdiction, try without it
      if (!results.length) {
        var url2 = 'https://api.opencorporates.com/v0.4/companies/search' +
          '?q=' + encodeURIComponent(insured) + '&per_page=10&order=score';
        var resp2 = await fetch(url2, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'SanketRiskInspector/1.0' }
        });
        var data2 = resp2.ok ? await resp2.json() : { results: { companies: [] } };
        results = (data2.results && data2.results.companies) || [];
        // Filter to Canadian results only
        results = results.filter(function(r) {
          var jur = (r.company && r.company.jurisdiction_code) || '';
          return jur.startsWith('ca') || jur === 'ca';
        });
      }

      return {
        statusCode: 200, headers: headers,
        body: JSON.stringify({ service: 'corporations_canada', status: 'ok', results: results, total: results.length })
      };

    } catch(e) {
      return {
        statusCode: 200, headers: headers,
        body: JSON.stringify({ service: 'corporations_canada', status: 'error', message: e.message })
      };
    }
  }

  // ── BC Assessment ───────────────────────────────────────────────────────
  if (service === 'bc_assessment') {
    if (!address || !city) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Address and city required' }) };
    }

    try {
      var fullAddr = address + ' ' + city + ' BC Canada';
      var bcUrl = 'https://evaluebc.bcassessment.ca/api/address/suggest?q=' +
        encodeURIComponent(fullAddr) + '&maxResults=5';

      var bcResp = await fetch(bcUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'SanketRiskInspector/1.0' }
      });

      if (!bcResp.ok) {
        return {
          statusCode: 200, headers: headers,
          body: JSON.stringify({ service: 'bc_assessment', status: 'error', message: 'BC Assessment API HTTP ' + bcResp.status })
        };
      }

      var suggestions = await bcResp.json();
      if (!suggestions || !suggestions.length) {
        return {
          statusCode: 200, headers: headers,
          body: JSON.stringify({ service: 'bc_assessment', status: 'not_found', message: 'No property found for: ' + address + ', ' + city })
        };
      }

      // Try to fetch full property detail
      var folio = suggestions[0].pid || suggestions[0].rollNumber || suggestions[0].parcelId || suggestions[0].folioId || '';
      var property = null;
      if (folio) {
        var detailResp = await fetch('https://evaluebc.bcassessment.ca/api/property/' + encodeURIComponent(folio), {
          headers: { 'Accept': 'application/json', 'User-Agent': 'SanketRiskInspector/1.0' }
        });
        if (detailResp.ok) property = await detailResp.json();
      }

      return {
        statusCode: 200, headers: headers,
        body: JSON.stringify({ service: 'bc_assessment', status: 'ok', suggestion: suggestions[0], property: property })
      };

    } catch(e) {
      return {
        statusCode: 200, headers: headers,
        body: JSON.stringify({ service: 'bc_assessment', status: 'error', message: e.message })
      };
    }
  }

  return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Unknown service: ' + service }) };
};
