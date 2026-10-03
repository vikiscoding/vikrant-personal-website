// GET /api/slo?days=30: the ledger's window plus SLO math. Read by the dashboard (and, once built, the daily Git export).
import { isCapacity, nextReset } from "./capacity";
import { readGap } from "./backfill";
import type { Env } from "./env";
import { activeFault } from "./faults";
import type { DayRow, EventRow, GameSummary, LedgerSource } from "./ledger";

/** Targets from docs/slo.md. "pulse" here is the white-box view of the probe; SLO-1 itself is UptimeRobot's number. */
export const TARGETS: Partial<Record<LedgerSource, number>> & { ticker: number; pulse: number } = {
  ticker: 0.98,
  pulse: 0.99,
  // Ludo, proposed (docs/ludo-telemetry.md). Lobby and game completion are tracked, not objectives.
  ludo_connect: 0.995,
  ludo_action: 0.99,
  ludo_bot: 0.99,
  ludo_rtt: 0.95,
};

export interface SourceSummary {
  source: LedgerSource;
  total: number;
  good: number;
  bad: number;
  sli: number | null;
  target: number | null;
  /** Fraction of the error budget still unspent (1 = untouched, 0 = spent, negative = SLO breached). */
  budget_left: number | null;
  days_with_data: number;
}

export interface SloWindow {
  generated_at: string;
  window_days: number;
  summary: SourceSummary[];
  days: DayRow[];
  events: EventRow[];
  /** Client path (Pulse run, ADR-015): tracked signals, never an SLO. */
  game: GameSummary;
  /** Present while recording is interrupted (ADR-028): the data stops at `since` and is being, or will be, rebuilt. */
  recording?: { state: "paused" | "rebuilding"; since: string; cause: string; resumes_at: string | null };
}

export function summarize(days: DayRow[], source: LedgerSource): SourceSummary {
  const rows = days.filter((d) => d.source === source);
  const total = rows.reduce((n, d) => n + d.total, 0);
  const good = rows.reduce((n, d) => n + d.good, 0);
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  const sli = total ? round(good / total) : null;
  const target = TARGETS[source] ?? null;
  const budget_left = total && target !== null ? round(1 - (1 - good / total) / (1 - target)) : null;
  return { source, total, good, bad: total - good, sli, target, budget_left, days_with_data: rows.length };
}

/**
 * A read copy of the 30-day window, outside the ledger. Once the free tier's daily writes are used up, Cloudflare
 * refuses every query on the ledger's storage, reads included (verified 2 Oct 2026), so the dashboard and /api/slo
 * fall back to this copy, labelled with when it was saved. Refreshed by every healthy scheduled run (~144 KV writes
 * a day, inside KV's own free allowance).
 */
export const SLO_COPY_KEY = "slo:last";
export interface SloCopy {
  saved_at: string;
  window: SloWindow;
}

export async function saveSloCopy(env: Env): Promise<void> {
  if (!env.PULSE) return;
  const win = await readWindow(env, 30);
  if (win) await env.PULSE.put(SLO_COPY_KEY, JSON.stringify({ saved_at: win.generated_at, window: win } satisfies SloCopy));
}

export async function readSloCopy(env: Env): Promise<SloCopy | null> {
  try {
    return env.PULSE ? await env.PULSE.get<SloCopy>(SLO_COPY_KEY, "json") : null;
  } catch {
    return null;
  }
}

export async function readWindow(env: Env, windowDays: number): Promise<SloWindow | null> {
  if (!env.LEDGER) return null;
  // Game day (deploy-time only): the ledger cannot be read, exactly as when the free tier's writes are used up.
  if (activeFault(env) === "ledger_read_fail") throw new Error("Exceeded allowed rows written in Durable Objects free tier. (injected: FAULT=ledger_read_fail)");
  const { days, events, game } = await env.LEDGER.get(env.LEDGER.idFromName("sli")).read(windowDays);
  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    summary: (["pulse", "ticker", "page", "ludo_connect", "ludo_action", "ludo_bot", "ludo_rtt", "ludo_lobby", "ludo_game", "ludo_turn"] as const).map((s) => summarize(days, s)),
    days,
    events,
    game,
  };
}

/** The recording status for /api/slo, from the open ledger gap if any. */
async function recordingStatus(env: Env): Promise<SloWindow["recording"]> {
  const gap = await readGap(env);
  if (!gap) return undefined;
  const paused = gap.cause === "capacity" && gap.resumeAt !== undefined && Date.now() < gap.resumeAt;
  return { state: paused ? "paused" : "rebuilding", since: gap.opened, cause: gap.cause ?? "outage", resumes_at: gap.resumeAt ? new Date(gap.resumeAt).toISOString() : null };
}

export async function sloApi(env: Env, url: URL): Promise<Response> {
  const requested = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
  const windowDays = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 90) : 30;
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=60" };
  try {
    const body = await readWindow(env, windowDays);
    if (!body) return new Response(JSON.stringify({ error: "ledger_disabled" }), { status: 503, headers });
    const recording = await recordingStatus(env);
    if (recording) body.recording = recording;
    return new Response(JSON.stringify(body), { headers });
  } catch (e) {
    // The ledger cannot be read: serve the last saved copy, labelled, so the record is still visible (ADR-028).
    const copy = await readSloCopy(env);
    if (copy) {
      const recording = (await recordingStatus(env)) ?? { state: "paused" as const, since: copy.saved_at, cause: isCapacity(e) ? "capacity" : "outage", resumes_at: isCapacity(e) ? new Date(nextReset()).toISOString() : null };
      return new Response(JSON.stringify({ ...copy.window, recording, from_copy: true, as_of: copy.saved_at }), { headers });
    }
    if (isCapacity(e)) {
      const resets = new Date(nextReset()).toISOString();
      return new Response(JSON.stringify({ error: "capacity", detail: "Cloudflare free-tier daily allowance used up", resets_at: resets }), { status: 503, headers: { ...headers, "retry-after": String(Math.ceil((nextReset() - Date.now()) / 1000)) } });
    }
    console.error(JSON.stringify({ v: 2, ts: new Date().toISOString(), op: "slo_api", outcome: "error", detail: e instanceof Error ? e.message : "read failed" }));
    return new Response(JSON.stringify({ error: "ledger_unavailable" }), { status: 503, headers });
  }
}
