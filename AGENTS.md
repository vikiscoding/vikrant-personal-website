# AGENTS.md: vikrantsingh.fyi

Cold start for anyone, human or coding agent, working in this repo. Read this, then [`docs/STATUS.md`](docs/STATUS.md) (what is live and verified), then [`docs/ROADMAP.md`](docs/ROADMAP.md). At the end of a working session, rewrite `docs/STATUS.md` to match reality.

## What this is

The owner's personal site (headline, proof items, résumé, contact) plus a small dynamic path that is operated in public: a heartbeat, SLOs, an outside probe, an incident desk and game days. Decisions are recorded in [`docs/adr/`](docs/adr/README.md); the key one is [ADR-010](docs/adr/010-clock-driven-heartbeat.md). Personal planning is kept outside this repo.

## Layout

| Path | Holds |
| --- | --- |
| `src/data/profile.ts` | All site copy. The only place to edit words. |
| `src/pages/` | `index`, `reliability` (dashboard), `play` (Pulse run), `notes/` (Writing, how-this-site-is-run, postmortems), `exhibits/*`, `privacy` |
| `src/layouts/Base.astro` | Shell, nav and wordmark, share tags, and the footer `[data-pulse]` slot |
| `worker/index.ts` | Routes: `/api/pulse`, `/api/slo`, `/api/rum`, pages, cron |
| `worker/ticker.ts` | Cron: GitHub → KV snapshot, then the incident-desk signal |
| `worker/pulse.ts` | Snapshot read, page injection (degrade open), probe endpoint |
| `worker/ledger.ts`, `worker/slo.ts` | SLI ledger (Durable Object) and the SLO window |
| `worker/dashboard.ts` | Server-rendered `/reliability/` |
| `worker/incidents.ts` | Incident desk: dispatch to the engine, read its feed |
| `worker/rum.ts` | Pulse run telemetry endpoint (the only public write path) |
| `worker/log.ts` | The one log/SLI event shape (`docs/log-schema.md`) |
| `worker/faults.ts` | Deploy-time game-day switch |
| `worker/ludo/`, `src/pages/ludo.astro` | Ludo latency testbed, **proposed** (ADR-026; branch only until its rule conflicts are resolved): `engine.ts` (pure, seeded rules), `room.ts` (one Durable Object per room), `route.ts` (WebSocket upgrade), `telemetry.ts` (event schema). Doc: `docs/ludo-telemetry.md` |
| `scripts/` | Brand-asset generator |
| `docs/` | Status, roadmap, ADRs, SLOs, runbook, game days, templates |

## Rules

- **Four proof items, no more** (ADR-022, ADR-023): this site's reliability (with Pulse run inside it), the incident desk, Balance-Books, Atlas Flow. Pulse run is a bounded client-path testbed, never the homepage hero; no second game on this domain. Never add other projects.
- **Every figure traces to the résumé or the owner's explicit confirmation.** "Scope:" lines say what a thing is not; they come after the text, never first.
- **Pulse run copy:** never "production-grade gaming platform"; no invented SLOs; no numbers on the home card until real samples exist; never link it to the Incident-AI or Atlas Flow videos or essays.
- **The incident desk only reports, never decides** (ADR-016): the Worker sends `site_alert`/`site_recovered`; every decision after intake is the owner's command on GitHub. Never add a visitor-triggered incident path.
- **`/api/rum` is the only public write path.** Validate everything (origin, size, type, bounds), store no IP, user agent or cookie, and never feed it into an SLO or an alert. Update `/privacy` before changing what it collects.
- **Keep personal planning out of this repo.** It is public.
- **Never invent** numbers, clients or testimonials. Unconfirmed copy stays marked `TODO`.
- **Nav labels stay literal:** Home · Live reliability · Writing · Play (ADR-024; Play stays last). No "observability" or "SLO console" in public labels. No gradients, galleries or stock hero.
- **Writing lists and links; it never republishes.** Titles and dates come from the Medium feed, and claims are the post's own words.
- **No claim ahead of evidence.** "Owns the pager" waits for a full 30-day SLO window; no film link until the film is published; the incident agent's suggestions are always "proposed, not applied"; never break or test Balance-Books or any live business site on purpose (ADR-008).
- **No personal data in logs**: no IP, email, body, headers or tokens.
- **Degrade open.** Nothing dynamic may fail a page. Only `/api/pulse` may return 5xx on purpose.
- **Faults are deploy-time only.** Never add a request-time fault toggle to the site Worker.
- No LLM features on the site. No new deploy units, vendors or shared packages without an ADR.
- `main` is production; the CI build must pass; secrets only in Cloudflare and GitHub secrets, set in their dashboards.

## Conventions

**Definition of done.** `npm run check` passes; the change is verified by running it (`npm run preview`, a scripted request, or a screenshot), not only by reading it; `docs/STATUS.md` matches reality; any decision that changes a rule above has an ADR; `/privacy` is updated before anything new is collected.

**Code.**
- Comments explain *why* (a constraint, an incident, an ADR), not what the next line does. Cite the ADR or game-day finding that caused a rule.
- One event shape for telemetry (`worker/log.ts`, `docs/log-schema.md`); change it by bumping `v` in the same commit as the doc.
- Every dynamic call degrades open, has a timeout, and never throws into a page.
- Validate every input at the boundary (origin, size, type, bounds). Never echo input; escape everything rendered into HTML.
- Prefer the platform and the existing stack over a new dependency. A new deploy unit, vendor or package needs an ADR.

**Coding agents.**
- Read `AGENTS.md`, `docs/STATUS.md` and the relevant ADRs before editing. Do not re-litigate an accepted ADR in code; propose a new one.
- Work on a branch. `main` deploys to production; never push to it, deploy, or change secrets or DNS without the owner's explicit go-ahead.
- Report outcomes as they are: what was run, what passed, what failed, what was not verified.
- Never set secrets through an agent's hidden `!` prompt (it stores an empty value); use the Cloudflare or GitHub dashboard.
- Keep personal planning, private project names and people's names out of commits, comments and docs; refer to "the owner".
- Commits: imperative summary line, a body that says why, and the tool's co-author trailer when an agent wrote the change.

## Commands

```sh
npm install
npm run dev       # Astro only, no Worker
npm run preview   # build + wrangler dev (Worker, assets, pulse)
npm run check     # astro check + Worker typecheck
python scripts/make-brand-assets.py   # after a headline change
# Deploy = push to main (CI/CD). `npm run deploy` is emergency-only.
```
