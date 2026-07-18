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
const { loadNyccas } = require('./nyccas-source');
const { loadAirNow } = require('./airnow-rss');

/* ---------- cached-route helper (the plugin core) ---------- */
const routes = new Map(); // path → { ttl, fetcher, empty, data, fetchedAt, refreshing }
function makeCachedRoute(routePath, ttlMs, fetcher, empty = {}) {
  routes.set(routePath, { ttl: ttlMs, fetcher, empty, data: null, fetchedAt: 0, refreshing: null });
}
async function ensureFresh(entry) { // refresh-if-stale, single-flight; resolves even on upstream failure (last-good)
  const fresh = entry.data !== null && Date.now() - entry.fetchedAt < entry.ttl;
  if (!fresh) {
    if (!entry.refreshing) { // single-flight: concurrent requests share one refresh
      entry.refreshing = entry.fetcher()
        .then(data => { entry.data = data; entry.fetchedAt = Date.now(); })
        .catch(e => console.error(new Date().toISOString(), 'fetch failed:', e.message || e))
        .finally(() => { entry.refreshing = null; });
    }
    await entry.refreshing;
  }
}
async function serveCached(entry, res) {
  await ensureFresh(entry);
  const stale = entry.data === null || Date.now() - entry.fetchedAt >= entry.ttl + 5000;
  // PERF.md workstream B: feeds are identical for every user → let the Vercel CDN
  // serve them (edge latency; upstream load stays flat as users grow). s-maxage
  // tracks the route's own TTL; SWR bounds worst-case staleness (clients dead-reckon
  // from fetchedAt, so motion stays smooth). Browsers still revalidate (max-age=0).
  // Never cache a not-yet-warmed (empty) response — it would pin emptiness at the
  // edge for the whole window (stations TTL is 24 h!).
  const ttlS = Math.max(10, Math.round(entry.ttl / 1000));
  const cache = entry.data === null ? null
    : `public, max-age=0, s-maxage=${ttlS}, stale-while-revalidate=${Math.min(ttlS * 4, 600)}`;
  sendJSON(res, { now: Date.now(), fetchedAt: entry.fetchedAt, stale, ...(entry.data ?? entry.empty) }, 200, cache);
}
function sendJSON(res, obj, status = 200, cache = null) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cache || 'no-store' // default stays uncacheable (errors, agent, logs)
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
   { hex, cs, cat, catLabel, kind, lat, lon, altM, gsMs, track, vrateMs }
   `kind` is a coarse airframe class ('heli' | 'jet') the client uses to pick a 3D model. */
const OS_URL = 'https://opensky-network.org/api/states/all' +
  '?lamin=40.3&lomin=-74.5&lamax=41.1&lomax=-73.6&extended=1'; // ~1 sq° box = 1 credit/call
// OpenSky extended category enum (per their API docs — note this differs from the raw
// ADS-B A1–A7 convention): 0/1 no info, 2 Light … 8 Rotorcraft. Probed live: ~90% report 0.
const CAT_LABEL = ['', '', 'Light', 'Small', 'Large', 'High-vortex', 'Heavy', 'High-perf',
                   'Rotorcraft', 'Glider', 'Balloon', '', 'Ultralight', '', 'UAV', 'Spacecraft'];
// Rotorcraft are the one airframe worth distinguishing over NYC (heli tours, medevac,
// NYPD, Wall St / airport executive shuttles — a huge share of the low-altitude traffic).
// Signals, in order of reliability: OpenSky's numeric category 8, the ADS-B emitter
// category "A7" the readsb aggregators report, and the ICAO type designator for the many
// feeds that report neither. The type list covers the rotorcraft actually seen over NYC.
const HELI_TYPES = new Set([
  'EC20', 'EC30', 'EC35', 'EC45', 'EC55', 'EC75', 'AS50', 'AS55', 'AS65', 'A109', 'A119',
  'A139', 'A169', 'A189', 'AW09', 'AW119', 'AW139', 'AW169', 'AW189', 'B06', 'B06T', 'B407',
  'B412', 'B427', 'B429', 'B430', 'B505', 'S76', 'S92', 'S61', 'R22', 'R44', 'R66', 'H500',
  'H60', 'H47', 'GAZL', 'EXPL', 'B47', 'MD52', 'MD60', 'NH90', 'S70', 'BK17', 'B222', 'B230']);
function acKind(cat, type) {
  if (cat === 8 || cat === 'A7') return 'heli'; // OpenSky Rotorcraft / ADS-B emitter A7
  const t = (type || '').toUpperCase();
  if (t && HELI_TYPES.has(t)) return 'heli';
  return 'jet';
}
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
        kind: acKind(cat, ''), // OpenSky /states has no ICAO type → classify on category alone
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
            kind: acKind(a.category, a.t), // readsb carries ADS-B emitter category + ICAO type
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

/* ---------- /api/weather — Google Weather, NWS then Open-Meteo fallback ----------
   Emits the Open-Meteo-shaped `current` object the frontend's applyWeather consumes. */
const GOOGLE_WEATHER_URL = 'https://weather.googleapis.com/v1/currentConditions:lookup';
const NWS_STATIONS = ['KNYC', 'KLGA', 'KEWR']; // Central Park, LaGuardia, Newark
const CLOUD_PCT = { CLR: 0, SKC: 0, FEW: 18, SCT: 40, BKN: 75, OVC: 100, VV: 100 };
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast?latitude=40.78&longitude=-73.97' +
  '&current=temperature_2m,precipitation,rain,snowfall,cloud_cover,wind_speed_10m,wind_direction_10m,visibility,weather_code&timezone=UTC';
function googleMapsKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'google-maps-key.json'), 'utf8'));
    if (j.key) return j.key;
  } catch { /* no key: weather falls through to keyless providers */ }
  return null;
}
function googleWeatherCode(type, cloud) {
  if (/THUNDER/.test(type)) return 95;
  if (/HAIL/.test(type)) return 96;
  if (/FREEZING|SLEET|ICE/.test(type)) return 67;
  if (/SNOW/.test(type)) {
    if (/SHOWER/.test(type)) return /HEAVY/.test(type) ? 86 : 85;
    return /HEAVY|STORM|BLOWING/.test(type) ? 75 : /LIGHT/.test(type) ? 71 : 73;
  }
  if (/DRIZZLE/.test(type)) return /LIGHT/.test(type) ? 51 : 53;
  if (/RAIN|SHOWER/.test(type)) {
    if (/SHOWER/.test(type)) return /HEAVY/.test(type) ? 82 : /LIGHT/.test(type) ? 80 : 81;
    return /HEAVY/.test(type) ? 65 : /LIGHT/.test(type) ? 61 : 63;
  }
  if (/FOG|MIST|HAZE/.test(type)) return 45;
  if (type === 'CLEAR') return 0;
  if (type === 'MOSTLY_CLEAR') return 1;
  if (type === 'PARTLY_CLOUDY') return 2;
  if (/CLOUDY/.test(type)) return type === 'CLOUDY' ? 3 : 2;
  return cloud >= 85 ? 3 : cloud >= 30 ? 2 : cloud >= 12 ? 1 : 0;
}
function googleToCurrent(j) {
  const num = (v, d = 0) => typeof v === 'number' && isFinite(v) ? v : d;
  const type = String(j.weatherCondition && j.weatherCondition.type || '');
  const cloud = num(j.cloudCover, 0);
  const tempObj = j.temperature || {}, speedObj = j.wind && j.wind.speed || {};
  const visObj = j.visibility || {}, qpfObj = j.precipitation && j.precipitation.qpf || {};
  let tempC = num(tempObj.degrees, null);
  if (tempObj.unit === 'FAHRENHEIT' && tempC != null) tempC = (tempC - 32) * 5 / 9;
  let windKmh = num(speedObj.value, 0);
  if (speedObj.unit === 'MILES_PER_HOUR') windKmh *= 1.609344;
  let visibility = num(visObj.distance, null);
  if (visibility == null) visibility = 16000;
  else if (visObj.unit === 'KILOMETERS') visibility *= 1000;
  else if (visObj.unit === 'MILES') visibility *= 1609.344;
  let precip = num(qpfObj.quantity, 0);
  if (qpfObj.unit === 'INCHES') precip *= 25.4;
  const chanceOnly = type.startsWith('CHANCE_OF_');
  const snow = /SNOW|SLEET/.test(type) && !chanceOnly;
  const rain = /RAIN|DRIZZLE|SHOWER|THUNDER|HAIL/.test(type) && !chanceOnly && !snow;
  if ((rain || snow) && precip <= 0) precip = /HEAVY|STORM/.test(type) ? 6 : /LIGHT/.test(type) ? 0.4 : 2;
  if (tempC == null) throw new Error('google weather missing temperature');
  return { temperature_2m: tempC, precipitation: precip,
    rain: rain ? precip : 0, snowfall: snow ? precip : 0, cloud_cover: cloud,
    wind_speed_10m: windKmh, wind_direction_10m: num(j.wind && j.wind.direction && j.wind.direction.degrees, 0),
    visibility, weather_code: googleWeatherCode(type, cloud) };
}
async function fetchGoogleWeather(key) {
  const u = new URL(GOOGLE_WEATHER_URL);
  u.searchParams.set('key', key);
  u.searchParams.set('location.latitude', '40.78');
  u.searchParams.set('location.longitude', '-73.97');
  u.searchParams.set('unitsSystem', 'METRIC');
  u.searchParams.set('languageCode', 'en-US');
  const r = await fetch(u);
  if (!r.ok) throw new Error('google weather http ' + r.status);
  const j = await r.json();
  return { source: 'google-weather', current: googleToCurrent(j) };
}
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
async function fetchNwsWeather() {
  const list = await Promise.all(NWS_STATIONS.map(s =>
    fetch('https://api.weather.gov/stations/' + s + '/observations/latest')
      .then(r => r.ok ? r.json() : null).catch(() => null)));
  const obs = list.filter(Boolean).map(j => j.properties)
    .filter(p => p && p.timestamp && p.temperature && typeof p.temperature.value === 'number')
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // freshest first
  if (!obs.length) throw new Error('no NWS observations');
  return { source: 'nws', current: nwsToCurrent(obs) };
}
async function fetchWeather() {
  const key = googleMapsKey();
  let googleError = null;
  if (key) {
    try { return await fetchGoogleWeather(key); }
    catch (e) { googleError = e; }
  }
  try {
    const result = await fetchNwsWeather();
    if (googleError) console.warn('[weather] Google Weather failed (' + (googleError.message || googleError) + ') → served NWS fallback');
    return result;
  } catch (nwsError) {
    const r = await fetch(OPEN_METEO_URL);
    if (!r.ok) throw new Error('open-meteo http ' + r.status + ' (after NWS: ' + (nwsError.message || nwsError) + ')');
    const j = await r.json();
    if (!j.current) throw new Error('open-meteo empty');
    const prior = googleError ? 'Google Weather: ' + (googleError.message || googleError) + '; ' : '';
    console.warn('[weather] ' + prior + 'NWS: ' + (nwsError.message || nwsError) + ' → served Open-Meteo fallback');
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
                 next, nextEtaMin, calls: [{ stopId, name, at }], docked }] } */
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
const nyPartsFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function nyParts(ms) { return Object.fromEntries(nyPartsFmt.formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)])); }
function nyMidnightEpoch(y, m, d) {
  const target = Date.UTC(y, m - 1, d); let t = target;
  for (let i = 0; i < 2; i++) { const p = nyParts(t); t += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); }
  return t;
}
function gtfsClockSeconds(s) { const p = String(s || '').split(':').map(Number); return p.length === 3 && p.every(isFinite) ? p[0] * 3600 + p[1] * 60 + p[2] : null; }
function csvVisitSimple(buf, visit) {
  const text = buf.toString('utf8'); let start = 0, end = text.indexOf('\n'), head = text.slice(0, end).replace(/^﻿|\r$/g, '').split(',');
  const idx = Object.fromEntries(head.map((h, i) => [h, i])); start = end + 1;
  while (start < text.length) { end = text.indexOf('\n', start); if (end < 0) end = text.length; const row = text.slice(start, end).replace(/\r$/, '').split(','); if (row.length > 1) visit(row, idx); start = end + 1; }
}
function gtfsDayContexts(nowMs) {
  const p = nyParts(nowMs), base = Date.UTC(p.year, p.month - 1, p.day), names = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return [0, 1].map(add => { const d = new Date(base + add * 86400000), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return { ymd: String(y) + String(m).padStart(2, '0') + String(day).padStart(2, '0'), weekday: names[d.getUTCDay()], midnight: nyMidnightEpoch(y, m, day) }; });
}
function gtfsActiveServices(files, ctx) {
  const active = new Set();
  if (files['calendar.txt']) for (const x of csvObjects(files['calendar.txt'].toString('utf8')))
    if (x[ctx.weekday] === '1' && x.start_date <= ctx.ymd && x.end_date >= ctx.ymd) active.add(x.service_id);
  if (files['calendar_dates.txt']) for (const x of csvObjects(files['calendar_dates.txt'].toString('utf8'))) if (x.date === ctx.ymd)
    x.exception_type === '1' ? active.add(x.service_id) : active.delete(x.service_id);
  return active;
}
function scheduledAtStops(files, wanted, nowMs, limit = 3) {
  const hitTrips = new Map(), stopTimes = files['stop_times.txt']; if (!stopTimes) return {};
  csvVisitSimple(stopTimes, (r, i) => { const sid = String(r[i.stop_id] || ''); if (!wanted.has(sid)) return;
    const secs = gtfsClockSeconds(r[i.arrival_time] || r[i.departure_time]); if (secs == null) return;
    let a = hitTrips.get(r[i.trip_id]); if (!a) hitTrips.set(r[i.trip_id], a = []); a.push({ stopId: sid, secs }); });
  if (!hitTrips.size) return {};
  const trips = new Map();
  for (const x of csvObjects(files['trips.txt'].toString('utf8'))) if (hitTrips.has(x.trip_id))
    trips.set(x.trip_id, { service: x.service_id, routeId: x.route_id, dest: x.trip_headsign || '' });
  const routes = new Map();
  for (const x of csvObjects(files['routes.txt'].toString('utf8'))) routes.set(x.route_id, x.route_short_name || x.route_long_name || x.route_id);
  const out = {}, days = gtfsDayContexts(nowMs).map(ctx => ({ ...ctx, active: gtfsActiveServices(files, ctx) }));
  for (const [tripId, calls] of hitTrips) { const trip = trips.get(tripId); if (!trip) continue;
    for (const day of days) { if (!day.active.has(trip.service)) continue; for (const c of calls) { const at = day.midnight + c.secs * 1000; if (at < nowMs - 20000) continue;
      (out[c.stopId] ||= []).push({ route: routes.get(trip.routeId) || trip.routeId, dest: trip.dest, at, scheduled: true }); } }
  }
  for (const sid of Object.keys(out)) out[sid] = out[sid].sort((a, b) => a.at - b.at).slice(0, limit);
  return out;
}
const FERRY_BASE = 'http://nycferry.connexionz.net/rtt/public/utility/';
let ferryStatic = null, ferryStaticAt = 0;
async function getFerryStatic() { // internal 24 h cache (route/terminal/headsign names)
  if (ferryStatic && Date.now() - ferryStaticAt < 86_400_000) return ferryStatic;
  const r = await fetch(FERRY_BASE + 'gtfs.aspx'); // 302 → node fetch follows
  if (!r.ok) throw new Error('ferry gtfs http ' + r.status);
  const files = unzip(Buffer.from(await r.arrayBuffer()));
  const routeName = {}, stopName = {}, tripInfo = {}, stops = [];
  for (const x of csvObjects(files['routes.txt'].toString('utf8')))
    routeName[x.route_id] = x.route_long_name || x.route_short_name || x.route_id;
  for (const x of csvObjects(files['stops.txt'].toString('utf8'))) {
    stopName[x.stop_id] = x.stop_name;
    const lat = Number(x.stop_lat), lon = Number(x.stop_lon);
    if (x.stop_name && isFinite(lat) && isFinite(lon)) stops.push({ id: x.stop_id, name: x.stop_name, lat, lon });
  }
  for (const x of csvObjects(files['trips.txt'].toString('utf8')))
    tripInfo[x.trip_id] = { route: routeName[x.route_id] || x.route_id, headsign: x.trip_headsign || '' };
  ferryStatic = { stopName, tripInfo, stops, files }; ferryStaticAt = Date.now();
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
  const tuTrips = [], callsByTrip = {};
  decodeFeed(tuBuf, tuTrips, {});
  const nowS = Date.now() / 1000;
  for (const rec of tuTrips) {
    const calls = [];
    for (const [sid, arr] of rec.stus) if (arr >= nowS - 30)
      calls.push({ stopId: String(sid), name: st.stopName[sid] || sid, at: arr * 1000 });
    calls.sort((a, b) => a.at - b.at);
    if (calls.length) callsByTrip[rec.tid] = calls;
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
    const info = st.tripInfo[rec.tripId], calls = callsByTrip[rec.tripId] || [], nx = calls[0];
    vessels.push({ id: key, label: rec.label || key, lat: rec.lat, lon: rec.lon,
      speedMs: rec.speedMs || 0, heading,
      route: info ? info.route : '', headsign: info ? info.headsign : '',
      next: nx ? nx.name : '', nextEtaMin: nx ? Math.max(0, Math.round((nx.at / 1000 - nowS) / 60)) : null,
      calls, docked: !rec.tripId });
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
const BUS_GTFS = ['gtfs_b.zip', 'gtfs_bx.zip', 'gtfs_m.zip', 'gtfs_q.zip', 'gtfs_si.zip', 'gtfs_busco.zip'];
let busStaticFeeds = null, busStaticBusy = null;
async function getBusStaticFeeds() {
  if (busStaticFeeds) return busStaticFeeds;
  if (!busStaticBusy) busStaticBusy = Promise.all(BUS_GTFS.map(name => fetch('https://rrgtfsfeeds.s3.amazonaws.com/' + name).then(async r => {
    if (!r.ok) throw new Error('bus gtfs ' + name + ' http ' + r.status);
    return { name, files: unzip(Buffer.from(await r.arrayBuffer())) };
  }))).then(x => { busStaticFeeds = x; return x; }).finally(() => { busStaticBusy = null; });
  return busStaticBusy;
}
async function fetchTransitStops() {
  const [busZips, ferry] = await Promise.all([getBusStaticFeeds(), getFerryStatic()]);
  const busStops = [], seen = new Set();
  for (const feed of busZips) {
    const raw = feed.files['stops.txt'];
    if (!raw) throw new Error('bus gtfs ' + feed.name + ' missing stops.txt');
    for (const x of csvObjects(raw.toString('utf8'))) {
      const lat = Number(x.stop_lat), lon = Number(x.stop_lon), name = String(x.stop_name || '').trim();
      if (!name || !isFinite(lat) || !isFinite(lon) || lat < 40.48 || lat > 40.93 || lon < -74.27 || lon > -73.68) continue;
      const key = name + '|' + lat.toFixed(5) + '|' + lon.toFixed(5);
      if (seen.has(key)) continue;
      const stopId = String(x.stop_id || '').replace(/^MTA_/, '');
      seen.add(key); busStops.push({ id: feed.name.slice(5, -4) + ':' + x.stop_id, stopId, name, lat, lon });
    }
  }
  const ferryStops = [], ferrySeen = new Set();
  for (const st of ferry.stops || []) {
    const key = st.name + '|' + st.lat.toFixed(5) + '|' + st.lon.toFixed(5);
    if (ferrySeen.has(key)) continue;
    ferrySeen.add(key); ferryStops.push(st);
  }
  if (!busStops.length || !ferryStops.length) throw new Error('static transit stops empty');
  return { busStops, ferryStops };
}
async function fetchTransitSchedule(mode, stopIds) {
  const wanted = new Set(stopIds.filter(x => /^[A-Za-z0-9_-]{1,40}$/.test(x)).slice(0, 120));
  if (!wanted.size) return {};
  const now = Date.now(), out = {};
  if (mode === 'ferry') Object.assign(out, scheduledAtStops((await getFerryStatic()).files, wanted, now));
  else if (mode === 'bus') for (const feed of await getBusStaticFeeds()) {
    const part = scheduledAtStops(feed.files, wanted, now);
    for (const [sid, rows] of Object.entries(part)) (out[sid] ||= []).push(...rows);
  }
  else throw new Error('bad transit mode');
  for (const sid of Object.keys(out)) out[sid] = out[sid].sort((a, b) => a.at - b.at).slice(0, 3);
  return out;
}
const busPrev = new Map(); // id → { lat, lon, t } for speed derivation
/* SIRI VehicleMonitoring enriches GTFS-rt with per-vehicle destinations.
   It is 2 MB and ~13 s upstream, so it refreshes lazily every 2 min in the
   background and NEVER blocks the 15 s position poll; without it (or before
   the first load) buses simply have no headsign. */
let siriDest = new Map(), siriCalls = new Map(), siriAt = 0, siriBusy = null;
function prettyDest(s) {
  if (!s) return '';
  s = s.split(' via ')[0].split(' VIA ')[0].trim();
  return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\s+/g, ' ');
}
function refreshSiri() {
  if (siriBusy || Date.now() - siriAt < 120_000) return;
  siriBusy = (async () => {
    const r = await fetch('https://bustime.mta.info/api/siri/vehicle-monitoring.json?key=' +
      encodeURIComponent(busKey) + '&version=2&VehicleMonitoringDetailLevel=calls&MaximumNumberOfCallsOnwards=12', { redirect: 'follow' });
    if (!r.ok) throw new Error('siri http ' + r.status);
    const j = await r.json();
    const va = j?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity;
    if (!Array.isArray(va)) throw new Error('siri shape');
    const m = new Map(), cm = new Map();
    const one = v => Array.isArray(v) ? v[0] : v;
    for (const a of va) {
      const mv = a.MonitoredVehicleJourney;
      if (!mv || !mv.VehicleRef) continue;
      const vehicleId = String(one(mv.VehicleRef) || '');
      const d = one(mv.DestinationName);
      if (d) m.set(vehicleId, prettyDest(d));
      const calls = [], addCall = c => {
        if (!c) return;
        const stopId = String(one(c.StopPointRef) || '').replace(/^MTA_/, '');
        const at = Date.parse(one(c.ExpectedArrivalTime) || one(c.AimedArrivalTime) || '');
        if (stopId && isFinite(at)) calls.push({ stopId, at });
      };
      addCall(mv.MonitoredCall);
      const onward = mv.OnwardCalls && mv.OnwardCalls.OnwardCall;
      for (const c of Array.isArray(onward) ? onward : onward ? [onward] : []) addCall(c);
      if (calls.length) {
        const unique = new Map();
        for (const c of calls) if (!unique.has(c.stopId) || c.at < unique.get(c.stopId).at) unique.set(c.stopId, c);
        cm.set(vehicleId, [...unique.values()]);
      }
    }
    if (m.size || cm.size) {
      siriDest = m; siriCalls = cm; siriAt = Date.now();
      console.log('[buses] siri arrivals refreshed:', cm.size);
    }
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
      speedMs: Math.round(speedMs * 10) / 10, dest: siriDest.get(rec.id) || '', calls: siriCalls.get(rec.id) || [] });
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

/* ---------- /api/traffic — NYC DOT real-time link speeds (keyless) ----------
   linkdata.nyctmc.org serves the DOT/TRANSCOM sensor export directly (Socrata's
   i4gi-tjb9 mirrors it with a few minutes' lag — used as the fallback). Gotchas
   probed live: the txt's `linkPoints` column is TRUNCATED at ~256 chars, so
   geometry comes from `EncodedPolyLine` (Google polyline, precision 5); dead
   sensors report status ≠ 0, speed 0, or epoch-1978 timestamps. Timestamps are
   ET wall clock with no zone marker. Contract (speed mph, tt seconds):
   { links: [{ id, speed, tt, name, borough, pts: [[lat,lon],…] }] } */
const TRAFFIC_BBOX = { latMin: 40.55, latMax: 40.92, lonMin: -74.10, lonMax: -73.75 };
function parseET(s) { // "7/7/2026 13:04:17" or "2026-07-07T13:04:17.000" — ET wall clock → epoch ms
  const m = s.match(/(?:(\d+)\/(\d+)\/(\d+)|(\d{4})-(\d{2})-(\d{2})T)\D*(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  const asUTC = m[1] ? Date.UTC(+m[3], +m[1] - 1, +m[2], +m[7], +m[8], +m[9])
                     : Date.UTC(+m[4], +m[5] - 1, +m[6], +m[7], +m[8], +m[9]);
  // DST-aware ET offset at that moment: render the instant as an ET wall string,
  // re-parse it AS UTC (the trailing ' UTC' pins the zone), diff = the offset
  const off = asUTC - Date.parse(new Date(asUTC).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' UTC');
  return asUTC + off;
}
function decodePolyline(str) { // Google encoded polyline, precision 5
  const pts = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (let ref = 0; ref < 2; ref++) {
      let sh = 0, res = 0, b;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
      const d = (res & 1) ? ~(res >> 1) : (res >> 1);
      if (ref === 0) lat += d; else lon += d;
    }
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}
function thinPts(pts, minM = 55, cap = 40) { // resample: keep shape, cap payload
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1];
    if (Math.hypot((pts[i][0] - p[0]) * 110540, (pts[i][1] - p[1]) * 84392) >= minM) out.push(pts[i]);
    if (out.length >= cap - 1) break;
  }
  out.push(pts[pts.length - 1]);
  return out;
}
async function fetchTraffic() {
  const r5t = (v) => Math.round(v * 1e5) / 1e5;
  const rows = [];
  try {
    const r = await fetch('https://linkdata.nyctmc.org/data/LinkSpeedQuery.txt');
    if (!r.ok) throw new Error('nyctmc http ' + r.status);
    const lines = (await r.text()).trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split('\t').map(s => s.replace(/\r$/, '').replace(/^"|"$/g, ''));
      if (f.length < 13) continue;
      rows.push({ id: f[5], speed: +f[1], tt: +f[2], status: +f[3], asOf: parseET(f[4]),
                  enc: f[7], borough: f[11], name: f[12] });
    }
    if (!rows.length) throw new Error('nyctmc parsed empty');
  } catch (e) {
    const r = await fetch('https://data.cityofnewyork.us/resource/i4gi-tjb9.json?$limit=800&$order=data_as_of%20DESC');
    if (!r.ok) throw new Error('socrata http ' + r.status + ' (after ' + (e.message || e) + ')');
    const seen = new Set();
    for (const x of await r.json()) {
      if (seen.has(x.link_id)) continue; // rows are per-reading: keep the freshest per link
      seen.add(x.link_id);
      rows.push({ id: x.link_id, speed: +x.speed, tt: +x.travel_time, status: +x.status,
                  asOf: parseET(x.data_as_of || ''), enc: x.encoded_poly_line || '',
                  borough: x.borough || '', name: x.link_name || '' });
    }
    console.log('[traffic] nyctmc failed (' + (e.message || e) + ') → served Socrata fallback');
  }
  const B = TRAFFIC_BBOX, links = [];
  for (const l of rows) {
    if (l.status !== 0 || !(l.speed > 0)) continue;          // dead / no-reading sensors
    if (Date.now() - l.asOf > 45 * 60_000) continue;          // stale reading
    if (l.borough === 'Staten Island') continue;              // no land built there
    let pts;
    try { pts = decodePolyline(l.enc); } catch { continue; }
    pts = pts.filter(p => p[0] > B.latMin && p[0] < B.latMax && p[1] > B.lonMin && p[1] < B.lonMax);
    if (pts.length < 2) continue;
    links.push({ id: l.id, speed: Math.round(l.speed * 10) / 10, tt: Math.round(l.tt),
      name: l.name, borough: l.borough, pts: thinPts(pts).map(p => [r5t(p[0]), r5t(p[1])]) });
  }
  if (!links.length) throw new Error('traffic: all rows filtered');
  return { links };
}

/* ---------- /api/traffic-events — 511NY incidents + closures (keyless) ----------
   getevents responds without a key (statewide, ~3 MB — hence the long TTL and the
   server-side trim). Only accidentsAndIncidents + closures pass the filter:
   roadwork/specialEvents/transitOperations are long-horizon notices, not live
   traffic state. Contract:
   { events: [{ id, kind, sev, road, dir, desc, lat, lon }] } (kind incident|closure) */
async function fetchTrafficEvents() {
  const r5t = (v) => Math.round(v * 1e5) / 1e5;
  const r = await fetch('https://511ny.org/api/getevents?format=json');
  if (!r.ok) throw new Error('511ny http ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) throw new Error('511ny empty');
  const KIND = { accidentsAndIncidents: 'incident', closures: 'closure' };
  const B = TRAFFIC_BBOX, events = [];
  for (const e of j) {
    const kind = KIND[e.EventType];
    if (!kind) continue;
    if (!(e.Latitude > B.latMin && e.Latitude < B.latMax && e.Longitude > B.lonMin && e.Longitude < B.lonMax)) continue;
    // standing regulatory notices (511NY files truck bans as "incidents") — signage, not live events;
    // midtown alone has dozens and they drown the real incidents
    if (/commercial vehicle ban|truck restriction/i.test(e.Description || '')) continue;
    events.push({ id: String(e.ID || ''), kind,
      sev: e.Severity === 'Major' ? 2 : e.Severity === 'Minor' ? 1 : 0,
      road: e.RoadwayName || '', dir: e.DirectionOfTravel || '',
      desc: (e.Description || '').slice(0, 220), lat: r5t(e.Latitude), lon: r5t(e.Longitude) });
    if (events.length >= 400) break;
  }
  if (!events.length) throw new Error('511ny all filtered');
  return { events };
}

/* ---------- /api/traffic-local[/:day] — E-ZPass local street speeds (NYC DOT) ----------
   DOT reads E-ZPass tags at fixed antennas on NORMAL streets (the Midtown-in-Motion
   network, ~290 links citywide / ~137 Manhattan) and publishes rolling 15-min median
   speeds per link on the open-data portal (6a2s-2t65; keyless Socrata). The catch:
   rows land in daily batches ~1.5–2 days behind, so this is NOT live — it serves
   full-day HOURLY speed profiles for a published day. The client colors each link by
   the profile hour matching the viewed wall clock: a clearly-labeled "recent typical"
   baseline in Live mode, and the day's real measurements during a timeline replay
   (which is why replay fetches the day here instead of the snapshot recorder — the
   published archive IS the recording). Speeds arrive in ft/s → served as mph.
   Contract: { day, links: [{ id, name, borough, pts: [[lat,lon],…], spd: [24 × mph|null] }] } */
const EZ_URL = 'https://data.cityofnewyork.us/resource/6a2s-2t65.json';
async function fetchTrafficLocalDay(day) {
  const r5t = (v) => Math.round(v * 1e5) / 1e5;
  const q = '?$select=' + encodeURIComponent(
      'sid,link_name,borough,polyline,date_extract_hh(median_calculation_timestamp) AS hh,avg(median_speed_fps) AS v') +
    '&$where=' + encodeURIComponent(
      `median_calculation_timestamp between '${day}T00:00:00' and '${day}T23:59:59' AND n_samples > 0 AND median_speed_fps > 0`) +
    '&$group=' + encodeURIComponent('sid,link_name,borough,polyline,hh') + '&$limit=12000';
  const r = await fetch(EZ_URL + q);
  if (!r.ok) throw new Error('ezpass http ' + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error('ezpass shape');
  const byId = new Map();
  const B = TRAFFIC_BBOX;
  for (const x of rows) {
    if (x.borough === 'Staten Island') continue;
    let L = byId.get(x.sid);
    if (!L) {
      let pts;
      try { pts = decodePolyline(x.polyline || ''); } catch { continue; }
      pts = pts.filter(p => p[0] > B.latMin && p[0] < B.latMax && p[1] > B.lonMin && p[1] < B.lonMax);
      if (pts.length < 2) continue;
      L = { id: x.sid, name: x.link_name || '', borough: x.borough || '',
            pts: thinPts(pts).map(p => [r5t(p[0]), r5t(p[1])]), spd: new Array(24).fill(null) };
      byId.set(x.sid, L);
    }
    const hh = +x.hh, mph = (+x.v) * 0.681818; // ft/s → mph
    if (hh >= 0 && hh < 24 && mph > 0) L.spd[hh] = Math.round(mph * 10) / 10;
  }
  const links = [...byId.values()];
  if (links.length < 30) throw new Error('ezpass ' + day + ' sparse (' + links.length + ' links) — likely unpublished');
  return { day, links };
}
const ezDayCache = new Map(); // day → { at, body } (published days are immutable)
async function trafficLocalByDay(day) {
  const hit = ezDayCache.get(day);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.body;
  const body = await fetchTrafficLocalDay(day);
  if (ezDayCache.size >= 10) ezDayCache.clear();
  ezDayCache.set(day, { at: Date.now(), body });
  return body;
}
async function fetchTrafficLocalLatest() {
  const r = await fetch(EZ_URL + '?$select=' + encodeURIComponent('max(median_calculation_timestamp) AS m'));
  if (!r.ok) throw new Error('ezpass max http ' + r.status);
  const m = (await r.json())[0]?.m;
  if (!m) throw new Error('ezpass max empty');
  let day = m.slice(0, 10);
  try { return await trafficLocalByDay(day); }
  catch { // trailing day partially published → step back one
    day = new Date(Date.parse(day + 'T12:00:00Z') - 86_400_000).toISOString().slice(0, 10);
    return trafficLocalByDay(day);
  }
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

/* ---------- /api/birds — live bird migration over Manhattan (BirdCast) ----------
   Cornell Lab's BirdCast publishes radar-derived migration measurements to a
   public S3 bucket every 10 minutes: dashboard/YYYY/MM/DD/livemig_gen-*.csv.gz
   (one row per county; the same numbers that power dashboard.birdcast.org).
   We read the latest file and keep the New York County (Manhattan) row.
   Columns: mtr (birds/km/h), ff (speed m/s), dd (direction toward, deg true),
   height_mean/max (m AGL), birds_aloft, part_of_day D/N.
   Data credit: BirdCast — Cornell Lab of Ornithology / CSU / UMass Amherst. */
const BC_S3 = 'https://is-birdcast-observed-prod.s3.us-east-1.amazonaws.com';
async function bcLatestKey(daysBack) {
  const d = new Date(Date.now() - daysBack * 86400_000);
  const p = `dashboard/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/`;
  const r = await fetch(`${BC_S3}/?list-type=2&prefix=${encodeURIComponent(p)}&max-keys=500`);
  if (!r.ok) throw new Error('birdcast list http ' + r.status);
  const keys = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]).sort();
  return keys[keys.length - 1] || null;
}
const BC_COUNTIES = { mn: 'US-NY-061', bk: 'US-NY-047', qn: 'US-NY-081', bx: 'US-NY-005' };
function bcSeason() { // NYC migration phenology — stable knowledge, keeps low counts in context
  const d = new Date(), doy = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400_000);
  if (doy >= 60 && doy <= 160) return { phase: 'spring migration',
    note: 'Northbound migration (Mar–early Jun), peaking late Apr–May; biggest flights after dark on warm south winds.' };
  if (doy > 160 && doy < 213) return { phase: 'breeding season',
    note: 'Mid Jun–Jul: local breeding and dispersal; nocturnal migration is minimal, so low radar counts are normal and expected.' };
  if (doy >= 213 && doy <= 335) return { phase: 'fall migration',
    note: 'Southbound migration (Aug–Nov), peaking Sep–Oct; big flights typically follow cold fronts with north winds.' };
  return { phase: 'winter', note: 'Dec–Feb: migration is over; radar counts stay near zero until March.' };
}
async function fetchBirds() {
  const key = (await bcLatestKey(0)) || (await bcLatestKey(1)); // just after 00:00 UTC today's dir is empty
  if (!key) throw new Error('birdcast: no recent files');
  const r = await fetch(BC_S3 + '/' + key);
  if (!r.ok) throw new Error('birdcast file http ' + r.status);
  const csv = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
  const lines = csv.split('\n');
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; }; // 'NA' → 0
  const boroughs = {}; let t = '', night = false;
  for (const [bo, county] of Object.entries(BC_COUNTIES)) {
    const row = lines.find(l => l.startsWith(county + ','));
    if (!row) continue;
    const c = row.split(',');
    t = c[1]; night = night || c[4] === 'N';
    boroughs[bo] = { aloft: Math.round(num(c[12])), dirDeg: num(c[9]), speedMs: num(c[8]),
      hMeanM: num(c[10]), hMaxM: num(c[11]), mtr: num(c[6]), passed: Math.round(num(c[13])),
      enabled: c[5] === 'TRUE' }; // BirdCast's own confidence flag: FALSE = daytime/off-season noise tier
  }
  if (!boroughs.mn) throw new Error('birdcast: US-NY-061 row missing');
  // citywide rollup: counts sum; direction is the aloft-weighted circular mean;
  // speed/heights are aloft-weighted means (hMax = the max anywhere)
  let aloft = 0, passed = 0, vx = 0, vz = 0, sw = 0, hw = 0, hMaxM = 0;
  for (const b of Object.values(boroughs)) {
    aloft += b.aloft; passed += b.passed;
    const w = Math.max(b.aloft, 0.001), a = (b.dirDeg * Math.PI) / 180;
    vx += Math.sin(a) * w; vz += Math.cos(a) * w;
    sw += b.speedMs * w; hw += b.hMeanM * w; hMaxM = Math.max(hMaxM, b.hMaxM);
  }
  const wTot = Object.values(boroughs).reduce((s, b) => s + Math.max(b.aloft, 0.001), 0);
  const dirDeg = ((Math.atan2(vx, vz) * 180) / Math.PI + 360) % 360;
  let pct = null;
  try { // rank tonight against our recorded nights (needs ≥3 snapshots carrying birds data)
    const man = await fetchHistory('manifest.json', 3_600_000);
    const past = [];
    for (const rel of (man.daily || []).slice(-14)) {
      const d = (rel.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      if (!d) continue;
      const f = await fetchHistory('daily/' + d + '.json', 86_400_000).catch(() => null);
      if (f && f.birds && typeof f.birds.passed === 'number') past.push(f.birds.passed);
    }
    if (past.length >= 3) pct = Math.round(100 * past.filter(v => v <= passed).length / past.length);
  } catch { /* history not reachable yet — percentile stays null */ }
  return {
    t, night, aloft, dirDeg, speedMs: sw / wTot, hMeanM: hw / wTot, hMaxM,
    mtr: boroughs.mn.mtr, passed, pct, boroughs,
    enabled: Object.values(boroughs).some(b => b.enabled),
    season: bcSeason(), // phenology context for the agent — deliberately NOT shown in the UI
    credit: 'BirdCast · Cornell Lab of Ornithology'
  };
}

/* ---------- /api/nyc311 — live 311 service requests (NYC Open Data, keyless Socrata) ----------
   The newest 250 geo-tagged requests from the last 48 h, served as compact rows
   (same array-schema convention as the recorder frames). erm2-nwe9 updates continuously. */
const PM25_BREAKS = [[0, 9, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500]];
function pm25Aqi(value) {
  const c = Math.floor(Math.max(0, value) * 10) / 10;
  const b = PM25_BREAKS.find(x => c >= x[0] && c <= x[1]);
  if (!b) return c > 325.4 ? 500 : null;
  return Math.round((b[3] - b[2]) / (b[1] - b[0]) * (c - b[0]) + b[2]);
}
function pmNowcastConcentration(values, referenceTime = values[0] && values[0].t) {
  if (!values.length || !isFinite(referenceTime)) return null;
  const recent = values.filter(v => referenceTime - v.t >= 0 && referenceTime - v.t < 12 * 3600_000);
  if (recent.filter(v => referenceTime - v.t < 3 * 3600_000).length < 2) return null;
  const lo = Math.min(...recent.map(v => v.v)), hi = Math.max(...recent.map(v => v.v));
  const weight = hi === 0 ? 1 : Math.max(0.5, 1 - (hi - lo) / hi);
  let sum = 0, weights = 0;
  for (const v of recent) {
    const w = weight ** Math.max(0, Math.round((referenceTime - v.t) / 3600_000));
    sum += v.v * w; weights += w;
  }
  return weights ? Math.round(sum / weights * 1000) / 1000 : null;
}
function pmNowcast(values, referenceTime) {
  const concentration = pmNowcastConcentration(values, referenceTime);
  return concentration == null ? null : pm25Aqi(concentration);
}
async function fetchAirQuality() {
  const [data, airNow] = await Promise.all([loadNyccas(), loadAirNow().catch(error => {
    console.warn('[air-quality] airnow_failed', String(error.message || error).slice(0, 120));
    return null;
  })]);
  const rows = [], averageStart = data.observedAt - 24 * 3600_000;
  for (const history of data.histories.values()) {
    const latest = history[0], prev = history.find(x => latest.observedAt - x.observedAt >= 30 * 60_000 && latest.observedAt - x.observedAt <= 90 * 60_000);
    const delta = prev ? Math.round((latest.value - prev.value) * 10) / 10 : null;
    const recent = history.filter(x => latest.observedAt - x.observedAt <= 12 * 3600_000);
    const peak = recent.reduce((max, x) => x.value > max.value ? x : max, recent[0]);
    const averageRows = history.filter(x => x.observedAt > averageStart && x.observedAt <= data.observedAt);
    const average24h = averageRows.length > 17 ? averageRows.reduce((sum, x) => sum + x.value, 0) / 24 : null;
    const nowcastConcentration = pmNowcastConcentration(history.map(x => ({ t: x.observedAt, v: x.value })), data.observedAt);
    rows.push([latest.siteId, latest.name, +latest.lat.toFixed(5), +latest.lon.toFixed(5), +latest.value.toFixed(1),
      Math.round(latest.observedAt / 60000), delta, nowcastConcentration == null ? null : pm25Aqi(nowcastConcentration),
      +peak.value.toFixed(1), Math.round(peak.observedAt / 60000),
      average24h == null ? null : +average24h.toFixed(2), averageRows.length,
      nowcastConcentration == null ? null : +nowcastConcentration.toFixed(2)]);
  }
  rows.sort((a, b) => a[1].localeCompare(b[1]));
  if (!rows.length) throw new Error('nyccas no stations');
  return { source: 'nyccas', observedAt: data.observedAt, rows,
    fields: 'siteId,name,lat,lon,latestHourlyPm25,observedEpochMin,delta1h,nowcastAqi,peak12hPm25,peak12hEpochMin,average24hPm25,average24hObservationCount,nowcastPm25',
    citation: 'NYC Health + Queens College — NYCCAS', stationCount: rows.length,
    selectedSource: data.selectedSource, sourceChanged: data.sourceChanged,
    sourceConflictCount: data.sourceConflictCount, sourceLagMinutes: data.sourceLagMinutes,
    sources: data.sources, airNow };
}

async function fetchNyc311() {
  const r5t = (v) => Math.round(v * 1e5) / 1e5;
  const since = new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 19);
  const q = '?$select=' + encodeURIComponent('created_date,complaint_type,descriptor,incident_address,borough,status,latitude,longitude') +
    '&$where=' + encodeURIComponent(`created_date > '${since}' AND latitude IS NOT NULL`) +
    '&$order=created_date%20DESC&$limit=250';
  const r = await fetch('https://data.cityofnewyork.us/resource/erm2-nwe9.json' + q,
    { headers: { 'User-Agent': 'city-twin' } });
  if (!r.ok) throw new Error('nyc311 http ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('nyc311 shape');
  const rows = [];
  for (const e of j) {
    const lat = parseFloat(e.latitude), lon = parseFloat(e.longitude);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    rows.push([r5t(lat), r5t(lon), e.complaint_type || '', (e.descriptor || '').slice(0, 120),
      e.incident_address || '', e.borough || '', e.status || '',
      Math.round(Date.parse(e.created_date) / 60000) || 0]);
  }
  return { rows, fields: 'lat,lon,type,descriptor,address,borough,status,createdEpochMin' };
}

/* ---------- /api/nwsalerts — active NWS watches/warnings for the five boroughs ----------
   api.weather.gov requires a descriptive User-Agent; alerts filtered to NYC counties. */
async function fetchNwsAlerts() {
  const r = await fetch('https://api.weather.gov/alerts/active?area=NY', {
    headers: { 'User-Agent': 'manhattan-island-city-twin (github.com/davidfromkansas/nycsim)',
               Accept: 'application/geo+json' }
  });
  if (!r.ok) throw new Error('nws http ' + r.status);
  const j = await r.json();
  const NYC = /New York \(Manhattan\)|Kings \(Brooklyn\)|Queens|Bronx|Richmond \(Staten Island\)|New York County|Kings County|Richmond County/i;
  const alerts = [];
  for (const f of (j.features || [])) {
    const p = f.properties || {};
    if (!NYC.test(p.areaDesc || '')) continue;
    alerts.push({ id: p.id || f.id || '', event: p.event || '', severity: p.severity || '',
      headline: (p.headline || '').slice(0, 200), ends: p.ends || p.expires || null });
    if (alerts.length >= 10) break;
  }
  return { alerts };
}

/* ---------- /api/headlines — amNewYork + THE CITY RSS, merged (zero-dep parse) ---------- */
function parseRss(xml, src, cap) {
  const items = [];
  const unesc = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0?39;|&apos;|&#8217;/g, '’')
    .replace(/&quot;|&#822[01];/g, '"').replace(/&#8211;|&#8212;/g, '–').trim();
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const it = m[0];
    const t = (it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1];
    const url = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1];
    const pd = (it.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1];
    if (!t || !url) continue;
    items.push({ t: unesc(t), url: unesc(url), src, at: Date.parse(pd || '') || 0 });
    if (items.length >= cap) break;
  }
  return items;
}
async function fetchHeadlines() {
  const FEEDS = [
    ['https://www.amny.com/feed/', 'amNY'],
    ['https://www.thecityreporter.nyc/feed/', 'THE CITY']
  ];
  const settled = await Promise.allSettled(FEEDS.map(async ([url, src]) => {
    const r = await fetch(url, { headers: { 'User-Agent': 'city-twin' } });
    if (!r.ok) throw new Error(src + ' http ' + r.status);
    return parseRss(await r.text(), src, 20);
  }));
  const items = settled.flatMap(s => s.status === 'fulfilled' ? s.value : []);
  if (!items.length) throw new Error('headlines: both feeds failed');
  items.sort((a, b) => b.at - a.at);
  return { items: items.slice(0, 30) };
}

/* ---------- /api/history — recorded daily snapshots (repo `data` branch) ----------
   The nightly cron (api/record.js) commits data/daily/YYYY-MM-DD.json there;
   this proxies them to the client (repo is private, so the GH_DATA_TOKEN that
   writes the snapshots also reads them back). Day files are immutable once
   written; the manifest churns daily. */
const HIST_REPO = 'davidfromkansas/nycsim';
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
  if (histCache.size >= 72) histCache.clear(); // 30 daily city + AQ files, plus manifest headroom
  histCache.set(rel, { at: Date.now(), body });
  return body;
}

/* ---------- route registrations (one line each — the recipe) ---------- */
makeCachedRoute('/api/flights', FLIGHTS_TTL, fetchFlights, { source: 'none', ac: [] });
makeCachedRoute('/api/weather', 300_000, fetchWeather, { source: 'none', current: null });
makeCachedRoute('/api/subway', 20_000, fetchSubway, { trips: [], vehStatus: {} });
makeCachedRoute('/api/subway/stations', 86_400_000, fetchStations, { rows: [] });
makeCachedRoute('/api/ferries', 15_000, fetchFerries, { vessels: [] });
makeCachedRoute('/api/transit-stops', 86_400_000, fetchTransitStops, { busStops: [], ferryStops: [] });
makeCachedRoute('/api/cams', 600_000, fetchCams, { cams: [] }); // camera list churns slowly; images are fetched live per-view
makeCachedRoute('/api/buses', 15_000, fetchBuses, { buses: [] }); // dormant (empty) until an MTA Bus Time key is configured
makeCachedRoute('/api/citibike', 30_000, fetchCitibike, { stations: [] });
makeCachedRoute('/api/traffic', 60_000, fetchTraffic, { links: [] }); // DOT sensors report every few minutes
makeCachedRoute('/api/traffic-events', 180_000, fetchTrafficEvents, { events: [] }); // 3 MB upstream: poll gently
makeCachedRoute('/api/traffic-local', 1_800_000, fetchTrafficLocalLatest, { day: '', links: [] }); // E-ZPass publishes in daily batches
makeCachedRoute('/api/birds', 300_000, fetchBirds, { aloft: 0, night: false }); // BirdCast S3 file lands every 10 min
makeCachedRoute('/api/nyc311', 300_000, fetchNyc311, { rows: [] }); // Socrata updates continuously; 5 min is plenty for 250 pins
makeCachedRoute('/api/air-quality', 60_000, fetchAirQuality, { source: 'nyccas', rows: [], stationCount: 0 });
makeCachedRoute('/api/nwsalerts', 300_000, fetchNwsAlerts, { alerts: [] });
makeCachedRoute('/api/headlines', 600_000, fetchHeadlines, { items: [] }); // newsroom cadence: 10 min

/* ---------- shared request dispatcher for /api/* (Node req/res) ---------- */
async function handleApi(pathname, res) {
  if (pathname === '/api/history' || pathname.startsWith('/api/history/')) {
    try {
      if (pathname === '/api/history') return sendJSON(res, await fetchHistory('manifest.json', 300_000), 200,
        'public, max-age=0, s-maxage=300, stale-while-revalidate=600'); // manifest churns daily
      const aqMatch = pathname.match(/^\/api\/history\/air-quality\/(\d{4}-\d{2}-\d{2})$/);
      if (aqMatch) return sendJSON(res, await fetchHistory('air-quality/' + aqMatch[1] + '.json', 3_600_000), 200,
        'public, max-age=0, s-maxage=3600');
      const day = pathname.slice('/api/history/'.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJSON(res, { error: 'bad day' }, 400);
      return sendJSON(res, await fetchHistory('daily/' + day + '.json', 3_600_000), 200,
        'public, max-age=0, s-maxage=3600'); // day files are immutable once written
    } catch (e) { return sendJSON(res, { error: String(e.message || e) }, 502); }
  }
  if (pathname.startsWith('/api/transit-schedule/')) {
    const rest = pathname.slice('/api/transit-schedule/'.length), slash = rest.indexOf('/');
    const mode = slash < 0 ? '' : rest.slice(0, slash), ids = slash < 0 ? [] : decodeURIComponent(rest.slice(slash + 1)).split(',');
    try { return sendJSON(res, { now: Date.now(), arrivals: await fetchTransitSchedule(mode, ids) }, 200,
      'public, max-age=0, s-maxage=300, stale-while-revalidate=600'); }
    catch (e) { return sendJSON(res, { now: Date.now(), arrivals: {}, error: String(e.message || e) }, 502); }
  }
  if (pathname.startsWith('/api/route/')) {
    const cs = decodeURIComponent(pathname.slice('/api/route/'.length)).slice(0, 12);
    const route = await fetchRoute(cs);
    return sendJSON(res, { now: Date.now(), route }, 200,
      route ? 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' : null); // negatives stay uncached
  }
  if (pathname.startsWith('/api/traffic-local/')) { // specific published day (timeline replay)
    const day = pathname.slice('/api/traffic-local/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJSON(res, { error: 'bad day' }, 400);
    try { return sendJSON(res, { now: Date.now(), ...(await trafficLocalByDay(day)) }, 200,
      'public, max-age=0, s-maxage=3600'); } // published day files are immutable
    catch (e) { return sendJSON(res, { now: Date.now(), day, links: [], error: String(e.message || e) }); } // unpublished day: empty, client falls back
  }
  if (pathname === '/api/live') {
    /* PERF.md workstream D: one consolidated snapshot instead of 9 independent
       pollers — composed purely from the per-route caches above (no new upstream
       calls; the per-feed endpoints remain for the recorder/concierge/history).
       A slow upstream must not stall the snapshot: each feed gets a bounded wait,
       and a feed that isn't ready ships its last-good (or empty) state with its
       own fetchedAt so the client can tell. */
    const LIVE_FEEDS = { subway: '/api/subway', buses: '/api/buses', ferries: '/api/ferries',
      flights: '/api/flights', citibike: '/api/citibike', traffic: '/api/traffic',
      trafficEvents: '/api/traffic-events', birds: '/api/birds', weather: '/api/weather',
      nyc311: '/api/nyc311', airQuality: '/api/air-quality', nwsalerts: '/api/nwsalerts', headlines: '/api/headlines' };
    const bounded = (p) => Promise.race([p, new Promise(r => setTimeout(r, 6000))]);
    await Promise.all(Object.values(LIVE_FEEDS).map(rp => { const e = routes.get(rp); return e ? bounded(ensureFresh(e)) : null; }));
    const feeds = {};
    for (const [name, rp] of Object.entries(LIVE_FEEDS)) {
      const e = routes.get(rp); if (!e) continue;
      feeds[name] = { fetchedAt: e.fetchedAt, stale: e.data === null || Date.now() - e.fetchedAt >= e.ttl + 5000,
        ...(e.data ?? e.empty) };
    }
    return sendJSON(res, { now: Date.now(), feeds }, 200,
      'public, max-age=0, s-maxage=15, stale-while-revalidate=60');
  }
  const entry = routes.get(pathname);
  if (entry) return serveCached(entry, res);
  return sendJSON(res, { error: 'unknown endpoint' }, 404);
}

module.exports = { routes, handleApi, sendJSON, trafficLocalByDay, pm25Aqi, pmNowcast, pmNowcastConcentration };
