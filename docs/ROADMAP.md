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
| Homepage rewrite: "Engineering and operations leader", proof you can open, "Scope:" lines; share image versioned by headline (ADR-022) | 1 Oct 2026 |

## Next

- [ ] **First 30-day SLO report, 30 Oct 2026.** Save the outside probe's 30-day uptime (SLO-1) and the ledger's scheduled-job success (SLO-2). Consider switching `DASHBOARD_MODE` to `auto`.
- [ ] **Game day 2: page on purpose, recorded.** Hold the fault until the outside probe pages (about 40–45 min after the last good run), restore, then work the incident through the human gate. Proves the probe → alert path end to end (game day 1, finding 8). Prerequisite: the alert channel has space (finding 7).
- [ ] **Pulse run break and restore.** After a few quiet days: deploy `FAULT=game_js_error`, watch the client-path block react, restore, and write it up.
- [ ] **Repo-aware suggestions** in the incident engine: one demo repo, read-only. Each suggestion gives a likely cause, a candidate file, confidence, and "verify before prod", and is always labelled *proposed, not applied*.

## Parked

Each of these needs a written reason before it moves.

- Daily export of the ledger and the probe history to a Git data branch (designed in `docs/slo.md`)
- Burn-rate alerts, an OTLP backend, a lab Worker, canary releases, load tests
- A traffic-aware config loop that proposes changes as pull requests and never applies them
- Sparklines on the dashboard (after 30 days of data)
- Analytics Engine (enable failed with code 10089), cookieless Web Analytics, turning off the `workers.dev` fallback
- Never: a second game, leaderboards or accounts, visitor-triggered incidents, auto-remediation
