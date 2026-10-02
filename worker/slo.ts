// GET /api/slo?days=30: the ledger's window plus SLO math. Read by the dashboard (and, once built, the daily Git export).
import type { Env } from "./env";
import type { DayRow, EventRow, GameSummary, LedgerSource } from "./ledger";

/** Targets from docs/slo.md. "pulse" here is the white-box view of the probe; SLO-1 itself is UptimeRobot's number. */
export const TARGETS: Partial<Record<LedgerSource, number>> & { ticker: number; pulse: number } = {
  ticker: 0.98,
  pulse: 0.99,
  // Ludo, proposed (docs/ludo-telemetry.md). Lobby and game completion are tracked, not objectives.
  ludo_connect: 0.995,
  ludo_action: 0.99,
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

export async function readWindow(env: Env, windowDays: number): Promise<SloWindow | null> {
  if (!env.LEDGER) return null;
  const { days, events, game } = await env.LEDGER.get(env.LEDGER.idFromName("sli")).read(windowDays);
  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    summary: (["pulse", "ticker", "page", "ludo_connect", "ludo_action", "ludo_rtt", "ludo_lobby", "ludo_game", "ludo_turn"] as const).map((s) => summarize(days, s)),
    days,
    events,
    game,
  };
}

export async function sloApi(env: Env, url: URL): Promise<Response> {
  const requested = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
  const windowDays = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 90) : 30;
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=60" };
  try {
    const body = await readWindow(env, windowDays);
    if (!body) return new Response(JSON.stringify({ error: "ledger_disabled" }), { status: 503, headers });
    return new Response(JSON.stringify(body), { headers });
  } catch (e) {
    console.error(JSON.stringify({ v: 1, ts: new Date().toISOString(), op: "slo_api", outcome: "error", detail: e instanceof Error ? e.message : "read failed" }));
    return new Response(JSON.stringify({ error: "ledger_unavailable" }), { status: 503, headers });
  }
}
