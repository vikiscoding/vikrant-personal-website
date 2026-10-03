# Incident: free-tier database writes used up (2 Oct 2026)

Raw record for the postmortem (template: `docs/templates/postmortem.md`; public version: `/notes/postmortem-free-tier-writes/`). Times in UTC (Toronto = UTC−4, EDT). Self-inflicted: caused by this site's own load testing, not by visitors or a provider fault.

**What happened:** two load tests and the regression runs after them used up the account's daily Durable Objects allowance of **100,000 rows written** (Cloudflare Workers Free plan, shared by every Worker on the account, reset at 00:00 UTC). From 17:36:20, every Durable Object write was refused with `Exceeded allowed rows written in Durable Objects free tier.`

## Impact

| Affected (17:36:20 to 00:00 UTC, 6 h 24 min) | Not affected |
| --- | --- |
| SLI ledger: writes refused, so `/reliability/` and `/api/slo` could not be read | Every page served |
| Ludo: new games could not start (room state could not be saved) | Heartbeat, footer and `/api/pulse` (KV) |
| Visit counter paused | Outside probe and SLO-1 (UptimeRobot) |
| Ledger records for the window missing (recoverable from Workers Logs) | Incident desk; no incident raised |

## Timeline (UTC)

| Time | Event | Evidence |
| --- | --- | --- |
| 16:21 | Load test 1 on the dev Worker: 40 rooms × 4 players, 60 s (11,622 actions) | dev `ludo_connect` burst in Workers Logs |
| 16:30–16:32 | Load test 2 after the scaling change (11,856 actions) | dev `ludo_connect` burst |
| 16:32–17:30 | Regression runs on dev (full games to last place, chat, leave, persistence) | dev logs |
| 17:10 | Scaling change (ADR-027) deployed to production: about 6 rows written per Ludo move | ci-cd run, commit `ead62c6` |
| **17:36:20** | **First refused write** (`op = ledger`, "Exceeded allowed rows written … free tier") | Workers Logs |
| 17:36:29 | Dashboard render fails; the page falls back to "The live numbers appear here once 30 days of data exist" | `op = dashboard` error |
| ~17:40 | Noticed by eye on `/reliability/`; the fallback read like a deliberate choice | Owner's screenshot |
| 17:42 | Cause confirmed from the production log tail | `wrangler tail` |
| 17:48 | Honest fallback deployed: "Live numbers are temporarily unavailable" (and the collecting-data banner) | commit `2ce05cd` |
| 18:09 | Capacity-aware messages (Ludo "napping" screen, dashboard card, `/api/slo` 503 with `Retry-After`); Ludo cut to ~2 rows per move | commit `5a2d6ce` |
| 18:58 | Backfill as a standing rule (ADR-028); "Nothing is lost" wording | commit `881da93` |
| ~19:05 | Today's gap seeded: `ledger:gap` = 17:36:19.792 to 00:00, mode `events` | KV |
| 19:35 | Checked on the dev Worker: with writes exhausted, even `SELECT 1` and a read of `sqlite_master` are refused ("Exceeded allowed rows written"); reads are not possible | dev Workers Logs (`DIAG` lines) |
| 19:45 | Read copy of the 30-day window in KV (`slo:last`), refreshed by every healthy run; dashboard and `/api/slo` fall back to it with "Recording paused since…" (ADR-029). Verified locally with `FAULT=ledger_read_fail` | branch `ledger-read-during-capacity` |
| 00:00 (3 Oct) | Allowance resets; backfill replays the gap from Workers Logs, a slice per run | Page captures 00:30 to 01:41 UTC show "Catching up on readings" throughout (`2026-10-02-free-tier-writes-record/`, local) |
| by 05:17 (3 Oct) | Gap closed: `/api/slo` reports no recording gap and the banner is gone. 2 Oct: 140 of 144 scheduled runs, 304 probe checks on record | `/api/slo?days=30` |

Time to detect: minutes, by a person, not by a signal (finding 4). Time to mitigate the user-facing confusion: 6 min after confirmation (17:42 to 17:48). Time to restore: the 00:00 UTC reset (no earlier restore exists on the Free plan).

## What went well

- Degrade-open held: every page served; the heartbeat and the outside probe never noticed.
- No false incident: nothing on the incident path uses Durable Objects, by design.
- The cause was in the logs verbatim; diagnosis took minutes.
- Nothing was truly lost: every event is also written to Workers Logs, a separate failure domain.

## Findings and actions

| # | Finding | Action | Status |
| --- | --- | --- | --- |
| 1 | The load-test plan checked the daily *request* limit, not *rows written*, the one that binds on the Free plan | No load tests beyond ~40 rooms on the Free plan; capacity budget is part of any test plan | Done (documented) |
| 2 | Dev and production share account-wide allowances: a test on dev took production storage down | Documented in STATUS; separate account or a paid plan before the next load test | Open (owner) |
| 3 | A scalability change optimised the wrong resource: it cut contention on the shared ledger but raised rows written per move from ~4 to ~6 | One state record + one log row per move: ~2 rows | Fixed (`5a2d6ce`) |
| 4 | Detection was by eye: no signal said the ledger was refusing writes | The heartbeat now notices refused writes and opens a backfill gap (deliberately not a page or an incident) | Fixed (`881da93`); a non-paging notice is open |
| 5 | The failure was misleading: the fallback said numbers "appear once 30 days exist" | Honest cards that name the cause and the reset time | Fixed (`2ce05cd`, `5a2d6ce`) |
| 6 | Ludo failed as a dead connection | "Ludo is napping" screen with the reset in the player's time; no retries until then | Fixed (`5a2d6ce`) |
| 7 | The ledger missed 6 h 24 min of records | Backfill from Workers Logs as a standing rule (ADR-028); today's gap seeded | Fixed; replay ran and the gap closed by 05:17 UTC on 3 Oct. Exact restored count still to read from `op = ledger_backfill` lines |
| 8 | The dashboard went dark although only writes were refused; testing showed Cloudflare refuses reads too once the write allowance is used up | Read copy of the window in KV, shown labelled when the ledger cannot be read (ADR-029) | Fixed |
| 9 | Rebuilt readings are said to be "marked as backfilled", but the ledger keeps full records only for failed or slow events, so good rebuilt readings lose the mark (two marked entries for 2 Oct) | Store rebuilt counts per day and source, and show them on `/reliability/` | Open |

## Open

- Read the restored counts from the `op = ledger_backfill` lines (Cloudflare dashboard; logs keep 3 days, so before about 5 Oct) and compare them with the dry run (17 probe hits, 7 heartbeat runs, 29 page requests by 18:55). `ledger:gap` is already gone.
- Finding 9.
- Findings 2 and 4 (non-paging notice).
