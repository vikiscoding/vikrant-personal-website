# Runbook: heartbeat

One page. For 3 a.m. Read top to bottom.

## Alert: `/api/pulse` failing

1. **Is the page still up?** Open `/`. It should load even now (degrade open). If the page itself is 5xx, this is a different incident: check the latest deploy and roll back (`npx wrangler rollback`).
2. **What does the pulse say?** `curl -s https://vikrantsingh.fyi/api/pulse`
   - `{"state":"stale"}`: the ticker has not written for more than 35 min. Go to step 3.
   - `{"state":"error"}`: KV read failing. Check the Cloudflare status page. Nothing to fix on our side, but log the start time.
   - `{"state":"missing"}`: the snapshot was never written (fresh namespace) or was deleted. Trigger the ticker (step 4).
3. **Why is the ticker failing?** Workers Logs, filter `op = "ticker"` and `outcome = "error"`. Read `dep` and `detail`:
   | `detail` | Likely cause | Fix |
   | --- | --- | --- |
   | `http 401` | Token expired or revoked | New fine-grained token, `npx wrangler secret put GITHUB_TOKEN` |
   | `http 403` / `http 429` | Rate limit | Check that the token is set; unauthenticated calls share Cloudflare IPs |
   | `http 5xx`, `TimeoutError` | GitHub incident | Check githubstatus.com. Wait; the budget absorbs it |
   | `injected …` | A game-day fault is still deployed | `npx wrangler deploy --var FAULT:none` |
4. **Force a tick** once fixed: `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled"`, or wait up to 10 min for the next cron.
5. **Close:** note start, detect and restore times, and the budget burned. If the budget burned more than 10%, write a postmortem from `docs/templates/postmortem.md`.

## The probe (black-box, SLO-1 source)

| Setting | Value |
| --- | --- |
| Vendor | UptimeRobot, free plan |
| Monitor ID | 804130225 (https://dashboard.uptimerobot.com/monitors/804130225). The earlier HTTP monitor 804130071 is retired |
| Type | Keyword: `GET https://vikrantsingh.fyi/api/pulse`, **down when `"state":"fresh"` is absent**. Chosen over an HTTP check because the free plan forces 3xx to count as "up" |
| Interval | 5 min (about 8,640 checks per 30 days) |
| Alert | Email + UptimeRobot app push, **on the first failed check, no repeat**. "Notify after N failures" is a paid feature; the 35-min staleness window already absorbs one or two missed ticks |
| Clock | Running since **Day 0 = 30 Sep 2026**. First 30-day window closes **30 Oct 2026**: save the 30-day uptime % then |
| Alert path verified | 30 Sep 2026, 02:50 a.m. ET: a real 503 → DOWN email received within one check. The UptimeRobot "up for …" figure counts paused time; judge uptime by the 30-day %, not that counter |

SLO-1 for a 30-day window = the monitor's 30-day uptime %. Export or screenshot it at each window end: the free plan's history retention is limited, so the report must not depend on it.

## Incident desk (ADR-016)

- A real incident opens as an issue in `vikiscoding/vikrant_perswebsite_incidents_aiengine` (label `incident`) about 20 minutes into a heartbeat failure. **UptimeRobot will already have paged you**; the issue is the triage record.
- Reply on the issue: `/approve` or `/reject <reason>` the AI's triage, then `/ack`, `/note …`, `/resolve <reason>` once the site has recovered (a "Site reports recovery" comment appears), and `/close`.
- Manual test without breaking anything: engine repo → Actions → **site-alert** → Run workflow.
- Desk state lives in KV `incident:state` (`failures`, `open`, `pending`). A stuck `pending` means the dispatch token is missing, expired or wrong: check the Worker secret `INCIDENTS_DISPATCH_TOKEN`.

## Scheduled incidents

- **GitHub token expiry:** **Mon 30 Aug 2027** (fine-grained token `vikrant-personal-website-fgtoken`: this repo only; read Actions, Contents, Metadata). Renew by 23 Aug 2027: regenerate, then `npx wrangler secret put GITHUB_TOKEN`. If it lapses, every tick fails with `http 401` and `/api/pulse` goes stale 35 min later.
- **Incident desk dispatch token expiry:** **Thu 30 Sep 2027** (Worker secret `INCIDENTS_DISPATCH_TOKEN`; fine-grained, engine repo only, Contents read and write). Renew by 23 Sep 2027 in the Cloudflare dashboard. If it lapses, alerts stay `pending` in KV `incident:state` and no incident opens (UptimeRobot still pages).
- **Cloudflare API token expiry (CI/CD):** date `TODO`. When it expires, every deploy fails with an authentication error. Renew 7 days before: new token, same permissions, update the `CLOUDFLARE_API_TOKEN` repo secret, and re-run the last `ci-cd` workflow.

## Ledger outage and backfill (ADR-028)

Rule: if the SLI ledger cannot record (a free-tier allowance used up, or any outage), what it missed is rebuilt from Workers Logs on the next restore. It never raises an incident.

- **Detect:** every scheduled run waits for its own ledger write. Refused → KV `ledger:gap` is opened (`{ from, mode: "unrecorded" }`), once per outage. Every refused write anywhere is logged in full as `op = "ledger_unrecorded"`.
- **Restore:** the first run whose write lands while a gap is open replays the gap's `ledger_unrecorded` lines, one 30-minute slice per run (inside the Free plan's CPU limit), marked `backfilled`. Progress is saved after each slice, so a retry never counts twice. Closed → the key is deleted; Workers Logs show `op = "ledger_backfill"` lines with what was restored.
- **Needs:** `CF_ACCOUNT_ID` (var, in `wrangler.jsonc`) and the Worker secret `CF_OBSERVABILITY_TOKEN`: an API token with **Account → Workers Observability → Edit**, created under My Profile → API Tokens and added in the Worker's Settings → Variables and Secrets (never through an agent's `!` prompt). Without it the gap waits and logs why.
- **Limits:** Workers Logs keep 3 days on the Free plan; an older gap is abandoned with a log line. Pulse run sessions and the visit counter are not backfilled (client-only, and a single number).
- **A gap from before this rule** (2 Oct 2026): seeded by hand as `{ "from": <exact outage start ms>, "to": <reset ms>, "mode": "events" }`, with `from` taken from the logs (the first `op = ledger` line saying "free tier": 17:36:20 UTC). The backfill replays the ordinary SLI lines in that window.
- **API notes:** the query API returns events newest first and parses JSON log lines into `source`; text search does not match JSON keys, so the backfill uses exact field filters (`op = ledger_unrecorded`) or reads every event in a slice.
- **Check it:** `npx wrangler kv key get --binding PULSE --remote ledger:gap` (absent = no open gap).

## Game days (the fault switch)

Deploy a fault, observe, restore. Events carry `fault` so they can be excluded from SLO numbers if you choose.

| Fault | Expect | Teaches |
| --- | --- | --- |
| `github_5xx` | Ticker errors every tick; pulse goes stale at 35 min; probe alert | Detection time vs. staleness threshold |
| `github_slow` | Ticker times out at 5 s; same as above, slower | Timeouts and budgets |
| `kv_read_fail` | Pages return 200 but degraded; `/api/pulse` 503 at once | Black-box vs. white-box, degrade open |
| `kv_write_fail` | Ticker errors; pulse stale after 35 min | Write path failure |
| `game_js_error` | `/play/` throws on start; "Client path" error rate rises with `game day` tags; server SLOs unaffected | Client-path signal and blast radius (ADR-015) |

```sh
npx wrangler deploy --var FAULT:github_5xx   # break
npx wrangler deploy --var FAULT:none         # restore
```
