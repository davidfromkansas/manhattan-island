# Manhattan Island — live NYC in the browser

A self-contained Three.js scene of New York City with **live data layers**:
real flights (OpenSky ADS-B), subway trains (MTA GTFS-realtime, 12 trunks incl. the G),
NYC Ferry vessels (real GPS), and weather (NWS station observations) — rain, snow,
fog and sun position all mirror the city right now.

- `public/index.html` — the entire scene (procedural, no assets, ~25k buildings, 3-tier LOD)
- `lib/api-core.js` — zero-dependency data layer (caching, protobuf/ZIP/CSV decoding, upstream fallbacks)
- `server.js` — local dev server: `node server.js` → http://localhost:4173
- `api/[...path].js` — the same data layer as a Vercel serverless function

## Deploy

Hosted on Vercel; every push to `main` deploys production automatically.
Secrets: `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` env vars
(locally: `opensky-credentials.json`, git-ignored). Without them the flight
layer falls back to OpenSky's anonymous tier (slower refresh).
