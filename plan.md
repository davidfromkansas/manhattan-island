# Task: Backend migration — serve ALL live data (flights via OpenSky, weather, subway) from a local API server

## Goal

The scene at `~/manhattan-island/index.html` currently fetches all live data directly from
third-party APIs in the browser. This broke: the flight feed (airplanes.live) deleted its
endpoint, and every remaining flight API (OpenSky, adsb.lol, adsb.fi) is CORS-blocked from
browsers. Migrate ALL data fetching behind a small local backend so the frontend only ever
calls same-origin `/api/*`:

- **`/api/flights`** — source: **OpenSky Network** (`opensky-network.org`), per user decision.
  Must show **ALL aircraft** — airliners, GA, helicopters, military — not just commercial.
  Verified OAuth credentials are provided (see the flights section).
- **`/api/weather`** — NWS station observations (moved server-side, same merge logic).
- **`/api/subway`** + **`/api/subway/stations`** — MTA GTFS-rt + Socrata (decoder moves server-side).
- Backend caches everything and serves last-good data on upstream failure. **Every existing
  scene behavior must keep working — except now better and more reliably.**

## User-visible outcome (what success looks like to a NON-technical viewer)

This is the acceptance bar. After the migration, someone just *looking* at the scene should experience:

1. **The planes come back.** The sky has been empty (except one decorative jet) since the old
   flight feed died. Live aircraft must return — and MORE than before: airliners, small private
   planes, helicopters over the rivers, occasional military. (~90 aircraft were over NYC in the
   verification probe.)
2. **Plane labels get slightly simpler — this is expected, not a regression.** Old tags read
   "DAL123 · B738" (exact model). OpenSky doesn't know exact models, so tags will usually show
   just the flight number ("DAL123"), with a broad size class ("Heavy", "Rotorcraft") when
   known (~10% of aircraft). Destinations ("LGA → ATL") still appear.
3. **Plane positions update ~every 30 s instead of 12 s.** Planes still glide smoothly the whole
   time (dead-reckoning); a plane may occasionally be a few seconds behind reality and gently
   drift-correct. No teleporting, ever.
4. **Nothing blinks out anymore.** Previously an upstream hiccup could silently empty part of
   the scene (that's exactly how the planes vanished). Now the scene keeps showing the
   last-known picture through outages and heals automatically — trains, weather, and planes
   must never just disappear because a provider had a bad minute.
5. **Everything else is pixel-identical.** City, subway beacons + chips, live weather (rain
   falls DOWN), clock/sun, click-to-follow on planes and trains, photo mode, presets — unchanged.

Known caveat to accept: on a *cold start during an upstream outage*, planes may take time to
appear (no last-good cache yet). Once running, the scene always has something to show.

## Hard constraints

- **One new file: `server.js`** in `~/manhattan-island/`. **Zero npm dependencies** — Node 18+
  built-ins only (`node:http`, `node:fs`, global `fetch`). No package.json, no build step.
- `server.js` serves the static files (index.html) AND the `/api/*` routes on **port 4173**
  (same port as today, so nothing else changes).
- Update `~/.claude/launch.json`: the `manhattan-island` entry currently runs
  `npx -y serve -l 4173 <dir>` — change it to run `node <dir>/server.js`. Keep `"port": 4173`.
- `index.html` stays a single self-contained file (no new script tags/assets); its only change
  is *where* it fetches from + the flight-ingest adaptation described below.
- Do NOT redesign rendering, dead-reckoning, chips, click-to-follow, the mirrored canvas, or
  any visual system. This is a data-plumbing migration.

## Architecture requirement — built to scale to FUTURE data sources

This backend is not three hardcoded routes; it is a **plugin pattern** we will keep extending
(planned candidates: Citi Bike stations, ferries, traffic incidents, air quality, ship AIS).
Structure `server.js` so that adding a source is mechanical:

- A single generic helper — `makeCachedRoute(path, ttlMs, fetcher)` — owns ALL shared concerns:
  in-memory cache, lazy refresh, last-good/stale serving, `fetchedAt`/`now` stamping, error
  containment, response headers. Route-specific code is ONLY the fetcher (fetch upstream →
  normalize → return plain JSON).
- Adding a future source must require exactly: (1) one fetcher function, (2) one
  `makeCachedRoute` registration line. Nothing else. Write a short comment block at the top of
  server.js documenting this recipe for future agents.
- Fetchers must never throw uncaught; they reject and the helper serves last-good.
- Secrets (like the OpenSky credentials) are loaded server-side only, per-fetcher, and never
  reach the browser.
- Known accepted limits (do NOT over-engineer around them): in-memory cache dies on restart
  (cold refetch is fine); polling-shaped only (no websockets/streaming needed); single-process,
  single-machine (fine for local use; a future public deployment is a hosting change, not a
  redesign — don't add infra for it now).

## Context — how the frontend consumes data today

The file is ~4,300 lines, one module script. Three IIFE modules fetch live data:

1. **`flights`** (search `const flights = (() => {`): polls
   `https://api.airplanes.live/v2/point/40.71/-74.01/40` every 12 s (**dead — 404**), expects
   adsb-style records: `{ hex, flight (padded callsign), t (type "B738"), lat, lon,
   alt_baro (FEET or "ground"), gs (KNOTS), track (deg), baro_rate (FT/MIN) }`.
   Ingest converts ft→m / kt→m/s, keeps the 64 lowest, dead-reckons between polls, eases to
   fixes, removes planes **unseen 45 s** (`t - p.seen > 45`). Destinations resolved lazily from
   `https://api.adsbdb.com/v0/callsign/{CS}` (CORS-open today, but proxy it anyway).
2. **`live`** weather (search `function runFetch()`): fetches 3 NWS stations
   (`api.weather.gov/stations/{KNYC,KLGA,KEWR}/observations/latest`), merges them client-side
   (`nwsToCurrent`: freshest-first scalars, UNION of presentWeather/cloudLayers across stations,
   maps METAR → the Open-Meteo-shaped object `{temperature_2m, precipitation, rain, snowfall,
   cloud_cover, wind_speed_10m, wind_direction_10m, visibility, weather_code}` consumed by
   `applyWeather`), refreshes every 10 min, Open-Meteo as fallback (`WURL` const).
3. **`subway`** (search `const subway = (() => {`): fetches 6 MTA GTFS-rt protobuf feeds
   (`api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs{,-ace,-bdfm,-nqrw,-l,-jz}`)
   every 20 s, decodes them with a minimal protobuf wire-walker (`pbVarint`/`pbWalk`/`pbStr`/
   `decodeFeed` — plain JS, ~70 lines), producing per-trip records
   `{ tid, route, stus: [[stopId, arrEpochSec, depEpochSec], ...] }` plus a `vehStatus` Map
   (`tid → current_status`, 1 = STOPPED_AT). Stations come once from
   `https://data.ny.gov/resource/39hk-dx4f.json?$limit=1000`.

All three poll off the **frame clock** (no timers) so a backgrounded tab pauses cleanly — keep
that pattern on the frontend.

## Known pitfalls in this codebase (read before coding)

- Preview tab is usually backgrounded: **rAF is paused**; verify with screenshots (each pumps a
  frame) or eval-driven `module.update(t, dt)` calls — never timing loops.
- Changing `location.hash` does NOT reload — always `location.reload()`.
- The canvas is **CSS-mirrored** (`canvas.mirrorX`, compass-correct presentation) with a
  window-capture pointer shim; chip screen-x uses `(0.5 − ndc.x·0.5)·innerWidth`. Don't touch.
- One flat module scope — grep before adding top-level names (`RC`, `B`, `S`, `T`, `W`, `SW` taken).
- Budgets: ≤300 draw calls, 60 fps High, zero per-frame allocation, memory flat.
- Test hooks `&fakeflights=`, `&fakeweather=`, `&fakesubway=` must keep working with **zero
  network** — they bypass fetching entirely; don't route them through the backend.
- `window.__dbg` (gated by `&dbg`) exposes modules for eval-driven testing.

## Feature 1 — `server.js`

Single file, structured as: static file server + the `makeCachedRoute(path, ttlMs, fetcher)`
helper (see Architecture requirement above) + four fetchers. Cache behavior for every route:

- In-memory `{ data, fetchedAt, ok }`. On request: if fresh (< TTL) serve cached; if stale,
  refresh **lazily** (await new fetch), and on fetch failure serve **last-good** data with
  `"stale": true` and its original `fetchedAt`. Never crash a route; never return 5xx while
  last-good data exists. Every payload includes `fetchedAt` (epoch ms) and `now` (epoch ms).
- Add `Access-Control-Allow-Origin: *` + `Cache-Control: no-store` on `/api/*` responses.
- Static: serve `index.html` for `/`, correct MIME for anything else in the directory, 404 otherwise.

### `/api/flights` — OpenSky, all aircraft

- Upstream: `https://opensky-network.org/api/states/all?lamin=40.3&lomin=-74.5&lamax=41.1&lomax=-73.6&extended=1`
  (bbox ≈ 1 sq° → **1 credit per call**; `extended=1` adds the aircraft `category` field).
- **Credentials (verified working):** OAuth client-credentials are in
  **`~/manhattan-island/opensky-credentials.json`** (`{"clientId": ..., "clientSecret": ...}`).
  Live-tested: token issues successfully; the account has the **4,000 credits/day tier**
  (`x-rate-limit-remaining: 3999`); the bbox returned 90 aircraft at test time.
  - Credential loading order: env vars `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` if set,
    else read `opensky-credentials.json` from the server's directory, else run anonymous.
  - Authenticate via OAuth2 client-credentials:
    `POST https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`
    with form-encoded `grant_type=client_credentials&client_id=…&client_secret=…`. The token
    lasts ~30 min — cache it, refresh proactively at ~25 min or on any 401. If the token
    request fails, fall back to anonymous cadence rather than erroring.
  - **Cadence by tier:** authenticated → TTL **30 s** (≈2,880 calls/day, inside the 4,000
    budget); anonymous → TTL **225 s** (≈384/day, under the 400 anonymous cap). Log the
    `X-Rate-Limit-Remaining` response header on each fetch so budget drift is visible.
  - **Never log the secret; never send it to the browser** — it stays server-side only. If
    this directory ever becomes a git repo, add `opensky-credentials.json` to `.gitignore` first.
- OpenSky `states` are **arrays**, metric units. Indices: `0` icao24, `1` callsign (8-char,
  space-padded, may be empty), `5` lon, `6` lat, `7` baro_altitude (**meters**, null on ground),
  `8` on_ground (bool), `9` velocity (**m/s**), `10` true_track (deg), `11` vertical_rate
  (**m/s**), `13` geo_altitude, `17` category (int, only with extended=1).
- Filter: has lat+lon, `on_ground === false` (taxiing aircraft would slide through the borough
  massing). **Nothing else** — keep helicopters, GA, gliders, military: the user explicitly
  wants ALL airborne aircraft.
- Normalize each state to this contract (document it in a comment):
  ```json
  { "hex": "ab1628", "cs": "SCX568", "cat": 3, "catLabel": "Large",
    "lat": 40.62, "lon": -73.78, "altM": 450.5, "gsMs": 92.1,
    "track": 210.9, "vrateMs": -4.2 }
  ```
  `altM` null → use `geo_altitude`, else 0. Category → label map: 1 Light, 2 Small, 3 Large,
  4 "High-vortex", 5 Heavy, 6 "High-perf", 7 **Rotorcraft**, 0/other → "" (unknown).
  **Reality check from the live probe:** ~90% of NYC-area aircraft report `category 0`, so
  `catLabel` will usually be empty — expected, not a bug.
  Payload: `{ now, fetchedAt, stale, source: "opensky", ac: [...] }`.
- **Server-side fallback**: if OpenSky errors (network / 429 / empty), try
  `https://api.adsb.lol/v2/point/40.71/-74.01/40` (server-to-server = no CORS problem) and
  normalize its `{hex, flight, t, lat, lon, alt_baro(ft), gs(kt), track, baro_rate(ft/min)}`
  records into the SAME contract (`catLabel` ← its `t` type code; ft→m, kt→m/s). Set
  `source: "adsb.lol"`. Only if both fail, serve last-good/stale.

### `/api/route/:callsign` — destinations proxy

Proxy `https://api.adsbdb.com/v0/callsign/{CS}`; extract
`{ origin, destination }` IATA codes or `null` (404/"unknown callsign" is normal — cache the
negative). Cache per callsign forever (Map, cap ~2,000 entries), throttle upstream to 1 req/2 s
(queue), return `{ route: "LGA → ATL" | null }`.

### `/api/weather`

Move the existing `fetchNWS`/`nwsToCurrent` logic (find it inside the `live` IIFE) into
server.js **verbatim in behavior**: fetch `KNYC, KLGA, KEWR` latest observations in parallel,
require a numeric temperature, sort freshest-first, take scalars from the freshest station
that has each, take the **UNION** of `presentWeather` + `cloudLayers` across all stations
(rain anywhere in the metro = rain), derive the WMO code + intensities exactly as the client
does today, emit the same Open-Meteo-shaped `current` object. TTL **5 min**. Fallback:
Open-Meteo (`WURL` in index.html — copy it) mapped straight through. Payload:
`{ now, fetchedAt, stale, source, current: {...} }`.

### `/api/subway` + `/api/subway/stations`

- Move the protobuf wire-walker (`pbVarint`, `pbWalk`, `pbStr`, `decodeFeed`) into server.js
  unchanged (it's dependency-free JS). Fetch all 6 feed URLs in parallel
  (Promise.all, `arrayBuffer()`), decode, and emit:
  `{ now, fetchedAt, stale, trips: [{ tid, route, stus: [[sid, arr, dep], ...] }, ...],
     vehStatus: { "<tid>": <int status>, ... } }` — TTL **20 s**, single retry then last-good.
- `/api/subway/stations`: proxy the Socrata URL, TTL **24 h** (it's static reference data).

## Feature 2 — frontend migration (`index.html`)

- **Flights module**: point polling at `/api/flights` (keep the frame-clock poll pattern; poll
  every **20 s** — it's now a cheap same-origin cache read; the SERVER owns upstream cadence).
  Rewrite `ingest()` for the new contract — key changes:
  - Units are already metric: **delete the ft/kt conversions** for OpenSky records
    (`alt = a.altM`, `spd = a.gsMs`, `vy = a.vrateMs`). World velocity from `track` unchanged
    (`azW = track·π/180 − GRID_ROT`).
  - Chip line 1 becomes `**{cs}** · {catLabel}` (falls back to just the callsign when catLabel
    is ""); the type-code from the adsb.lol fallback slots into the same field. The route
    sub-line now fetches `/api/route/{cs}` instead of adsbdb directly (same lazy queue, same
    2.5 s throttle, same negative-cache behavior).
  - **CRITICAL — data age**: the payload is a snapshot taken at `fetchedAt`. On ingest, advance
    every target by its own velocity × `(Date.now() − fetchedAt)/1000` before setting it, or
    planes will jump backward on every poll.
  - **CRITICAL — stale-removal must outlive the upstream cadence**: with a 30 s upstream TTL
    (and 225 s anonymous fallback), the current `unseen > 45 s → remove` would delete planes
    between refreshes in the anonymous case. Change removal to
    `unseen > max(90, 2.5 × dataRefreshSec)` where `dataRefreshSec` is derived from observing
    `fetchedAt` changes (or simply use 600 s). Planes dead-reckon the gap — the existing 400 m
    ease/fade-teleport logic already handles corrections.
  - Keep: 64-slot cap (lowest altitude first), `dispY` altitude compression, trails, nav
    lights, distance-adaptive scale, click-to-fly/follow, `airlife.jet` decoy hide/show,
    `&fakeflights` (zero network, unchanged shape — adapt the fake ingest to the new field
    names or translate fakes at the boundary).
- **Weather**: replace the 3-station fetch + `nwsToCurrent` + Open-Meteo fallback with ONE
  fetch of `/api/weather` → `applyWeather(j.current)`. Keep the 10-min re-poll, the
  fail-fast-then-backoff behavior (5 s ×2 → 30 s → … → 16 min cap, "weather offline" only after
  3 consecutive failures), and `&fakeweather` untouched. Delete the now-dead client copies of
  `fetchNWS`/`nwsToCurrent`/`fetchOpenMeteo`.
- **Subway**: replace the 6-feed fetch + client-side `decodeFeed` with one `/api/subway` JSON
  fetch (20 s frame-clock cadence, single retry then skip, unchanged). `vehStatus` arrives as a
  plain object — adapt the `Map.get` call. Stations from `/api/subway/stations`. Delete the
  client wire-walker. Keep: corridors, geoToScene, beacons, chips, click-follow, `&fakesubway`,
  dormancy + backoff when `/api/subway` itself fails.
- Grep for any remaining third-party URLs in index.html when done — there should be ZERO
  (the only network the page touches is same-origin + the three.js CDN import).

## Verification (do ALL before calling it done)

1. `node server.js` starts clean; `curl localhost:4173/` returns the HTML;
   `curl localhost:4173/api/flights | python3 -m json.tool` shows normalized aircraft
   (log the count and `X-Rate-Limit-Remaining` — should confirm the authenticated 4,000 tier).
   Same smoke-check for `/api/weather`, `/api/subway`, `/api/subway/stations`,
   `/api/route/DAL123`.
2. Launch via the updated `.claude/launch.json` (preview tools) — scene renders identically;
   console has no NEW errors.
3. **Planes are back**: `__dbg.flights.list.length > 0` with live OpenSky data; screenshot
   shows aircraft with trails + nav lights; chips show `CS · catLabel` (usually just the
   callsign, given sparse categories); if any aircraft reports `cat 7`, confirm a Rotorcraft
   label — otherwise verify via the category histogram in `/api/flights`; click a chip →
   camera flies + follows.
4. **Age handling**: two ingests 30 s apart produce no backward jumps (eval two position
   snapshots around a forced poll; deltas must be forward-along-track).
5. **Weather**: chip matches `curl /api/weather` conditions; if it's precipitating, the veil +
   3D streaks render (rain falls DOWNWARD); kill the network → chip keeps last-known values,
   "weather offline" appears only after ~3 failures, recovers on reconnect.
6. **Subway**: beacon count within ±20% of `curl /api/subway` trips length (in-bounds subset);
   motion smooth over 40 s; chips + click-follow work.
7. **Fakes still bypass the network entirely**: `&fakeflights`, `&fakeweather`, `&fakesubway`
   each render correctly with upstreams unreachable — page must not error.
8. **Stale-serving**: blackhole the upstreams (e.g., /etc/hosts or point OpenSky at an invalid
   host temporarily), restart server: `/api/flights` returns last-good with `stale: true` if it
   had data, or a clean empty `ac: []` — the scene shows the decoy jet, no console spam.
9. **Extensibility check (the scalability promise)**: confirm that adding a hypothetical new
   source would touch only (a) one new fetcher function and (b) one `makeCachedRoute` line —
   if any shared concern (caching, stale-serving, headers, error handling) had to be
   copy-pasted per-route, refactor until it doesn't.
10. Budgets hold: draw calls unchanged (≤ ~80 total), fps 60 at High, memory flat over 5 min,
    zero per-frame allocation added.
11. Restart `server.js` while the page is open — the frontend's next polls recover without a
    reload.
12. **User-visible outcome check (final)**: walk the five bullets in the "User-visible outcome"
    section above against the live scene and confirm each one holds.

## After completion

Update `~/.claude/projects/-Users-david-lietjauw/memory/project_manhattan_island.md`: new
paragraph describing the backend (server.js routes, TTLs, the makeCachedRoute plugin recipe
for future sources, OpenSky credential file + credit math, fallback chain, the launch.json
change), and mark the old "direct third-party fetch" descriptions as superseded. Leave the
preview serving a clean `http://localhost:4173/`.
