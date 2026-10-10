// Reliability dashboard (ADR-013). Server-rendered HTML from the SLI ledger + the live pulse. No client JS.
// Shown on /reliability/ when DASHBOARD_MODE allows: "off" | "auto" (once 30 days of data exist) | "on".
import type { Env } from "./env";
import type { DayRow, EventRow, LedgerSource } from "./ledger";
import type { Pulse } from "./pulse";
import { TARGETS, type SloWindow } from "./slo";
import { addDays, localDay, localStamp } from "./time";
import type { FailedRun, Feed, FeedIncident, RunsRecord } from "./incidents";
import type { Gap } from "./backfill";
import { nextReset } from "./capacity";
import type { ExpiryStatus, LimitsView, TicketView } from "./limits";

export type DashboardMode = "off" | "auto" | "on";
export const WINDOW_DAYS = 30;

export function dashboardMode(env: Env): DashboardMode {
  return env.DASHBOARD_MODE === "on" || env.DASHBOARD_MODE === "auto" ? env.DASHBOARD_MODE : "off";
}

/** Expected events in a full 30-day window, from the schedules (probe every 5 min, ticker every 10 min). */
const EXPECTED: Record<"pulse" | "ticker", number> = { pulse: 8_640, ticker: 4_320 };

/*
 * Names (panel, 9 Oct 2026: SRE, technical recruiter, front-end engineer, plain-language editor; ADR-031). Each
 * signal is named "what is measured (where from)": the SRE term a reviewer would search for, then the mechanism in
 * plain words. Client path and server path stay as section names: they say where the timer runs, which is the point
 * of having both testbeds.
 */
const LUDO_EVENT_LABEL = {
  ludo_action: "Ludo action latency",
  ludo_bot: "Ludo bot turn lag",
  ludo_rtt: "Ludo round-trip time",
  ludo_connect: "Ludo connection",
  ludo_lobby: "Ludo lobby wait",
  ludo_game: "Ludo game completion",
  ludo_turn: "Ludo turn",
} as const;
const LABEL: Record<LedgerSource, string> = {
  pulse: "Availability (outside probe)",
  ticker: "Cron job success (GitHub sync)",
  page: "Page requests",
  frame: "Frame time (Pulse run)",
  game: "Pulse run sessions",
  ...LUDO_EVENT_LABEL,
};
const EVENT_LABEL: Record<LedgerSource, string> = { pulse: "Outside probe", ticker: "Cron job", page: "Page request", frame: "Pulse run frame", game: "Pulse run (browser)", ...LUDO_EVENT_LABEL };
/** The SLI in one line: what one check is and when it counts as good (docs/slo.md). */
const SLI: Record<"pulse" | "ticker", string> = {
  pulse: "Black-box SLI · good = <code>GET /api/pulse</code> answers 200 within 2 s · every 5 min",
  ticker: "White-box SLI · good = the scheduled run completes · every 10 min",
};
const EXPLAIN: Record<"pulse" | "ticker", string> = {
  pulse: "An uptime monitor outside Cloudflare asks this site for its status snapshot. The site answers 200 only while the snapshot is under 35 minutes old, so one check covers both: the site is up, and its data is fresh.",
  ticker: "A cron-triggered Worker reads this site's latest commit and CI result from the GitHub API and saves them as the status snapshot. This is the site's own record of the job the probe depends on: when it keeps failing, the probe's figure follows.",
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
  // The bar shows what is left, the same way the caption reads; overspent fills it in red.
  const leftPct = left < 0 ? 100 : Math.max(0, Math.round((left / allowed) * 100));
  const state = !sum || sum.total === 0 ? "none" : left < 0 ? "bad" : usedPct >= 50 ? "warn" : "good";
  const big = sum && sum.total ? pct(sum.good / sum.total) : "—";
  const budgetText =
    left >= 0
      ? `${n(used)} of ${n(allowed)} allowed failures used · <strong>${n(left)} left</strong>`
      : `<strong>Objective missed:</strong> ${n(used)} failures against ${n(allowed)} allowed`;
  return `<section class="dash-card" data-state="${state}">
    <h2>${LABEL[source]}</h2>
    <p class="dash-small dash-muted">${SLI[source]}</p>
    <p class="dash-big">${big}</p>
    <p class="dash-small dash-muted">${n(sum?.good ?? 0)} of ${n(sum?.total ?? 0)} checks good</p>
    <p class="dash-small">Objective: <strong>${+(target * 100).toFixed(2)}%</strong> over 30 days</p>
    <div class="dash-bar" role="img" aria-label="${left < 0 ? "Error budget overspent" : `Error budget ${leftPct}% left`}"><span style="width:${leftPct}%"></span></div>
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
    <h2>Daily record, last 30 days</h2>
    ${line("pulse")}${line("ticker")}
    <p class="dash-strip-axis dash-small dash-muted"><span>${keys[0]}</span><span>today</span></p>
    <p class="dash-legend dash-small dash-muted">
      <span data-state="good"></span>no failures <span data-state="warn"></span>some failures, objective met
      <span data-state="bad"></span>objective missed that day <span data-state="none"></span>no data
    </p>
  </section>`;
}

/**
 * Error budget burn-down: budget left at the end of each day of the window, per objective. Shown from the day the
 * "Collecting data" banner names as the first full window (first recorded day + 30: 30 Oct 2026 here), by age rather
 * than by days with data, so one empty day cannot hold it back. Before that, a half-empty chart would read as a trend
 * that does not exist yet (no claim ahead of evidence). Drawn from the same daily rows as the strip; a day with no
 * data breaks the line rather than being joined across.
 */
export function burnDown(days: DayRow[], now: number): string {
  const keys = dayKeys(now);
  const W = 300;
  const H = 80;
  const top = 4;
  const bottom = H - 4;
  const x = (i: number) => +((i * W) / (keys.length - 1)).toFixed(1);
  const y = (r: number) => +(top + (1 - Math.max(0, Math.min(1, r))) * (bottom - top)).toFixed(1);
  const series = (source: "pulse" | "ticker") => {
    const allowed = Math.floor(EXPECTED[source] * (1 - TARGETS[source]));
    let spent = 0;
    const runs: string[][] = [[]];
    keys.forEach((k, i) => {
      const row = days.find((d) => d.day === k && d.source === source);
      if (!row || row.total === 0) {
        if (runs.at(-1)!.length) runs.push([]);
        return;
      }
      spent += row.bad;
      runs.at(-1)!.push(`${x(i)},${y((allowed - spent) / allowed)}`);
    });
    // A single point has no line to draw: a short tick keeps that day visible.
    const paths = runs
      .filter((r) => r.length)
      .map((r) => (r.length === 1 ? `M${r[0]} h2` : `M${r.join(" L")}`))
      .join(" ");
    return { allowed, left: allowed - spent, paths };
  };
  const hb = series("pulse");
  const job = series("ticker");
  const words = (s: { allowed: number; left: number }) =>
    s.left >= 0 ? `${n(s.left)} of ${n(s.allowed)} failures left` : `overspent by ${n(-s.left)} of ${n(s.allowed)}`;
  const desc = `${LABEL.pulse}: ${words(hb)}. ${LABEL.ticker}: ${words(job)}.`;
  return `<section class="dash-section">
    <h2>Error budget over the window</h2>
    <figure class="dash-burn">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-labelledby="burn-title burn-desc">
        <title id="burn-title">Error budget left at the end of each day, last 30 days</title>
        <desc id="burn-desc">${esc(desc)}</desc>
        <line x1="0" x2="${W}" y1="${top}" y2="${top}" class="burn-ref" vector-effect="non-scaling-stroke" />
        <line x1="0" x2="${W}" y1="${bottom}" y2="${bottom}" class="burn-zero" vector-effect="non-scaling-stroke" />
        <path d="${hb.paths}" class="burn-hb" vector-effect="non-scaling-stroke" />
        <path d="${job.paths}" class="burn-job" vector-effect="non-scaling-stroke" />
      </svg>
      <p class="dash-strip-axis dash-small dash-muted"><span>${keys[0]}</span><span>today</span></p>
      <figcaption class="dash-small">
        <span class="burn-key burn-key-hb" aria-hidden="true"></span>${LABEL.pulse}: ${words(hb)}
        <span class="burn-key burn-key-job" aria-hidden="true"></span>${LABEL.ticker}: ${words(job)}
      </figcaption>
      <p class="dash-small dash-muted">Top line: the full budget. Bottom line: all of it spent. A steep drop is a bad day; a gap is a day with no data.</p>
    </figure>
  </section>`;
}

const LIMIT_STATE: Record<ExpiryStatus, "good" | "warn" | "bad" | "none"> = {
  ok: "good",
  none: "none",
  due: "warn",
  missing: "warn",
  unchecked: "warn",
  urgent: "bad",
  expired: "bad",
};
const LIMIT_BADGE: Record<ExpiryStatus, string> = {
  ok: "OK",
  none: "NO EXPIRY",
  due: "RENEW SOON",
  missing: "NOT RECORDED",
  unchecked: "UNCHECKED",
  urgent: "RENEW NOW",
  expired: "EXPIRED",
};

/**
 * What could stop this site (ADR-030): every credential and renewal it depends on, and today's use of the free-tier
 * allowances. A date nobody could read is shown as a risk, not as fine. Status is in words as well as colour.
 */
function limitsSection(v: LimitsView, now: number): string {
  const rank = (s: ExpiryStatus) => ["expired", "urgent", "due", "missing", "unchecked", "ok", "none"].indexOf(s);
  const ordered = [...v.expiries].sort((a, b) => rank(a.status) - rank(b.status));
  const rows = ordered
    .map((e) => {
      const state = LIMIT_STATE[e.status];
      const calm = e.status === "ok" || e.status === "none";
      const when = e.expires_at ? longDay(localDay(e.expires_at)) : null;
      const how = e.checked_at ? `${esc(e.source)}, checked ${esc(ago(e.checked_at, now))}` : esc(e.source);
      const right = when ? `${esc(when)}${e.days_left !== null && e.days_left >= 0 ? ` <span class="dash-muted">· ${n(e.days_left)} days</span>` : ""}` : "";
      return `<li data-state="${state}">
        <p class="dash-limit-head"><span class="dash-badge" data-state="${state}">${LIMIT_BADGE[e.status]}</span><strong>${esc(e.label)}</strong><span class="dash-limit-when">${right}</span></p>
        ${calm ? `<p class="dash-small dash-muted">${how}</p>` : `<p class="dash-small">${esc(e.status_text)} <span class="dash-muted">(${how})</span></p>
        <p class="dash-small dash-muted">If it lapses: ${esc(e.breaks)}</p>`}
      </li>`;
    })
    .join("");
  const meter = (share: number) => (share >= 0.8 ? "bad" : share >= 0.5 ? "warn" : "good");
  const usage = v.usage
    ? `<ul class="dash-usage">${v.usage.items
        .map((u) => {
          const pctNum = Math.min(100, Math.round(u.share * 100));
          return `<li data-state="${meter(u.share)}"><p class="dash-small"><strong>${esc(u.label)}</strong>: ${n(u.used)} of ${n(u.limit)} <span class="dash-muted">(${pctNum}%)</span></p>
          <div class="dash-meter" role="img" aria-label="${esc(u.label)}: ${pctNum}% of today's allowance used"><span style="width:${pctNum}%"></span></div></li>`;
        })
        .join("")}</ul>
      ${v.usage.new_day ? `<p class="dash-small">A new day began at ${esc(localStamp(new Date(Date.parse(v.usage.resets_at) - 86_400_000).toISOString()).slice(11))}, so these start near zero. Cloudflare's figures run a few minutes behind; they fill in over the next half hour.</p>` : ""}
      ${v.yesterday ? `<p class="dash-small dash-muted">Yesterday (UTC day ${esc(v.yesterday.day)}): ${v.yesterday.items.map((u) => `${esc(u.label.toLowerCase())} ${n(u.used)} (${Math.round(u.share * 100)}%)`).join(" · ")}.</p>` : ""}
      <p class="dash-small dash-muted">As of ${esc(localStamp(v.usage.as_of).slice(11))}; resets at ${esc(localStamp(v.usage.resets_at).slice(11))} (00:00 UTC). Shared by every Worker on the account. Running out pauses the live numbers and Ludo until the reset, and says so; it is never an incident. Total storage isn't shown: Cloudflare's analytics give no storage figure for this account.</p>`
    : `<p class="dash-small" data-state="warn"><span class="dash-badge" data-state="warn">NOT CONNECTED</span>${esc(v.usage_note ?? "No reading yet today.")}</p>`;
  return `<section class="dash-section" id="limits">
    <h2>What could stop this site</h2>
    <p class="dash-small dash-muted">Everything this site depends on that expires, and what breaks if it does. Dates are read every day from the service that issued them; one that can't be read is shown as a risk, not as fine. Renewal reminders go to the owner at 90, 60 and 30 days.</p>
    <ul class="dash-limits">${rows}</ul>
    <p class="dash-small"><a href="/notes/dependency-expiry-gaps/">How this board found its own blind spot →</a></p>
    <h3 class="dash-sub">Today's free allowance</h3>
    ${usage}
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
  return `<details class="dash-fold">
    <summary>Latency by day (p95) <span class="dash-muted">· 95% of checks finished within this time</span></summary>
    <p class="dash-small dash-muted">Times are rounded up to the nearest band (50, 100, 200, 400, 800, 1,600, 3,200 ms).</p>
    <table class="dash-table">
      <thead><tr><th scope="col">Day</th><th scope="col">Cron job <span class="dash-muted">(GitHub API read)</span></th><th scope="col">Outside probe <span class="dash-muted">(<code>/api/pulse</code> answer)</span></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3" class="dash-muted">No data yet.</td></tr>`}</tbody>
    </table>
  </details>`;
}

/** The site's own checks. Ludo and Pulse run have their own sections (docs/ludo-telemetry.md, ADR-015). */
export const SITE_SOURCES = ["ticker", "pulse", "page"] as const;
const isSite = (e: EventRow) => (SITE_SOURCES as readonly string[]).includes(e.source);

function failureItem(e: EventRow): string {
  const gameDay = e.fault !== "none" ? ` <span class="dash-tag">game day</span>` : "";
  const what = e.outcome === "degraded" ? "served without live status" : "failed";
  return `<li><time datetime="${esc(e.ts)}">${esc(localStamp(e.ts))}</time>
        <span><strong>${EVENT_LABEL[e.source]}</strong> ${what}: ${esc(e.detail || `HTTP ${e.status}`)}${
          e.dep !== "none" ? ` <span class="dash-muted">(cause: ${esc(e.dep)})</span>` : ""
        }${gameDay}</span></li>`;
}

function failures(events: EventRow[]): string {
  const server = events.filter(isSite);
  const all = server.filter((e) => e.outcome !== "ok");
  const shown = all.slice(0, 5);
  const slow = server.filter((e) => e.outcome === "ok").length;
  const more = all.length - shown.length;
  return `<section class="dash-section" id="failures">
    <h2>Failures</h2>
    ${shown.length ? `<ol class="dash-events">${shown.map(failureItem).join("")}</ol>` : `<p>No failures in the last 30 days.</p>`}
    <p class="dash-small">${more > 0 ? `Showing the latest ${n(shown.length)} of ${n(all.length)} in the last 30 days. ` : ""}<a href="/reliability/failures/">Full failure history →</a></p>
    ${slow ? `<p class="dash-small dash-muted">${n(slow)} slow but successful run${slow === 1 ? "" : "s"} (over half the time budget) also recorded as early warnings.</p>` : ""}
  </section>`;
}

/**
 * /reliability/failures/: every failure the ledger still keeps for the site's own checks, newest first, by day.
 * Added 4 Oct 2026, when the dashboard's single 1,000-record read had let Ludo's records crowd game day 1 out of view.
 */
export function renderHistory(events: EventRow[], now = Date.now()): string {
  const fails = events.filter((e) => isSite(e) && e.outcome !== "ok");
  if (!fails.length) return `<div class="dash"><p>No failures recorded yet.</p></div>`;
  const byDay = new Map<string, EventRow[]>();
  for (const e of fails) {
    const d = localDay(e.ts);
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  const days = [...byDay.entries()]
    .map(([d, list]) => {
      const planned = list.filter((e) => e.fault !== "none").length;
      return `<section class="dash-section">
      <h2>${esc(longDay(d))} <span class="dash-muted dash-count">· ${n(list.length)} failure${list.length === 1 ? "" : "s"}${planned ? `, ${n(planned)} on a game day` : ""}</span></h2>
      <ol class="dash-events">${list.map(failureItem).join("")}</ol>
    </section>`;
    })
    .join("");
  const oldest = fails.at(-1)!.ts;
  return `<div class="dash">
    <p class="dash-summary" data-state="none"><strong>${n(fails.length)} failure${fails.length === 1 ? "" : "s"}</strong> on ${n(byDay.size)} day${byDay.size === 1 ? "" : "s"} · since ${esc(longDay(localDay(oldest)))}</p>
    ${days}
    <p class="dash-small dash-muted">The site keeps its detailed records for 400 days, up to 500 per check per day; daily totals are on <a href="/reliability/">Live reliability</a>. Times are Toronto time. Generated ${esc(localStamp(new Date(now).toISOString()))} · <a href="/api/slo?days=30">raw data (JSON)</a></p>
  </div>`;
}

function clientPath(win: SloWindow): string {
  const g = win.game;
  const rate = (k: number) => (g.sessions ? `${Math.round((k / g.sessions) * 1000) / 10}%` : "—");
  const errors = win.events.filter((e) => e.source === "game").slice(0, 5);
  const tiles = g.sessions
    ? `<dl class="dash-facts dash-client">
        <div><dt>Sessions</dt><dd>${n(g.sessions)} <span class="dash-muted">(${n(g.started)} played)</span></dd></div>
        <div><dt>Session error rate</dt><dd>${rate(g.errored)}</dd><dd class="dash-small dash-muted">sessions with a JavaScript error</dd></div>
        <div><dt>Frame time (p95)</dt><dd>${g.frame_p95_ms === null ? "—" : `≤ ${n(g.frame_p95_ms)} ms`}</dd><dd class="dash-small dash-muted">60 fps needs about 16 ms</dd></div>
        <div><dt>Jank rate</dt><dd>${rate(g.janky)}</dd><dd class="dash-small dash-muted">sessions with a frame over 50 ms</dd></div>
      </dl>`
    : `<p>No plays recorded yet. <a href="/play/">Be the first →</a></p>`;
  const errs = errors.length
    ? `<details class="dash-fold"><summary>Recent game errors <span class="dash-muted">· ${n(errors.length)}</span></summary><ol class="dash-events">${errors
        .map(
          (e) => `<li><time datetime="${esc(e.ts)}">${esc(localStamp(e.ts))}</time><span>${esc(e.detail)}${
            e.fault !== "none" ? ` <span class="dash-tag">game day</span>` : ""
          }</span></li>`,
        )
        .join("")}</ol></details>`
    : "";
  return `<section class="dash-card" data-state="none" id="client-path">
    <h2>Client path: browser telemetry (<a href="/play/">Pulse run</a>)</h2>
    <p class="dash-small dash-muted">Real-user monitoring (RUM): a 30-second game times itself in the visitor's browser and sends its errors and frame times in one beacon. Reported by the browser, not measured by the server.</p>
    ${tiles}${errs}
    <p class="dash-small"><a href="/play/">Add a data point: play Pulse run for 30 seconds →</a></p>
    <p class="dash-small dash-muted">Client-only signal. Does not prove server capacity or ITSM readiness.</p>
  </section>`;
}

/** Ludo (docs/ludo-telemetry.md): server-measured interaction latency. Proposed objectives, plus tracked engagement. */
function ludoSection(win: SloWindow): string {
  const sum = (src: LedgerSource) => win.summary.find((x) => x.source === src);
  const rows = (src: LedgerSource) => win.days.filter((d) => d.source === src);
  const worstP95 = (src: LedgerSource) => {
    const vals = rows(src).map((d) => d.p95_ms).filter((v): v is number => v !== null);
    return vals.length ? Math.max(...vals) : null;
  };
  const share = (good: number, total: number) => (total ? pct(good / total) : "—");
  const played = (sum("ludo_game")?.total ?? 0) + (sum("ludo_connect")?.total ?? 0);
  if (!played) {
    return `<section class="dash-card" data-state="none" id="ludo">
    <h2>Server path: WebSocket game server (<a href="/ludo/">Ludo</a>)</h2>
    <p>No games recorded yet. <a href="/ludo/">Play a game →</a></p>
  </section>`;
  }
  const slo = (src: LedgerSource, label: string, good: string) => {
    const x = sum(src);
    const target = TARGETS[src];
    const p95 = worstP95(src);
    const state = !x || !x.total ? "none" : target !== undefined && x.good / x.total < target ? "bad" : "good";
    return `<div data-state="${state}"><dt>${esc(label)}</dt><dd>${x && x.total ? share(x.good, x.total) : "—"}${
      target !== undefined ? ` <span class="dash-muted">(objective ${pct(target)})</span>` : ""
    }</dd><dd class="dash-small dash-muted">${esc(good)} · ${n(x?.total ?? 0)} checks${p95 === null ? "" : ` · p95 ≤ ${n(p95)} ms`}</dd></div>`;
  };
  const games = sum("ludo_game");
  const lobby = sum("ludo_lobby");
  const turns = sum("ludo_turn");
  const thinkToday = rows("ludo_turn").at(-1)?.p50_ms ?? null;
  return `<section class="dash-card" data-state="none" id="ludo">
    <h2>Server path: WebSocket game server (<a href="/ludo/">Ludo</a>)</h2>
    <p class="dash-small dash-muted">Every roll and move is decided and timed inside the game room on the server (a Durable Object), so these are measured, not reported by browsers. Objectives are proposed and not yet held for a full 30 days.</p>
    <dl class="dash-facts dash-client">
      ${slo("ludo_connect", "Connection success", "WebSocket join answered: 101, or a correct refusal such as “full”")}
      ${slo("ludo_action", "Action latency", "receive → save → broadcast ≤ 100 ms")}
      ${slo("ludo_bot", "Bot turn lag", "each bot step ≤ 250 ms past its pace")}
      ${slo("ludo_rtt", "Round-trip time", "server ping → page echo ≤ 300 ms")}
    </dl>
    <details class="dash-fold"><summary>Engagement <span class="dash-muted">· completion, lobby starts, turn timeouts</span></summary>
    <dl class="dash-facts dash-client">
      <div><dt>Game completion</dt><dd>${share(games?.good ?? 0, games?.total ?? 0)}</dd><dd class="dash-small dash-muted">${n(games?.good ?? 0)} of ${n(games?.total ?? 0)} reached a winner</dd></div>
      <div><dt>Lobby start rate</dt><dd>${share(lobby?.good ?? 0, lobby?.total ?? 0)}</dd><dd class="dash-small dash-muted">within 2 minutes · ${n(lobby?.total ?? 0)} code rooms</dd></div>
      <div><dt>Turn timeout rate</dt><dd>${share(turns?.bad ?? 0, turns?.total ?? 0)}</dd><dd class="dash-small dash-muted">30 s without a move${thinkToday === null ? "" : ` · median think ≤ ${n(thinkToday)} ms today`}</dd></div>
    </dl>
    </details>
    <p class="dash-small"><a href="/ludo/">Add a data point: play Ludo →</a> · <a href="/api/slo?days=30">raw data</a></p>
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

/**
 * Below incident level (ADR-031): the reminder issues the daily limits check keeps (ADR-030). Shown on the desk so a
 * reader sees every ticket this site raised, not only the ones that reached the engine; still never an incident, never
 * paged, never counted in "open incidents". Open ones first; closed ones folded.
 */
function ticketList(t: LimitsView["tickets"] | undefined, now: number): string {
  const head = `<h4 class="dash-small"><strong>Renewal reminders</strong></h4>
    <p class="dash-small dash-muted">Raised by the daily dependency check: a renewal or expiry the owner needs to act on before anything breaks. They open at P3 (90 days out), escalate to P2, P1 and P0 as the date nears, and close themselves once fixed.</p>`;
  if (!t) return `${head}<p class="dash-small">Not reported yet: the daily check sends its tickets after its next run.</p>`;
  const one = (x: TicketView) => {
    const level = x.level ? `<span class="dash-badge" data-state="${x.state === "closed" ? "none" : x.level === "P3" ? "warn" : "bad"}">${x.level}</span>` : "";
    const span = x.closed_at ? ` · closed ${esc(localStamp(x.closed_at))}` : ` · open ${esc(ago(x.opened_at, now).replace(" ago", ""))}`;
    return `<li>
            <p class="dash-incident-head"><span class="dash-badge" data-state="${x.state === "open" ? "warn" : "good"}">${x.state.toUpperCase()}</span>${level}<a href="${esc(x.url)}">${esc(x.title.replace(/^Limits: /, ""))}</a> <span class="dash-muted">#${n(x.number)}</span></p>
            <p class="dash-small dash-muted">Opened ${esc(localStamp(x.opened_at))}${span}</p>
          </li>`;
  };
  const open = t.items.filter((x) => x.state === "open");
  const closed = t.items.filter((x) => x.state === "closed");
  const list = open.length ? `<ol class="dash-incidents">${open.map(one).join("")}</ol>` : `<p class="dash-small">No open tickets.</p>`;
  const fold = closed.length
    ? `<details class="dash-fold"><summary>${n(closed.length)} closed ticket${closed.length === 1 ? "" : "s"}</summary><ol class="dash-incidents">${closed.map(one).join("")}</ol></details>`
    : "";
  return `${head}${list}${fold}<p class="dash-small dash-muted">As of the daily check, ${esc(localStamp(t.as_of))} · <a href="#limits">the dependency board</a></p>`;
}

/**
 * Failed GitHub Actions runs, last 30 days (ADR-031): a failed deploy leaves the last good version serving, so it is
 * low priority, not an incident. "Fixed" means a later run of the same workflow passed. Unfixed first; fixed folded.
 */
function runList(r: RunsRecord | null): string {
  const head = `<h4 class="dash-small"><strong>Failed workflow runs</strong> <span class="dash-muted">· last 30 days</span></h4>
    <p class="dash-small dash-muted">The build-and-deploy pipeline and the daily dependency check run as GitHub Actions. When one fails, the live site keeps serving the last good version, so it is listed here rather than raised as an incident.</p>`;
  if (!r) return `${head}<p class="dash-small">Not read yet: the list is read from GitHub once an hour.</p>`;
  const one = (x: FailedRun) => `<li>
            <p class="dash-incident-head"><span class="dash-badge" data-state="${x.resolved ? "good" : "warn"}">${x.resolved ? "FIXED" : "FAILED"}</span><span class="dash-badge" data-state="none">LOW</span><a href="https://github.com/${esc(r.repo)}/actions/runs/${x.id}">${esc(x.workflow)}</a> <span class="dash-muted">${esc(x.conclusion.replace(/_/g, " "))}</span></p>
            <p class="dash-small dash-muted">${esc(localStamp(x.at))}${x.resolved ? " · a later run passed" : ""}</p>
          </li>`;
  const open = r.items.filter((x) => !x.resolved);
  const fixed = r.items.filter((x) => x.resolved);
  const list = open.length ? `<ol class="dash-incidents">${open.map(one).join("")}</ol>` : `<p class="dash-small">${fixed.length ? "None unfixed." : "None in the last 30 days."}</p>`;
  const fold = fixed.length
    ? `<details class="dash-fold"><summary>${n(fixed.length)} fixed by a later run</summary><ol class="dash-incidents">${fixed.map(one).join("")}</ol></details>`
    : "";
  return `${head}${list}${fold}<p class="dash-small dash-muted">Read hourly from GitHub; as of ${esc(localStamp(r.checkedAt))} · <a href="https://github.com/${esc(r.repo)}/actions">all runs</a></p>`;
}

function incidentDesk(feed: Feed | null, tickets: LimitsView["tickets"] | undefined, runs: RunsRecord | null, now: number): string {
  const repo = feed?.repo ? `https://github.com/${esc(feed.repo)}` : null;
  const items = (feed?.incidents ?? []).slice(0, 5);
  const one = (i: FeedIncident) => {
          const state = OPEN.has(i.state) ? "bad" : "good";
          const title = i.issue_url ? `<a href="${esc(i.issue_url)}">${esc(i.title)}</a>` : esc(i.title);
          const proposal = i.triage
            ? `AI proposed <strong>${esc(i.triage.priority)}</strong> (confidence ${i.triage.confidence.toFixed(2)})`
            : "No AI proposal (model unavailable)";
          // The priority in force, after the human gate; a test with none set shows no badge.
          const priority = i.priority && i.priority !== "None" ? `<span class="dash-badge" data-state="none">${esc(i.priority.toUpperCase())}</span>` : "";
          return `<li>
            <p class="dash-incident-head"><span class="dash-badge" data-state="${state}">${esc(i.state)}</span>${priority} ${title}</p>
            <p class="dash-small dash-muted">Opened ${esc(localStamp(i.created_at))} · ${proposal} · gate: ${esc(i.gate)}${
              i.drafts_unsent ? ` · ${n(i.drafts_unsent)} draft${i.drafts_unsent === 1 ? "" : "s"}, never sent` : ""
            }${i.recovered_at ? ` · site recovered ${esc(localStamp(i.recovered_at))}` : ""}</p>
            ${i.note ? `<p class="dash-small">Owner's note: ${ownerNote(i.note)}</p>` : ""}
            <p class="dash-small">${esc(trail(i))}</p>
          </li>`;
  };
  const [latest, ...earlier] = items;
  const list = latest
    ? `<ol class="dash-incidents">${one(latest)}</ol>${
        earlier.length
          ? `<details class="dash-fold"><summary>${n(earlier.length)} earlier incident${earlier.length === 1 ? "" : "s"}</summary><ol class="dash-incidents">${earlier.map(one).join("")}</ol></details>`
          : ""
      }`
    : `<p>No incidents yet. When this site's scheduled job fails twice in a row, the incident engine opens one here.</p>`;
  return `<section class="dash-card" data-state="none" id="incident-desk">
    <h2>Incident desk</h2>
    <p class="dash-small dash-muted">Real failures of this site go to an incident triage agent. It proposes priority and drafts updates; a human runs every step after that, in public GitHub issues.</p>
    ${list}
    <h3 class="dash-sub">Low-priority tickets</h3>
    <p class="dash-small dash-muted">Below incident level: they never page anyone and are never counted as incidents.</p>
    ${ticketList(tickets, now)}
    ${runList(runs)}
    <p class="dash-small dash-muted">Incidents are alerts from this site only; tests are titled as tests. AI drafts are never sent. Since 1 Oct 2026, every AI priority waits for a human approval; each entry's gate says which rule applied when it was triaged. AI priority never pages anyone: paging comes from the outside probe on this site's SLO. After intake, every state change is a human command.${
      repo ? ` <a href="${repo}">Engine repo →</a>` : ""
    }</p>
  </section>`;
}

function traffic(win: SloWindow): string {
  const page = win.summary.find((s) => s.source === "page");
  if (!page || !page.total) return "";
  return `<p class="dash-small dash-muted">Page requests served in this window: ${n(page.total)} (bots included) · served without the live status line: ${n(page.bad)}.</p>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-30" → "30 Oct 2026". */
const longDay = (d: string) => `${Number(d.slice(8))} ${MONTHS.at(Number(d.slice(5, 7)) - 1)} ${d.slice(0, 4)}`;

/**
 * Shown until the first full 30-day window exists: the numbers below are real and live, but a few days of readings
 * are not yet a trend, so the page says how far along the window is and when the full picture forms.
 */
function collecting(firstDay: string, now: number, paused = false): string {
  const today = localDay(new Date(now).toISOString());
  const elapsed = Math.round((Date.parse(today) - Date.parse(firstDay)) / 864e5) + 1;
  const day = Math.min(Math.max(elapsed, 1), WINDOW_DAYS);
  const complete = addDays(firstDay, WINDOW_DAYS);
  const pct = Math.round((day / WINDOW_DAYS) * 100);
  return `<section class="dash-collecting" aria-label="Data collection in progress">
    <p class="dash-collecting-head"><span class="dash-chip">Collecting data</span> Day ${n(day)} of ${WINDOW_DAYS}</p>
    <div class="dash-progress" role="progressbar" aria-label="First 30-day window" aria-valuemin="0" aria-valuemax="${WINDOW_DAYS}" aria-valuenow="${day}"><span style="width:${pct}%"></span></div>
    <p class="dash-small">${paused ? "Real readings, up to the pause above." : "Live readings."} Early ones, though: the objectives, budgets and strip become meaningful once the first full window is in, on <strong>${esc(longDay(complete))}</strong>.</p>
  </section>`;
}

/**
 * While the ledger's recording is interrupted (ADR-028): the figures below stop at a point, so say where, why, and that
 * the missing readings come back on their own. Capacity before the reset = "paused"; afterwards = "catching up".
 */
function recordingBanner(gap: Gap | null, now: number, copy: { asOf: string; capacity: boolean } | null): string {
  if (!gap && !copy) return "";
  const since = localStamp(gap?.opened ?? copy!.asOf);
  const resumeAt = gap?.resumeAt ?? (copy?.capacity ? nextReset(now) : null);
  const paused = copy !== null || (gap?.cause === "capacity" && resumeAt !== null && now < resumeAt);
  const head = paused ? `Recording paused since ${esc(since)}` : `Catching up on readings since ${esc(since)}`;
  const shown = copy ? ` Showing the last saved copy of the records, from <strong>${esc(localStamp(copy.asOf))}</strong>.` : "";
  const cause = copy && !copy.capacity ? "The record store can't be read right now, so" : "Today's free allowance of database writes is used up, so";
  const body = paused
    ? `${cause} the figures below stop there.${shown} Nothing is lost: readings since then are kept in the site's logs and are rebuilt automatically once writes resume${resumeAt ? ` at <strong>${esc(localStamp(new Date(resumeAt).toISOString()))}</strong>` : ""}.`
    : `Recording was interrupted, and the readings since then are being rebuilt from the site's logs, half an hour at a time. The figures below fill in as that finishes; rebuilt readings go back into each day's totals, and any that failed or were slow are kept in full, marked as backfilled.`;
  return `<section class="dash-card" data-state="warn" aria-label="Recording status">
    <h2>${head}</h2>
    <p class="dash-small">${body} The site and its outside monitor are unaffected, and this never raises an incident.</p>
  </section>`;
}

export function renderDashboard(
  win: SloWindow,
  pulse: Pulse | null,
  feed: Feed | null = null,
  desk: { failures: number; lastDetail: string } | null = null,
  now = Date.now(),
  gap: Gap | null = null,
  copy: { asOf: string; capacity: boolean } | null = null,
  limits: LimitsView | null = null,
  runs: RunsRecord | null = null,
): string {
  const firstDay = win.days[0]?.day;
  const daysWithData = new Set(win.days.map((d) => d.day)).size;
  const young = firstDay && daysWithData < WINDOW_DAYS ? collecting(firstDay, now, copy !== null) : "";
  // One-line summary (ADR-018): the answer before the evidence.
  const fresh = pulse?.state === "fresh";
  const failing = fresh && (desk?.failures ?? 0) > 0;
  const openIncidents = (feed?.incidents ?? []).filter((i) => OPEN.has(i.state)).length;
  const status = !pulse ? "Status unavailable" : !fresh ? "Heartbeat late" : failing ? "Degraded" : "All checks normal";
  const summary = `<p class="dash-summary" data-state="${!fresh ? "bad" : failing ? "warn" : "good"}"><strong>${status}</strong> · ${
    openIncidents === 0 ? "no open incidents" : `${n(openIncidents)} open incident${openIncidents === 1 ? "" : "s"}`
  }${(() => {
    // Tickets are counted apart from incidents (ADR-031), and only when there is one to see.
    const t = (limits?.tickets?.items.filter((x) => x.state === "open").length ?? 0) + (runs?.items.filter((x) => !x.resolved).length ?? 0);
    return t ? ` · <a href="#incident-desk">${n(t)} open low-priority ticket${t === 1 ? "" : "s"}</a>` : "";
  })()}${
    limits
      ? (() => {
          const risky = limits.expiries.filter((e) => e.status !== "ok" && e.status !== "none").length;
          return risky ? ` · <a href="#limits">${n(risky)} dependenc${risky === 1 ? "y needs" : "ies need"} attention</a>` : " · dependencies OK";
        })()
      : ""
  } · data since ${esc(firstDay ?? "today")}</p>`;
  return `<div class="dash">
    ${summary}
    ${recordingBanner(gap, now, copy)}
    ${young}
    ${liveCard(pulse, now, desk)}
    <div class="dash-grid">${sloCard(win, "pulse")}${sloCard(win, "ticker")}</div>
    ${strip(win.days, now)}
    ${firstDay && firstDay <= addDays(localDay(now), -WINDOW_DAYS) ? burnDown(win.days, now) : ""}
    ${speed(win.days, now)}
    ${failures(win.events)}
    ${limits ? limitsSection(limits, now) : ""}
    ${incidentDesk(feed, limits?.tickets, runs, now)}
    ${clientPath(win)}
    ${ludoSection(win)}
    <details class="dash-fold dash-howto">
      <summary>How to read this</summary>
      <ul class="dash-small">
        <li><strong>Objective (SLO):</strong> the share of checks that must succeed over 30 days.</li>
        <li><strong>Error budget:</strong> how many failures the objective allows in 30 days. Spending it is fine; overspending means reliability work comes before new features.</li>
        <li>The official external number is the outside monitor's 30-day uptime, reported monthly. The figures here are the site's own records of the same checks.</li>
        <li>All times and days are Toronto time (ET: EDT in summer, EST in winter).</li>
      </ul>
      ${traffic(win)}
    </details>
    <p class="dash-small dash-muted">Updated ${esc(localStamp(win.generated_at))} · <a href="/reliability/failures/">failure history</a> · <a href="/api/slo?days=30">raw data (JSON)</a> · <a href="/api/limits">dependencies (JSON)</a></p>
  </div>`;
}
