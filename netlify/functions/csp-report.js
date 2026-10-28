// Receives browser Content-Security-Policy violation reports (REPORT-ONLY mode) and writes one short line
// per report to the Netlify function log. Public on purpose (browsers send reports without logging in);
// it stores nothing, only logs, and ignores anything large or malformed.
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 204, body: '' };
    const raw = (event.body || '').slice(0, 4000);
    let j = {}; try { j = JSON.parse(raw); } catch (e) { return { statusCode: 204, body: '' }; }
    const list = Array.isArray(j) ? j : [j];
    list.slice(0, 5).forEach(function (x) {
      const r = x['csp-report'] || x.body || x || {};
      const pick = function (v) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').slice(0, 200); };
      console.log('CSP-VIOLATION page=' + pick(r['document-uri'] || r.documentURL) +
        ' directive=' + pick(r['effective-directive'] || r['violated-directive'] || r.effectiveDirective) +
        ' blocked=' + pick(r['blocked-uri'] || r.blockedURL) +
        ' source=' + pick(r['source-file'] || r.sourceFile));
    });
  } catch (e) { /* never fail */ }
  return { statusCode: 204, body: '' };
};
