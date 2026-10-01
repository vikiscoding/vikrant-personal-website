# Status

What is live, what is verified, what is pending. Rewrite this file at the end of every working session to match reality; replace, do not append.

Last updated: 1 Oct 2026.

## Live

| Component | State |
| --- | --- |
| Site | https://vikrantsingh.fyi on Cloudflare Workers; `main` deploys through GitHub Actions; `http` and `www` redirect to the apex |
| Homepage | Headline "IT Operations and Engineering"; the record (Citi/Virtusa, Ontario/CompuCom); "Proof you can open": this site's reliability (Pulse run inside it), the incident desk, Balance-Books, Atlas Flow's live site; "Scope:" lines (ADR-022, ADR-023). Nav: Home · Live reliability · Writing · Play (ADR-024) |
| Heartbeat | Cron every 10 min fetches this repo's latest commit and CI status from GitHub into KV; the footer shows it; `/api/pulse` returns 200 while the snapshot is under 35 min old |
| Outside probe | UptimeRobot keyword monitor on `/api/pulse` every 5 min; email alerts. SLO clock Day 0 = 30 Sep 2026 |
| SLI ledger | Durable Object `SliLedger`: daily counts and histograms per source, failures in full; public `/api/slo?days=N` |
| Dashboard | `/reliability/` (flag `DASHBOARD_MODE=on`): summary, live state with Degraded when the latest run failed, SLO cards, 30-day strip, speed, failures, incident desk, client path |
| Incident desk | 2 failed runs → `repository_dispatch` to the incident engine; owner `/commands` on GitHub Issues are the human gate; since 1 Oct 2026 every AI priority waits for `/approve` (ADR-021); the site reads the engine's public `feed.json` (refreshed by the scheduled job, so up to 10 min behind), showing each ticket's gate with the rule it ran under and the owner's latest `/note` (ADR-025) |
| Pulse run | `/play/`: validated `POST /api/rum`, no IP, user agent or cookie; personal result at game over |
| Visit counter | Counting, hidden until 1,000 views (`VISITS_MODE=auto`) |
| Brand | Favicon set and 1200×630 share image from `scripts/make-brand-assets.py` (reads the headline); `og:image` URL is versioned by the headline so caches never serve a stale card |

## Verified

- Game day 1 (1 Oct 2026, `FAULT=github_5xx`): the alert was raised by the site, triaged by the engine, worked through the human gate, and recovery was reported automatically. Eight findings, six fixed. Record: `docs/gamedays/2026-10-01-github_5xx.md`; public postmortem: `/notes/postmortem-game-day-1/`.
- Endpoint validation for `/api/rum` (origin, size, type, bounds), scripted playthroughs, the `game_js_error` game day, degrade-open behaviour, the Toronto-time boundaries across DST.
- Live desk policy: the engine's live workflow runs with `TRIAGE_AUTO_APPLY=off`, so a confident Low still waits for `/approve` (engine test `test_live_desk_never_auto_applies_even_low`, ADR-021).
- Desk records keep the rule they ran under (ADR-025): the one pre-ADR-021 ticket reads "auto-applied under the earlier low-risk rule"; the owner's latest `/note` shows on each ticket (issue #2 says game day 1's alert landed there).
- Homepage copy: every figure traced to the résumé or Vikrant's confirmation before publishing (ADR-022).

## Pending

- Cloudflare CI token expiry is still `TODO` in `docs/runbook.md`.
- Alert channel: the alert mailbox is near capacity (game day 1, finding 7; owner: Vikrant).
- See [`ROADMAP.md`](ROADMAP.md) → Next.

## Token expiries

See `docs/runbook.md` → Scheduled incidents (GitHub read token, incident dispatch token, Cloudflare API token).

## Local dev gotchas (Windows)

- Never set secrets through a `!` prompt in an agent session: the hidden prompt stores an **empty** value and still reports success. Use the Cloudflare dashboard or a separate terminal.
- A stray `wrangler dev` holds its port; stop leftover `node` processes running `wrangler` before restarting.
- `wrangler.jsonc` sets `dev.host = localhost`; without it, the custom-domain routes make `wrangler dev` loop on the https redirect.
