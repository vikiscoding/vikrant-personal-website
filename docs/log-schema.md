# Log schema (v1)

One JSON line per unit of work, emitted by `worker/log.ts`. The same fields go to Workers Logs (console), the SLI ledger and, once enabled, Analytics Engine (`site_sli`). None of them shares a failure domain with KV, so a KV outage is still recorded.

Pulse run's browser events (`POST /api/rum`, ADR-015) are not log lines: they go straight to the ledger's `game_sessions` table and `frame`/`game` sources after validation.

Events with `op` in `ticker`, `pulse_api`, `page` are also written to the SLI ledger (ADR-012) as daily counts, with non-good and slow-good events kept in full.

**Never logged:** IP addresses, email addresses, message bodies, request headers, tokens.

| Field | Type | Values | Analytics Engine column |
| --- | --- | --- | --- |
| `v` | number | `1` | — |
| `ts` | ISO string, **UTC** | Ledger `day` = Toronto calendar date of `ts` (ADR-014) | `timestamp` (automatic) |
| `op` | string | `ticker`, `page`, `pulse_api`, `visits` (counter failures and timeouts only) | `index1`, `blob1` |
| `outcome` | string | `ok`, `degraded`, `error` | `blob2` |
| `path` | string | URL path, pages only | `blob3` |
| `dep` | string | `github`, `kv`, `assets`, `none`: what failed | `blob4` |
| `detail` | string | Short cause, e.g. `http 503`, `TimeoutError`, `stale` | `blob5` |
| `fault` | string | Active `FAULT` value, so game-day events can be filtered out | `blob6` |
| `status` | number | HTTP status, or the dependency's status for the ticker | `double1` |
| `ms` | number | Duration of the unit of work | `double2` |

`outcome` meanings:

- `ok`: did its job.
- `degraded`: the user got a working page without the dynamic part (degrade open).
- `error`: the unit of work failed. For `pulse_api` that includes returning 503 because the snapshot is stale.

Change the schema by bumping `v` and adding a row here in the same PR.
