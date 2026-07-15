# Spec: `Home` — sign in, set your address, and the city opens at YOUR block

Audience: a coding agent joining this repo to implement Home Phase 1. Read `AGENTS.md`
first — the Iron Rules and parallel-work discipline all apply.

**IMPORTANT — a complete reference implementation exists.** This feature was fully
built, tested, and shipped as commit `03bb8d3`, then deliberately reverted (the owner
wants a different agent to carry it). `git show 03bb8d3` is your best friend: every
code pattern referenced below exists there, verbatim and verified working. You may
cherry-pick it, rebuild from it, or reimplement — but read this spec first, because it
records what was VERIFIED, what was NOT, and the traps that were already sprung so you
don't spring them again. Anchors below were correct at `78ec318`/`03bb8d3`; line
numbers drift — re-verify with grep.

---

## Product definition (owner decisions — locked, do not relitigate)

1. **The feature**: a Home button. Signed out → Google sign-in modal. Signed in
   without a home → type your address once, confirm on the map, saved. From then on
   every visit boots straight to your block: a voxel-cottage beacon + light column
   marks it, a clickable 🏠 chip tracks it, and a "resident dashboard" panel shows the
   nearest live info (next trains, Citi Bike counts, buses passing, nearest ferry).
2. **RESET is retired** (decision 2026-07-14): the GBA button becomes HOME for
   everyone — signed-out tap opens sign-in, signed-in tap flies home. It falls back to
   the legacy reload-RESET ONLY when the feature is unconfigured server-side.
3. **Email stored plaintext** (decision 2026-07-14): the owner wants to read users'
   emails from the store to reach out for feedback. Private blob only — the email must
   NEVER appear in an API response, client payload, log line, or error message.
4. **Address never stored**: geocode → confirm → discard. Only coordinates (encrypted
   at rest) + borough/NTA labels persist. Public surface in Phase 1: nothing.
5. Phases: **1 = all of the above** (this spec). 2 = preferences + concierge
   "my home" context. 3 = opt-in social, neighborhood-level only. The profile schema
   reserves `prefs:{}` and `pub:false` from day one so 2/3 need no migration.

## Architecture (all verified working in the reference impl)

| Piece | File | Notes |
|---|---|---|
| Backend core | `lib/home-core.js` (new, ~280 lines) | zero-dep; sessions, crypto, blob I/O, all actions |
| Vercel function | `api/home.js` (new) | thin wrapper → `handleHome` (copy of `api/agent.js` shape) |
| Local mirror | `server.js` | one require + one route line: `if (p === '/api/home') return await handleHome(req, res);` |
| Geocode + area labels | `lib/agent-core.js` | change ONLY the last line: export `findPlace` and `whereIs` alongside the existing exports |
| Client | `public/index.html` §26f | CSS block, markup block, one §26e edit, the `homeui` module, one tick line in `frame()` |
| Secrets | `.gitignore` | `session-secret.json`, `google-oauth-client.json` (already ignored on main — keep) |

### ONE route, not nested routes (hard-won)

`vercel.json` rewrites `/api/(.*)` → `/api/index` (the cached-feed dispatcher). A real
file `api/home.js` beats the rewrite for exactly `/api/home` — but `/api/home/login`
would fall through to the dispatcher and 404. So the API is a single route:

- `GET /api/home` → `{ enabled, clientId, signedIn, name, home }` (home = `{lat, lon,
  borough, neighborhood}` or null; decrypted server-side for the owner only)
- `POST /api/home` with JSON `{ action: 'login'|'logout'|'set'|'confirm'|'delete', … }`

`enabled` is false unless ALL of `GOOGLE_CLIENT_ID`+`SESSION_SECRET`+`BLOB_READ_WRITE_TOKEN`
resolve (each: env var → git-ignored JSON file → `.env.local` for the blob token —
copy the `placesKey()` / `blobToken()` loading patterns). Any missing → the client
keeps today's behavior byte-identically. This dormant path is what makes pushing safe
before the owner configures prod; it was verified twice (local + prod).

### Auth flow

1. Client loads Google Identity Services (`https://accounts.google.com/gsi/client` —
   a CDN include like Three.js, lazily injected only when the sign-in modal opens),
   `initialize({client_id, callback, ux_mode:'popup'})` + `renderButton`. No One Tap.
2. `POST {action:'login', credential}` → server verifies via
   `https://oauth2.googleapis.com/tokeninfo?id_token=…` (Google checks the signature;
   zero crypto code) then asserts: `aud === clientId()`, `iss` ∈
   {`accounts.google.com`, `https://accounts.google.com`}, `exp` fresh,
   `email_verified === 'true'` (tokeninfo returns STRINGS), `sub`+`email` present.
3. Session cookie `mih` = `base64url({s:<subHash>, e:<now+30d ms>}) + '.' +
   HMAC-SHA256(payload, SESSION_SECRET)` (base64url digest). Flags: `Max-Age`,
   `Path=/api/home`, `HttpOnly`, `SameSite=Lax`, and `Secure` ONLY when
   `x-forwarded-proto === 'https'` (unconditional Secure breaks local curl/http
   testing). Verify with `crypto.timingSafeEqual` (guard equal lengths first).
4. CSRF: SameSite=Lax + reject POSTs whose `Content-Type` isn't `application/json`.
5. Login upserts the profile (captures `name` = given_name, `email`) even before an
   address is set — the email capture is the point.

### Profile storage (Vercel Blob, the `agent-log.js` REST pattern)

Path: `homes/<sha256('mih-v1|' + googleSub).hex.slice(0,32)>.json` in the existing
private store (`BLOB_READ_WRITE_TOKEN`, `x-api-version: 7`). Shape:

```js
{ v: 1, sub_h,                    // hash only — never the raw Google sub
  name,                           // given name, for "Welcome back, David"
  email,                          // PLAINTEXT (owner decision) — private store only
  enc,                            // base64url( iv(12) ‖ gcmTag(16) ‖ AES-256-GCM({lat,lon}) )
                                  // key = sha256(SESSION_SECRET + '|home-loc-v1')
  boro, nta,                      // public-safe labels, plaintext (Phase 3 listability)
  prefs: {}, pub: false, ts }
```

Blob REST specifics that cost time to discover:
- **Write**: `PUT https://blob.vercel-storage.com/<path>` with headers
  `x-add-random-suffix: 0` AND **`x-allow-overwrite: 1`** (without it, re-saving an
  existing profile fails), `x-vercel-blob-access: private`.
- **Read**: there is no get-by-path for private blobs — `GET ?prefix=<exact path>&limit=1`
  (list) → `blobs[0].url` → fetch that URL with the bearer token.
- **Delete**: `POST https://blob.vercel-storage.com/delete` body `{urls: [<url from list>]}`.
- Add a tiny in-process cache (60 s TTL, invalidate on write/delete) — every boot of
  every signed-in visitor does the list+get pair otherwise.

### Geocoding (reuse, don't rebuild)

Export `findPlace` + `whereIs` from `lib/agent-core.js` and call them. This inherits
the whole cost-rail stack for free (NYC locationRestriction, 24 h cache, daily budget,
429 circuit breaker, the Google-side $10/month quota cap — see plan-find-place.md).
`set` flow: append `', New York, NY'` unless the address already mentions NY; take
`results[0]`; return `{candidate:{address, lat, lon, borough, neighborhood}}` and save
NOTHING. `confirm` flow: client sends back `{lat, lon}` → validate against the NYC
bbox (`{latMin:40.45, latMax:41.05, lonMin:-74.35, lonMax:-73.55}`) → re-derive
borough/NTA server-side via `whereIs` (don't trust client labels) → encrypt + write.

**Verified end-to-end**: `"350 5th Ave, Manhattan"` → `40.74839, -73.98489`,
`Manhattan / Midtown South-Flatiron-Union Square`; blob at rest contained keys
`v,sub_h,prefs,pub,enc,boro,nta,ts` and NO plaintext coordinate substring; tampered
cookie → 401; delete removed the blob and cleared the cookie.

### Rate limiting

Copy the `rateLimited` pattern from agent-core (per-IP, per-warm-instance) at
10/min + 100/day, applied to `login` and `set` only (the geocode + Google round-trips).

## Client (§26f — the reference impl's layout, all verified rendering)

Insertion points (grep anchors):
1. **CSS** — after `body.photo #personaCard { display:none !important; }`. Pieces:
   `#homeBtn` (clone of `#fbBtn` pill), `#homeModal` (backdrop + `.hm` card, steps
   rendered into `#hmBody`), `#homePanel` (personaCard-style card, fixed left,
   `bottom:118px` desktop / `bottom:196px; left:8px` under 700px so it clears the GBA
   cluster), plus `body.photo` / `body.focusmode` hides.
2. **Markup** — `#homeBtn` inside `#brand` right before `#fbBtn`; modal + panel +
   `<div id="homeChip" class="fybl"><b>🏠 Home</b></div>` after `#thoughtTicker`.
3. **§26e one-line change** — the RESET wiring becomes:
   `wire('gbaReset', () => (window.__home && window.__home.ready) ? window.__home.act() : location.reload());`
   The home module later sets `ready = true` and swaps the label via
   `gb.dataset.l = 'HOME'` (the GBA button label is `content: attr(data-l)`).
4. **`homeui` module** — define immediately BEFORE `function frame()` (everything it
   references — `subway`, `citibike`, `ferries`, `buses`, `landOK`, `HIST`,
   `setFocus`, `resumeTour`, `camTween`, `scene`, `BufferGeometryUtils` — is module
   scope above that point). Export `window.__home = homeui`.
5. **Tick** — `homeui.tick();` right after `focusui.tick();` inside `frame()`.

Module behavior (see `03bb8d3` for the exact code):
- **Boot**: one `fetch('/api/home')`. Disabled → return (nothing changes). Enabled →
  show pill, swap GBA label, and if a home exists: place the beacon, prefetch the
  station list, and set a `pendingFly` flag — consumed on the first `tick()` so the
  flight starts once frames run. Respect the SAME deep-link guard as the auto-tour:
  skip the boot flight when `/cam=|tgt=|scrub=|snap/.test(location.hash)`.
- **Beacon**: voxel cottage (5 vertex-colored boxes merged via
  `BufferGeometryUtils.mergeGeometries`, Lambert `vertexColors` + emissive `0x9aa4b8`
  @ 0.14 — the persona pastel standard) at ground level, PLUS an additive cylinder
  beam with **`depthTest:false`, renderOrder 8** — the address block usually has real
  DCP massing on it, and without the see-through beam the house is invisible from
  altitude (cams-marker trick). +2 draw calls, only when a home is set.
  Coords: `subway.geoRaw(lat, lon)` (Iron Rule 1 — geoToWorld drifts). Assert
  `landOK` with a console.warn (real addresses are land; it's a calibration tripwire).
- **Chip**: project `(hx, 34, hz)`; hide when `ndc.z > 1` or |ndc| > 1.05; else
  `display:'block'` (Iron Rule 6) and `x = (0.5 − ndc.x·0.5)·innerWidth` (the mirror
  formula — Iron Rule 3). Click → fly home + open panel.
- **Flight**: set the global `camTween` (`p1 = home + (170, 230, −300)`, `t1 =
  (hx, 12, hz)`, dur 2.6) — `autoPan.tick` yields automatically when camTween is set,
  and canvas pointerdown/wheel cancel it like every other flight. Also
  `setFocus('home', 'Home — <neighborhood>', …)` so the concierge knows.
- **Modal steps** (`auth` → `addr` → `confirm` → done; `hub` for the signed-in
  manage view: Fly home / Change address / Sign out / Delete my data):
  - The address `<input>` MUST `stopPropagation` on keydown — the global key handler
    binds 0-6/H/P/L unconditionally (AGENTS gotcha; Enter submits).
  - `set` returns the candidate → pre-fly the camera to it so "Is this your
    building?" is answerable by looking; Yes → `confirm` action → beacon + flight.
  - Sign out / delete → POST then `location.reload()` (cleanest full-state reset).
  - ✕ / backdrop click → close + `resumeTour()` (house modal convention).
- **Panel** (the resident dashboard) — computed 100% client-side from feeds already
  polling; zero new endpoints; refresh every ~6 scene-seconds while open:
  - **Subway**: fetch `/api/subway/stations` once (24 h server TTL); rows →
    `{name: stop_name, routes: daytime_routes, x, z}` via `subway.geoRaw`. Show the
    nearest ≤2 stations within 900 m with distance + routes. Arrivals: scan
    `subway.trips` (exported Map) — each trip has `stops: [{name, arr, dep}]` (epoch
    seconds) — match by station NAME (same Socrata source both sides, names align),
    `arr > nowS − 20`, sort, show ≤3 as `"B 3 min · D 7 min"`.
    `nowS = HIST.active ? HIST.epochS : Date.now()/1000` (Iron Rule 5 — ETAs stay
    honest in replay; the panel footer must also switch to `"replaying <day> — not
    live"` when `HIST.active`).
  - **Citi Bike**: nearest of `citibike.stations` ≤600 m → live `bikes/ebikes/docks`.
  - **Buses**: routes with a vehicle in `buses.list` within 400 m (entries carry
    `.pos` Vector3 + `.route`), deduped, ≤5.
  - **Ferry**: nearest of `ferries.list` ≤1.5 km → `label`, `.next`, `.eta`.
- **Dev hook**: `window.__home._dev(lat, lon, nbhd, boro)` fakes a saved home
  client-side (beacon + flight + panel). Essential for browser testing — the session
  cookie is HttpOnly so you cannot forge signed-in state from the console.

## Testing protocol (what the reference run did — repeat it)

Server (before any client work):
1. `node -e "require('./lib/home-core.js')"` + api-core + agent-core syntax gates.
2. Dev secrets: write `session-secret.json` `{"secret":"<32 random bytes b64>"}` and
   `google-oauth-client.json` `{"clientId":"DEV-PLACEHOLDER.apps.googleusercontent.com"}`
   (both git-ignored on main — verify with `git check-ignore`). Blob token comes from
   `.env.local` (present). Maps key file exists.
3. Forge a session cookie in node (same payload+HMAC recipe, any test sub) and curl:
   GET (signed out) → GET (cookie) → `set` with a real address → `confirm` → wait out
   the 60 s profile cache → GET shows the home → read the raw blob and grep that no
   coordinate substring appears → tamper one byte of the cookie → expect 401 →
   `delete` → GET shows home null. Rename `google-oauth-client.json` away → GET
   returns `{"enabled":false}` → restore.
4. Real login can't be tested until the owner creates the OAuth client — the
   tokeninfo `aud` check rejects the placeholder. That's expected; everything else is
   testable without it.

Client:
5. Serve via the `manhattan-island` launch config (port 4173). Cache-bust the reload
   (`/?v=…`) — the browser happily serves a stale index.html.
6. `window.__moduleError` FIRST. Then AGENTS smoke counts (`__personas.list.length`
   ≈ 12.5k, `__traffic.total` > 10k).
7. Expect: pill visible, GBA label HOME, modal opens with the sign-in step.
8. `__home._dev(40.74839, -73.98489, 'Midtown South-Flatiron-Union Square',
   'Manhattan')` → beacon at scene ≈ `(−23, 6147)`, panel shows
   `34 St-Herald Sq · ~248 m · B D F M` (+ the NQRW twin) — real numbers, they
   reproduce. Screenshot with the chip visible.
9. Unconfigured pass: hide the oauth file, hard-reload → RESET label, hidden pill,
   no module error — byte-identical app. Restore.

**KNOWN-UNVERIFIED (the one gap)**: the arrival-ETA line never rendered with LIVE
trips, because the preview pane reports `document.visibilityState === 'hidden'` and
liveBridge deliberately pauses all polling on hidden tabs — `subway.trips` stays empty
in the harness no matter what you do (screenshot frame-pumping doesn't run polls long
enough). The read path mirrors the shipped train-chip logic exactly, but EYEBALL IT in
a real browser tab (or after deploy) before calling the panel done.

## Config the OWNER must do (hand them this checklist)

1. Google Cloud Console → OAuth client ID (Web application) → authorized JavaScript
   origins: the prod URL AND `http://localhost:4173`. (No redirect URIs needed —
   GIS popup mode.)
2. `vercel env add GOOGLE_CLIENT_ID` + `vercel env add SESSION_SECRET` (32+ random
   chars), all environments, then redeploy. Locally: put the real client id in
   `google-oauth-client.json`.
3. Until then the feature is dormant everywhere and pushing is safe (verified: prod
   `/api/home` → `{"enabled":false}`, RESET untouched).

## Ship checklist

- CHANGELOG entry at the TOP, house format — `03bb8d3` contains a complete one you
  can lift (credits Google Sign-In/Places + the live feeds, states the
  address-discarded / email-kept-privately / encrypted-at-rest facts honestly).
- `git pull --rebase` before push (parallel agents; note `git stash -u` first if the
  tree is dirty — plain pull refuses). Check `git status` for OTHER agents' WIP and
  for secret files before staging; stage files explicitly, never `git add -A`.
- Diff surface: `lib/home-core.js` + `api/home.js` (new), one export line in
  `lib/agent-core.js`, two lines in `server.js`, §26f blocks in `public/index.html`,
  `CHANGELOG.md`. Nothing else.

## Non-goals (Phase 1)

No friends/presence/public anything; no home customization; no preferences UI (the
field exists, nothing writes it); nothing automated ever emails users; no npm deps;
no `.github/workflows/` (Iron Rule 7).
