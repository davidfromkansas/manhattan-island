/* ============================================================
   lib/agent-core.js — "City Concierge": a sandboxed LLM agent
   over the twin's own data. POST /api/agent {messages, context?}
   → {reply, camera|null, layers|null, timeline|null}. Zero deps.

   Sandbox model: the LLM never touches the scene or the network
   directly. It gets READ-ONLY tools — live feeds via api-core's
   cached routes in-process (same TTLs/last-good as the client),
   the baked street graph + building footprints from disk, and
   recorded history — plus three intent-shaped tools (set_camera,
   show_layer, set_timeline) whose outputs are not executed here:
   they are validated, returned to the browser, and applied
   client-side (camTween / layer renderer / timeline.set).

   COORDINATE SPACES (deliberate — IRON RULE 1 is never violated
   by this file): live feeds speak lat/lon; the baked street graph
   and buildings are already-calibrated SCENE METERS. This module
   does all substrate math in scene space and never re-implements
   the geo→scene calibration. The bridge between spaces is
   geocode_intersection (street names → scene node) and the
   client's viewer context; set_camera and layer points accept
   either space and the browser converts lat/lon via subway.geoRaw.

   LLM transport: Vercel AI Gateway's Anthropic-compatible
   endpoint via raw fetch (no SDK — this repo stays zero-dep).
   Auth (first hit wins): AI_GATEWAY_API_KEY env · git-ignored
   ai-gateway-key.json {"key":"..."} · OIDC (env / x-vercel-oidc-
   token request header on deployments / .env.local from
   `vercel env pull`). Missing key degrades gracefully: friendly
   503, nothing crashes. NEVER log, commit, or echo key material.
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const { routes, handleApi, sendJSON } = require('./api-core');
const agentLog = require('./agent-log');

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/messages';
const MODEL = 'anthropic/claude-sonnet-4.6';
const MAX_TOKENS = 1000;     // per reply — bounds worst-case spend
const MAX_ROUNDS = 8;        // tool-use loop cap
const TOOL_RESULT_CAP = 7000; // chars per tool result fed back to the model
const MAX_LAYERS = 3;        // layer intents per turn

function gatewayKey(req) {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai-gateway-key.json'), 'utf8'));
    if (j.key) return j.key;
  } catch { /* fall through */ }
  if (process.env.VERCEL_OIDC_TOKEN) return process.env.VERCEL_OIDC_TOKEN;
  // deployed Vercel functions receive the OIDC token per-request, not as an env var
  if (req && req.headers && req.headers['x-vercel-oidc-token']) return req.headers['x-vercel-oidc-token'];
  try { // local dev: `vercel env pull` drops VERCEL_OIDC_TOKEN into .env.local
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const m = env.match(/^VERCEL_OIDC_TOKEN="?([^"\n]+)"?$/m);
    if (m) return m[1];
  } catch { /* no key: degrade gracefully */ }
  return null;
}

/* ---------- in-process read of api-core's cached routes ----------
   Same freshness/last-good semantics as serveCached, minus the res. */
async function readFeed(routePath) {
  const entry = routes.get(routePath);
  if (!entry) throw new Error('unknown feed ' + routePath);
  const fresh = entry.data !== null && Date.now() - entry.fetchedAt < entry.ttl;
  if (!fresh) {
    if (!entry.refreshing) {
      entry.refreshing = entry.fetcher()
        .then(data => { entry.data = data; entry.fetchedAt = Date.now(); })
        .catch(e => console.error(new Date().toISOString(), '[agent] feed fetch failed:', e.message || e))
        .finally(() => { entry.refreshing = null; });
    }
    await entry.refreshing;
  }
  return entry.data ?? entry.empty;
}

/* ---------- geo + generic row query pipeline ---------- */
const EARTH = 6371000;
function distM(la1, lo1, la2, lo2) { // haversine, meters
  const p = Math.PI / 180, dl = (la2 - la1) * p, dn = (lo2 - lo1) * p;
  const s = Math.sin(dl / 2) ** 2 + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin(dn / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(s));
}
const hit = (s, f) => !f || String(s || '').toLowerCase().includes(f);
/* filter → near → sort → top. Rows may carry lat/lon (live feeds) —
   `near {lat,lon,radius_m}` annotates dist_m and sorts nearest-first. */
function applyQuery(rows, q, searchOf) {
  const f = q.filter ? String(q.filter).toLowerCase() : '';
  let out = f ? rows.filter(r => hit(searchOf(r), f)) : rows.slice();
  if (q.near && isFinite(q.near.lat) && isFinite(q.near.lon)) {
    const rad = Math.min(Math.max(Number(q.near.radius_m) || 500, 50), 8000);
    out = out.filter(r => typeof r.lat === 'number');
    for (const r of out) r.dist_m = Math.round(distM(q.near.lat, q.near.lon, r.lat, r.lon));
    out = out.filter(r => r.dist_m <= rad).sort((a, b) => a.dist_m - b.dist_m);
  }
  if (q.sort_by && out.length && typeof out[0][q.sort_by] === 'number') {
    const dir = q.descending === false ? 1 : -1; // rankings default biggest-first
    out.sort((a, b) => (a[q.sort_by] - b[q.sort_by]) * dir);
  }
  const top = Math.min(Math.max(1, Number(q.top) || Number(q.limit) || 25), 200);
  return { matched: out.length, rows: out.slice(0, top) };
}

/* ---------- live feeds, normalized to labeled lat/lon rows ----------
   label doubles as the map-pin text when a layer is built from the feed. */
const FEEDS = {
  flights: { route: '/api/flights',
    rows: d => (d.ac || []).map(a => ({ label: a.cs || a.hex, callsign: a.cs, hex: a.hex, lat: a.lat, lon: a.lon,
      altM: Math.round(a.altM), speedMs: Math.round(a.gsMs), track: Math.round(a.track), type: a.catLabel || undefined })),
    search: r => r.callsign + ' ' + r.hex + ' ' + (r.type || ''),
    summary: d => ({ source: d.source, airborneTotal: (d.ac || []).length }) },
  subway_stations: { route: '/api/subway/stations',
    rows: d => (d.rows || []).map(r => ({ label: r.stop_name || r.name || '', routes: r.daytime_routes || r.line || '',
      lat: parseFloat(r.gtfs_latitude ?? r.latitude), lon: parseFloat(r.gtfs_longitude ?? r.longitude), borough: r.borough || '' }))
      .filter(r => r.label && isFinite(r.lat)),
    search: r => r.label + ' ' + r.routes + ' ' + r.borough,
    summary: d => ({ totalStations: (d.rows || []).length }) },
  ferries: { route: '/api/ferries',
    rows: d => (d.vessels || []).map(v => ({ label: v.label, route: v.route, headsign: v.headsign, lat: v.lat, lon: v.lon,
      speedMs: v.speedMs, nextStop: v.next, nextEtaMin: v.nextEtaMin, docked: v.docked })),
    search: r => r.label + ' ' + r.route + ' ' + (r.headsign || '') + ' ' + (r.nextStop || ''),
    summary: d => ({ vesselsTotal: (d.vessels || []).length }) },
  buses: { route: '/api/buses',
    rows: d => (d.buses || []).map(b => ({ label: b.route + (b.dest ? ' → ' + b.dest : ''), id: b.id, route: b.route,
      dest: b.dest, lat: b.lat, lon: b.lon, speedMs: b.speedMs })),
    search: r => r.route + ' ' + (r.dest || ''),
    summary: d => { const by = {}; for (const b of d.buses || []) by[b.route] = (by[b.route] || 0) + 1;
      return { busesTotal: (d.buses || []).length, busesByRoute: by }; } },
  citibike: { route: '/api/citibike',
    rows: d => (d.stations || []).map(s => ({ label: s.name, lat: s.lat, lon: s.lon, bikes: s.bikes, ebikes: s.ebikes,
      docks: s.docks, capacity: s.cap, active: s.on })),
    search: r => r.label,
    summary: d => { let bikes = 0, ebikes = 0, docks = 0;
      for (const s of d.stations || []) { bikes += s.bikes; ebikes += s.ebikes; docks += s.docks; }
      return { stationsTotal: (d.stations || []).length, citywide: { bikes, ebikes, docks } }; } },
  cams: { route: '/api/cams',
    rows: d => (d.cams || []).map(c => ({ label: c.name, area: c.area, lat: c.lat, lon: c.lon, id: c.id })),
    search: r => r.label + ' ' + (r.area || ''),
    summary: d => ({ camsTotal: (d.cams || []).length }) },
  traffic: { route: '/api/traffic',
    rows: d => (d.links || []).map(l => { const m = l.pts && l.pts.length ? l.pts[Math.floor(l.pts.length / 2)] : null;
      return { label: l.name + ' · ' + l.speed + ' mph', name: l.name, borough: l.borough,
        speedMph: l.speed, travelTimeS: l.tt, lat: m ? m[0] : undefined, lon: m ? m[1] : undefined, id: l.id }; }),
    search: r => r.name + ' ' + r.borough,
    summary: d => { const by = {}; for (const l of d.links || []) { (by[l.borough] ||= { n: 0, s: 0 }); by[l.borough].n++; by[l.borough].s += l.speed; }
      return { linksTotal: (d.links || []).length,
        avgSpeedMphByBorough: Object.fromEntries(Object.entries(by).map(([b, v]) => [b, Math.round(v.s / v.n * 10) / 10])) }; } },
  traffic_events: { route: '/api/traffic-events',
    rows: d => (d.events || []).map(e => ({ label: (e.kind === 'closure' ? 'CLOSURE ' : 'INCIDENT ') + (e.road || ''),
      kind: e.kind, severity: e.sev, road: e.road, direction: e.dir, lat: e.lat, lon: e.lon, desc: e.desc })),
    search: r => r.road + ' ' + r.kind + ' ' + (r.desc || ''),
    summary: d => ({ eventsTotal: (d.events || []).length }) }
};
async function feedQuery(input) {
  const feed = input && input.feed;
  if (feed === 'weather') { const d = await readFeed('/api/weather'); return { source: d.source, current: d.current }; }
  if (feed === 'birds') return await readFeed('/api/birds');
  if (feed === 'subway') return await subwayQuery(input);
  const def = FEEDS[feed];
  if (!def) return { error: 'unknown feed' };
  const d = await readFeed(def.route);
  const { matched, rows } = applyQuery(def.rows(d), input, def.search);
  return { ...def.summary(d), matched, rows };
}
async function subwayQuery(input) { // trips have no usable lat/lon — route-level view
  const d = await readFeed('/api/subway');
  const byRoute = {}; const nowS = Date.now() / 1000;
  for (const t of d.trips || []) byRoute[t.route] = (byRoute[t.route] || 0) + 1;
  const out = { activeTrips: (d.trips || []).length, tripsByRoute: byRoute };
  const f = input.filter ? String(input.filter).toLowerCase() : '';
  if (f) {
    let names = new Map();
    try {
      const st = await readFeed('/api/subway/stations');
      for (const r of st.rows || []) { const id = r.gtfs_stop_id || r.stop_id; if (id) names.set(String(id), r.stop_name || ''); }
    } catch { /* ids only */ }
    const rows = (d.trips || []).filter(t => t.route.toLowerCase() === f);
    out.matchedRoute = f.toUpperCase();
    out.trips = rows.slice(0, Math.min(Math.max(1, Number(input.top) || 15), 30)).map(t => {
      const next = (t.stus || []).find(s => s[1] >= nowS - 30);
      return { tripId: t.tid, nextStop: next ? (names.get(next[0].replace(/[NS]$/, '')) || next[0]) : null,
        etaMin: next ? Math.max(0, Math.round((next[1] - nowS) / 60)) : null,
        stopped: d.vehStatus && d.vehStatus[t.tid] === 1 };
    });
  }
  return out;
}

/* ---------- baked substrate: street graph + buildings (scene meters) ----------
   Lazy singleton; disk locally, self-fetch of the deployed static files on
   Vercel (the function bundle doesn't carry public/). ~50 MB heap once loaded,
   warm Fluid instances keep it. */
async function readPublicJSON(name) { // baked assets: disk locally / the deployed static file on Vercel
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8')); }
  catch {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    if (!host) throw new Error(name + ' unavailable');
    const r = await fetch('https://' + host + '/' + name, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(name + ' http ' + r.status);
    return await r.json();
  }
}
let SUB = null, subLoading = null;
function substrate() {
  if (SUB) return Promise.resolve(SUB);
  if (subLoading) return subLoading;
  subLoading = (async () => {
    const [bj, sj] = await Promise.all([readPublicJSON('buildings.json'), readPublicJSON('streets.json')]);
    const B = { n: bj.n, x: Float32Array.from(bj.x), z: Float32Array.from(bj.z),
      h: Float32Array.from(bj.h), bin: Int32Array.from(bj.bin) };
    const nameIdx = new Map(); // normalized street name → edge indexes
    sj.edges.forEach((e, i) => { const k = normSt(e.nm); if (!nameIdx.has(k)) nameIdx.set(k, []); nameIdx.get(k).push(i); });
    SUB = { B, nodes: sj.nodes, edges: sj.edges, nameIdx };
    console.log('[agent] substrate loaded:', B.n, 'buildings,', sj.edges.length, 'edges');
    return SUB;
  })().catch(e => { subLoading = null; throw e; });
  return subLoading;
}
const BORO = ['', 'Manhattan', 'Bronx', 'Brooklyn', 'Queens', 'Staten Island'];
const ORD = { FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6, SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10, ELEVENTH: 11, TWELFTH: 12 };
const ABBR = { STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', ROAD: 'RD', DRIVE: 'DR', PLACE: 'PL', PARKWAY: 'PKWY',
  SQUARE: 'SQ', TERRACE: 'TER', LANE: 'LN', COURT: 'CT', HIGHWAY: 'HWY', EXPRESSWAY: 'EXPY', PLAZA: 'PLZ', BRIDGE: 'BR' };
function normSt(s) { // "West 45th Street" → "W 45 ST" (CSCL house style)
  let t = String(s || '').toUpperCase().replace(/[.,']/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  t = t.map(w => ABBR[w] || (ORD[w] != null ? String(ORD[w]) : w.replace(/^(\d+)(ST|ND|RD|TH)$/, '$1')));
  if (t.length >= 3 && ['WEST', 'EAST', 'NORTH', 'SOUTH'].includes(t[0])) t[0] = t[0][0];
  return t.join(' ');
}
function edgesByName(S, name, boFilter) {
  const key = normSt(name);
  let idx = S.nameIdx.get(key);
  if (!idx) { // fallback: substring either way, shortest key wins
    let best = null;
    for (const k of S.nameIdx.keys())
      if (k.includes(key) || key.includes(k)) { if (!best || k.length < best.length) best = k; }
    if (best) idx = S.nameIdx.get(best);
  }
  if (!idx) return [];
  return boFilter ? idx.filter(i => S.edges[i].bo === boFilter) : idx;
}
function boCode(name) { const i = BORO.findIndex(b => b && b.toLowerCase() === String(name || '').toLowerCase()); return i > 0 ? i : 0; }
async function geocodeIntersection(input) {
  const S = await substrate();
  const bo = boCode(input.borough);
  const ea = edgesByName(S, input.street_a, bo), eb = edgesByName(S, input.street_b, bo);
  if (!ea.length || !eb.length)
    return { error: 'street not found: ' + (!ea.length ? input.street_a : input.street_b) + ' — use NYC CSCL style like "7 AVE", "W 45 ST", "BROADWAY"' };
  const aNodes = new Set();
  for (const i of ea) { aNodes.add(S.edges[i].a); aNodes.add(S.edges[i].b); }
  const hits = [];
  for (const i of eb) { if (aNodes.has(S.edges[i].a)) hits.push(S.edges[i].a); if (aNodes.has(S.edges[i].b)) hits.push(S.edges[i].b); }
  if (!hits.length) return { error: 'streets exist but do not intersect' + (bo ? ' in ' + BORO[bo] : '') };
  // dual carriageways yield node clusters — average everything near the first hit
  const n0 = S.nodes[hits[0]]; let sx = 0, sz = 0, n = 0;
  for (const h of new Set(hits)) { const nd = S.nodes[h];
    if (Math.hypot(nd[0] - n0[0], nd[1] - n0[1]) < 300) { sx += nd[0]; sz += nd[1]; n++; } }
  return { sx: Math.round(sx / n), sz: Math.round(sz / n),
    borough: BORO[S.edges[ea[0]].bo] || '', note: 'scene meters — usable as set_camera/layer/query anchor' };
}
async function resolveAnchor(input) { // {sx,sz} | {street_a,street_b[,borough]} → scene point
  if (input && isFinite(input.sx) && isFinite(input.sz)) return { sx: Number(input.sx), sz: Number(input.sz) };
  if (input && input.street_a && input.street_b) {
    const g = await geocodeIntersection(input);
    return g.error ? g : { sx: g.sx, sz: g.sz };
  }
  return { error: 'anchor needs {sx,sz} or {street_a,street_b}' };
}
async function queryBuildings(input) {
  const S = await substrate();
  const minH = Math.max(0, Number(input.min_height_m) || 0);
  let sx = null, sz = null, rad = 0;
  if (input.anchor) {
    const a = await resolveAnchor(input.anchor);
    if (a.error) return a;
    sx = a.sx; sz = a.sz; rad = Math.min(Math.max(Number(input.radius_m) || 600, 50), 5000);
  } else if (minH < 80) {
    return { error: 'citywide scans need min_height_m >= 80, or provide an anchor {sx,sz | street_a+street_b} + radius_m' };
  }
  const { B } = S;
  let count = 0, maxH = 0, sumH = 0;
  const top = [];
  const keep = Math.min(Math.max(1, Number(input.top) || 10), 200);
  for (let i = 0; i < B.n; i++) {
    const h = B.h[i];
    if (h < minH) continue;
    if (sx !== null && Math.hypot(B.x[i] - sx, B.z[i] - sz) > rad) continue;
    count++; sumH += h; if (h > maxH) maxH = h;
    if (top.length < keep) { top.push(i); if (top.length === keep) top.sort((a, b) => B.h[b] - B.h[a]); }
    else if (h > B.h[top[keep - 1]]) { top[keep - 1] = i; top.sort((a, b) => B.h[b] - B.h[a]); }
  }
  if (top.length < keep) top.sort((a, b) => B.h[b] - B.h[a]);
  return { count, maxHeightM: Math.round(maxH), meanHeightM: count ? Math.round(sumH / count) : 0,
    tallest: top.map(i => ({ sx: Math.round(B.x[i]), sz: Math.round(B.z[i]), height_m: Math.round(B.h[i]), bin: B.bin[i] })) };
}
async function streetSegments(name, borough) { // scene-space polyline segments for layer highlighting
  const S = await substrate();
  const idx = edgesByName(S, name, boCode(borough));
  if (!idx.length) return null;
  const segs = [];
  for (const i of idx) {
    const p = S.edges[i].p;
    for (let k = 0; k < p.length - 1 && segs.length < 900; k++) segs.push([p[k][0], p[k][1], p[k + 1][0], p[k + 1][1]]);
  }
  return segs;
}

/* ---------- borough + neighborhood boundaries (public/boundaries.json) ----------
   5 NYC boroughs + 262 real 2020 NTA neighborhoods, as [lon,lat] rings. Kept in
   geographic coords (client converts to scene via subway.geoRaw — IRON RULE 1);
   the agent reasons in lat/lon here. Powers where_is context and boundary layers. */
const bnorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
let BND = null, bndLoading = null;
function boundaries() {
  if (BND) return Promise.resolve(BND);
  if (bndLoading) return bndLoading;
  bndLoading = (async () => {
    const d = await readPublicJSON('boundaries.json');
    BND = { boroughs: d.boroughs, neighborhoods: d.neighborhoods };
    console.log('[agent] boundaries loaded:', d.boroughs.length, 'boroughs,', d.neighborhoods.length, 'neighborhoods');
    return BND;
  })().catch(e => { bndLoading = null; throw e; });
  return bndLoading;
}
function pointInRings(lon, lat, rings) { // ray cast; inside ANY ring of a (multi)polygon
  for (const ring of rings) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-18) + xi)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
async function whereIs(input) {
  const lat = Number(input && input.lat), lon = Number(input && input.lon);
  if (!isFinite(lat) || !isFinite(lon)) return { error: 'lat, lon required' };
  const B = await boundaries();
  let borough = null, neighborhood = null, kind = null;
  for (const b of B.boroughs) if (pointInRings(lon, lat, b.rings)) { borough = b.name; break; }
  for (const n of B.neighborhoods) if (pointInRings(lon, lat, n.rings)) { neighborhood = n.name; kind = n.kind; if (!borough) borough = n.boro; break; }
  if (!borough && !neighborhood) return { borough: null, neighborhood: null, note: 'point is outside the mapped city (water or beyond NYC)' };
  return { borough, neighborhood, neighborhood_kind: kind === 'special' ? 'park/airport/cemetery' : (neighborhood ? 'residential' : null) };
}
async function findRegion(type, name) { // fuzzy: exact norm match, else shortest name containing/contained
  const B = await boundaries();
  const pool = type === 'borough' ? B.boroughs : B.neighborhoods;
  const q = bnorm(name);
  let exact = null, best = null;
  for (const reg of pool) {
    const rn = bnorm(reg.name);
    if (rn === q) { exact = reg; break; }
    if (rn.includes(q) || q.includes(rn)) { if (!best || reg.name.length < best.name.length) best = reg; }
  }
  return exact || best || null;
}

/* ---------- spatial_report: buffer/coverage counts around anchors ---------- */
async function spatialReport(input) {
  const anchors = Array.isArray(input.anchors) ? input.anchors.slice(0, 25) : null;
  if (!anchors || !anchors.length) return { error: 'anchors: [{lat,lon,label?} | {sx,sz,label?}] required (max 25)' };
  const rad = Math.min(Math.max(Number(input.radius_m) || 300, 50), 3000);
  if (input.feed === 'buildings') {
    const S = await substrate(); const { B } = S;
    const minH = Math.max(0, Number(input.min_height_m) || 0);
    const report = [];
    for (const a of anchors) {
      if (!isFinite(a.sx) || !isFinite(a.sz)) { report.push({ label: a.label || '?', error: 'buildings anchors need scene {sx,sz} (geocode_intersection gives them)' }); continue; }
      let count = 0, maxH = 0;
      for (let i = 0; i < B.n; i++) {
        if (B.h[i] < minH) continue;
        if (Math.hypot(B.x[i] - a.sx, B.z[i] - a.sz) <= rad) { count++; if (B.h[i] > maxH) maxH = B.h[i]; }
      }
      report.push({ label: a.label || `(${a.sx},${a.sz})`, count, maxHeightM: Math.round(maxH) });
    }
    return { radius_m: rad, report };
  }
  const def = FEEDS[input.feed];
  if (!def) return { error: 'feed must be one of ' + Object.keys(FEEDS).join('/') + ' or buildings' };
  const rows = def.rows(await readFeed(def.route)).filter(r => typeof r.lat === 'number');
  const report = [];
  for (const a of anchors) {
    if (!isFinite(a.lat) || !isFinite(a.lon)) { report.push({ label: a.label || '?', error: 'live-feed anchors need {lat,lon}' }); continue; }
    let count = 0, nearest = null, nd = Infinity;
    for (const r of rows) {
      const d = distM(a.lat, a.lon, r.lat, r.lon);
      if (d <= rad) count++;
      if (d < nd) { nd = d; nearest = r.label; }
    }
    report.push({ label: a.label || `(${a.lat.toFixed(4)},${a.lon.toFixed(4)})`, count, nearest, nearest_m: Math.round(nd) });
  }
  return { radius_m: rad, report };
}

/* ---------- layer materialization (server builds, client renders) ---------- */
const PALETTE = ['amber', 'cyan', 'ember', 'green', 'violet', 'white'];
async function buildLayer(input) {
  const title = String(input.title || 'layer').slice(0, 40);
  const color = PALETTE.includes(input.color) ? input.color : 'amber';
  const layer = { title, color, points: [], segs: [], rings: [], regions: [], fit: input.fit !== false };
  const src = input.source || {};
  if (src.feed) {
    const res = await feedQuery({ ...src, top: Math.min(Number(src.top) || 120, 200) });
    if (res.error) return res;
    for (const r of res.rows || []) if (typeof r.lat === 'number')
      layer.points.push({ lat: r.lat, lon: r.lon, label: String(r.label || '').slice(0, 48) });
  } else if (src.buildings) {
    const res = await queryBuildings({ ...src.buildings, top: Math.min(Number(src.buildings.top) || 30, 200) });
    if (res.error) return res;
    for (const b of res.tallest) layer.points.push({ sx: b.sx, sz: b.sz, label: b.height_m + ' m · BIN ' + b.bin });
  } else if (src.street) {
    const segs = await streetSegments(src.street.name, src.street.borough);
    if (!segs) return { error: 'street not found: ' + src.street.name };
    layer.segs = segs;
  } else if (src.boundary) {
    const type = src.boundary.type === 'borough' ? 'borough' : 'neighborhood';
    const reg = await findRegion(type, src.boundary.name);
    if (!reg) return { error: type + ' not found: ' + src.boundary.name };
    layer.regions.push({ name: reg.name, rings: reg.rings }); // [lon,lat] rings — client converts via geoRaw
    if (title === 'layer') layer.title = reg.name;
  } else if (Array.isArray(src.points)) {
    for (const p of src.points.slice(0, 60)) {
      if (isFinite(p.lat) && isFinite(p.lon)) layer.points.push({ lat: +p.lat, lon: +p.lon, label: String(p.label || '').slice(0, 48) });
      else if (isFinite(p.sx) && isFinite(p.sz)) layer.points.push({ sx: +p.sx, sz: +p.sz, label: String(p.label || '').slice(0, 48) });
    }
  } else return { error: 'source needs feed | buildings | street | boundary | points' };
  for (const r of (Array.isArray(input.rings) ? input.rings.slice(0, 24) : [])) {
    const radius = Math.min(Math.max(Number(r.radius_m) || 250, 30), 5000);
    if (isFinite(r.lat) && isFinite(r.lon)) layer.rings.push({ lat: +r.lat, lon: +r.lon, radius_m: radius });
    else if (isFinite(r.sx) && isFinite(r.sz)) layer.rings.push({ sx: +r.sx, sz: +r.sz, radius_m: radius });
  }
  layer.points = layer.points.slice(0, 200);
  if (!layer.points.length && !layer.segs.length && !layer.rings.length && !layer.regions.length) return { error: 'layer came out empty — adjust the query' };
  return { layer, ok: true, points: layer.points.length, segments: layer.segs.length, rings: layer.rings.length,
    regions: layer.regions.map(r => r.name), sample: layer.points.slice(0, 5).map(p => p.label) };
}

/* ---------- tools ---------- */
const NYC = { latMin: 40.45, latMax: 41.05, lonMin: -74.35, lonMax: -73.55 };
const SCENE = { xMin: -15000, xMax: 24000, zMin: -10000, zMax: 25500 };
const PRESETS = ['hero', 'downtown', 'canyon', 'park', 'bridges', 'gwb'];
const TOOLS = [
  { name: 'get_data',
    description: 'Read a live data feed. filter = case-insensitive substring on names/routes/callsigns (feed=subway: exact route letter like "A"). near {lat,lon,radius_m} keeps rows within radius, adds dist_m, sorts nearest-first. sort_by = any numeric row field (speedMph, bikes, altM, dist_m…), biggest-first unless descending:false. top caps rows.',
    input_schema: { type: 'object', properties: {
      feed: { type: 'string', enum: [...Object.keys(FEEDS), 'subway', 'weather', 'birds'] },
      filter: { type: 'string' },
      near: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, radius_m: { type: 'number' } } },
      sort_by: { type: 'string' }, descending: { type: 'boolean' }, top: { type: 'integer' } }, required: ['feed'] } },
  { name: 'get_history',
    description: 'Recorded daily snapshots (last ~7 days, one frame per day ~05:05 UTC). No args → list of days. With day (YYYY-MM-DD) → weather + counts; add feed (buses|bikes|ferries|flights|traffic|trafficEvents) for sample rows (returned schema names the columns).',
    input_schema: { type: 'object', properties: { day: { type: 'string' }, feed: { type: 'string' } } } },
  { name: 'geocode_intersection',
    description: 'Street names → scene-meter point (the baked street graph). Use NYC CSCL style: "BROADWAY", "7 AVE", "W 45 ST", "WALL ST". This is THE bridge for landmarks: pick the nearest intersection you know (Times Square ≈ BROADWAY + W 45 ST). Result {sx,sz} anchors query_buildings, buildings layers/reports, and set_camera.',
    input_schema: { type: 'object', properties: { street_a: { type: 'string' }, street_b: { type: 'string' },
      borough: { type: 'string', enum: ['Manhattan', 'Bronx', 'Brooklyn', 'Queens'] } }, required: ['street_a', 'street_b'] } },
  { name: 'query_buildings',
    description: '304,911 real building footprints (scene meters, real heights, BIN ids). anchor {sx,sz} or {street_a,street_b} + radius_m scopes the scan; min_height_m filters; citywide scans (no anchor) need min_height_m>=80. Returns count/max/mean + tallest list.',
    input_schema: { type: 'object', properties: {
      anchor: { type: 'object', properties: { sx: { type: 'number' }, sz: { type: 'number' }, street_a: { type: 'string' }, street_b: { type: 'string' }, borough: { type: 'string' } } },
      radius_m: { type: 'number' }, min_height_m: { type: 'number' }, top: { type: 'integer' } } } },
  { name: 'spatial_report',
    description: 'Buffer/coverage counts: how many <feed> entities lie within radius_m of EACH anchor (max 25). Live feeds need {lat,lon} anchors; feed="buildings" needs scene {sx,sz} anchors (+optional min_height_m). Returns per-anchor count + nearest. Pair with show_layer rings to visualize the buffers.',
    input_schema: { type: 'object', properties: {
      feed: { type: 'string' }, radius_m: { type: 'number' }, min_height_m: { type: 'number' },
      anchors: { type: 'array', items: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' },
        sx: { type: 'number' }, sz: { type: 'number' }, label: { type: 'string' } } } } }, required: ['feed', 'anchors'] } },
  { name: 'where_is',
    description: 'Name the borough and 2020-NTA neighborhood containing a lat/lon point (e.g. to answer "what neighborhood is the Brooklyn Bridge in"). The [viewer context] already carries the neighborhood the camera is currently over, so only call this for a DIFFERENT point.',
    input_schema: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } }, required: ['lat', 'lon'] } },
  { name: 'show_layer',
    description: 'Draw a result layer on the 3D map: pins + labels, street polylines, buffer rings, or the real outline of a borough/neighborhood (source.boundary). The server materializes source queries — do NOT copy rows into points by hand when a source query can produce them. Max 3 layers per turn; a new turn\'s layers replace the old ones. fit:false keeps the camera still.',
    input_schema: { type: 'object', properties: {
      title: { type: 'string' }, color: { type: 'string', enum: PALETTE },
      source: { type: 'object', properties: {
        feed: { type: 'string' }, filter: { type: 'string' },
        near: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, radius_m: { type: 'number' } } },
        sort_by: { type: 'string' }, descending: { type: 'boolean' }, top: { type: 'integer' },
        buildings: { type: 'object', properties: { anchor: { type: 'object' }, radius_m: { type: 'number' }, min_height_m: { type: 'number' }, top: { type: 'integer' } } },
        street: { type: 'object', properties: { name: { type: 'string' }, borough: { type: 'string' } } },
        boundary: { type: 'object', description: 'outline a real region', properties: { type: { type: 'string', enum: ['borough', 'neighborhood'] }, name: { type: 'string', description: 'e.g. "Bronx", "Williamsburg", "Upper East Side" (2020 NTA names; fuzzy-matched)' } } },
        points: { type: 'array', items: { type: 'object' } } } },
      rings: { type: 'array', items: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' },
        sx: { type: 'number' }, sz: { type: 'number' }, radius_m: { type: 'number' } } } },
      fit: { type: 'boolean' } }, required: ['title', 'source'] } },
  { name: 'set_camera',
    description: 'Fly the user\'s 3D camera. Use preset when one fits; else a lat/lon target (your NYC knowledge is fine) or scene {sx,sz} (from geocode_intersection/query_buildings). altitude_m: ~250 street, ~500 landmark, ~1200 neighborhood, 4000+ borough. heading_deg: compass bearing the camera looks TOWARD (avenues run ~29°E of N; 20–30 reads up the island). A glowing boundary is drawn around the framed area automatically on any coordinate zoom; set highlight_radius_m to match the real size of the place you name (e.g. Times Square ~450, Central Park ~1600, a whole neighborhood ~1200), or 0 to suppress the outline. Skip heading when show_layer fit already frames the result. At most one call per user request.',
    input_schema: { type: 'object', properties: {
      preset: { type: 'string', enum: PRESETS, description: 'hero=full island, downtown=harbor, canyon=midtown, park=Central Park, bridges=East River, gwb=George Washington Bridge' },
      lat: { type: 'number' }, lon: { type: 'number' }, sx: { type: 'number' }, sz: { type: 'number' },
      altitude_m: { type: 'number' }, heading_deg: { type: 'number' },
      highlight_radius_m: { type: 'number', description: 'radius in meters of the area to outline; 0 = no outline' },
      duration_s: { type: 'number' }, label: { type: 'string' } } } },
  { name: 'set_timeline',
    description: 'Scrub the whole city back in time. scrub_min = negative minutes before now for the moment the user ASKED for (e.g. "3 days ago" → -4320); the client snaps city data to the nearest recorded daily snapshot automatically — never adjust the minutes yourself to match the archive. scrub_min 0 is ONLY for "back to live".',
    input_schema: { type: 'object', properties: { scrub_min: { type: 'number' } }, required: ['scrub_min'] } }
];

function validCamera(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.preset && PRESETS.includes(c.preset)) return { preset: c.preset, label: c.label || c.preset };
  const cl = (v, a, b, d) => { v = Number(v); return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  const base = { altitude_m: cl(c.altitude_m, 80, 16000, 600),
    heading_deg: ((cl(c.heading_deg, -360, 720, 25) % 360) + 360) % 360,
    duration_s: cl(c.duration_s, 1, 6, 2.6), label: String(c.label || '').slice(0, 60) };
  if (isFinite(Number(c.highlight_radius_m))) base.highlight_radius_m = Math.min(6000, Math.max(0, Number(c.highlight_radius_m))); // 0 = suppress the outline
  const sx = Number(c.sx), sz = Number(c.sz);
  if (isFinite(sx) && isFinite(sz)) {
    if (sx < SCENE.xMin || sx > SCENE.xMax || sz < SCENE.zMin || sz > SCENE.zMax) return null;
    return { sx, sz, ...base };
  }
  const lat = Number(c.lat), lon = Number(c.lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat < NYC.latMin || lat > NYC.latMax || lon < NYC.lonMin || lon > NYC.lonMax) return null;
  return { lat, lon, ...base };
}

const SYSTEM = `You are the City Concierge inside a live Three.js digital twin of New York City. \
The scene covers Manhattan (fully built from real data), the Brooklyn/LIC/Astoria waterfront, the \
South Bronx, Roosevelt and Governors Islands, and LGA + JFK, with LIVE feeds: aircraft, subway, \
NYC Ferry, MTA buses, Citi Bike, DOT traffic speeds/cameras/incidents, weather, BirdCast bird \
migration — plus the real street graph (86k segments), 305k real building footprints, and daily \
snapshots of the past week.
TWO COORDINATE SPACES: live feeds use lat/lon; the street graph and buildings use SCENE METERS \
{sx,sz}. Bridge them with geocode_intersection (landmark → the nearest intersection you know). \
set_camera and layer points accept either space. There is no automatic conversion between spaces.
Rules:
- Answer city questions ONLY from tool results — never invent numbers.
- birds_aloft is a RADAR estimate of birds in migratory flight aloft (BirdCast/NEXRAD) — NOT a \
bird-population count; perched and low-flying birds are invisible to it. When enabled=false \
(daytime/off-season) BirdCast itself flags the reading low-confidence — present it that way.
- MAP YOUR RESULTS: whenever an answer is a set of places (stations, incidents, buildings, a \
street, buffers), call show_layer so the user sees pins/lines on the map — prefer source-based \
layers (the server fills the points; don't hand-copy rows). Rings visualize spatial_report buffers.
- When the user asks to see/zoom/fly somewhere, call set_camera. Use a preset ONLY for the broad \
canned view it names; for a specific place, landmark, or neighborhood — and ALWAYS when the user \
says highlight/outline/show the area — use lat/lon or {sx,sz} with a fitting altitude_m and set \
highlight_radius_m to the place's real size, so the glowing boundary is drawn (presets never draw \
it). If a layer with fit:true already frames the result, skip set_camera.
- "Around here / what am I looking at" → use the [viewer context] line appended to the message (it \
names the borough + neighborhood the camera is over).
- REGIONS: the city is 5 boroughs + 262 real 2020-NTA neighborhoods. To outline/show a region, \
show_layer with source.boundary {type, name} (fit frames it — no set_camera needed). To name the \
region at a point other than the current view, use where_is {lat,lon}. Neighborhood names are NTA \
names ("Midtown-Times Square", "Williamsburg", "Upper East Side-Carnegie Hill") and fuzzy-match, so \
"Times Square" or "Upper East Side" resolve.
- Time questions ("last Tuesday", "yesterday") → get_history for facts, set_timeline to actually \
show that day (data snaps to daily snapshots; only the sun follows exact minutes).
- Keep replies under ~80 words of plain conversational text. NO markdown — no asterisks, bullets, \
or headings (the chat UI renders raw text). Say what appeared on the map when you draw a layer.
- The twin is stylized: real buildings/bridges/streets, but individual monuments (e.g. the Statue \
of Liberty) are not modeled — describe what the scene actually shows.
- You control only the camera, layers, and timeline. Everything else is read-only — politely decline.`;

/* ---------- per-IP rate limiting (per warm instance — bounds burst abuse;
   Fluid Compute keeps instances warm so this holds up in practice) ---------- */
const RL = new Map(); // ip → { stamps: [ms...], day: 'YYYY-MM-DD', dayCount }
let instanceDay = '', instanceCount = 0;
const RL_PER_MIN = 8, RL_PER_DAY = 60, RL_INSTANCE_PER_DAY = 500;
function rateLimited(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (instanceDay !== today) { instanceDay = today; instanceCount = 0; }
  if (++instanceCount > RL_INSTANCE_PER_DAY) return 'global daily budget reached — try tomorrow';
  let r = RL.get(ip);
  if (!r || r.day !== today) { r = { stamps: [], day: today, dayCount: 0 }; RL.set(ip, r); }
  const now = Date.now();
  r.stamps = r.stamps.filter(t => now - t < 60_000);
  if (r.stamps.length >= RL_PER_MIN) return 'too many messages — wait a minute';
  if (++r.dayCount > RL_PER_DAY) return 'daily limit reached for your connection';
  r.stamps.push(now);
  if (RL.size > 5000) RL.clear();
  return null;
}

/* ---------- gateway call (one retry on timeout/network/5xx — a single slow
   round must not kill a request that already has good tool results) ---------- */
async function callGateway(key, messages, attempt = 0) {
  try {
    const r = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, tools: TOOLS, messages }),
      signal: AbortSignal.timeout(45_000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status >= 500 && attempt === 0) { console.error('[agent] gateway ' + r.status + ' → retrying'); return callGateway(key, messages, 1); }
      throw new Error('gateway http ' + r.status + ' ' + JSON.stringify(j.error || j).slice(0, 200));
    }
    return j;
  } catch (e) {
    const transient = e.name === 'TimeoutError' || e.name === 'AbortError' || /abort|timeout|fetch failed|network/i.test(String(e.message || e));
    if (transient && attempt === 0) { console.error('[agent] gateway ' + (e.name || e.message) + ' → retrying'); return callGateway(key, messages, 1); }
    throw e;
  }
}

/* history: /api/history is special-cased inside handleApi (fetchHistory is
   not exported), so read it through handleApi with a stub res — keeps the
   GH token handling and day-file caching in exactly one place. */
function viaHandleApi(pathname) {
  return new Promise((resolve, reject) => {
    const res = { writeHead() {}, end(body) { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } } };
    handleApi(pathname, res).catch(reject);
  });
}
async function historyTool(input) {
  if (!input || !input.day) {
    const man = await viaHandleApi('/api/history');
    return { retentionDays: man.retentionDays, days: (man.daily || []).map(d => d.replace(/^daily\//, '').replace(/\.json$/, '')) };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) return { error: 'day must be YYYY-MM-DD' };
  const fr = await viaHandleApi('/api/history/' + input.day);
  if (fr.error) return fr;
  const out = { day: input.day, recordedAt: fr.t, weather: fr.weather, counts: {
    buses: (fr.buses || []).length, bikeStations: (fr.bikes || []).length, ferries: (fr.ferries || []).length,
    flights: (fr.flights || []).length, subwayTrips: fr.subway ? (fr.subway.trips || []).length : 0,
    trafficLinks: (fr.traffic || []).length, trafficEvents: (fr.trafficEvents || []).length }, schema: fr.schema };
  const feed = input.feed;
  if (feed && fr[feed]) out.rows = fr[feed].slice(0, 30); // schema field names the columns
  return out;
}

async function runTool(name, input) {
  try {
    if (name === 'get_data') return await feedQuery(input || {});
    if (name === 'get_history') return await historyTool(input || {});
    if (name === 'geocode_intersection') return await geocodeIntersection(input || {});
    if (name === 'query_buildings') return await queryBuildings(input || {});
    if (name === 'spatial_report') return await spatialReport(input || {});
    if (name === 'where_is') return await whereIs(input || {});
    return { error: 'unknown tool' };
  } catch (e) { return { error: String(e.message || e) }; }
}

/* ---------- request handler (shared by server.js and api/agent.js) ---------- */
function readBody(req) {
  if (req.body !== undefined) { // Vercel pre-parses JSON bodies
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 65_536) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function contextLine(ctx) { // viewer context from the client, sanitized
  if (!ctx || typeof ctx !== 'object') return '';
  const num = (v) => (isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const sx = num(ctx.sx), sz = num(ctx.sz), alt = num(ctx.alt_m), scrub = num(ctx.scrub_min);
  const street = String(ctx.street || '').slice(0, 48), boro = String(ctx.borough || '').slice(0, 16);
  const nbhd = String(ctx.neighborhood || '').slice(0, 48);
  const bits = [];
  if (sx !== null && sz !== null) bits.push(`camera target scene {sx:${sx}, sz:${sz}}` + (alt !== null ? ` · alt ~${alt} m` : ''));
  if (nbhd) bits.push('in ' + nbhd + (boro ? ', ' + boro : '') + (street ? ' · near ' + street : ''));
  else if (street) bits.push('near ' + street + (boro ? ', ' + boro : ''));
  bits.push(scrub ? `timeline ${scrub} min (past)` : 'timeline LIVE');
  if (ctx.focus_kind) { // the dialogue/entity the user last clicked in the scene
    const kind = String(ctx.focus_kind).slice(0, 40), label = String(ctx.focus_label || '').slice(0, 80);
    const age = isFinite(Number(ctx.focus_age_s)) ? Math.round(Number(ctx.focus_age_s)) : null;
    let data = '';
    try { data = JSON.stringify(ctx.focus_data).slice(0, 400); } catch { /* unserializable → skip */ }
    bits.push(`user is following: ${kind} — ${label}` + (age !== null ? ` (clicked ${age}s ago)` : '') + (data && data !== 'null' ? ' ' + data : ''));
  }
  return bits.length ? `\n\n[viewer context: ${bits.join(' · ')}]` : '';
}

async function handleAgent(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST' }); return res.end(); }
  const key = gatewayKey(req);
  if (req.method !== 'POST') return sendJSON(res, { ok: true, llm: !!key, model: MODEL, tools: TOOLS.length });
  if (!key) return sendJSON(res, { error: 'agent not configured (no AI Gateway credential)' }, 503);

  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
  const limited = rateLimited(ip);
  if (limited) return sendJSON(res, { error: limited }, 429);

  let body;
  try { body = await readBody(req); } catch { return sendJSON(res, { error: 'bad request body' }, 400); }
  const msgs = Array.isArray(body && body.messages) ? body.messages.slice(-16) : null;
  if (!msgs || !msgs.length) return sendJSON(res, { error: 'messages required' }, 400);
  const messages = [];
  for (const m of msgs) { // sanitize: plain user/assistant text turns only
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return sendJSON(res, { error: 'bad message shape' }, 400);
    const prev = messages[messages.length - 1];
    if (prev && prev.role === m.role) prev.content = (prev.content + '\n' + m.content).slice(0, 4000); // API rejects consecutive same-role turns
    else messages.push({ role: m.role, content: m.content.slice(0, 2000) });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return sendJSON(res, { error: 'last message must be user' }, 400);
  messages[messages.length - 1].content += contextLine(body.context);

  let camera = null, timeline = null, reply = '';
  const layers = [];
  // usage-logging accumulators (first-party analytics — see lib/agent-log.js)
  const startedAt = Date.now();
  const userMsg = messages[messages.length - 1].content;
  const toolCalls = []; // [{ round, name, input }] — the real "how do people use it" signal
  const usage = { input_tokens: 0, output_tokens: 0 };
  let rounds = 0;
  const writeLog = (status, errMsg) => agentLog.logTurn({
    t: new Date().toISOString(), status,
    visitor: agentLog.visitorHash(ip),
    message: userMsg,                       // full user text (see the changelog/privacy note)
    context: body.context || null,
    tools: toolCalls,
    intents: { camera: !!camera, layers: layers.map(l => ({ title: l.title, points: (l.points || []).length })),
      timeline: timeline ? timeline.scrub_min : null },
    reply: (reply || '').slice(0, 1200),
    rounds, usage, latency_ms: Date.now() - startedAt,
    model: MODEL, error: errMsg || null
  }).catch(() => {});
  try {
    const t0 = Date.now();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (Date.now() - t0 > 100_000) break; // total budget: stop launching rounds, answer with what we have
      rounds++;
      const resp = await callGateway(key, messages);
      if (resp.usage) { usage.input_tokens += resp.usage.input_tokens || 0; usage.output_tokens += resp.usage.output_tokens || 0; }
      const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
      for (const b of resp.content || []) if (b.type === 'text') reply = b.text;
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) break;
      for (const tu of toolUses) toolCalls.push({ round, name: tu.name, input: tu.input });
      messages.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const tu of toolUses) {
        let out;
        if (tu.name === 'set_camera') {
          camera = validCamera(tu.input);
          out = camera ? { ok: true, applied: camera } : { error: 'invalid or out-of-bounds camera target' };
        } else if (tu.name === 'set_timeline') {
          const v = Number(tu.input && tu.input.scrub_min);
          if (!isFinite(v)) out = { error: 'scrub_min required (0 = live)' };
          else { timeline = { scrub_min: Math.min(0, Math.max(-10080, Math.round(v))) }; out = { ok: true, applied: timeline }; }
        } else if (tu.name === 'show_layer') {
          if (layers.length >= MAX_LAYERS) out = { error: 'layer budget reached (3 per turn)' };
          else {
            const built = await buildLayer(tu.input || {}).catch(e => ({ error: String(e.message || e) }));
            if (built.layer) { layers.push(built.layer); delete built.layer; }
            out = built;
          }
        } else {
          out = await runTool(tu.name, tu.input);
        }
        let s = JSON.stringify(out);
        if (s.length > TOOL_RESULT_CAP) s = s.slice(0, TOOL_RESULT_CAP) + '…(truncated — use a filter or smaller limit)';
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: s });
      }
      messages.push({ role: 'user', content: results });
    }
    if (!reply) reply = (camera || layers.length || timeline) ? 'Done — take a look.' : 'Sorry — I could not put an answer together.';
    await writeLog('ok'); // best-effort, time-boxed; never blocks/breaks the reply
    return sendJSON(res, { reply, camera, layers: layers.length ? layers : null, timeline });
  } catch (e) {
    console.error('[agent]', e.message || e);
    if (/abort|timeout/i.test(String(e.message || e)) || e.name === 'TimeoutError') {
      // slow model round even after the retry: answer like a person, keep any intents already gathered
      reply = reply || 'That one took too long on the model side — please ask again (it usually goes through on the second try).';
      await writeLog('timeout', String(e.message || e));
      return sendJSON(res, { reply, camera, layers: layers.length ? layers : null, timeline });
    }
    await writeLog('error', String(e.message || e));
    return sendJSON(res, { error: 'agent error: ' + String(e.message || e).slice(0, 140) }, 502);
  }
}

module.exports = { handleAgent };
