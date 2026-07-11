# Task: `find_place` — Google Places lookup so the Concierge can fly to named places

Audience: a coding agent joining this repo. Read `AGENTS.md` first — the Iron Rules and
the parallel-work discipline all apply. Anchors below were verified against the working
tree on 2026-07-11; line numbers drift — re-verify with grep before editing. This plan
touches ONLY `lib/agent-core.js` (+ `.gitignore`, `CHANGELOG.md`); it needs no client
code, no new endpoint, and no recorder changes.

---

## For the non-technical reader: what is this and how will it work?

**The problem.** People ask the City Concierge for places by *name*: "take me to Black
cat les" (the Black Cat coffee shop on the Lower East Side). The agent's only way to
turn a place into map coordinates today is street intersections — fine for Times Square,
hopeless for a small coffee shop. So it either guesses or gives up.

**The fix.** Give the agent one new tool: it sends the place name to Google Places (the
same search that powers Google Maps), gets back the real name, address, and coordinates,
and then uses the flying-camera machinery it *already has* to bring you there — camera
swoops to the storefront, a glowing ring hugs the block, a labeled pin drops on the map.

**What it costs / what it won't do.** Lookups run on the server with our own Google key
(never exposed to visitors), answers are cached, and daily lookups are capped well inside
Google's free monthly tier. If the key is ever missing, the concierge simply falls back
to today's behavior — nothing crashes.

---

## Where this lives (all in `lib/agent-core.js`, ~1,000 lines)

| Anchor (grep for it) | What's there today | What you add |
|---|---|---|
| `function gatewayKey` (~line 45) | env → git-ignored JSON key loading pattern | copy the pattern: `placesKey()` |
| `const NYC = {` (~line 625) | NYC lat/lon bounding box | reuse it for locationRestriction + clamping |
| `const TOOLS = [` (~line 628) | 12 tool definitions | tool #13: `find_place` |
| `async function runTool` (~line 852) | dispatcher | one new `if` line |
| `const SYSTEM = \`` (~line 717) | system prompt; "Bridge them with geocode_intersection" + the LOCATING A SPECIFIC POINT rule | 2 small edits (below) |
| `whereIs` internals (point-in-polygon over `boundaries.json`) | names borough + NTA neighborhood for a lat/lon | call it to annotate each result |
| `RL_INSTANCE_PER_DAY` (~line 784) | per-warm-instance daily budget pattern | same pattern for a Places daily cap |

`module.exports = { handleAgent, feedQuery }` is the last line — no export changes needed.

## Step 1 — key loading + `.gitignore`

Follow the existing secrets pattern exactly (see `gatewayKey` and AGENTS.md "Run + test
locally"):

```js
function placesKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'google-maps-key.json'), 'utf8')).key || null; }
  catch { return null; }
}
```

- Add `google-maps-key.json` to `.gitignore` under the secrets block (top of file).
- The user already has the key. Local: they create `google-maps-key.json`
  (`{"key": "…"}`) — ask them for it; do NOT go looking for it elsewhere. Vercel:
  they run `vercel env add GOOGLE_MAPS_API_KEY` (all environments) and redeploy.
- **NEVER log, commit, or echo the key** (Iron Rule territory). It must not appear in
  error strings, tool results, or agent-log blobs.

## Step 2 — the Places call (zero deps, raw fetch)

Google **Places API (New), Text Search**: `POST https://places.googleapis.com/v1/places:searchText`

```js
headers: {
  'Content-Type': 'application/json',
  'X-Goog-Api-Key': key,
  'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.types,places.businessStatus'
}
body: {
  textQuery: q,                      // e.g. "Black Cat coffee Lower East Side NYC"
  maxResultCount: 5,
  regionCode: 'US',
  locationRestriction: { rectangle: {
    low:  { latitude: NYC.latMin, longitude: NYC.lonMin },
    high: { latitude: NYC.latMax, longitude: NYC.lonMax } } }
}
```

- The FieldMask is a **cost control**: exactly these fields keep every call in the
  Text Search **Pro** SKU (5,000 free calls/month as of 2025 pricing). Do not add
  rating/phone/hours fields — those jump to the Enterprise SKU.
- `locationRestriction` (not `locationBias`) hard-limits results to the NYC box — the
  same `NYC` const `validCamera` already clamps to, so every returned point is
  guaranteed flyable. Belt-and-braces: still drop any row outside `NYC` bounds.
- Timeout: wrap in `AbortSignal.timeout(4000)` and one retry, mirroring `callGateway`'s
  philosophy (a slow lookup must not eat the 100 s turn budget).
- Non-OK / empty → `{ error: 'no places matched "<q>" in NYC — try adding the
  neighborhood or cross-streets' }` (the model then falls back to
  `geocode_intersection`). Missing key → `{ error: 'place search not configured' }`.

## Step 3 — result shape + neighborhood annotation

Return at most 5 candidates:

```js
{ query: q, results: [{
    name, address,                     // displayName.text, formattedAddress
    lat, lon,                          // location.latitude/longitude
    types: types.slice(0, 4),          // e.g. ["cafe","coffee_shop"]
    open: businessStatus !== 'CLOSED_PERMANENTLY',   // omit when unknown
    borough, neighborhood              // via the existing whereIs point-in-polygon
} ] }
```

The `borough`/`neighborhood` annotation reuses the `whereIs` internals (the point-in-
polygon over `boundaries.json` — factor a tiny internal helper if `whereIs` isn't
already structured to share it; do NOT duplicate the polygon math). It serves two
purposes: the model can confirm the match against the user's hint ("les" →
"Lower East Side"), and it can warn honestly when a match lands outside the built
scene (only Manhattan is fully built — see the scene-coverage line at the top of
`SYSTEM`).

## Step 4 — cache + daily budget

- **Cache**: module-scope `Map`, key = normalized query (lowercase, trimmed, collapsed
  whitespace), value = `{ t, result }`, TTL **24 h**, cap ~500 entries (evict oldest on
  overflow). Google's TOS allows caching lat/lon up to 30 days; 24 h is comfortably
  inside and keeps repeat questions ("black cat", "the black cat cafe") cheap.
- **Budget**: per-warm-instance daily counter, same pattern as `RL_INSTANCE_PER_DAY`
  (~line 784): `PLACES_PER_DAY = 150`. Over budget → the same friendly error as the
  no-key case. 150/day ≈ 4,500/month worst case, inside the 5,000 free Pro calls.
  (The existing chat rate limits — 8/min, 60/day per IP — already bound abuse
  upstream; `MAX_ROUNDS` caps tool calls per turn.) This is the *soft* limit — the
  hard $10/month ceiling is the next section.

## Hard $10/month cost ceiling (runaway-cost prevention)

Requirement: total Places spend must never exceed **$10/month**; once hit, the tool
stops calling Google until the monthly quota refreshes. Three layers, cheapest-wins:

**Layer 1 — Google-side quota cap (authoritative; zero code; do this FIRST).**
An in-app counter can never be the real guarantee: warm instances churn and module-
scope counters reset, and a durable counter would race across instances. The only
mechanism that survives every bug, redeploy, and abuse scenario is Google's own quota
enforcement, so the dollar cap lives there:
- In Google Cloud Console → APIs & Services → **Places API (New)** → Quotas: set
  **requests per day** to a value derived from CURRENT console pricing (verify at
  setup — SKU prices change). At 2025 pricing (Text Search Pro ≈ $35/1,000 after
  5,000 free/month): 170/day × 31 days = 5,270 calls → 270 paid → **≈ $9.45/month
  worst case**. So: **cap = 170/day**, recompute if the console shows different rates.
- Also create a **Billing budget** on the project: $10/month with alerts at 50/90/100%
  → email warning if reality ever diverges from the math above.
- When the daily quota is exhausted Google returns `429` / `RESOURCE_EXHAUSTED` — which
  the tool already treats as a graceful "not available right now" error. The quota
  window resets daily, the free tier monthly — i.e. exactly the user's "stop until it
  refreshes" behavior, enforced by Google, not by us.
- These are console steps for the USER (agent: give them this checklist and wait for
  confirmation before the prod test).

**Layer 2 — circuit breaker in `findPlace` (code).**
On any `429`/`RESOURCE_EXHAUSTED` response, set a module-scope
`placesExhaustedUntil = <next UTC midnight>` and short-circuit all further Google calls
until then (return the friendly error immediately, cache still served). Prevents
hammering a dead quota and keeps turn latency snappy once capped.

**Layer 3 — the Step 4 counters (defense in depth).**
`PLACES_PER_DAY = 150` per warm instance sits *under* the 170/day Google cap, and the
24 h cache means repeat queries never touch the quota at all. Layers 2+3 are best-effort
optimizations; Layer 1 is the guarantee. Do NOT build a Blob-persisted monthly counter —
it would duplicate what Google's quota already enforces authoritatively, with worse
consistency.

## Step 5 — tool definition + dispatcher + system prompt

**TOOLS entry** (append after `rank_areas`):

```js
{ name: 'find_place',
  description: 'Google Places search: a NAMED place/business/landmark → real name, address, lat/lon, borough + neighborhood (up to 5 candidates, NYC only). Use for shops, cafes, restaurants, venues, addresses — anything you cannot place by intersection. Expand user shorthand into the query ("Black cat les" → "Black Cat coffee Lower East Side"). Then set_camera to the lat/lon (altitude_m ~250-350, tight highlight_radius_m ~120-200) and drop a labeled show_layer pin. If candidates are ambiguous, ask the user which one. Data © Google.',
  input_schema: { type: 'object', properties: {
    query: { type: 'string', description: 'place name + any area hint, e.g. "Katz\'s Delicatessen" or "Black Cat cafe Lower East Side"' } },
    required: ['query'] } }
```

**runTool**: `if (name === 'find_place') return await findPlace(input || {});`

**SYSTEM prompt — two surgical edits** (keep everything else byte-identical):

1. The coordinate-spaces line: "Bridge them with geocode_intersection (landmark → the
   nearest intersection you know)" → append "**; named places/businesses → find_place
   (returns lat/lon directly)**".
2. Extend the existing "LOCATING A SPECIFIC POINT" rule with one sentence: "For a named
   business/venue/address you don't have exact coordinates for, call find_place FIRST,
   fly to the top match, mention name + address, and note when it's outside the fully
   built area (only Manhattan is fully built)."

Do NOT add a whole new rule block — the fly-there behavior is already specified there;
`find_place` just feeds it coordinates.

## Explicit non-goals

- **No public `/api/places` endpoint.** The tool runs only inside `handleAgent`, behind
  the per-IP rate limits — never expose a free-to-the-internet Google proxy.
- **No client/index.html changes.** `set_camera` + `show_layer` points already render
  the experience. (Parallel-agent bonus: zero collision surface on the shared file.)
- **No recorder changes** — this is not a live layer; Iron Rule 5 doesn't apply.
- **No npm deps** (repo is zero-dep; raw fetch like `agent-log.js`).

## Testing (before any push — every push deploys)

1. `node -e "require('./lib/agent-core.js')"` — syntax gate (AGENTS.md).
2. Key present, `node server.js`, then:
   `curl -s localhost:4173/api/agent -X POST -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"take me to black cat les"}]}'`
   Expect: tool trace shows `find_place` → `set_camera` (lat/lon near 40.716, -73.986,
   Lower East Side) and a reply naming the real place + address.
3. Ambiguity: "take me to the black cat" → agent asks or picks the LES cafe with
   address stated. Non-NYC place ("Eiffel Tower cafe Paris") → clean "not in NYC" reply.
4. Degradation: temporarily rename `google-maps-key.json` → tool errors politely, agent
   falls back to intersection knowledge, **nothing crashes**; restore the file.
   Also simulate the quota case: hardcode `placesExhaustedUntil = Date.now()+60000`
   for one run → same graceful path, no Google calls fired; revert.
5. Cache: repeat query #2 — server log/latency shows no second Google call.
6. Browser (`localhost:4173`): ask the concierge the same question; verify camera flies
   there with a tight glowing ring + labeled pin; check `window.__moduleError` FIRST
   (should be untouched — no client edits); screenshot for the user.
7. After deploy: user adds `GOOGLE_MAPS_API_KEY` to Vercel env; re-run test 2 against
   prod URL.

## Changelog

User-visible feature → entry at the TOP of `CHANGELOG.md`, same push, exact house
format (`## emoji Title` / `**Shipped:**` / `**TL;DR:**` / `**What you'll see:**` /
`**How it works:**`). Credit **Google Places API** by name with a link, and be honest
about mechanics: lookups are server-side, NYC-restricted, cached up to 24 h, capped
daily; results are Google's index, not a live feed; only Manhattan is fully built so
flights elsewhere land on stylized ground.

## Acceptance criteria

- "Black cat les" flies the camera to Black Cat LES (172 Rivington St area), states
  name + address, drops a labeled pin. Same for other NYC shops/venues by name.
- Key never appears in logs, errors, commits, or client payloads; `google-maps-key.json`
  is git-ignored.
- No key / over budget / Google down → graceful text fallback, zero crashes, zero
  client-side changes, `public/index.html` untouched.
- **Cost ceiling verified**: Google-side daily quota cap (≈170/day, recomputed from
  current pricing) + $10 billing budget with alerts are configured in the Cloud
  Console BEFORE the feature ships to prod; 429 circuit breaker confirmed in test 4.
  Worst-case monthly spend ≤ $10 even if every app-side counter fails.
- Diff surface: `lib/agent-core.js`, `.gitignore`, `CHANGELOG.md`, nothing else.
