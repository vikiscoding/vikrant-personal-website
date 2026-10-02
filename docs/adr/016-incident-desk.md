# ADR-016: Incident desk, the triage agent on this site's real alerts

Status: Accepted and built, 1 Oct 2026. Engine repo: [`vikiscoding/vikrant_perswebsite_incidents_aiengine`](https://github.com/vikiscoding/vikrant_perswebsite_incidents_aiengine) (public; its `SITE_BRIDGE.md` has the full flow).

## Objective

Make the Incident-AI exhibit **live**: the agent handles this site's own failures in public, next to the dashboard, instead of only in a recorded walkthrough.

## Decision

- **A fresh engine repo** imported from `itsm-incident-mgmt-agent@895b805`: code, docs, tests and synthetic fixtures only. No preview incidents, demo runs or history. The original repo is untouched.
- **Event-driven, not long-running.** Each lifecycle step is one short GitHub Actions run against the store on the `incident-data` branch (`incidents.db`, per-incident folders, `feed.json`), committed after every step and serialised by one concurrency group. A long-lived job was rejected: a 6-hour cap, no inbound address, and loss on cancellation. The agent's store already makes the incident continuous.
- **Trigger:** the ticker raises `site_alert` after **2 consecutive failed ticks**, and `site_recovered` on the next healthy tick (`worker/incidents.ts`). If GitHub is unreachable, the signal stays pending and is retried each tick, so it is delivered late rather than lost.
- **Honest actors:** a new ingest-only actor `service:vikrantsingh.fyi-heartbeat` raises the incident. It can never transition, approve or hand off (enforced in the engine's model; tested). Grok proposes as `ai:grok:<model>`. Every later state change is `human:vikiscoding`.
- **Human gate = the GitHub Issue.** Only the owner's `/approve`, `/reject`, `/priority`, `/ack`, `/note`, `/resolve`, `/close` and `/reopen` comments run, through the agent's own CLI (typed confirm, holder checks, `requires_human` rules unchanged). Comment text reaches code only through env vars.
- **Showcase:** "Incident desk" on `/reliability/`: the latest 5 incidents with state, AI proposal, gate, and a who-did-what trail. Data comes from the public `feed.json` (no token), pulled into KV by the ticker when it changes.
- **Paging is not the agent's job.** UptimeRobot stays the pager; the desk is triage and record. If GitHub is down, the desk is late and the pager still fires.

## Consequences

- Secrets: `XAI_API_KEY` on the engine repo (optional; without it the model-down path runs). `INCIDENTS_DISPATCH_TOKEN` as a Worker secret (fine-grained, engine repo only, Contents read and write), set in the Cloudflare dashboard.
- Game days (`FAULT=github_5xx`) now produce real incidents through the desk. That is the natural way to run the next game day.
- Visitors cannot create incidents, and the desk shows nothing about visitors.
- Verified 1 Oct 2026: GitHub smoke test #1 (manual alert, model down) went site raised → AI unavailable → human ACKNOWLEDGED → ACTIVE → RESOLVED → CLOSED, and was shown on the local dashboard from the live feed. Engine tests: 120 passed.

## Rejected

- Keeping the agent running in one Actions job per incident: the reasons are above.
- An always-on VM: a server to patch and defend, for no benefit at this volume.
- Recording site alerts as `human:` or `ai:` actors: a false audit trail in a system whose pitch is verifiability.
- Visitor-triggered demo incidents: abuse and model-cost risk.
