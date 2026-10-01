// Reliability dashboard (ADR-013). Server-rendered HTML from the SLI ledger + the live pulse. No client JS.
// Shown on /reliability/ when DASHBOARD_MODE allows: "off" | "auto" (once 30 days of data exist) | "on".
import type { Env } from "./env";
import type { DayRow, EventRow, LedgerSource } from "./ledger";
import type { Pulse } from "./pulse";
import { TARGETS, type SloWindow } from "./slo";
import { addDays, localDay, localStamp } from "./time";
import type { Feed, FeedIncident } from "./incidents";

export type DashboardMode = "off" | "auto" | "on";
export const WINDOW_DAYS = 30;

export function dashboardMode(env: Env): DashboardMode {
  return env.DASHBOARD_MODE === "on" || env.DASHBOARD_MODE === "auto" ? env.DASHBOARD_MODE : "off";
}

/** Expected events in a full 30-day window, from the schedules (probe every 5 min, ticker every 10 min). */
const EXPECTED: Record<"pulse" | "ticker", number> = { pulse: 8_640, ticker: 4_320 };

const LABEL: Record<LedgerSource, string> = {
  pulse: "Heartbeat freshness",
  ticker: "Scheduled job success",
  page: "Page requests",
  frame: "Pulse run frame time",
  game: "Pulse run",
};
const EVENT_LABEL: Record<LedgerSource, string> = { pulse: "Probe check", ticker: "Scheduled job", page: "Page", frame: "Pulse run frame", game: "Pulse run (browser)" };
const EXPLAIN: Record<"pulse" | "ticker", string> = {
  pulse: "Every 5 minutes an outside monitor asks whether this site's status snapshot is less than 35 minutes old.",
  ticker: "Every 10 minutes a job fetches this site's latest commit and build status from GitHub and saves a snapshot.",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const n = (x: number) => x.toLocaleString("en-CA");
function pct(x: number): string {
  if (x >= 1) return "100%";
  const v = Math.floor(x * 10_000) / 100; // never round up into a better number than earned
  return `${v.toFixed(2)}%`;
}
function ago(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const ms = (v: number | null) => (v === null ? "over 6.4 s" : `≤ ${n(v)} ms`);

function dayKeys(now: number): string[] {
  const today = localDay(now);
  return Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(today, i - (WINDOW_DAYS - 1)));
}

function liveCard(pulse: Pulse | null, now: number, desk: { failures: number; lastDetail: string } | null): string {
  if (!pulse) {
    return `<section class="dash-card dash-live" data-state="bad"><h2>Right now</h2>
      <p class="dash-big">Status unavailable</p><p class="dash-muted">The status store could not be read. The site itself is still serving.</p></section>`;
  }
  // Freshness alone hid a failing job for ~20 minutes in game day 1: the latest run's outcome counts too (ADR-017).
  const failing = pulse.state === "fresh" && (desk?.failures ?? 0) > 0;
  const state = pulse.state !== "fresh" ? "bad" : failing ? "warn" : "good";
  const headline =
    pulse.state === "stale" ? "Heartbeat late"
    : pulse.state === "missing" ? "No heartbeat yet"
    : failing ? "Degraded: last scheduled run failed"
    : "Operating normally";
  const why = failing
    ? `<p class="dash-small">Failing ${esc(desk?.lastDetail ?? "")}. Visitors are unaffected: the last good snapshot is still inside its window.</p>`
    : "";
  const s = pulse.snap;
  const rows = s
    ? `<dl class="dash-facts">
        <div><dt>Last check</dt><dd>${esc(ago(s.fetchedAt, now))}</dd></div>
        <div><dt>Last shipped</dt><dd>${esc(ago(s.lastCommitAt, now))} <span class="dash-muted">(${esc(s.lastCommitSha)})</span></dd></div>
        <div><dt>Build</dt><dd>${esc(s.ciConclusion ?? "running")}</dd></div>
      </dl>`
    : "";
  return `<section class="dash-card dash-live" data-state="${state}">
    <h2>Right now</h2>
    <p class="dash-big"><span class="dash-dot" aria-hidden="true"></span>${headline}</p>${why}${rows}
  </section>`;
}

function sloCard(win: SloWindow, source: "pulse" | "ticker"): string {
  const sum = win.summary.find((s) => s.source === source);
  const target = TARGETS[source];
  const allowed = Math.floor(EXPECTED[source] * (1 - target));
  const used = sum?.bad ?? 0;
  const left = allowed - used;
  const usedPct = Math.min(100, Math.round((used / allowed) * 100));
  const state = !sum || sum.total === 0 ? "none" : left < 0 ? "bad" : usedPct >= 50 ? "warn" : "good";
  const big = sum && sum.total ? pct(sum.good / sum.total) : "—";
  const budgetText =
    left >= 0
      ? `${n(used)} of ${n(allowed)} allowed failures used · <strong>${n(left)} left</strong>`
      : `<strong>Objective missed:</strong> ${n(used)} failures against ${n(allowed)} allowed`;
  return `<section class="dash-card" data-state="${state}">
    <h2>${LABEL[source]}</h2>
    <p class="dash-big">${big}</p>
    <p class="dash-small dash-muted">${n(sum?.good ?? 0)} of ${n(sum?.total ?? 0)} checks good</p>
    <p class="dash-small">Objective: <strong>${+(target * 100).toFixed(2)}%</strong> over 30 days</p>
    <div class="dash-bar" role="img" aria-label="Error budget ${usedPct}% used"><span style="width:${usedPct}%"></span></div>
    <p class="dash-small">Error budget: ${budgetText}</p>
    <p class="dash-small dash-muted">${EXPLAIN[source]}</p>
  </section>`;
}

function dayState(row: DayRow | undefined, source: "pulse" | "ticker"): "none" | "good" | "warn" | "bad" {
  if (!row || row.total === 0) return "none";
  if (row.bad === 0) return "good";
  return row.good / row.total >= TARGETS[source] ? "warn" : "bad";
}

function strip(days: DayRow[], now: number): string {
  const keys = dayKeys(now);
  const line = (source: "pulse" | "ticker") => {
    const cells = keys
      .map((k) => {
        const row = days.find((d) => d.day === k && d.source === source);
        const st = dayState(row, source);
        const tip = row ? `${k}: ${n(row.good)} of ${n(row.total)} good` : `${k}: no data`;
        return `<li data-state="${st}" title="${esc(tip)}"><span class="dash-sr">${esc(tip)}</span></li>`;
      })
      .join("");
    return `<div class="dash-strip-row"><p class="dash-small">${LABEL[source]}</p><ol class="dash-strip">${cells}</ol></div>`;
  };
  return `<section class="dash-section">
    <h2>Last 30 days</h2>
    ${line("pulse")}${line("ticker")}
    <p class="dash-strip-axis dash-small dash-muted"><span>${keys[0]}</span><span>today</span></p>
    <p class="dash-legend dash-small dash-muted">
      <span data-state="good"></span>no failures <span data-state="warn"></span>some failures, objective met
      <span data-state="bad"></span>objective missed that day <span data-state="none"></span>no data
    </p>
  </section>`;
}

function speed(days: DayRow[], now: number): string {
  const keys = dayKeys(now).slice(-7).reverse();
  const cell = (row: DayRow | undefined) => (row && row.total ? ms(row.p95_ms) : "—");
  const rows = keys
    .map((k) => {
      const t = days.find((d) => d.day === k && d.source === "ticker");
      const p = days.find((d) => d.day === k && d.source === "pulse");
      if (!t && !p) return "";
      return `<tr><th scope="row">${k}</th><td>${cell(t)}</td><td>${cell(p)}</td></tr>`;
    })
    .join("");
  return `<section class="dash-section">
    <h2>Speed</h2>
    <p class="dash-small dash-muted">95% of runs were at least this fast. Times are rounded up to the nearest band (50, 100, 200, 400, 800, 1,600, 3,200 ms).</p>
    <table class="dash-table">
      <thead><tr><th scope="col">Day</th><th scope="col">Scheduled job <span class="dash-muted">(GitHub check)</span></th><th scope="col">Probe check <span class="dash-muted">(site's answer)</span></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3" class="dash-muted">No data yet.</td></tr>`}</tbody>
    </table>
  </section>`;
}

function failures(events: EventRow[]): string {
  const server = events.filter((e) => e.source !== "game" && e.source !== "frame");
  const shown = server.filter((e) => e.outcome !== "ok").slice(0, 15);
  const slow = server.filter((e) => e.outcome === "ok").length;
  const items = shown
    .map((e) => {
      const gameDay = e.fault !== "none" ? ` <span class="dash-tag">game day</span>` : "";
      const what = e.outcome === "degraded" ? "served without live status" : "failed";
      return `<li><time datetime="${esc(e.ts)}">${esc(localStamp(e.ts))}</time>
        <span><strong>${EVENT_LABEL[e.source]}</strong> ${what}: ${esc(e.detail || `HTTP ${e.status}`)}${
          e.dep !== "none" ? ` <span class="dash-muted">(cause: ${esc(e.dep)})</span>` : ""
        }${gameDay}</span></li>`;
    })
    .join("");
  const more = server.filter((e) => e.outcome !== "ok").length - shown.length;
  return `<section class="dash-section">
    <h2>Failures</h2>
    ${
      items
        ? `<ol class="dash-events">${items}</ol>${more > 0 ? `<p class="dash-small dash-muted">and ${n(more)} more in the raw data.</p>` : ""}`
        : `<p>No failures in the last 30 days.</p>`
    }
    ${slow ? `<p class="dash-small dash-muted">${n(slow)} slow but successful run${slow === 1 ? "" : "s"} (over half the time budget) also recorded as early warnings.</p>` : ""}
  </section>`;
}

function clientPath(win: SloWindow): string {
  const g = win.game;
  const rate = (k: number) => (g.sessions ? `${Math.round((k / g.sessions) * 1000) / 10}%` : "—");
  const errors = win.events.filter((e) => e.source === "game").slice(0, 5);
  const tiles = g.sessions
    ? `<dl class="dash-facts dash-client">
        <div><dt>Sessions</dt><dd>${n(g.sessions)} <span class="dash-muted">(${n(g.started)} played)</span></dd></div>
        <div><dt>Game error rate</dt><dd>${rate(g.errored)}</dd></div>
        <div><dt>p95 frame time</dt><dd>${g.frame_p95_ms === null ? "—" : `≤ ${n(g.frame_p95_ms)} ms`}</dd></div>
        <div><dt>Sessions with jank</dt><dd>${rate(g.janky)}</dd></div>
      </dl>`
    : `<p>No plays recorded yet. <a href="/play/">Be the first →</a></p>`;
  const errs = errors.length
    ? `<ol class="dash-events">${errors
        .map(
          (e) => `<li><time datetime="${esc(e.ts)}">${esc(localStamp(e.ts))}</time><span>${esc(e.detail)}${
            e.fault !== "none" ? ` <span class="dash-tag">game day</span>` : ""
          }</span></li>`,
        )
        .join("")}</ol>`
    : "";
  return `<section class="dash-card" data-state="none" id="client-path">
    <h2>Client path (<a href="/play/">Pulse run</a>)</h2>
    <p class="dash-small dash-muted">A 30-second browser game on this site reports its own errors and frame times. Jank = a frame slower than 50 ms. 60 fps needs about 16 ms.</p>
    ${tiles}${errs}
    <p class="dash-small"><a href="/play/">Add a data point: play Pulse run for 30 seconds →</a></p>
    <p class="dash-small dash-muted">Client-only signal. Does not prove server capacity or ITSM readiness.</p>
  </section>`;
}

const OPEN = new Set(["DETECTED", "TRIAGING", "ACKNOWLEDGED", "ACTIVE"]);

/** "service raised it → AI → human: ACKNOWLEDGED → ACTIVE → …": who did what, from the engine's own timeline. */
/** The owner's note, escaped; only links back to this site become clickable. */
function ownerNote(note: string): string {
  return esc(note).replace(/https:\/\/vikrantsingh\.fyi\/[\w\-./#]*/g, (u) => `<a href="${u}">${u.replace("https://vikrantsingh.fyi", "")}</a>`);
}

function trail(i: FeedIncident): string {
  const steps: string[] = [];
  if (i.timeline.some((e) => e.kind === "service")) steps.push("site raised it");
  const ai = i.timeline.filter((e) => e.kind === "ai");
  if (ai.length) steps.push(ai.some((e) => e.event.endsWith("_failed")) && !i.triage ? "AI unavailable" : "AI proposed");
  const human = i.timeline.filter((e) => e.kind === "human" && e.to).map((e) => e.to as string);
  if (human.length) steps.push(`human: ${human.join(" → ")}`);
  return steps.join(" → ");
}

function incidentDesk(feed: Feed | null): string {
  const repo = feed?.repo ? `https://github.com/${esc(feed.repo)}` : null;
  const items = (feed?.incidents ?? []).slice(0, 5);
  const list = items.length
    ? `<ol class="dash-incidents">${items
        .map((i) => {
          const state = OPEN.has(i.state) ? "bad" : "good";
          const title = i.issue_url ? `<a href="${esc(i.issue_url)}">${esc(i.title)}</a>` : esc(i.title);
          const proposal = i.triage
            ? `AI proposed <strong>${esc(i.triage.priority)}</strong> (confidence ${i.triage.confidence.toFixed(2)})`
            : "No AI proposal (model unavailable)";
          return `<li>
            <p class="dash-incident-head"><span class="dash-badge" data-state="${state}">${esc(i.state)}</span> ${title}</p>
            <p class="dash-small dash-muted">Opened ${esc(localStamp(i.created_at))} · ${proposal} · gate: ${esc(i.gate)}${
              i.drafts_unsent ? ` · ${n(i.drafts_unsent)} draft${i.drafts_unsent === 1 ? "" : "s"}, never sent` : ""
            }${i.recovered_at ? ` · site recovered ${esc(localStamp(i.recovered_at))}` : ""}</p>
            ${i.note ? `<p class="dash-small">Owner's note: ${ownerNote(i.note)}</p>` : ""}
            <p class="dash-small">${esc(trail(i))}</p>
          </li>`;
        })
        .join("")}</ol>`
    : `<p>No incidents yet. When this site's scheduled job fails twice in a row, the incident engine opens one here.</p>`;
  return `<section class="dash-card" data-state="none" id="incident-desk">
    <h2>Incident desk</h2>
    <p class="dash-small dash-muted">Real failures of this site go to an incident triage agent. It proposes priority and drafts updates; a human runs every step after that, in public GitHub issues.</p>
    ${list}
    <p class="dash-small dash-muted">Alerts from this site only; tests are titled as tests. AI drafts are never sent. Since 1 Oct 2026, every AI priority waits for a human approval; each entry's gate says which rule applied when it was triaged. AI priority never pages anyone: paging comes from the outside probe on this site's SLO. After intake, every state change is a human command.${
      repo ? ` <a href="${repo}">Engine repo →</a>` : ""
    }</p>
  </section>`;
}

function traffic(win: SloWindow): string {
  const page = win.summary.find((s) => s.source === "page");
  if (!page || !page.total) return "";
  return `<p class="dash-small dash-muted">Page requests served in this window: ${n(page.total)} (bots included) · served without the live status line: ${n(page.bad)}.</p>`;
}

export function renderDashboard(
  win: SloWindow,
  pulse: Pulse | null,
  feed: Feed | null = null,
  desk: { failures: number; lastDetail: string } | null = null,
  now = Date.now(),
): string {
  const firstDay = win.days[0]?.day;
  const daysWithData = new Set(win.days.map((d) => d.day)).size;
  const young =
    daysWithData < WINDOW_DAYS
      ? `<p class="dash-note">Only ${daysWithData} day${daysWithData === 1 ? "" : "s"} of data so far (since ${esc(firstDay ?? "today")}). The 30-day figures become meaningful once a full window exists.</p>`
      : "";
  // One-line summary (ADR-018): the answer before the evidence.
  const fresh = pulse?.state === "fresh";
  const failing = fresh && (desk?.failures ?? 0) > 0;
  const openIncidents = (feed?.incidents ?? []).filter((i) => OPEN.has(i.state)).length;
  const status = !pulse ? "Status unavailable" : !fresh ? "Heartbeat late" : failing ? "Degraded" : "All checks normal";
  const summary = `<p class="dash-summary" data-state="${!fresh ? "bad" : failing ? "warn" : "good"}"><strong>${status}</strong> · ${
    openIncidents === 0 ? "no open incidents" : `${n(openIncidents)} open incident${openIncidents === 1 ? "" : "s"}`
  } · data since ${esc(firstDay ?? "today")}</p>`;
  return `<div class="dash">
    ${summary}
    ${young}
    ${liveCard(pulse, now, desk)}
    <div class="dash-grid">${sloCard(win, "pulse")}${sloCard(win, "ticker")}</div>
    ${strip(win.days, now)}
    ${speed(win.days, now)}
    ${failures(win.events)}
    ${incidentDesk(feed)}
    ${clientPath(win)}
    <section class="dash-section">
      <h2>How to read this</h2>
      <ul class="dash-small">
        <li><strong>Objective (SLO):</strong> the share of checks that must succeed over 30 days.</li>
        <li><strong>Error budget:</strong> how many failures the objective allows in 30 days. Spending it is fine; overspending means reliability work comes before new features.</li>
        <li>The official external number is the outside monitor's 30-day uptime, reported monthly. The figures here are the site's own records of the same checks.</li>
        <li>All times and days are Toronto time (ET: EDT in summer, EST in winter).</li>
      </ul>
      ${traffic(win)}
      <p class="dash-small dash-muted">Updated ${esc(localStamp(win.generated_at))} · <a href="/api/slo?days=30">raw data (JSON)</a></p>
    </section>
  </div>`;
}
