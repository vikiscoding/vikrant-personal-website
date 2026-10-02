# ADR-010: A clock-driven heartbeat is the system under test

Status: Accepted, 29 Sep 2026. Amends ADR-003 and ADR-007. Moves the contact form out of P1.

## Context

The two design-review documents (kept outside this repo) disagree in a way neither one says out loud.

- **Design v2**, after independent-review finding C1, made "synthetic probe results" the SLO population, but aimed the probe at `/api/contact`.
- **The critique** wants "a path that already ticks, not hoping strangers use a form". Its step 4 says to defer the contact form, and the SRE seat's objection is "a dashboard of your own synthetic clicks".

Probing a contact form every 5 minutes is not workable in practice:

1. It writes about 8,640 fake messages a month into D1 and sends as many emails. Or
2. It gets a bypass (skip Turnstile, skip storage, skip email). Then the probe no longer tests the real path, and the SLO measures the bypass.

Either way the SRE objection stands. The two fixes the critique offered are both unavailable: the other candidate is a client's live site (ADR-008), and the owner's other scheduled job runs about 30 times a month, which is too few.

## Decision

Build a small dynamic path that we own and that does real work on a clock:

| Part | What it does | Volume | Real failure modes |
| --- | --- | --- | --- |
| **Ticker** (Cron Trigger, every 10 min) | Calls the GitHub API for this repo's latest commit and `main` CI status. Writes a snapshot to KV. | ~4,320 runs a month | GitHub 5xx, secondary rate limits, token expiry, timeouts, response-shape drift, KV write errors |
| **Page read** (`run_worker_first` on HTML) | Reads the snapshot and injects "Last shipped … · build passing · checked 4 min ago" into the footer with `HTMLRewriter`. **Degrades open.** | Every human and crawler visit | KV read errors, stale snapshot |
| **`/api/pulse`** | Returns 200 when the snapshot is under 30 min old (35 since ADR-017), and 503 otherwise | ~8,640 external probes a month | Any of the above, seen from outside |

Why this answers the SRE seat:

- **The clock generates the volume, not visitors.** 4,320 ticker runs a month is enough for a 98% target to mean something (86 allowed failures).
- **The failures are not ours to invent.** The ticker depends on GitHub, a real third party. On a normal month it will fail sometimes, with no game day needed.
- **The probe is black-box and read-only.** It reads the path; it does not generate the work. This is how SRE teams use probers, and it avoids the fake-message problem entirely.
- **White-box and black-box disagree in useful ways.** Under `kv_read_fail`, pages still return 200 (degraded open) while `/api/pulse` returns 503. That gap is a useful lesson on its own.
- **We can break production on purpose.** The blast radius is one footer line by construction, so game days run on the real site, not a lab copy. The fault switch is a deploy-time variable (`FAULT`), with no request-time toggle and no Access policy needed yet.

Cost: all within Cloudflare's free plan at this volume (Workers, Cron Triggers, KV at about 144 writes a day). The external probe uses any free uptime monitor with a 5-minute interval and a status-code check.

## Consequences

- **Contact form moves from P1 to P3 (optional).** P0b's routed email address covers contact. This deletes Turnstile, D1, message retention, the 90-day purge job and most of the privacy burden from the critical path. If the form comes back, it is a lab experiment with real submissions as audit samples only.
- **P1 is now "the heartbeat"**, which is smaller than the contact form it replaces.
- **The site repo must be readable by the ticker.** A public repo (the recommended answer to the open question) needs only a token for rate limits. A private repo needs a fine-grained read-only token.
- **The fine-grained token expires.** Treat the expiry date as a scheduled incident: put it in the runbook and on the calendar. If it lapses anyway, that is a real postmortem.
- **The lab Worker is no longer needed for P2.** It stays deferred until a P3 experiment needs isolation the fault switch cannot give (canary, load testing).

## Rejected

- Probe the contact form with a bypass header: it measures the bypass, not the path.
- Hit counter or first-party analytics beacon as the heartbeat: volume depends on visitors again, and it collects visitor data.
- A client's live site or jobs as the system under test: other people depend on them (ADR-008).
