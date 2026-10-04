# SLOs

Status: **draft targets**, measured since 30 Sep 2026. Revisit after the first 30-day window (30 Oct 2026). Never tighten a target that has not been met.

Window: rolling 30 days. Sources: **black-box** (external probe) and **white-box** (the SLI ledger, a Durable Object written by `worker/log.ts`; Analytics Engine dataset `site_sli` as well once it is enabled).

## SLO-1: Heartbeat freshness (black-box)

| | |
| --- | --- |
| SLI | Share of probe checks to `GET /api/pulse` that return **200 within 2 s** |
| Population | External probe, every 5 min ≈ **8,640 checks / 30 days** |
| Target | **99.0%**, so the error budget is about 86 bad checks ≈ **7 h 12 min** a month |
| Why this number | The snapshot must be under 35 min old (30 until game day 1, ADR-017), so two missed ticks in a row are absorbed with one tick of margin. GitHub has real incidents. Start loose, then tighten from data. |

## SLO-2: Ticker success (white-box)

| | |
| --- | --- |
| SLI | Share of `op=ticker` events with `outcome=ok` |
| Population | Cron every 10 min ≈ **4,320 runs / 30 days** |
| Target | **98.0%**, so the error budget is about 86 failed runs |
| Why this number | Every failure is a real dependency failure (GitHub, KV, token). SLO-1 is the user-facing view; this one explains it. |

## Tracked SLIs, not yet SLOs

| SLI | Why it is not an SLO yet |
| --- | --- |
| Page degraded rate (`op=page`, `outcome=degraded` / all) | Volume depends on visitors and crawlers. Promote once it exceeds about 1,000 events a month. |
| Page Worker time p95 (`op=page`, `double2`) | Same reason. Page speed stays a CI budget (L2). |
| **Server path (Ludo, ADR-026):** connects answered (proposed 99.5%), actions on time (≤ 100 ms server time, human actions only; proposed 99%), bots on pace (one check per run of bot turns, every step ≤ 250 ms late; proposed 99%; split out in schema v2, 3 Oct 2026), round trips ≤ 300 ms (proposed 95%); lobby starts, turn timeouts and game completion tracked | Server-measured, so trustworthy, but volume depends on people playing. Promote to SLOs with budgets after a full 30-day window of real play. Details: [ludo-telemetry.md](ludo-telemetry.md) |
| **Client path (Pulse run, ADR-015):** sessions started, game error rate, p95 frame time, % sessions with jank | Client-only and spoofable (public beacon). Shown as observations with the bound "Does not prove server capacity or ITSM readiness". Never an SLO or an alert |

## Alerting

| Phase | Rule | Channel |
| --- | --- | --- |
| P1 | Probe: 2 consecutive failures on `/api/pulse` | Uptime monitor's free email or push alert |
| P2 | Burn-rate, two windows: **fast** 14.4× over 1 h (≈2 of 12 checks bad) pages; **slow** 6× over 6 h tickets | OTLP backend chosen in P2 (ADR-004) |

## Query sketch (Analytics Engine SQL API, once enabled)

```sql
-- SLO-2, last 30 days. blob2 = outcome. Weight by _sample_interval for sampled rows.
SELECT
  SUM(_sample_interval * IF(blob2 = 'ok', 1, 0)) / SUM(_sample_interval) AS ticker_success
FROM site_sli
WHERE index1 = 'ticker' AND timestamp > NOW() - INTERVAL '30' DAY
```

## Long-term history (design agreed 30 Sep 2026, not built yet)

Vendor retention is short (Workers Logs: a few days; UptimeRobot free: 30 days shown; Analytics Engine: about 3 months, unverified). The permanent record is **Git**: a daily GitHub Action appends to an orphan branch `slo-data`. It never commits to `main`, because that would redeploy the site and fake "Last shipped" in the footer.

**Principle: failures in full, successes counted.**

| File | Rows | Contents |
| --- | --- | --- |
| `slo/daily.csv` | One per source (`probe`, `ticker`) per day | `date, source, total, good, bad, p50_ms, p95_ms, max_ms, slow_good` |
| `slo/events.csv` | One per non-good event | `ts, source, outcome, status, ms, dep, detail, fault`. Every `error`, every `degraded`, and every "slow good" (passed but used more than 50% of the latency budget) |

- SLO for any window = Σgood / Σtotal over its days. Exact, because the counts add up.
- Postmortems use `events.csv` timelines. Game-day rows are filterable by `fault`.
- Given up on purpose: recomputing past days under a stricter threshold. p95, max and `slow_good` bound it.
- **Built 30 Sep 2026: the SLI ledger (ADR-012)** implements this principle inside Cloudflare (Durable Object `SliLedger`, `GET /api/slo?days=N`). Sources: `ticker` (SLO-2), `pulse` (white-box view of every probe hit), `page`.
- Built 30 Sep 2026: the dashboard at `/reliability/` (ADR-013).
- Still to build: the daily Git export (reads `/api/slo` plus the UptimeRobot API for the black-box SLO-1). Needs only `UPTIMEROBOT_API_KEY` (read-only) as a GitHub secret; no Cloudflare analytics token.
- Paging is **not** served from this history. Alerts stay live in UptimeRobot.
- **Ledger outages are rebuilt, not lost (ADR-028).** Every SLI event is also written to Workers Logs. If the ledger refuses writes (2 Oct 2026: the free tier's 100,000 daily rows written were used up), the refused entries are logged in full and replayed into the ledger on the next healthy run, marked `backfilled`. Capacity refusals themselves are never counted. Workers Logs keep 3 days on the Free plan, which bounds how long an outage can wait.

## Why this is not theatre

A static page's uptime measures the CDN. Here, the measured path calls a third party on a clock, writes state, and every page and probe reads it back. It fails on its own, it degrades by design, and it can be broken on purpose without hurting visitors. See [ADR-010](adr/010-clock-driven-heartbeat.md).
