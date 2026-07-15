# NYC Sim — live New York City in the browser

**nycsim.com** · a self-contained Three.js digital twin of all five boroughs, with the
real city flowing through it live.

- **The city**: real DCP 3D-model building massing (streamed binary chunks), the real
  CSCL street graph (86k segments), surveyed wetlands, the bridges, LGA + JFK, the
  Staten Island Railway — plus 12,703 clickable voxel residents sampled from real
  Census PUMS records, thinking Sims-style thoughts.
- **Live layers**: flights (ADS-B), subway (MTA GTFS-realtime, every trunk incl. the
  G), NYC Ferry GPS, MTA buses, Citi Bike docks, 800+ traffic cameras you can watch,
  bird migration radar (BirdCast), 311 calls, street speeds, NWS weather — rain in
  the city is rain in the sim.
- **Time travel**: a nightly recorder snapshots everything; the timeline slider
  replays the last 7 days.
- **City Concierge**: an LLM agent with spatial tools — ask it anything about what
  you're looking at and it flies the camera, draws map layers, and cites live feeds.

## Run it

```bash
node server.js      # → http://localhost:4173 — zero dependencies, no build step
```

Everything is one page (`public/index.html`) + one zero-dep data layer
(`lib/api-core.js`) shared by the local server and Vercel functions. Secrets live in
git-ignored root JSON files / Vercel env vars; every missing key degrades gracefully.

## Contributing / agents

Read **`AGENTS.md`** first — it's the onboarding doc (iron rules, testing protocol,
parallel-work discipline) and points to the current open work. `CHANGELOG.md` is the
user-facing feature history. Every push to `main` deploys production.
