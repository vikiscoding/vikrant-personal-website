# vikrantsingh.fyi

A personal site, **operated in public**. A static page on a CDN almost never fails, so its uptime proves nothing. This site runs one small dynamic path on purpose, and treats it like production: service level objectives, an outside probe, an incident desk with a human gate, game days and postmortems.

**Live:** [site](https://vikrantsingh.fyi) · [Live reliability](https://vikrantsingh.fyi/reliability/) · [postmortem: game day 1](https://vikrantsingh.fyi/notes/postmortem-game-day-1/) · [raw SLI data](https://vikrantsingh.fyi/api/slo?days=30)

## How it works

```
 every 10 min                                   every visit · every 5-min outside probe
┌──────────────┐  GitHub API  ┌─────┐  read   ┌───────────────────────────────────────────┐
│ cron: ticker │ ───────────▶ │ KV  │ ◀────── │ Worker: pages · /api/pulse · /api/slo     │
└──────┬───────┘  snapshot    └─────┘         │ /reliability/ dashboard · /api/rum (game) │
       │ 2 failed runs                        └─────────────────┬─────────────────────────┘
       ▼                                                        │ every unit of work
 incident engine (GitHub Actions + Issues, human gate)          ▼
 github.com/vikiscoding/vikrant_perswebsite_incidents_aiengine   SLI ledger (Durable Object)
```

- **Pages** are static HTML (Astro) served by one Cloudflare Worker, which fills the footer with "Last shipped · build status · checked N min ago". If anything dynamic fails, the page still serves (degrade open).
- **`/api/pulse`** returns 200 while the snapshot is under 35 minutes old. An outside probe checks it every 5 minutes; that is SLO-1.
- **The SLI ledger** records every scheduled run, probe hit, page view and game event: failures in full, successes counted. The [dashboard](https://vikrantsingh.fyi/reliability/) and `/api/slo` read it. If it cannot be written (for example, the free tier's daily allowance runs out), every event is still in Workers Logs and the missed ones are rebuilt from there on the next healthy run.
- **The incident desk:** after two failed runs, the Worker raises an incident in the [incident engine](https://github.com/vikiscoding/vikrant_perswebsite_incidents_aiengine). An AI proposes triage and drafts that are never sent; every later step is a human command on a GitHub Issue.
- **Pulse run** (`/play/`) is a 30-second browser game whose errors and frame times are the client-side signal.
- **Ludo** (`/ludo/`) is a server-authoritative multiplayer game (bots, invite links, room chat) whose connects, moves and round trips are timed on the server: the server-path signal ([docs/ludo-telemetry.md](docs/ludo-telemetry.md)).

## Read the record

| | |
| --- | --- |
| Decisions, each with what it rejected | [`docs/adr/`](docs/adr/README.md) |
| What is live, what is next | [`docs/STATUS.md`](docs/STATUS.md) · [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| SLOs and their error budgets | [`docs/slo.md`](docs/slo.md) |
| Runbook, including game-day faults | [`docs/runbook.md`](docs/runbook.md) |
| Game day 1: timeline and findings | [`docs/gamedays/`](docs/gamedays/) |
| Real incidents: timeline and findings | [`docs/incidents/`](docs/incidents/) |
| Log and SLI event schema | [`docs/log-schema.md`](docs/log-schema.md) |
| Working rules and conventions for contributors and coding agents | [`AGENTS.md`](AGENTS.md) |

## Deploy

Push to `main` → GitHub Actions runs type checks, the build and a dry-run deploy → `wrangler deploy` to Cloudflare. Secrets live only in GitHub and Cloudflare. Rollback: `npx wrangler rollback`, then revert the commit on `main`.

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars        # optional: a read-only GitHub token for the ticker
npm run preview                       # build + wrangler dev on http://localhost:8787
npx wrangler dev --test-scheduled     # then: curl "http://localhost:8787/__scheduled" to run a tick
npm run check                         # astro check + Worker typecheck
```

Game-day faults are deploy-time variables (`FAULT` in `wrangler.jsonc`); there is no request-time toggle.

## License

All rights reserved. The source is public so the engineering record can be read and checked; it is not licensed for reuse. See [LICENSE](LICENSE).
