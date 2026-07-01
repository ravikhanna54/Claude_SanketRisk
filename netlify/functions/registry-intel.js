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

  var service     = body.service     || '';
  var insured     = body.insured     || '';
  var address     = body.address     || '';
  var city        = body.city        || '';
  var province    = body.province    || '';
  var fullAddress = body.fullAddress || '';

  // ── Google Geocoding + Building Outlines + Places API ──────────────────────
  if (service === 'google_geocode') {
    if (!fullAddress) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'fullAddress required' }) };
    }
    var GMAPS_KEY = 'AIzaSyDAHNS9_C-NLzVhAUDhD9HfSP-7X-xTVkI';
    try {
      // Try 1: Geocoding API with BUILDING_AND_ENTRANCES (Preview — limited rural coverage)
      var gUrl = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
        encodeURIComponent(fullAddress) + '&extra_computations=BUILDING_AND_ENTRANCES&key=' + GMAPS_KEY;
      var gR = await httpsGet(gUrl);
      var gData = {};
      try { gData = JSON.parse(gR.text); } catch(e) {}

      if (gData.status !== 'OK' || !gData.results || !gData.results.length) {
        return {
          statusCode: 200, headers: headers,
          body: JSON.stringify({ service: 'google_geocode', status: 'not_found', message: gData.status || 'No results' })
        };
      }

      var gRes = gData.results[0];
      var lat = gRes.geometry.location.lat;
      var lon = gRes.geometry.location.lng;
      var footprintAreaSqM = null;
      var footprintSource = null;

      // Check for building outline from BUILDING_AND_ENTRANCES
      var buildings = gRes.buildings || (gRes.geometry && gRes.geometry.buildings) || null;
      if (buildings && buildings.length && buildings[0].building_outlines && buildings[0].building_outlines.length) {
        var outline = buildings[0].building_outlines[0].display_polygon;
        if (outline && outline.coordinates && outline.coordinates[0]) {
          var pts = outline.coordinates[0];
          var R = 6378137;
          var area = 0;
          for (var i = 0; i < pts.length - 1; i++) {
            var p1 = pts[i], p2 = pts[i+1];
            var x1 = p1[0] * Math.PI / 180 * R * Math.cos(p1[1] * Math.PI / 180);
            var y1 = p1[1] * Math.PI / 180 * R;
            var x2 = p2[0] * Math.PI / 180 * R * Math.cos(p2[1] * Math.PI / 180);
            var y2 = p2[1] * Math.PI / 180 * R;
            area += (x1 * y2 - x2 * y1);
          }
          footprintAreaSqM = Math.abs(area / 2);
          footprintSource = 'Google Building Outlines';
        }
      }

      // Try 2: Places API (New) — has richer geometry for commercial properties
      if (!footprintAreaSqM) {
        try {
          var placeUrl = 'https://places.googleapis.com/v1/places:searchText';
          var placeBody = JSON.stringify({ textQuery: fullAddress, maxResultCount: 1 });
          var placeR = await new Promise(function(resolve, reject) {
            var options = {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GMAPS_KEY,
                'X-Goog-FieldMask': 'places.id,places.location,places.viewport,places.addressComponents'
              }
            };
            var req = require('https').request('https://places.googleapis.com/v1/places:searchText', options, function(res) {
              var d = '';
              res.on('data', function(c){ d += c; });
              res.on('end', function(){ resolve({ status: res.statusCode, text: d }); });
            });
            req.on('error', reject);
            req.write(placeBody);
            req.end();
          });

          var pData = {};
          try { pData = JSON.parse(placeR.text); } catch(e) {}

          if (pData.places && pData.places.length) {
            var place = pData.places[0];
            var vp = place.viewport;
            if (vp && vp.high && vp.low) {
              // Estimate building area from viewport bounds (reasonable for single-building queries)
              var latDiff = Math.abs(vp.high.latitude - vp.low.latitude);
              var lonDiff = Math.abs(vp.high.longitude - vp.low.longitude);
              var R2 = 6378137;
              var heightM = latDiff * Math.PI / 180 * R2;
              var widthM  = lonDiff * Math.PI / 180 * R2 * Math.cos(lat * Math.PI / 180);
              var vpArea = heightM * widthM;
              // Viewport includes some padding — building is typically ~60% of viewport
              // Only use if viewport suggests a single building (under 10,000 m²)
              if (vpArea > 50 && vpArea < 10000) {
                footprintAreaSqM = vpArea * 0.6;
                footprintSource = 'Google Places (viewport estimate)';
              }
            }
            // Override lat/lon with Places result if more precise
            if (place.location) {
              lat = place.location.latitude;
              lon = place.location.longitude;
            }
          }
        } catch(pErr) { /* Places API failed — continue with geocode lat/lon */ }
      }

      return {
        statusCode: 200, headers: headers,
        body: JSON.stringify({
          service: 'google_geocode', status: 'ok',
          lat: lat, lon: lon,
          footprintAreaSqM: footprintAreaSqM,
          footprintSource: footprintSource
        })
      };

    } catch(e) {
      return {
        statusCode: 200, headers: headers,
        body: JSON.stringify({ service: 'google_geocode', status: 'error', message: e.message })
      };
    }
  }

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
