# ADR-015: Pulse run, a third exhibit as a client-path testbed

Status: Accepted and **built 30 Sep 2026** (panel-approved scope, owner). **Supersedes ADR-006 "two exhibits only" for this one bounded exhibit.** Files: `src/pages/play.astro`, `worker/rum.ts`, `worker/ledger.ts` (`addGame`, `game_sessions`), `worker/dashboard.ts` (`clientPath`).

Found while building: static HTML carried an ETag, so a returning browser got `304` and reused stale edge-injected content (footer, dashboard, game fault). Pages are now served `no-store` with validators stripped; assets keep their 304s.

## Objective

**Give the site's observability claim more credibility.** Today the dashboard proves the server side is operated. Pulse run adds real user-side traffic and a second, different signal (browser errors and frame time) on the same system, so the claim covers both halves of what a visitor experiences.

## Context

The site's reliability story is all server side: the ticker, KV, the probe. Nothing shows the **client path**: what a visitor's browser actually experiences (script errors, frame drops). A tiny game is the cheapest honest way to generate real client-side signal on the same origin, so the dashboard can tell one story end to end.

The risk is scope creep: polishing a side system instead of shipping the next piece of real work. So the scope is fixed and there is a stop rule.

## Decision

Add **Pulse run**: a 30-second browser runner at `/play/`, shown as exhibit **three** (never the homepage hero). Its telemetry is the exhibit; the game is the load generator.

### Scope (fixed)

- One canvas or DOM runner: jump/duck, rising score, restart on hit. Keyboard **Space/↑** (jump), **↓** (duck); **tap** to jump on mobile.
- Fixed-step loop on `requestAnimationFrame`. FPS or jank indicator only with `?debug=1`; the clean view by default.
- **No** accounts, ads, WebGL, multiplayer, leaderboard, sound pipeline, or asset pipeline. No framework on the client.
- **Stop rule:** no game two on this domain until the existing exhibits are complete.

### Telemetry: the first public write endpoint (zero trust)

`POST /api/rum`, same origin, sent with `navigator.sendBeacon`. Events:

| Event | Fields |
| --- | --- |
| `game_start` | `session` |
| `game_over` | `session`, `score`, `duration_s` |
| `game_error` | `session`, `message` (truncated to 120 characters, no stack, no URL query) |
| `frame_sample` (every ~5 s while playing) | `session`, `p95_frame_ms`, `long_frames` (frames over 50 ms) |

- `session` = a random ID made per page load, held in memory only: no cookie, no localStorage, never stored with an IP or user agent.
- **Validation before anything is recorded:** `Origin` must be `https://vikrantsingh.fyi`; the body must be ≤ 1 KB JSON; `type` must be one of four; numbers must be in sane bounds (`score` 0–1,000,000, `p95_frame_ms` 0–5,000, `duration_s` 0–3,600); anything else gets `400` and is not recorded. Always respond `204` quickly; never echo input.
- **Spam is possible and accepted as a bound.** A public beacon can be faked. Mitigations: the checks above, the ledger's per-source daily cap on detailed rows (500), and the page copy "client-only signal". This signal never feeds an SLO or an alert.
- Stored in the **SLI ledger** (ADR-012) as a new source `game`, with its **own latency histogram edges** tuned to frame times (8, 16, 25, 33, 50, 100, 250, 1,000 ms). The server edges (50 ms and up) are too coarse. `game_error` events are kept in full (message and time); everything else is counted.

### Showcase on /reliability/

A block **"Client path (Pulse run)"**, linking `/play/`:

- sessions started · game error rate (sessions with an error ÷ sessions started) · p95 frame time · % of sessions with jank (any sample with `long_frames > 0`)
- The bound, verbatim: **"Client-only signal. Does not prove server capacity or ITSM readiness."**
- These are **tracked signals, not SLOs.** No target or error budget is quoted until real samples exist, and even then only as an observation.

### Break and restore

After a few days of quiet data, run one deliberate break through the existing deploy-time switch (ADR-010 rule: no request-time toggles). For example `FAULT=game_js_error` makes `/play/` throw on start. Watch the client-path block react, restore, then write one `/notes/` post: what broke, what the dashboard showed, what was fixed. Link Medium only if it is also published there.

## Consequences

- The homepage heading changes from "Two exhibits" to "Exhibits". Card: **Pulse run** · "Tiny browser runner used as a client perf and error-budget testbed on this same site." · Bound: "A 30-second toy, not a product and not a bank stack." · **Play → /play/**. Nav item "Pulse run" is optional; decide at build.
- `/privacy` must say, before the endpoint goes live: the game sends anonymous gameplay and performance events tied to a random per-visit ID, with no cookies, no IP and no user agent stored.
- Copy rules: never "production-grade gaming platform"; no invented SLOs; no numbers on the home card until there are real samples; Pulse run never links to the Incident-AI or Atlas videos or essays.
- **Done when:** someone lands on home → sees Pulse run → plays for 30 seconds → opens Live reliability and sees the client-path signal from that play. Then stop.

## Rejected

- The game as the homepage hero: it would bury the main exhibits.
- A leaderboard or accounts: that means personal data, moderation and abuse handling, a product, not a testbed.
- Analytics Engine or a third-party RUM vendor: it splits the story across systems and adds a vendor. The ledger already exists.
- A request-time fault toggle (`?break=1`): an attack surface (ADR-005, ADR-010).
