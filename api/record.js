/* Daily city snapshot — called by Vercel Cron (vercel.json) once per day.
   Captures full NYC state (buses, bikes, ferries, flights, weather, complete
   subway) and commits it to the repo's `data` branch via the GitHub API.
   Needs env: GH_DATA_TOKEN (fine-grained PAT, Contents read/write on this repo).
   Optional: CRON_SECRET (Vercel sends it as a Bearer token if configured). */
const REPO = 'davidfromkansas/manhattan-island';
const BRANCH = 'data';
const RETENTION_DAYS = 7;

const gh = async (method, path, body) => {
  const r = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + process.env.GH_DATA_TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'city-recorder',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 404) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + (j.message || ''));
  return { status: r.status, json: j };
};

module.exports = async (req, res) => {
  try {
    if (process.env.CRON_SECRET &&
        req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET)
      { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
    if (!process.env.GH_DATA_TOKEN)
      { res.statusCode = 503; return res.end('{"error":"GH_DATA_TOKEN not configured"}'); }

    const base = 'https://' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host);
    const get = async (p) => {
      try { const r = await fetch(base + p, { signal: AbortSignal.timeout(45000) }); return r.ok ? r.json() : null; }
      catch { return null; }
    };
    const [buses, bikes, ferries, flights, weather, subway, traffic, trafficEvents, birds] = await Promise.all([
      get('/api/buses'), get('/api/citibike'), get('/api/ferries'),
      get('/api/flights'), get('/api/weather'), get('/api/subway'),
      get('/api/traffic'), get('/api/traffic-events'), get('/api/birds')
    ]);
    const r5 = (v) => Math.round(v * 1e5) / 1e5;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const frame = {
      v: 1, t: now.toISOString(), kind: 'daily',
      weather: weather?.current ?? null,
      buses: (buses?.buses ?? []).map(b => [b.id.replace(/^[^_]*_/, ''), b.route, r5(b.lat), r5(b.lon),
        Math.round(b.bearing ?? -1), Math.round((b.speedMs ?? 0) * 10) / 10, b.dest || '']),
      bikes: (bikes?.stations ?? []).map(s => [s.id, s.bikes, s.ebikes, s.docks, s.on ? 1 : 0]),
      ferries: (ferries?.vessels ?? []).map(v => [v.id, v.label, r5(v.lat), r5(v.lon),
        Math.round(v.heading ?? -1), Math.round((v.speedMs ?? 0) * 10) / 10, v.route || '', v.headsign || '', v.docked ? 1 : 0]),
      flights: (flights?.ac ?? []).map(a => [a.hex, a.cs, r5(a.lat), r5(a.lon),
        Math.round(a.altM), Math.round(a.gsMs), Math.round(a.track)]),
      subway: subway ? { trips: subway.trips, vehStatus: subway.vehStatus } : null,
      // BirdCast (Cornell Lab) radar migration over Manhattan — 1 am snapshots catch peak hours
      birds: birds && typeof birds.aloft === 'number' ? { aloft: birds.aloft, dirDeg: birds.dirDeg,
        speedMs: birds.speedMs, hMeanM: birds.hMeanM, hMaxM: birds.hMaxM, night: !!birds.night, t: birds.t,
        passed: birds.passed ?? 0, pct: birds.pct ?? null, enabled: birds.enabled ?? null, boroughs: birds.boroughs ?? null } : null,
      // traffic records readings only — link geometry is re-fetched live at replay
      // time (same pattern as bike stations: the substrate churns far slower than the data)
      traffic: (traffic?.links ?? []).map(l => [l.id, l.speed, l.tt]),
      trafficEvents: (trafficEvents?.events ?? []).map(e => [e.id, e.kind, e.sev,
        e.road || '', e.dir || '', r5(e.lat), r5(e.lon), e.desc || '']),
      schema: {
        buses: 'id,route,lat,lon,bearing,speedMs,dest',
        bikes: 'stationId,bikes,ebikes,docks,on',
        ferries: 'id,label,lat,lon,heading,speedMs,route,headsign,docked',
        flights: 'hex,callsign,lat,lon,altM,gsMs,track',
        traffic: 'linkId,speedMph,travelTimeS',
        trafficEvents: 'id,kind,severity,road,direction,lat,lon,desc'
      }
    };

    // write data/daily/<day>.json (contents API needs the existing sha to overwrite)
    const path = 'data/daily/' + day + '.json';
    const existing = await gh('GET', `/repos/${REPO}/contents/${path}?ref=${BRANCH}`);
    await gh('PUT', `/repos/${REPO}/contents/${path}`, {
      message: 'daily snapshot ' + day, branch: BRANCH,
      content: Buffer.from(JSON.stringify(frame)).toString('base64'),
      ...(existing.status === 200 ? { sha: existing.json.sha } : {})
    });

    // prune beyond retention + refresh the manifest
    const dir = await gh('GET', `/repos/${REPO}/contents/data/daily?ref=${BRANCH}`);
    const files = Array.isArray(dir.json) ? dir.json : [];
    const cutoff = Date.now() - (RETENTION_DAYS + 1) * 86400_000;
    const kept = [];
    for (const f of files) {
      const m = f.name.match(/^(\d{4})-(\d{2})-(\d{2})\.json$/);
      if (!m) continue;
      if (Date.UTC(+m[1], +m[2] - 1, +m[3]) < cutoff)
        await gh('DELETE', `/repos/${REPO}/contents/${f.path}`, { message: 'prune ' + f.name, branch: BRANCH, sha: f.sha });
      else kept.push('daily/' + f.name);
    }
    kept.sort();
    const manPath = 'data/manifest.json';
    const man = await gh('GET', `/repos/${REPO}/contents/${manPath}?ref=${BRANCH}`);
    await gh('PUT', `/repos/${REPO}/contents/${manPath}`, {
      message: 'manifest ' + day, branch: BRANCH,
      content: Buffer.from(JSON.stringify({ v: 1, updated: now.toISOString(), retentionDays: RETENTION_DAYS, daily: kept, frames: [] })).toString('base64'),
      ...(man.status === 200 ? { sha: man.json.sha } : {})
    });

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, day, counts: {
      buses: frame.buses.length, bikes: frame.bikes.length, ferries: frame.ferries.length,
      flights: frame.flights.length, subwayTrips: frame.subway ? frame.subway.trips.length : 0,
      traffic: frame.traffic.length, trafficEvents: frame.trafficEvents.length }, kept }));
  } catch (e) {
    console.error('[record]', e.message || e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
