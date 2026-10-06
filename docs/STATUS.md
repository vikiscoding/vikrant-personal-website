# Status

What is live, what is verified, what is pending. Rewrite this file at the end of every working session to match reality; replace, do not append.

Last updated: 6 Oct 2026. The site is feature-complete (see the note *This site as a product*); changes from here come from operating it.

## Live

| Component | State |
| --- | --- |
| Site | https://vikrantsingh.fyi on Cloudflare Workers; `main` deploys through GitHub Actions; `http` and `www` redirect to the apex |
| Homepage | Headline "IT Operations and Engineering"; the record (Citi/Virtusa, Ontario/CompuCom) with scope and no outcome percentages, which stay on the résumé; "What I'm building toward" links the product note; "A short path" (four links) above "Proof you can open": this site's reliability (Pulse run and Ludo inside it), the incident desk, Balance-Books, Atlas Flow's live site (ADR-022, ADR-023). Nav: Home · Live reliability · Writing · Play (ADR-024) |
| Writing | `/notes/`: five site notes (the product note, the dependency board, the failure list, the free-tier postmortem, game day 1), then the Medium essays |
| Heartbeat | A scheduled job every 10 min reads this repo's latest commit and CI status from GitHub into KV; the footer shows it; `/api/pulse` returns 200 while the snapshot is under 35 min old |
| Outside probe | UptimeRobot keyword monitor on `/api/pulse` every 5 min; email alerts. SLO clock Day 0 = 30 Sep 2026 |
| SLI ledger | Durable Object `SliLedger`: daily counts and histograms per source, failures in full, read per source so no source can crowd out another; public `/api/slo?days=N`. Refused writes are logged as `ledger_unrecorded` and rebuilt from Workers Logs on the next healthy run (ADR-028) |
| Dashboard | `/reliability/`: the answer first (status, open incidents, dependencies needing attention), the collecting-data banner until 30 Oct 2026, live state, SLO cards with the budget left, the 30-day strip, speed (folded), the latest 5 failures with a link to `/reliability/failures/` (every kept failure, by day, game days marked), the dependency board, the incident desk, both testbeds. From a KV read copy when the ledger can't be read (ADR-029). The error budget burn-down appears on its own on 30 Oct 2026 |
| Dependency board | `/reliability/#limits` and `GET /api/limits` (ADR-030): six renewals, each read from its issuer daily, all green since 4 Oct 2026, 7:43 p.m.; today's use of five free-tier allowances, with yesterday's totals after the 00:00 UTC reset. The domain's expiry is read by the daily `limits` workflow, because the registries rate-limit Cloudflare's addresses. Reminder issues escalate P3 (90 days), P2 (60), P1 (30), P0 (expired) and close themselves |
| Incident desk | 2 failed runs → `repository_dispatch` to the incident engine; owner `/commands` on GitHub Issues are the human gate; every AI priority waits for `/approve` (ADR-021); the site reads the engine's public `feed.json` (refreshed by the scheduled job) |
| Pulse run | `/play/`: validated `POST /api/rum`, no IP, user agent or cookie |
| Ludo | `/ludo/` (ADR-026, ADR-027): one Durable Object per room; solo vs bots or up to four players on an invite link; bots capture first; a late joiner takes a bot's seat; an away player's seat is played at bot pace, labelled "(away)", and goes back to the bot after 2 minutes; a game everyone has left ends (at once on Leave, after 1 minute otherwise). Names and chat stay in the room. Server-measured SLIs on `/reliability/#ludo`. Details: `docs/ludo-telemetry.md` |
| Visit counter | Counting, hidden until 1,000 views (`VISITS_MODE=auto`) |
| Brand | Favicon set and 1200×630 share image from `scripts/make-brand-assets.py` |

## Verified

- `npm run check` (CI and locally): Astro and Worker typechecks, and 13 dashboard checks in `scripts/check-dashboard.mjs` (the burn-down's gate, the budget bar, the failure list and history, the dependency statuses and their sources). Each dashboard check was seen to fail against a deliberately broken dashboard.
- Game day 1 (1 Oct 2026): raised by the site, triaged, worked through the human gate, recovery reported automatically. Record `docs/gamedays/2026-10-01-github_5xx.md`; postmortem `/notes/postmortem-game-day-1/`.
- Free-tier incident (2 Oct 2026, self-inflicted): every page served, the heartbeat stayed fresh, no incident opened; the capacity messages worked live. Record `docs/incidents/2026-10-02-free-tier-writes.md`; postmortem `/notes/postmortem-free-tier-writes/`.
- The failure-list fix (4 Oct 2026): after the deploy, all 12 site failures of the window were back on the page, matching the daily totals.
- The dependency board (4 Oct 2026): all six dates read live from their sources; the report path refused a missing or wrong secret, a bad body and an oversized one; both reminder issues opened, reached the owner by email and closed themselves.
- Ludo engine: 2,000 seeded games finish and replay exactly, including with capture-first bots. Late joiners, away seats, the 2-minute release and ended rooms each tested locally over WebSockets. The new labels have not yet been seen on a phone.
- Live desk policy: `TRIAGE_AUTO_APPLY=off`, so a confident Low still waits for `/approve` (engine test `test_live_desk_never_auto_applies_even_low`).

## Pending

- **Game day 2** (run 2 Oct 2026): write its record in `docs/gamedays/` from the template, including whether the alert reached the owner.
- **Error budget policy:** drafted in `docs/slo.md`; every threshold is `TODO` for the owner. Not adopted, and no page says the site follows it.
- **30 Oct 2026:** the first full SLO window; the burn-down appears; the first monthly reliability note.
- **Finding 9 follow-up:** a stored count of readings rebuilt from logs, per day and source (roadmap).
- **Load tests** stay off until the dev Worker has its own account or a paid plan: the Free plan's daily allowances are shared by production and dev (incident finding 2).
- **Alert mailbox** near capacity (game day 1, finding 7).
- See [`ROADMAP.md`](ROADMAP.md) → Next.

## Local dev gotchas (Windows)

- Never set secrets through a `!` prompt in an agent session: the hidden prompt stores an **empty** value and still reports success. Use the Cloudflare or GitHub dashboard.
- A stray `wrangler dev` keeps its port. Stop leftover `node` and `workerd` processes before restarting, or use another port.
- `wrangler dev --var` did not reach the Worker in local testing; put local-only values in `.dev.vars`.
- `wrangler.jsonc` sets `dev.host = localhost`; without it, the custom-domain routes make `wrangler dev` loop on the https redirect.
- To run the scheduled job locally: `POST /cdn-cgi/local/explorer/api/local/scheduled?worker=vikrantsingh-fyi` with `{"cron": "*/10 * * * *"}`.
