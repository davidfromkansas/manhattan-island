#!/usr/bin/env node
/* ============================================================
   record.mjs — the city's tape recorder. Zero dependencies.

   Fetches the live production APIs and writes ONE frame of NYC
   state, agent-readable: versioned, per-entity, keyed by the
   same stable IDs the spatial graph uses.

     node scripts/record.mjs           → 15-min texture frame
     node scripts/record.mjs --daily   → full true-replay snapshot
                                          (adds the complete subway payload)

   Layout (on the `data` branch — committing to main would
   trigger a Vercel deploy per frame):
     data/frames/YYYY/MM/DD/HHMM.json   slim frames, 15-min cadence
     data/daily/YYYY-MM-DD.json         daily replay keyframes
     data/manifest.json                 index + retention window
   Frames older than RETENTION_DAYS are pruned on each run.
   ============================================================ */
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.RECORD_BASE || 'https://manhattan-island-davidlietjauw-7177s-projects.vercel.app';
const ROOT = process.env.RECORD_ROOT || 'data';
const RETENTION_DAYS = 7;
const DAILY = process.argv.includes('--daily');

const get = async (p) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(p + ' http ' + r.status);
  return r.json();
};
const tryGet = async (p) => { try { return await get(p); } catch (e) { console.error('skip', p, String(e.message || e)); return null; } };
const r5 = (v) => Math.round(v * 1e5) / 1e5;

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const Y = now.getUTCFullYear(), M = pad(now.getUTCMonth() + 1), D = pad(now.getUTCDate());
// frame timestamps snap to the quarter hour so paths are predictable
const q = Math.floor(now.getUTCMinutes() / 15) * 15;
const stamp = `${pad(now.getUTCHours())}${pad(q)}`;

const [buses, bikes, ferries, flights, weather, subway, traffic, trafficEvents, birds] = await Promise.all([
  tryGet('/api/buses'), tryGet('/api/citibike'), tryGet('/api/ferries'),
  tryGet('/api/flights'), tryGet('/api/weather'),
  DAILY ? tryGet('/api/subway') : Promise.resolve(null),
  tryGet('/api/traffic'), tryGet('/api/traffic-events'), tryGet('/api/birds')
]);

const frame = {
  v: 1,
  t: now.toISOString(),
  kind: DAILY ? 'daily' : 'frame',
  weather: weather?.current ?? null,
  buses: (buses?.buses ?? []).map(b => [b.id.replace(/^[^_]*_/, ''), b.route, r5(b.lat), r5(b.lon),
    Math.round(b.bearing ?? -1), Math.round((b.speedMs ?? 0) * 10) / 10, b.dest || '']),
  bikes: (bikes?.stations ?? []).map(s => [s.id, s.bikes, s.ebikes, s.docks, s.on ? 1 : 0]),
  ferries: (ferries?.vessels ?? []).map(v => [v.id, v.label, r5(v.lat), r5(v.lon),
    Math.round(v.heading ?? -1), Math.round((v.speedMs ?? 0) * 10) / 10, v.route || '', v.headsign || '', v.docked ? 1 : 0]),
  flights: (flights?.ac ?? []).map(a => [a.hex, a.cs, r5(a.lat), r5(a.lon),
    Math.round(a.altM), Math.round(a.gsMs), Math.round(a.track)]),
  // BirdCast (Cornell Lab) radar migration over Manhattan
  birds: birds && typeof birds.aloft === 'number' ? { aloft: birds.aloft, dirDeg: birds.dirDeg,
    speedMs: birds.speedMs, hMeanM: birds.hMeanM, hMaxM: birds.hMaxM, night: !!birds.night, t: birds.t,
    passed: birds.passed ?? 0, pct: birds.pct ?? null, enabled: birds.enabled ?? null, boroughs: birds.boroughs ?? null } : null,
  // traffic records readings only — link geometry is re-fetched live at replay time
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
if (DAILY && subway) frame.subway = { trips: subway.trips, vehStatus: subway.vehStatus };

const rel = DAILY ? `daily/${Y}-${M}-${D}.json` : `frames/${Y}/${M}/${D}/${stamp}.json`;
const file = path.join(ROOT, rel);
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(frame));
console.log('wrote', file,
  `(${frame.buses.length} buses, ${frame.bikes.length} docks, ${frame.ferries.length} ferries, ${frame.flights.length} aircraft${DAILY ? ', + subway' : ''})`);

// ---- prune frames beyond retention (daily keyframes use the same window) ----
const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
async function prune(dir, isDayDir) {
  if (!existsSync(dir)) return;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { await prune(p, true); const rest = await readdir(p); if (!rest.length) await rm(p, { recursive: true }); }
    else if (e.name.endsWith('.json')) {
      const m = p.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
      if (m && Date.UTC(+m[1], +m[2] - 1, +m[3]) < cutoff - 86400_000) { await rm(p); console.log('pruned', p); }
    }
  }
}
await prune(path.join(ROOT, 'frames'));
await prune(path.join(ROOT, 'daily'));

// ---- manifest: what the slider (and the agent) can ask for ----
const manifest = { v: 1, updated: now.toISOString(), retentionDays: RETENTION_DAYS, frames: [], daily: [] };
async function walk(dir, into) {
  if (!existsSync(dir)) return;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, into);
    else if (e.name.endsWith('.json')) into.push(path.relative(ROOT, p));
  }
}
await walk(path.join(ROOT, 'frames'), manifest.frames);
await walk(path.join(ROOT, 'daily'), manifest.daily);
manifest.frames.sort(); manifest.daily.sort();
await writeFile(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest));
console.log('manifest:', manifest.frames.length, 'frames,', manifest.daily.length, 'daily snapshots');
