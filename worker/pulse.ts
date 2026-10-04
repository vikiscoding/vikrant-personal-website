// Read side of the heartbeat. Every page view and every probe reads the snapshot.
// Page views degrade open (ADR-010): if KV fails, the static page still serves.
import { isCapacity, nextReset, untilText } from "./capacity";
import { readLimits } from "./limits";
import { localStamp } from "./time";
import type { Env } from "./env";
import { activeFault } from "./faults";
import { DepError, record } from "./log";
import { SNAPSHOT_KEY, type Snapshot } from "./ticker";
import { countVisit, isCountable, visitsText } from "./visits";
import { dashboardMode, renderDashboard, WINDOW_DAYS } from "./dashboard";
import { readSloCopy, readWindow } from "./slo";
import { readDeskState, readFeed } from "./incidents";
import { readGap } from "./backfill";

/** Stale after 35 min: two missed ticks (10 min apart) plus one tick of margin. At 30 min, a 2-tick outage hit
 *  the edge exactly (game day 1, 1 Oct 2026: last good 05:10:15, next good 05:40:15). ADR-017. */
export const STALE_AFTER_S = 35 * 60;

export type PulseState = "fresh" | "stale" | "missing";

export interface Pulse {
  state: PulseState;
  ageS: number | null;
  snap: Snapshot | null;
}

export async function readPulse(env: Env, now = Date.now()): Promise<Pulse> {
  if (activeFault(env) === "kv_read_fail") throw new DepError("kv", "injected read failure", 500);
  if (!env.PULSE) throw new DepError("kv", "PULSE binding missing", 500);
  let snap: Snapshot | null;
  try {
    snap = await env.PULSE.get<Snapshot>(SNAPSHOT_KEY, "json");
  } catch (e) {
    throw new DepError("kv", e instanceof Error ? e.message : "get failed", 500);
  }
  if (!snap) return { state: "missing", ageS: null, snap: null };
  const ageS = Math.max(0, Math.round((now - Date.parse(snap.fetchedAt)) / 1000));
  return { state: ageS <= STALE_AFTER_S ? "fresh" : "stale", ageS, snap };
}

/** Probe target. 200 only when fresh: this response is the freshness SLI. */
export async function pulseApi(env: Env, ctx?: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const fault = activeFault(env);
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (!env.PULSE) {
    // Heartbeat switched off (no PULSE binding). Not an SLI event.
    return new Response(JSON.stringify({ state: "disabled" }), { status: 503, headers });
  }
  try {
    const p = await readPulse(env);
    const status = p.state === "fresh" ? 200 : 503;
    record(env, {
      op: "pulse_api",
      outcome: status === 200 ? "ok" : "error",
      status,
      ms: Date.now() - started,
      // Stale means the ticker, and so its dependency, failed upstream of this read.
      dep: status === 200 ? "none" : "github",
      detail: p.state,
      fault,
    }, ctx);
    return new Response(
      JSON.stringify({ state: p.state, age_s: p.ageS, fetched_at: p.snap?.fetchedAt ?? null }),
      { status, headers },
    );
  } catch (e) {
    const err = e instanceof DepError ? e : new DepError("kv", String(e));
    record(env, { op: "pulse_api", outcome: "error", status: 503, ms: Date.now() - started, dep: err.dep, detail: err.detail, fault }, ctx);
    return new Response(JSON.stringify({ state: "error" }), { status: 503, headers });
  }
}

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function pulseText(p: Pulse): string | null {
  if (!p.snap) return null;
  const c = p.snap.ciConclusion;
  const build = c === "success" ? "build passing" : c ? `build ${c}` : "build running";
  const checked = p.state === "fresh" ? `checked ${ago(p.snap.fetchedAt)}` : "heartbeat late";
  return `Last shipped ${ago(p.snap.lastCommitAt)} · ${build} · ${checked}`;
}

/** The footer's pulse slot: text to show (or null), and whether the page is degraded. Never throws. */
async function pagePulse(env: Env): Promise<{ text: string | null; outcome: "ok" | "degraded"; detail?: string }> {
  // Heartbeat switched off (no PULSE binding): the static fallback footer is the intended page.
  if (!env.PULSE) return { text: null, outcome: "ok", detail: "pulse_disabled" };
  try {
    const p = await readPulse(env);
    return p.state === "fresh"
      ? { text: pulseText(p), outcome: "ok" }
      : { text: pulseText(p), outcome: "degraded", detail: p.state };
  } catch (e) {
    return { text: null, outcome: "degraded", detail: e instanceof DepError ? e.detail : "pulse read failed" };
  }
}

/** The dashboard HTML for /reliability/, or null (flag off, not enough data, or ledger unreadable). Never throws. */
async function dashboardHtml(env: Env): Promise<string | null> {
  const mode = dashboardMode(env);
  if (mode === "off") return null;
  try {
    const win = await readWindow(env, WINDOW_DAYS);
    if (!win) return unavailable();
    const daysWithData = new Set(win.days.map((d) => d.day)).size;
    if (mode === "auto" && daysWithData < WINDOW_DAYS) return null;
    const [pulse, feed, desk, gap, limits] = await Promise.all([readPulse(env).catch(() => null), readFeed(env), readDeskState(env), readGap(env), readLimits(env)]);
    return renderDashboard(win, pulse, feed, desk, Date.now(), gap, null, limits);
  } catch (e) {
    // The ledger cannot be read (capacity or outage): show the last saved copy of the records, clearly labelled.
    const copy = await readSloCopy(env);
    if (copy) {
      const [pulse, feed, desk, gap, limits] = await Promise.all([readPulse(env).catch(() => null), readFeed(env), readDeskState(env), readGap(env), readLimits(env)]);
      return renderDashboard(copy.window, pulse, feed, desk, Date.now(), gap, { asOf: copy.saved_at, capacity: isCapacity(e) }, limits);
    }
    if (isCapacity(e)) return capacityCard();
    console.error(JSON.stringify({ v: 2, ts: new Date().toISOString(), op: "dashboard", outcome: "error", detail: e instanceof Error ? e.message : "render failed" }));
    return unavailable();
  }
}

/** The records are fine, but today's free-tier allowance is used up: say exactly that, and when it comes back. */
function capacityCard(): string {
  const at = nextReset();
  return `<div class="dash"><section class="dash-card" data-state="warn">
    <h2>Live numbers are paused until the daily allowance resets</h2>
    <p>Nothing is broken. This dashboard reads from storage on Cloudflare's free tier, and today's free allowance of database writes is used up. It resets at <strong>00:00 UTC (${localStamp(new Date(at).toISOString()).slice(11)})</strong>, in about ${untilText(at)}, and the numbers come back on their own.</p>
    <p class="dash-small dash-muted">The site and the outside monitor that checks it every 5 minutes are unaffected, and running out of allowance never raises an incident. Nothing is lost: every reading is also written to the site's logs, and once the allowance resets the missed readings are rebuilt from them automatically, back into each day's totals. The live heartbeat is still here: <a href="/api/pulse">/api/pulse</a>.</p>
  </section></div>`;
}

/** The dashboard is switched on but its records cannot be read right now: say so plainly (degrade open, ADR-010). */
function unavailable(): string {
  return `<div class="dash"><section class="dash-card" data-state="warn">
    <h2>Live numbers are temporarily unavailable</h2>
    <p>The store that holds this site's reliability records can't be read right now, so the dashboard can't be drawn. The site itself is up, and the outside monitor that checks it every 5 minutes is unaffected.</p>
    <p class="dash-small dash-muted">Readings taken while the store is unavailable are still written to the site's logs, and are rebuilt from them automatically once it is back, into each day's totals. The live heartbeat is still here: <a href="/api/pulse">/api/pulse</a>.</p>
  </section></div>`;
}

/** Serve a static page and fill its `[data-pulse]`, `[data-visits]` and `[data-dashboard]` slots. Never fails the page. */
export async function servePage(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const fault = activeFault(env);
  const path = new URL(request.url).pathname;
  // Pages are dynamic at the edge (footer, counter, dashboard, game fault), so they must never be revalidated
  // against the static file: a 304 would make the browser reuse stale injected content. Assets keep their 304s.
  const isPage = !/\.[a-z0-9]+$/i.test(path) || path.endsWith(".html");
  let assetRequest = request;
  if (isPage) {
    const headers = new Headers(request.headers);
    headers.delete("if-none-match");
    headers.delete("if-modified-since");
    assetRequest = new Request(request, { headers });
  }
  const page = await env.ASSETS.fetch(assetRequest);
  if (!page.headers.get("content-type")?.includes("text/html")) return page;

  if (page.status >= 500) {
    record(env, { op: "page", outcome: "error", status: page.status, ms: Date.now() - started, path, dep: "assets", fault }, ctx);
    return page;
  }

  const [pulse, total] = await Promise.all([
    pagePulse(env),
    isCountable(request, page.status) ? countVisit(env) : Promise.resolve(null),
  ]);
  const visits = visitsText(env, total);
  const dashboard = path.startsWith("/reliability") ? await dashboardHtml(env) : null;

  record(env, {
    op: "page",
    outcome: pulse.outcome,
    status: page.status,
    ms: Date.now() - started,
    path,
    dep: pulse.outcome === "ok" ? "none" : "kv",
    detail: pulse.detail,
    fault,
  }, ctx);

  const rewritten = new HTMLRewriter()
    .on("[data-pulse]", {
      element(el) {
        if (!env.PULSE) return;
        el.setAttribute("data-pulse-state", pulse.outcome === "ok" ? "fresh" : "degraded");
        if (pulse.text) el.setInnerContent(pulse.text);
      },
    })
    .on("[data-game]", {
      // Game-day switch for Pulse run (ADR-015): deploy-time only, never a request toggle.
      element(el) {
        if (fault === "game_js_error") el.setAttribute("data-fault", "game_js_error");
      },
    })
    .on("[data-dashboard]", {
      element(el) {
        if (dashboard) el.setInnerContent(dashboard, { html: true });
      },
    })
    .on("[data-visits]", {
      element(el) {
        if (!visits) return;
        el.setInnerContent(` · ${visits}`);
        el.removeAttribute("hidden");
      },
    })
    .transform(page);
  const out = new Response(rewritten.body, rewritten);
  // Dynamic HTML: no validators, no caching, so every view gets fresh edge content.
  out.headers.delete("etag");
  out.headers.delete("last-modified");
  out.headers.set("cache-control", "no-store");
  return out;
}
