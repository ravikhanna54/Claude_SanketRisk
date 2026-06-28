// netlify/functions/registry-intel.js
// Sanket Registry Intel — server-side proxy for registry API calls
// Uses Node.js built-in https module — no dependencies required
// Place at: netlify/functions/registry-intel.js

const https = require('https');

function httpsGet(url) {
  return new Promise(function(resolve, reject) {
    var options = {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SanketRiskInspector/1.0'
      }
    };
    https.get(url, options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        resolve({ status: res.statusCode, text: data });
      });
    }).on('error', function(e) {
      reject(e);
    });
  });
}

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
      // Search Canadian jurisdictions
      var url1 = 'https://api.opencorporates.com/v0.4/companies/search' +
        '?q=' + encodeURIComponent(insured) +
        '&jurisdiction_code=ca&per_page=10&order=score';

      var r1 = await httpsGet(url1);
      var data1 = { results: { companies: [] } };
      try { data1 = JSON.parse(r1.text); } catch(e) {}
      var results = (data1.results && data1.results.companies) || [];

      // If no results, try without jurisdiction filter
      if (!results.length) {
        var url2 = 'https://api.opencorporates.com/v0.4/companies/search' +
          '?q=' + encodeURIComponent(insured) + '&per_page=10&order=score';
        var r2 = await httpsGet(url2);
        var data2 = { results: { companies: [] } };
        try { data2 = JSON.parse(r2.text); } catch(e) {}
        var allResults = (data2.results && data2.results.companies) || [];
        // Filter to Canadian only
        results = allResults.filter(function(r) {
          var jur = (r.company && r.company.jurisdiction_code) || '';
          return jur.startsWith('ca');
        });
      }

      return {
        statusCode: 200, headers: headers,
        body: JSON.stringify({
          service: 'corporations_canada',
          status: 'ok',
          results: results,
          total: results.length,
          debug: 'OpenCorporates query for: ' + insured
        })
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

      var bcR = await httpsGet(bcUrl);
      var suggestions = [];
      try { suggestions = JSON.parse(bcR.text); } catch(e) {}

      if (!suggestions || !suggestions.length) {
        return {
          statusCode: 200, headers: headers,
          body: JSON.stringify({
            service: 'bc_assessment',
            status: 'not_found',
            message: 'No property found for: ' + address + ', ' + city
          })
        };
      }

      var folio = suggestions[0].pid || suggestions[0].rollNumber ||
                  suggestions[0].parcelId || suggestions[0].folioId || '';
      var property = null;

      if (folio) {
        var detailUrl = 'https://evaluebc.bcassessment.ca/api/property/' + encodeURIComponent(folio);
        var detailR = await httpsGet(detailUrl);
        try { property = JSON.parse(detailR.text); } catch(e) {}
      }

      return {
        statusCode: 200, headers: headers,
        body: JSON.stringify({
          service: 'bc_assessment',
          status: 'ok',
          suggestion: suggestions[0],
          property: property
        })
      };

    } catch(e) {
      return {
        statusCode: 200, headers: headers,
        body: JSON.stringify({ service: 'bc_assessment', status: 'error', message: e.message })
      };
    }
  }

  return {
    statusCode: 400, headers: headers,
    body: JSON.stringify({ error: 'Unknown service: ' + service })
  };
};
