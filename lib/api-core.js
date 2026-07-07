/* ============================================================
   lib/api-core.js — all live-data fetchers + the cached-route core.
   Zero dependencies (Node 18+: global fetch, node:fs, node:zlib).
   Shared by server.js (local dev) and api/index.js (Vercel).

   ADDING A NEW DATA SOURCE — the whole recipe, nothing else:
     1. Write one async fetcher that returns plain JSON:
          async function fetchThing() { ...fetch upstream, normalize... return { thing: [...] }; }
        Fetchers REJECT on failure (never crash the process, never
        return partial garbage) — the helper serves last-good data.
     2. Register it at the bottom:
          makeCachedRoute('/api/thing', 30_000, fetchThing, { thing: [] });
   The helper owns: in-memory cache, lazy single-flight refresh,
   last-good/stale serving, fetchedAt/now stamping, error
   containment, and response headers. Secrets load server-side
   only (see OpenSky below) and never reach the browser.

   Accepted limits (deliberate, do not over-engineer): cache dies
   on restart / cold start (cold refetch is fine — on Vercel, Fluid
   Compute reuses warm instances so the cache mostly survives),
   polling-shaped only, per-instance state.
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------- cached-route helper (the plugin core) ---------- */
const routes = new Map(); // path → { ttl, fetcher, empty, data, fetchedAt, refreshing }
function makeCachedRoute(routePath, ttlMs, fetcher, empty = {}) {
  routes.set(routePath, { ttl: ttlMs, fetcher, empty, data: null, fetchedAt: 0, refreshing: null });
}
async function serveCached(entry, res) {
  const fresh = entry.data !== null && Date.now() - entry.fetchedAt < entry.ttl;
  if (!fresh) {
    if (!entry.refreshing) { // single-flight: concurrent requests share one refresh
      entry.refreshing = entry.fetcher()
        .then(data => { entry.data = data; entry.fetchedAt = Date.now(); })
        .catch(e => console.error(new Date().toISOString(), 'fetch failed:', e.message || e))
        .finally(() => { entry.refreshing = null; });
    }
    await entry.refreshing; // resolves even when the fetch failed (last-good below)
  }
  const stale = entry.data === null || Date.now() - entry.fetchedAt >= entry.ttl + 5000;
  sendJSON(res, { now: Date.now(), fetchedAt: entry.fetchedAt, stale, ...(entry.data ?? entry.empty) });
}
function sendJSON(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* ---------- OpenSky auth (credentials never reach the browser) ---------- */
let osCreds = null;
{
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  if (id && secret) osCreds = { id, secret };
  else {
    try { // local dev fallback; the file is git-ignored and never exists on Vercel
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'opensky-credentials.json'), 'utf8'));
      if (j.clientId && j.clientSecret) osCreds = { id: j.clientId, secret: j.clientSecret };
    } catch { /* anonymous tier */ }
  }
}
const FLIGHTS_TTL = osCreds ? 30_000 : 225_000; // 4000 credits/day authed ≈ 30s; 400/day anon ≈ 225s
console.log('[opensky]', osCreds ? 'credentials loaded → authenticated tier, 30s refresh'
                                 : 'no credentials → anonymous tier, 225s refresh');

let osToken = { value: null, exp: 0 };
async function openskyToken() {
  if (!osCreds) return null;
  if (osToken.value && Date.now() < osToken.exp) return osToken.value;
  const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(osCreds.id) +
          '&client_secret=' + encodeURIComponent(osCreds.secret)
  });
  if (!r.ok) throw new Error('opensky token http ' + r.status);
  const j = await r.json();
  // refresh proactively ~5 min before the ~30 min expiry
  osToken = { value: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 1800) - 300) * 1000 };
  return osToken.value;
}

/* ---------- /api/flights — OpenSky (ALL airborne aircraft), adsb.lol fallback ----------
   Normalized contract (metric):
   { hex, cs, cat, catLabel, lat, lon, altM, gsMs, track, vrateMs }              */
const OS_URL = 'https://opensky-network.org/api/states/all' +
  '?lamin=40.3&lomin=-74.5&lamax=41.1&lomax=-73.6&extended=1'; // ~1 sq° box = 1 credit/call
// OpenSky extended category enum (per their API docs — note this differs from the raw
// ADS-B A1–A7 convention): 0/1 no info, 2 Light … 8 Rotorcraft. Probed live: ~90% report 0.
const CAT_LABEL = ['', '', 'Light', 'Small', 'Large', 'High-vortex', 'Heavy', 'High-perf',
                   'Rotorcraft', 'Glider', 'Balloon', '', 'Ultralight', '', 'UAV', 'Spacecraft'];
async function fetchFlights() {
  try {
    const headers = {};
    const tok = await openskyToken().catch(() => null); // token trouble → try anonymous
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const r = await fetch(OS_URL, { headers });
    if (r.status === 401 && tok) { osToken = { value: null, exp: 0 }; throw new Error('opensky 401'); }
    if (!r.ok) throw new Error('opensky http ' + r.status);
    const remaining = r.headers.get('x-rate-limit-remaining');
    if (remaining !== null) console.log('[flights] opensky ok, credits remaining:', remaining);
    const j = await r.json();
    const ac = [];
    for (const s of j.states || []) {
      const lat = s[6], lon = s[5];
      if (lat == null || lon == null || s[8] === true) continue; // no fix / on ground
      const cat = (s.length > 17 && typeof s[17] === 'number') ? s[17] : 0;
      ac.push({
        hex: s[0], cs: (s[1] || '').trim(), cat, catLabel: CAT_LABEL[cat] || '',
        lat, lon,
        altM: typeof s[7] === 'number' ? s[7] : (typeof s[13] === 'number' ? s[13] : 0),
        gsMs: typeof s[9] === 'number' ? s[9] : 0,
        track: typeof s[10] === 'number' ? s[10] : 0,
        vrateMs: typeof s[11] === 'number' ? s[11] : 0
      });
    }
    return { source: 'opensky', ac };
  } catch (e) {
    // Fallback chain: independent community readsb aggregators, identical v2 schema.
    // OpenSky blocks datacenter IPs, so in production the first of these IS the source.
    let err = e;
    for (const [name, url] of READSB_FALLBACKS) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(name + ' http ' + r.status);
        const j = await r.json();
        const FT = 0.3048, KT = 0.51444, FPM = 0.00508;
        const ac = [];
        for (const a of j.ac || j.aircraft || []) {
          if (a.lat == null || a.lon == null || typeof a.alt_baro !== 'number') continue; // "ground" → skip
          ac.push({ hex: a.hex, cs: (a.flight || '').trim(), cat: 0, catLabel: a.t || '',
            lat: a.lat, lon: a.lon, altM: a.alt_baro * FT, gsMs: (a.gs || 0) * KT,
            track: a.track || 0, vrateMs: (a.baro_rate || 0) * FPM });
        }
        if (!ac.length) throw new Error(name + ' returned no aircraft');
        console.log('[flights] ' + (err.message || err) + ' → served ' + name);
        return { source: name, ac };
      } catch (e2) { err = new Error((e2.message || e2) + ' (after ' + (err.message || err) + ')'); }
    }
    throw err;
  }
}
const READSB_FALLBACKS = [
  ['adsb.lol', 'https://api.adsb.lol/v2/point/40.71/-74.01/40'],
  ['airplanes.live', 'https://api.airplanes.live/v2/point/40.71/-74.01/40'],
  ['adsb.fi', 'https://opendata.adsb.fi/api/v2/lat/40.71/lon/-74.01/dist/40']
];

/* ---------- /api/weather — NWS station observations, Open-Meteo fallback ----------
   Emits the Open-Meteo-shaped `current` object the frontend's applyWeather consumes. */
const NWS_STATIONS = ['KNYC', 'KLGA', 'KEWR']; // Central Park, LaGuardia, Newark
const CLOUD_PCT = { CLR: 0, SKC: 0, FEW: 18, SCT: 40, BKN: 75, OVC: 100, VV: 100 };
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast?latitude=40.78&longitude=-73.97' +
  '&current=temperature_2m,precipitation,rain,snowfall,cloud_cover,wind_speed_10m,wind_direction_10m,visibility,weather_code&timezone=UTC';
function nwsToCurrent(obsList) {
  // obsList freshest-first; take each scalar from the first observation that has it
  const pick = (fn) => { for (const p of obsList) { const v = fn(p); if (v != null) return v; } return null; };
  const val = (k) => pick(p => (p[k] && typeof p[k].value === 'number') ? p[k].value : null);
  // precipitation is spotty — pool present-weather + clouds across ALL stations
  // so rain anywhere in the NYC cluster registers (metro-level "is it raining")
  const pw = obsList.flatMap(p => p.presentWeather || []);
  const clouds = obsList.flatMap(p => p.cloudLayers || []);
  const has = (w) => pw.some(x => (x.weather || '').includes(w));
  const heavy = pw.some(x => x.intensity === 'heavy'), light = pw.some(x => x.intensity === 'light');
  const cloudPct = clouds.reduce((m, c) => Math.max(m, CLOUD_PCT[c.amount] ?? 0), 0);
  let code = 1, precip = 0, snowfall = 0;
  if (has('snow')) { code = heavy ? 75 : light ? 71 : 73; snowfall = heavy ? 2 : light ? 0.4 : 1; }
  else if (has('thunderstorm')) { code = 95; precip = 6; }
  else if (has('rain') && has('shower')) { code = heavy ? 82 : light ? 80 : 81; precip = heavy ? 7 : light ? 1 : 3; }
  else if (has('rain')) { code = heavy ? 65 : light ? 61 : 63; precip = heavy ? 7 : light ? 1 : 3; }
  else if (has('drizzle')) { code = light ? 51 : 53; precip = light ? 0.4 : 1; }
  else if (has('fog') || has('mist')) code = 45;
  else code = cloudPct >= 85 ? 3 : cloudPct >= 30 ? 2 : cloudPct >= 12 ? 1 : 0;
  const measured = val('precipitationLastHour'); // often null; use it when present
  if (measured != null && measured > precip) precip = measured;
  return { temperature_2m: val('temperature'), precipitation: precip,
    rain: has('rain') || has('drizzle') ? precip : 0, snowfall, cloud_cover: cloudPct,
    wind_speed_10m: val('windSpeed'), wind_direction_10m: val('windDirection'),
    visibility: val('visibility'), weather_code: code };
}
async function fetchWeather() {
  try {
    const list = await Promise.all(NWS_STATIONS.map(s =>
      fetch('https://api.weather.gov/stations/' + s + '/observations/latest')
        .then(r => r.ok ? r.json() : null).catch(() => null)));
    const obs = list.filter(Boolean).map(j => j.properties)
      .filter(p => p && p.timestamp && p.temperature && typeof p.temperature.value === 'number')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // freshest first
    if (!obs.length) throw new Error('no NWS observations');
    return { source: 'nws', current: nwsToCurrent(obs) };
  } catch (e) {
    const r = await fetch(OPEN_METEO_URL);
    if (!r.ok) throw new Error('open-meteo http ' + r.status + ' (after ' + (e.message || e) + ')');
    const j = await r.json();
    if (!j.current) throw new Error('open-meteo empty');
    console.log('[weather] NWS failed (' + (e.message || e) + ') → served Open-Meteo fallback');
    return { source: 'open-meteo', current: j.current };
  }
}

/* ---------- /api/subway — MTA GTFS-realtime, decoded server-side ----------
   Minimal protobuf wire walker (varint + length-delimited), field numbers per
   gtfs-realtime.proto: FeedMessage.entity=2; FeedEntity.trip_update=3, vehicle=4;
   TripUpdate.trip=1 {trip_id=1, route_id=5}, stop_time_update=2 {arrival=2{time=2},
   departure=3{time=2}, stop_id=4}; VehiclePosition.trip=1, current_status=4 (1=STOPPED_AT). */
const MTA_BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';
const MTA_SUFFIXES = ['', '-ace', '-bdfm', '-nqrw', '-l', '-jz', '-g']; // -g: the G train has its own feed
function pbVarint(b, i) { let r = 0, s = 1; for (;;) { const x = b[i++]; r += (x & 0x7f) * s; if (!(x & 0x80)) return [r, i]; s *= 128; } }
function pbWalk(b, lo, hi, cb) {
  let i = lo;
  while (i < hi) {
    let key; [key, i] = pbVarint(b, i);
    const f = Math.floor(key / 8), w = key & 7;
    if (w === 0) { let v; [v, i] = pbVarint(b, i); cb(f, v, 0, 0, 0); }
    else if (w === 2) { let ln; [ln, i] = pbVarint(b, i); cb(f, 0, i, i + ln, 2); i += ln; }
    else if (w === 5) { // fixed32 float (ferry lat/lon/speed) — pass value + wire type
      cb(f, new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, true), 0, 0, 5); i += 4;
    }
    else if (w === 1) i += 8;
    else return; // unknown wire type: bail on this message
  }
}
const pbStr = (b, lo, hi) => { let s = ''; for (let i = lo; i < hi; i++) s += String.fromCharCode(b[i]); return s; };
function decodeFeed(buf, out, vehStatus) {
  const b = new Uint8Array(buf);
  pbWalk(b, 0, b.length, (f, v, lo, hi) => {
    if (f !== 2) return; // entity
    let tuLo = 0, tuHi = 0, vLo = 0, vHi = 0;
    pbWalk(b, lo, hi, (f2, v2, l2, h2) => {
      if (f2 === 3) { tuLo = l2; tuHi = h2; }
      if (f2 === 4) { vLo = l2; vHi = h2; }
    });
    if (tuHi) {
      const rec = { tid: '', route: '', stus: [] };
      pbWalk(b, tuLo, tuHi, (f2, v2, l2, h2) => {
        if (f2 === 1) pbWalk(b, l2, h2, (f3, v3, l3, h3) => {
          if (f3 === 1) rec.tid = pbStr(b, l3, h3);
          if (f3 === 5) rec.route = pbStr(b, l3, h3);
        });
        if (f2 === 2) {
          let sid = '', arr = 0, dep = 0;
          pbWalk(b, l2, h2, (f3, v3, l3, h3) => {
            if (f3 === 4) sid = pbStr(b, l3, h3);
            if (f3 === 2) pbWalk(b, l3, h3, (f4, v4) => { if (f4 === 2) arr = v4; });
            if (f3 === 3) pbWalk(b, l3, h3, (f4, v4) => { if (f4 === 2) dep = v4; });
          });
          if (sid) rec.stus.push([sid, arr || dep, dep || arr]);
        }
      });
      if (rec.tid && (rec.route || rec.stus.length)) out.push(rec); // ferries omit route_id; MTA always has it
    }
    if (vHi) {
      let tid = '', status = -1;
      pbWalk(b, vLo, vHi, (f2, v2, l2, h2) => {
        if (f2 === 1) pbWalk(b, l2, h2, (f3, v3, l3, h3) => { if (f3 === 1) tid = pbStr(b, l3, h3); });
        if (f2 === 4) status = v2;
      });
      if (tid) vehStatus[tid] = status;
    }
  });
}
async function fetchSubway() {
  const trips = [], vehStatus = {};
  const bufs = await Promise.all(MTA_SUFFIXES.map(sfx =>
    fetch(MTA_BASE + sfx).then(r => { if (!r.ok) throw new Error('mta http ' + r.status); return r.arrayBuffer(); })));
  for (const buf of bufs) decodeFeed(buf, trips, vehStatus);
  if (!trips.length) throw new Error('mta feeds decoded empty');
  return { trips, vehStatus };
}
async function fetchStations() {
  const r = await fetch('https://data.ny.gov/resource/39hk-dx4f.json?$limit=1000');
  if (!r.ok) throw new Error('socrata http ' + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('socrata empty');
  return { rows };
}

/* ---------- /api/ferries — NYC Ferry GTFS-realtime (real vessel GPS) ----------
   VehiclePositions carry actual boat lat/lon/speed (floats — hence the pbWalk fixed32
   support); TripUpdates give upcoming stops; the static GTFS zip gives route names,
   terminal names and trip headsigns. The feed has NO bearing field, so heading is
   derived server-side from successive fixes. Contract:
   { vessels: [{ id, label, lat, lon, speedMs, heading, route, headsign,
                 next, nextEtaMin, docked }] } */
function unzip(buf) { // minimal ZIP reader: EOCD → central directory → STORE/DEFLATE entries
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip: no EOCD');
  const files = {};
  let n = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const dstart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dstart, dstart + csize);
    files[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}
function csvObjects(text) { // tiny quoted-CSV parser → array of objects keyed by header
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const head = rows.shift().map(h => h.replace(/^﻿/, '').trim());
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
const FERRY_BASE = 'http://nycferry.connexionz.net/rtt/public/utility/';
let ferryStatic = null, ferryStaticAt = 0;
async function getFerryStatic() { // internal 24 h cache (route/terminal/headsign names)
  if (ferryStatic && Date.now() - ferryStaticAt < 86_400_000) return ferryStatic;
  const r = await fetch(FERRY_BASE + 'gtfs.aspx'); // 302 → node fetch follows
  if (!r.ok) throw new Error('ferry gtfs http ' + r.status);
  const files = unzip(Buffer.from(await r.arrayBuffer()));
  const routeName = {}, stopName = {}, tripInfo = {};
  for (const x of csvObjects(files['routes.txt'].toString('utf8')))
    routeName[x.route_id] = x.route_long_name || x.route_short_name || x.route_id;
  for (const x of csvObjects(files['stops.txt'].toString('utf8'))) stopName[x.stop_id] = x.stop_name;
  for (const x of csvObjects(files['trips.txt'].toString('utf8')))
    tripInfo[x.trip_id] = { route: routeName[x.route_id] || x.route_id, headsign: x.trip_headsign || '' };
  ferryStatic = { stopName, tripInfo }; ferryStaticAt = Date.now();
  console.log('[ferries] static GTFS loaded:', Object.keys(stopName).length, 'terminals,',
    Object.keys(tripInfo).length, 'trips');
  return ferryStatic;
}
const ferryPrev = new Map(); // vid → { lat, lon, heading } for heading derivation
async function fetchFerries() {
  const st = await getFerryStatic();
  const [vpBuf, tuBuf] = await Promise.all(['gtfsrealtime.aspx/vehicleposition', 'gtfsrealtime.aspx/tripupdate']
    .map(p => fetch(FERRY_BASE + p).then(r => { if (!r.ok) throw new Error('ferry rt http ' + r.status); return r.arrayBuffer(); })));
  // trip updates → next upcoming stop per trip (same TripUpdate schema as the MTA)
  const tuTrips = [], nextByTrip = {};
  decodeFeed(tuBuf, tuTrips, {});
  const nowS = Date.now() / 1000;
  for (const rec of tuTrips) {
    for (const [sid, arr] of rec.stus) {
      if (arr >= nowS - 30) { nextByTrip[rec.tid] = { stop: st.stopName[sid] || sid, etaMin: Math.max(0, Math.round((arr - nowS) / 60)) }; break; }
    }
  }
  // vehicle positions (floats arrive via pbWalk's fixed32 path, wire type 5)
  const vessels = [], b = new Uint8Array(vpBuf);
  pbWalk(b, 0, b.length, (f, v, lo, hi, w) => {
    if (f !== 2 || w !== 2) return; // FeedEntity
    let vp = null;
    pbWalk(b, lo, hi, (f2, v2, l2, h2, w2) => { if (f2 === 4 && w2 === 2) vp = [l2, h2]; });
    if (!vp) return;
    const rec = { id: '', label: '', lat: null, lon: null, speedMs: 0, tripId: '', status: -1 };
    pbWalk(b, vp[0], vp[1], (f2, v2, l2, h2, w2) => {
      if (f2 === 1 && w2 === 2) pbWalk(b, l2, h2, (f3, v3, l3, h3, w3) => { if (f3 === 1 && w3 === 2) rec.tripId = pbStr(b, l3, h3); });
      else if (f2 === 2 && w2 === 2) pbWalk(b, l2, h2, (f3, v3, l3, h3, w3) => {
        if (w3 === 5) { if (f3 === 1) rec.lat = v3; else if (f3 === 2) rec.lon = v3; else if (f3 === 5) rec.speedMs = v3; }
      });
      else if (f2 === 4 && w2 === 0) rec.status = v2;
      else if (f2 === 8 && w2 === 2) pbWalk(b, l2, h2, (f3, v3, l3, h3, w3) => {
        if (w3 === 2) { if (f3 === 1) rec.id = pbStr(b, l3, h3); else if (f3 === 2) rec.label = pbStr(b, l3, h3); }
      });
    });
    if (rec.lat == null || rec.lon == null) return;
    const key = rec.id || rec.label;
    const prev = ferryPrev.get(key);
    let heading = prev ? prev.heading : null;
    if (prev) {
      const dN = (rec.lat - prev.lat) * 110540, dE = (rec.lon - prev.lon) * 84392;
      if (Math.hypot(dN, dE) > 8) heading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
    }
    ferryPrev.set(key, { lat: rec.lat, lon: rec.lon, heading });
    const info = st.tripInfo[rec.tripId], nx = nextByTrip[rec.tripId];
    vessels.push({ id: key, label: rec.label || key, lat: rec.lat, lon: rec.lon,
      speedMs: rec.speedMs || 0, heading,
      route: info ? info.route : '', headsign: info ? info.headsign : '',
      next: nx ? nx.stop : '', nextEtaMin: nx ? nx.etaMin : null,
      docked: !rec.tripId });
  });
  return { vessels };
}

/* ---------- /api/buses — MTA Bus Time GTFS-realtime VehiclePositions ----------
   gtfsrt.prod.obanyc.com needs a free key (https://register.developer.obanyc.com/):
   env MTA_BUS_KEY or mta-bus-key.json ({"key":"..."} — git-ignored). Same protobuf
   walker as the subway/ferries. Speed is derived from successive fixes (the feed
   carries bearing but rarely speed). Contract:
   { buses: [{ id, route, lat, lon, bearing, speedMs }] } */
let busKey = process.env.MTA_BUS_KEY || null;
if (!busKey) {
  try { busKey = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mta-bus-key.json'), 'utf8')).key || null; }
  catch { /* buses stay dormant until a key exists */ }
}
console.log('[buses]', busKey ? 'key loaded → live bus feed on' : 'no key (env MTA_BUS_KEY or mta-bus-key.json) → /api/buses serves empty');
const busPrev = new Map(); // id → { lat, lon, t } for speed derivation
/* SIRI VehicleMonitoring enriches GTFS-rt with per-vehicle destinations.
   It is 2 MB and ~13 s upstream, so it refreshes lazily every 2 min in the
   background and NEVER blocks the 15 s position poll; without it (or before
   the first load) buses simply have no headsign. */
let siriDest = new Map(), siriAt = 0, siriBusy = null;
function prettyDest(s) {
  if (!s) return '';
  s = s.split(' via ')[0].split(' VIA ')[0].trim();
  return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\s+/g, ' ');
}
function refreshSiri() {
  if (siriBusy || Date.now() - siriAt < 120_000) return;
  siriBusy = (async () => {
    const r = await fetch('https://bustime.mta.info/api/siri/vehicle-monitoring.json?key=' +
      encodeURIComponent(busKey) + '&version=2', { redirect: 'follow' });
    if (!r.ok) throw new Error('siri http ' + r.status);
    const j = await r.json();
    const va = j?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity;
    if (!Array.isArray(va)) throw new Error('siri shape');
    const m = new Map();
    for (const a of va) {
      const mv = a.MonitoredVehicleJourney;
      if (!mv || !mv.VehicleRef) continue;
      const d = Array.isArray(mv.DestinationName) ? mv.DestinationName[0] : mv.DestinationName;
      if (d) m.set(mv.VehicleRef, prettyDest(d));
    }
    if (m.size) { siriDest = m; siriAt = Date.now(); console.log('[buses] siri destinations refreshed:', m.size); }
  })().catch(e => console.error('[buses] siri refresh failed:', e.message || e))
     .finally(() => { siriBusy = null; });
}
async function fetchBuses() {
  if (!busKey) throw new Error('no MTA bus key');
  refreshSiri(); // fire-and-forget destination enrichment
  const r = await fetch('https://gtfsrt.prod.obanyc.com/vehiclePositions?key=' + encodeURIComponent(busKey));
  if (!r.ok) throw new Error('obanyc http ' + r.status);
  const buf = await r.arrayBuffer();
  const buses = [], b = new Uint8Array(buf), nowMs = Date.now();
  pbWalk(b, 0, b.length, (f, v, lo, hi, w) => {
    if (f !== 2 || w !== 2) return; // FeedEntity
    let vp = null;
    pbWalk(b, lo, hi, (f2, v2, l2, h2, w2) => { if (f2 === 4 && w2 === 2) vp = [l2, h2]; });
    if (!vp) return;
    const rec = { id: '', route: '', lat: null, lon: null, bearing: null };
    pbWalk(b, vp[0], vp[1], (f2, v2, l2, h2, w2) => {
      if (f2 === 1 && w2 === 2) pbWalk(b, l2, h2, (f3, v3, l3, h3, w3) => {
        if (f3 === 5 && w3 === 2) rec.route = pbStr(b, l3, h3);
      });
      else if (f2 === 2 && w2 === 2) pbWalk(b, l2, h2, (f3, v3, l3, h3, w3) => {
        if (w3 === 5) { if (f3 === 1) rec.lat = v3; else if (f3 === 2) rec.lon = v3; else if (f3 === 3) rec.bearing = v3; }
      });
      else if (f2 === 8 && w2 === 2) pbWalk(b, l2, h2, (f3, v3, l3, h3, w3) => {
        if (f3 === 1 && w3 === 2) rec.id = pbStr(b, l3, h3);
      });
    });
    if (rec.lat == null || rec.lon == null || !rec.id) return;
    if (rec.lat < 40.55 || rec.lat > 40.92 || rec.lon < -74.06 || rec.lon > -73.75) return; // scene bbox (drops Staten Island)
    rec.route = rec.route.replace(/^[^_]*_/, ''); // "MTA NYCT_M15" → "M15"
    let speedMs = 0;
    const prev = busPrev.get(rec.id);
    if (prev) {
      const dtS = (nowMs - prev.t) / 1000;
      if (dtS > 3) {
        const dN = (rec.lat - prev.lat) * 110540, dE = (rec.lon - prev.lon) * 84392;
        speedMs = Math.min(20, Math.hypot(dN, dE) / dtS);
      } else speedMs = prev.speedMs || 0;
    }
    busPrev.set(rec.id, { lat: rec.lat, lon: rec.lon, t: nowMs, speedMs });
    buses.push({ id: rec.id, route: rec.route, lat: rec.lat, lon: rec.lon, bearing: rec.bearing,
      speedMs: Math.round(speedMs * 10) / 10, dest: siriDest.get(rec.id) || '' });
  });
  if (!buses.length) throw new Error('bus feed decoded empty');
  if (busPrev.size > 12000) busPrev.clear(); // simple cap
  return { buses };
}

/* ---------- /api/cams — NYC DOT traffic cameras (same network 511NY lists) ----------
   webcams.nyctmc.org is keyless and CORS-open; each camera's /image endpoint serves a
   live-refreshing JPEG (the frontend polls it ~1.5 s for the "live video" viewer).
   Contract: { cams: [{ id, name, area, lat, lon }] } — image URL is derived from id. */
async function fetchCams() {
  const r = await fetch('https://webcams.nyctmc.org/api/cameras');
  if (!r.ok) throw new Error('nyctmc http ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) throw new Error('nyctmc empty');
  const cams = [];
  for (const c of j) {
    if (c.isOnline !== 'true' || c.latitude == null || c.longitude == null) continue;
    if (c.latitude < 40.55 || c.latitude > 40.92 || c.longitude < -74.10 || c.longitude > -73.75) continue; // scene bbox
    cams.push({ id: c.id, name: c.name || '', area: c.area || '', lat: c.latitude, lon: c.longitude });
  }
  if (!cams.length) throw new Error('nyctmc all filtered');
  return { cams };
}

/* ---------- /api/citibike — Citi Bike GBFS (keyless, public) ----------
   station_information (names/positions/capacity, 24 h internal cache) merged
   with station_status (live bikes/ebikes/docks, ~30 s upstream cadence).
   NOTE: GBFS has NO live rider GPS — trips are anonymized. The frontend's
   "riders" layer is a clearly-labeled simulation driven by station deltas.
   Contract: { stations: [{ id, name, lat, lon, cap, bikes, ebikes, docks, on }] } */
const GBFS = 'https://gbfs.citibikenyc.com/gbfs/en/';
const GBFS_ALT = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/';
let cbInfo = null, cbInfoAt = 0;
async function getCbInfo() {
  if (cbInfo && Date.now() - cbInfoAt < 86_400_000) return cbInfo;
  let j = null;
  for (const base of [GBFS, GBFS_ALT]) {
    try {
      const r = await fetch(base + 'station_information.json');
      if (r.ok) { j = await r.json(); break; }
    } catch { /* try alternate */ }
  }
  if (!j) throw new Error('gbfs station_information unreachable');
  const m = new Map();
  for (const s of j.data.stations) {
    if (s.lat < 40.55 || s.lat > 40.92 || s.lon < -74.06 || s.lon > -73.75) continue;
    m.set(String(s.station_id), { name: s.name || '', lat: s.lat, lon: s.lon, cap: s.capacity || 0 });
  }
  cbInfo = m; cbInfoAt = Date.now();
  console.log('[citibike] station info loaded:', m.size, 'stations');
  return m;
}
async function fetchCitibike() {
  const info = await getCbInfo();
  let j = null;
  for (const base of [GBFS, GBFS_ALT]) {
    try {
      const r = await fetch(base + 'station_status.json');
      if (r.ok) { j = await r.json(); break; }
    } catch { /* try alternate */ }
  }
  if (!j) throw new Error('gbfs station_status unreachable');
  const stations = [];
  for (const s of j.data.stations) {
    const inf = info.get(String(s.station_id));
    if (!inf) continue;
    stations.push({ id: String(s.station_id), name: inf.name, lat: inf.lat, lon: inf.lon, cap: inf.cap,
      bikes: s.num_bikes_available | 0,
      ebikes: (s.num_ebikes_available ?? 0) | 0,
      docks: s.num_docks_available | 0,
      on: s.is_renting !== 0 && s.is_installed !== 0 });
  }
  if (!stations.length) throw new Error('gbfs status empty');
  return { stations };
}

/* ---------- /api/route/:callsign — adsbdb destination proxy ---------- */
const routeCache = new Map(); // CS → "LGA → ATL" | null (negatives cached too)
let routeChain = Promise.resolve(), lastRouteAt = 0;
function fetchRoute(cs) {
  if (routeCache.has(cs)) return Promise.resolve(routeCache.get(cs));
  const p = routeChain.then(async () => {
    if (routeCache.has(cs)) return routeCache.get(cs);
    const wait = Math.max(0, lastRouteAt + 2000 - Date.now()); // throttle upstream: 1 req / 2 s
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastRouteAt = Date.now();
    let route = null;
    try {
      const r = await fetch('https://api.adsbdb.com/v0/callsign/' + encodeURIComponent(cs));
      const j = await r.json();
      const fr = j && j.response && j.response.flightroute;
      const o = fr && fr.origin && fr.origin.iata_code;
      const d = fr && fr.destination && fr.destination.iata_code;
      route = o && d ? o + ' → ' + d : null; // 404/"unknown callsign" is normal (GA traffic)
    } catch { /* negative-cache network errors too; a retry costs a page reload */ }
    if (routeCache.size >= 2000) routeCache.clear(); // simple cap
    routeCache.set(cs, route);
    return route;
  });
  routeChain = p.then(() => {}, () => {});
  return p;
}

/* ---------- /api/history — recorded daily snapshots (repo `data` branch) ----------
   The nightly cron (api/record.js) commits data/daily/YYYY-MM-DD.json there;
   this proxies them to the client (repo is private, so the GH_DATA_TOKEN that
   writes the snapshots also reads them back). Day files are immutable once
   written; the manifest churns daily. */
const HIST_REPO = 'davidfromkansas/manhattan-island';
const histCache = new Map(); // rel → { at, body }
function ghDataToken() { // env in prod (Vercel); git-ignored file for local dev (mta-bus-key pattern)
  if (process.env.GH_DATA_TOKEN) return process.env.GH_DATA_TOKEN;
  try { return require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'gh-data-token.json'), 'utf8').trim().replace(/^"|"$/g, ''); }
  catch { return null; }
}
async function fetchHistory(rel, ttlMs) {
  const hit = histCache.get(rel);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body;
  const headers = { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'city-twin' };
  const tok = ghDataToken();
  if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch(`https://api.github.com/repos/${HIST_REPO}/contents/data/${rel}?ref=data`, { headers });
  if (!r.ok) throw new Error('history ' + rel + ' http ' + r.status);
  const body = await r.json();
  if (histCache.size >= 24) histCache.clear(); // 7-day window: tiny cap is plenty
  histCache.set(rel, { at: Date.now(), body });
  return body;
}

/* ---------- route registrations (one line each — the recipe) ---------- */
makeCachedRoute('/api/flights', FLIGHTS_TTL, fetchFlights, { source: 'none', ac: [] });
makeCachedRoute('/api/weather', 300_000, fetchWeather, { source: 'none', current: null });
makeCachedRoute('/api/subway', 20_000, fetchSubway, { trips: [], vehStatus: {} });
makeCachedRoute('/api/subway/stations', 86_400_000, fetchStations, { rows: [] });
makeCachedRoute('/api/ferries', 15_000, fetchFerries, { vessels: [] });
makeCachedRoute('/api/cams', 600_000, fetchCams, { cams: [] }); // camera list churns slowly; images are fetched live per-view
makeCachedRoute('/api/buses', 15_000, fetchBuses, { buses: [] }); // dormant (empty) until an MTA Bus Time key is configured
makeCachedRoute('/api/citibike', 30_000, fetchCitibike, { stations: [] });

/* ---------- shared request dispatcher for /api/* (Node req/res) ---------- */
async function handleApi(pathname, res) {
  if (pathname === '/api/history' || pathname.startsWith('/api/history/')) {
    try {
      if (pathname === '/api/history') return sendJSON(res, await fetchHistory('manifest.json', 300_000));
      const day = pathname.slice('/api/history/'.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJSON(res, { error: 'bad day' }, 400);
      return sendJSON(res, await fetchHistory('daily/' + day + '.json', 3_600_000));
    } catch (e) { return sendJSON(res, { error: String(e.message || e) }, 502); }
  }
  if (pathname.startsWith('/api/route/')) {
    const cs = decodeURIComponent(pathname.slice('/api/route/'.length)).slice(0, 12);
    const route = await fetchRoute(cs);
    return sendJSON(res, { now: Date.now(), route });
  }
  const entry = routes.get(pathname);
  if (entry) return serveCached(entry, res);
  return sendJSON(res, { error: 'unknown endpoint' }, 404);
}

module.exports = { routes, handleApi, sendJSON };
