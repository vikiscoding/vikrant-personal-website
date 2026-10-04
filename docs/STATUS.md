# Status

What is live, what is verified, what is pending. Rewrite this file at the end of every working session to match reality; replace, do not append.

Last updated: 3 Oct 2026 (after Ludo telemetry v2 was merged and deployed).

## Live

| Component | State |
| --- | --- |
| Site | https://vikrantsingh.fyi on Cloudflare Workers; `main` deploys through GitHub Actions; `http` and `www` redirect to the apex |
| Homepage | Headline "IT Operations and Engineering"; the record (Citi/Virtusa, Ontario/CompuCom, no automation or restore-time percentage); "A short path" above "Proof you can open" (reliability, the free-tier note, the incident issues, game day 1); proof: this site's reliability (Pulse run and Ludo inside it, both postmortems linked), the incident desk, Balance-Books, Atlas Flow's live site; "Scope:" lines (ADR-022, ADR-023). Writing index leads with those two notes. Nav: Home · Live reliability · Writing · Play (ADR-024) |
| Heartbeat | Cron every 10 min fetches this repo's latest commit and CI status from GitHub into KV; the footer shows it; `/api/pulse` returns 200 while the snapshot is under 35 min old |
| Outside probe | UptimeRobot keyword monitor on `/api/pulse` every 5 min; email alerts. SLO clock Day 0 = 30 Sep 2026 |
| SLI ledger | Durable Object `SliLedger`: daily counts and histograms per source, failures in full; public `/api/slo?days=N` (503 `capacity` with `Retry-After` when the free-tier allowance is used up). Refused writes are logged as `ledger_unrecorded` and rebuilt from Workers Logs on the next healthy run (ADR-028) |
| Dashboard | `/reliability/` (flag `DASHBOARD_MODE=on`): summary, "Collecting data · Day N of 30" banner until the first window completes (30 Oct 2026), live state with Degraded when the latest run failed, SLO cards, 30-day strip, speed, failures, incident desk, client path, server path (Ludo). When the ledger cannot be read it renders from a KV read copy saved by every healthy run, with "Recording paused since…" and when writes resume (ADR-029); with no copy it says why (capacity, with the reset time, or unavailable). Missed readings are rebuilt from logs |
| Incident desk | 2 failed runs → `repository_dispatch` to the incident engine; owner `/commands` on GitHub Issues are the human gate; since 1 Oct 2026 every AI priority waits for `/approve` (ADR-021); the site reads the engine's public `feed.json` (refreshed by the scheduled job, so up to 10 min behind), showing each ticket's gate with the rule it ran under and the owner's latest `/note` (ADR-025) |
| Pulse run | `/play/` (a games page: Ludo and Pulse run cards, then the runner): validated `POST /api/rum`, no IP, user agent or cookie; personal result at game over |
| Ludo | `/ludo/` (ADR-026): one Durable Object per room over WebSockets; solo vs bots or up to four players on an invite link; names and room chat in any language, kept only in the room; server-measured SLIs `ludo_connect`, `ludo_action` (human actions), `ludo_bot` (one per run of bot turns), `ludo_rtt` (+ lobby, turn, game) on `/reliability/#ludo`. Linked from the homepage reliability item and `/play/`. Rooms batch telemetry to the ledger and append moves as rows (ADR-027; dev load test at 40 rooms: p99 240 to 80 ms). Games run until no human is left playing (then the bots are placed by board position); any player can leave, and an empty room stops. Invite links open a join-only screen. About 2 storage rows per move. When the free-tier allowance is used up it shows a "Ludo is napping" screen with the reset in the player's time and does not retry. Dev Worker `vikrantsingh-fyi-dev` (`wrangler deploy --env dev`) for trying branches |
| Visit counter | Counting, hidden until 1,000 views (`VISITS_MODE=auto`) |
| Brand | Favicon set and 1200×630 share image from `scripts/make-brand-assets.py` (reads the headline); `og:image` URL is versioned by the headline so caches never serve a stale card |

## Verified

- Game day 1 (1 Oct 2026, `FAULT=github_5xx`): the alert was raised by the site, triaged by the engine, worked through the human gate, and recovery was reported automatically. Eight findings, six fixed. Record: `docs/gamedays/2026-10-01-github_5xx.md`; public postmortem: `/notes/postmortem-game-day-1/`.
- Endpoint validation for `/api/rum` (origin, size, type, bounds), scripted playthroughs, the `game_js_error` game day, degrade-open behaviour, the Toronto-time boundaries across DST.
- Live desk policy: the engine's live workflow runs with `TRIAGE_AUTO_APPLY=off`, so a confident Low still waits for `/approve` (engine test `test_live_desk_never_auto_applies_even_low`, ADR-021).
- Desk records keep the rule they ran under (ADR-025): the one pre-ADR-021 ticket reads "auto-applied under the earlier low-risk rule"; the owner's latest `/note` shows on each ticket (issue #2 says game day 1's alert landed there).
- Homepage copy: every figure traced to the résumé or the owner's confirmation before publishing (ADR-022). 3 Oct 2026: the CompuCom 55% and 35% figures are off the page; the short path and the writing-index notes are live (checked on https://vikrantsingh.fyi/ and `/notes/`). CI run for `e542430` succeeded.
- **Error budget policy, draft:** `docs/slo.md` → Error budget policy. Levels at 50%, 25% and overspent, what counts (dependency failures, game days) and the monthly review are all `TODO` for the owner to confirm. Not adopted, and not stated on any page until it is.
- Error budget burn-down (4 Oct 2026, merged to `main`): built and hidden; it appears on `/reliability/` on its own from 30 Oct 2026 (first recorded day + 30, the date the collecting banner names). The SLO cards' budget bar now shows what is left, like its caption. Verified by `scripts/check-dashboard.mjs` (run by `npm run check` and CI): the gate flips at 00:00 Toronto on 30 Oct and one empty day cannot delay it; the chart matches the cards, breaks on a missing day and states an overspent budget; the bar fills with what is left. Each check was seen to fail against a deliberately broken dashboard.
- Ludo telemetry v2 (3 Oct 2026, PR #1, merged and deployed; live `/reliability/` shows both figures; not run on the dev Worker first): `ludo_action` counts human actions only; bot steps go to `ludo_bot`, one event per run of bot turns (worst lateness, steps, late steps), with its own proposed 99% objective and a "Bots on pace" figure on `/reliability/#ludo`. Log lines are `v: 2`; the backfill parser reads v1 and v2.
- Ludo fixes (3 Oct 2026, on `main`): a moved token no longer vanishes until the next roll (the last animation frame dropped it); invite screen shows one action; the game ends with the last human. Verified: `npm run check`; 2,000 seeded engine games finish, replay exactly and never move a bot after the last human finishes; local friends' room over WebSockets (start with bots, leave, play goes on); invite and plain start screens rendered headless. Not yet tried on a phone.
- Ludo (2 Oct 2026): 2,000 seeded games replay exactly and run to full placings; live tests of solo, four-player, rematch, leave (lobby, mid-game, solo stops the room), chat in 18 scripts, names; phone and desktop renders; dev load test at 40 rooms (p99 240 to 80 ms after ADR-027).
- Free-tier postmortem screenshots (4 Oct 2026): "What it looked like" on `/notes/postmortem-free-tier-writes/`: the paused reliability page and "Ludo is napping" on a phone at 7:58 p.m. EDT, and the "Catching up" page at 8:30 p.m. Cropped, resized JPEGs in `public/notes/free-tier-writes/` (about 270 KB together); no other people's names or personal data. Rendered locally at desktop width.
- Free-tier incident (2 Oct 2026, self-inflicted): capacity messages verified live during the outage (Ludo napping screen, dashboard card, `/api/slo` 503 `capacity`); heartbeat stayed fresh and no incident opened. Record: `docs/incidents/2026-10-02-free-tier-writes.md`; public postmortem: `/notes/postmortem-free-tier-writes/`.
- Ledger backfill (ADR-028): query API and parsing validated against real Workers Logs; dry run over the 2 Oct gap would restore 17 probe hits, 7 heartbeat runs and 29 page requests (to 18:55 UTC); capacity refusals are never replayed.

## Pending

- Game day 2 (2 Oct 2026, `FAULT=github_5xx`, held until the outside monitor went Down, then restored and worked through the gate on incident #3): write its record in `docs/gamedays/` from the template, including whether the alert reached the owner.
- Cloudflare CI token expiry is still `TODO` in `docs/runbook.md`.
- **Backfill restored counts for 2 Oct:** the rebuild ran and the gap is closed (`/api/slo` reports no recording gap; checked 05:17 UTC on 3 Oct). 2 Oct shows 140 of 144 scheduled runs and 304 probe checks. Still to read: the `op = ledger_backfill` lines in the Cloudflare dashboard, for the exact count restored. Workers Logs keep 3 days, so read or export them before about 5 Oct.
- **Backfilled readings are not visibly marked:** the ledger keeps a full record only for failed or slow events, so good rebuilt readings lose the `backfilled` mark and only two marked entries exist for 2 Oct. Pages that say rebuilt readings are "marked as backfilled" overstate it until rebuilt counts are stored per day and shown. Finding 9 in the incident record.
- Cloudflare account is on the Free plan: the daily Durable Object allowances (100,000 rows written) are shared by production and the dev Worker, so heavy tests on dev can take live storage down (it happened on 2 Oct). No load tests beyond ~40 rooms until a separate account or a paid plan (incident finding 2).
- A quiet, non-paging notice when the ledger refuses writes (incident finding 4).
- Alert channel: the alert mailbox is near capacity (game day 1, finding 7; owner: site owner).
- See [`ROADMAP.md`](ROADMAP.md) → Next.

## Token expiries

See `docs/runbook.md` → Scheduled incidents (GitHub read token, incident dispatch token, Cloudflare API token).

## Local dev gotchas (Windows)

- Never set secrets through a `!` prompt in an agent session: the hidden prompt stores an **empty** value and still reports success. Use the Cloudflare dashboard or a separate terminal.
- A stray `wrangler dev` holds its port; stop leftover `node` processes running `wrangler` before restarting.
- `wrangler.jsonc` sets `dev.host = localhost`; without it, the custom-domain routes make `wrangler dev` loop on the https redirect.
