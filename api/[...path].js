/* Vercel serverless catch-all for /api/* — thin adapter over lib/api-core.js.
   Warm Fluid Compute instances keep the in-memory caches (flights tokens,
   ferry static GTFS, route negatives) alive between invocations; a cold
   start just refetches, same as a local server restart. */
const { handleApi } = require('../lib/api-core');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    await handleApi(url.pathname, res);
  } catch (e) {
    console.error(new Date().toISOString(), 'request error:', e.message || e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal' }));
  }
};
