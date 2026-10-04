# Roadmap

Engineering roadmap for vikrantsingh.fyi. Decisions are in [`docs/adr/`](adr/README.md); what is live now is in [`STATUS.md`](STATUS.md).

## Done

| Item | When |
| --- | --- |
| Static site on Cloudflare Workers, push-to-deploy CI/CD, custom domain (ADR-001, 002, 009) | 30 Sep 2026 |
| Heartbeat: scheduled job → KV snapshot → footer, `/api/pulse`, outside probe (ADR-010) | 30 Sep 2026 |
| SLI ledger in a Durable Object, public `/api/slo` (ADR-012) | 30 Sep 2026 |
| Live reliability dashboard, Toronto time (ADR-013, 014) | 30 Sep 2026 |
| Pulse run, a client-path testbed with validated telemetry (ADR-015) | 30 Sep 2026 |
| Incident desk: real site failures triaged by the incident engine, human gate on GitHub Issues (ADR-016) | 1 Oct 2026 |
| Game day 1 and its fixes; public postmortem (ADR-017) | 1 Oct 2026 |
| Brand assets and share image; Pulse run invitation (ADR-018, 019) | 1 Oct 2026 |
| Repository made public (ADR-020) | 1 Oct 2026 |
| The live desk never lets the model set priority; the site says AI priority never pages anyone (ADR-021) | 1 Oct 2026 |
| Homepage rewrite: proof you can open, "Scope:" lines; share image versioned by headline (ADR-022) | 1 Oct 2026 |
| Headline "IT Operations and Engineering"; Balance-Books added as proof (ADR-023) | 1 Oct 2026 |
| Nav item **Play**, last (ADR-024) | 1 Oct 2026 |
| Incident desk: the AI-priority rule is dated; the old ticket shows the rule it ran under; the owner's latest note shows on each ticket (ADR-025) | 1 Oct 2026 |
| Ludo: server-path latency testbed with server-measured SLIs, bots, invite links, room chat in any language, full screen on phones (ADR-026) | 2 Oct 2026 |
| Ludo scale: per-room telemetry batches, append-only moves, ~2 rows per move; play to last place; leave any time (ADR-027) | 2 Oct 2026 |
| Free-tier incident: capacity-aware pages, collecting-data banner, public postmortem; ledger backfill from logs as a standing rule (ADR-028) | 2 Oct 2026 |

## Next

- [ ] **Read the 2 Oct backfill's restored count** from the `op = ledger_backfill` lines (before about 5 Oct, when the logs expire), and close finding 7.
- [ ] **Isolate load testing from production capacity** (incident finding 2): a separate Cloudflare account for the dev Worker, or a paid plan, before any load test above ~40 rooms.
- [ ] **First monthly reliability note, 30 Oct 2026.** A short public note per 30-day window: budget spent and why, what changed, what comes next. The decisions, not just the numbers. The first can record the burn-down chart as that window's change.
- [ ] **Error budget burn-down goes live, 30 Oct 2026, on its own.** Built and merged early; `/reliability/` shows it only once the first full window is in (the same condition that retires the "Collecting data" banner). Check it on the day; nothing else on graphs until then.
- [ ] **First 30-day SLO report, 30 Oct 2026.** Save the outside probe's 30-day uptime (SLO-1) and the ledger's scheduled-job success (SLO-2). Consider switching `DASHBOARD_MODE` to `auto`.
- [ ] **Game day 2: fire the alert on purpose, recorded.** *Run 2 Oct 2026; record pending in `docs/gamedays/`.* Hold the fault until the outside monitor goes Down and alerts (about 40–45 min after the last good run), restore, then work the incident through the human gate. Proves the probe → alert → delivery path end to end (game day 1, finding 8). Prerequisite: the alert channel has space (finding 7).
- [ ] **Pulse run break and restore.** After a few quiet days: deploy `FAULT=game_js_error`, watch the client-path block react, restore, and write it up.
- [ ] **Repo-aware suggestions** in the incident engine: one demo repo, read-only. Each suggestion gives a likely cause, a candidate file, confidence, and "verify before prod", and is always labelled *proposed, not applied*.

## Later (ideas, not scheduled)

- **Ludo objectives held for a full window.** After 30 days of real play, decide whether `ludo_action` and `ludo_rtt` become SLOs with budgets, and whether a `FAULT=ludo_slow` game day earns a write-up.
- **Pulse run server actions, for a user-journey SLO.** (Ludo now covers a server-measured journey; revisit whether this is still needed.) Today the game's telemetry is client-only and spoofable, so it can never be an SLO (ADR-015). Give the game a few small server calls during a session (for example a checkpoint at start, at each 30 s and at game over) and measure them **on the server**: success rate and latency per session. That makes a trustworthy journey-level SLI, a candidate third SLO ("a game session's server calls succeed and return within N ms"), and a way to stress-test the user-facing path deliberately (`FAULT` values such as `game_api_slow` / `game_api_5xx`).
  - Guardrails before building: an ADR; no shared state written by visitors (read-mostly or per-session only); validation and a per-session rate cap like `/api/rum`; recorded in the SLI ledger as its own source; `/privacy` updated first; never feeds paging until it has a full 30-day window.

## Parked

Each of these needs a written reason before it moves.

- Daily export of the ledger and the probe history to a Git data branch (designed in `docs/slo.md`)
- Burn-rate alerts, an OTLP backend, a lab Worker, canary releases, load tests
- A traffic-aware config loop that proposes changes as pull requests and never applies them
- Sparklines on the dashboard (after 30 days of data)
- Analytics Engine (enable failed with code 10089), cookieless Web Analytics, turning off the `workers.dev` fallback
- Never: a third game, leaderboards or accounts, visitor-triggered incidents, auto-remediation
