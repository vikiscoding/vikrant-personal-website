// SLI ledger (ADR-012). Our own long-term SLI store: one SQLite-backed Durable Object.
// Principle: failures in full, successes counted (docs/slo.md). A separate storage system from KV,
// so a KV outage is still recorded. Never stores IPs, headers or tokens.
// Client path (ADR-015): Pulse run sessions and frame samples, from the validated /api/rum beacon.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { SliEvent } from "./log";
import { addDays, localDay } from "./time";

/** Server sources (ticker, pulse, page), client frame samples (frame) and client game errors (game). */
export type LedgerSource = ServerSource | "frame" | "game";
type LudoSource = "ludo_action" | "ludo_bot" | "ludo_rtt" | "ludo_connect" | "ludo_lobby" | "ludo_game" | "ludo_turn";
type ServerSource = "ticker" | "pulse" | "page" | LudoSource;

/** Histogram upper edges (ms); the last bucket is "over the last edge". Same column count for both sets. */
const SERVER_EDGES = [50, 100, 200, 400, 800, 1600, 3200, 6400] as const;
const FRAME_EDGES = [8, 16, 25, 33, 50, 100, 250, 1000] as const;
const edgesFor = (s: string): readonly number[] => (s === "frame" ? FRAME_EDGES : SERVER_EDGES);
const HIST = SERVER_EDGES.length + 1;
/** A good event slower than this is kept in full as an early warning ("slow good"): half the latency budget. */
const SLOW_GOOD_MS: Record<ServerSource, number> = {
  ticker: 2_500,
  pulse: 1_000,
  page: 1_000,
  // Ludo (docs/ludo-telemetry.md): half of each patience budget.
  ludo_action: 50,
  ludo_bot: 125,
  ludo_rtt: 150,
  ludo_connect: 500,
  ludo_lobby: 60_000,
  ludo_game: Number.MAX_SAFE_INTEGER,
  // Think time: kept in full only when a human is slow to act (an early patience signal).
  ludo_turn: 15_000,
};
/** Cap on detailed rows per source per day, so a storm (bots, spam, an outage) cannot bloat the ledger. */
const MAX_EVENTS_PER_DAY = 500;
/** Cap on new game sessions per day: /api/rum is public and spoofable (ADR-015). */
const MAX_SESSIONS_PER_DAY = 5_000;
const KEEP_DAYS = 400;
/** Detailed records returned per source with a window. */
const EVENTS_PER_SOURCE = 200;

export function ledgerSource(op: SliEvent["op"]): ServerSource | null {
  if (op === "ticker") return "ticker";
  if (op === "pulse_api") return "pulse";
  if (op === "page") return "page";
  if (op.startsWith("ludo_")) return op as LudoSource;
  return null;
}

export interface LedgerEntry {
  ts: string;
  source: ServerSource;
  outcome: SliEvent["outcome"];
  status: number;
  ms: number;
  dep: string;
  detail: string;
  fault: string;
}

/** Already validated by worker/rum.ts. */
export type GameEvent =
  | { type: "game_start"; session: string }
  | { type: "game_over"; session: string; score: number; duration_s: number }
  | { type: "game_error"; session: string; message: string }
  | { type: "frame_sample"; session: string; p95_frame_ms: number; long_frames: number };

export interface DayRow {
  day: string;
  source: LedgerSource;
  total: number;
  good: number;
  bad: number;
  slow_good: number;
  /** Events dropped from `events` because the daily cap was hit. They are still in the counts. */
  overflow: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number;
}

export interface EventRow {
  ts: string;
  source: LedgerSource;
  outcome: string;
  status: number;
  ms: number;
  dep: string;
  detail: string;
  fault: string;
}

export interface GameSummary {
  /** Page loads that sent any game event. */
  sessions: number;
  /** Sessions where a run actually started. */
  started: number;
  /** Sessions with at least one uncaught error. */
  errored: number;
  /** Sessions with at least one frame over 50 ms while playing. */
  janky: number;
  /** Sessions that reached game over. */
  finished: number;
  frame_samples: number;
  /** Window-wide p95 of the per-sample p95 frame time (ms, bucket upper edge). */
  frame_p95_ms: number | null;
}

function bucketOf(ms: number, edges: readonly number[]): number {
  const i = edges.findIndex((edge) => ms <= edge);
  return i === -1 ? edges.length : i;
}

/** Approximate percentile from the histogram: the upper edge of the bucket where the rank falls. */
function percentile(hist: number[], total: number, q: number, edges: readonly number[]): number | null {
  if (total === 0) return null;
  const rank = Math.ceil(total * q);
  let seen = 0;
  for (let i = 0; i < HIST; i++) {
    seen += hist[i] ?? 0;
    if (seen >= rank) return i < edges.length ? (edges[i] ?? null) : null;
  }
  return null;
}

const hcols = Array.from({ length: HIST }, (_, i) => `h${i}`);

export class SliLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      // Create only what is missing, and never let a refused create throw out of start-up. (Note: once the free tier's
      // daily writes are used up, Cloudflare refuses EVERY query on this storage, reads included, as verified on 2 Oct
      // 2026; that is why the dashboard keeps a read copy in KV, worker/slo.ts saveSnapshot.)
      const have = new Set(sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index')`).toArray().map((r) => r.name));
      if (have.has("daily") && have.has("events") && have.has("events_day") && have.has("game_sessions")) return;
      try {
        sql.exec(`CREATE TABLE IF NOT EXISTS daily (
          day TEXT NOT NULL, source TEXT NOT NULL,
          total INTEGER NOT NULL DEFAULT 0, good INTEGER NOT NULL DEFAULT 0, bad INTEGER NOT NULL DEFAULT 0,
          slow_good INTEGER NOT NULL DEFAULT 0, overflow INTEGER NOT NULL DEFAULT 0, max_ms INTEGER NOT NULL DEFAULT 0,
          ${hcols.map((c) => `${c} INTEGER NOT NULL DEFAULT 0`).join(", ")},
          PRIMARY KEY (day, source))`);
        sql.exec(`CREATE TABLE IF NOT EXISTS events (
          ts TEXT NOT NULL, day TEXT NOT NULL, source TEXT NOT NULL, outcome TEXT NOT NULL,
          status INTEGER NOT NULL, ms INTEGER NOT NULL, dep TEXT NOT NULL, detail TEXT NOT NULL, fault TEXT NOT NULL)`);
        sql.exec(`CREATE INDEX IF NOT EXISTS events_day ON events (day, source)`);
        // One row per game session (a random per-page-load ID). No IP, user agent or cookie.
        sql.exec(`CREATE TABLE IF NOT EXISTS game_sessions (
          day TEXT NOT NULL, session TEXT NOT NULL,
          started INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
          errored INTEGER NOT NULL DEFAULT 0, janky INTEGER NOT NULL DEFAULT 0,
          best_score INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, session))`)      } catch (e) {
        console.error(JSON.stringify({ v: 2, ts: new Date().toISOString(), op: "ledger", outcome: "error", detail: `schema setup refused: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 200) }));
      }
    });
  }

  /** Count one event into the daily table. Returns whether it was over the detail cap. */
  private bump(day: string, source: LedgerSource, good: boolean, ms: number, slow: boolean, keepDetail: boolean): boolean {
    const sql = this.ctx.storage.sql;
    const h = `h${bucketOf(ms, edgesFor(source))}`;
    const detailed = keepDetail
      ? sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE day = ? AND source = ?`, day, source).one().n
      : 0;
    const overflow = keepDetail && detailed >= MAX_EVENTS_PER_DAY;
    sql.exec(
      `INSERT INTO daily (day, source, total, good, bad, slow_good, overflow, max_ms, ${h})
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (day, source) DO UPDATE SET
         total = total + 1, good = good + excluded.good, bad = bad + excluded.bad,
         slow_good = slow_good + excluded.slow_good, overflow = overflow + excluded.overflow,
         max_ms = MAX(max_ms, excluded.max_ms), ${h} = ${h} + 1`,
      day, source, good ? 1 : 0, good ? 0 : 1, slow ? 1 : 0, overflow ? 1 : 0, Math.round(ms),
    );
    return overflow;
  }

  private detail(e: Omit<EventRow, "detail"> & { detail: string }, day: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO events (ts, day, source, outcome, status, ms, dep, detail, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.ts, day, e.source, e.outcome, e.status, Math.round(e.ms), e.dep, e.detail.slice(0, 200), e.fault,
    );
  }

  add(e: LedgerEntry): void {
    const day = localDay(e.ts); // Toronto calendar day (ADR-014)
    const good = e.outcome === "ok";
    const slow = good && e.ms > SLOW_GOOD_MS[e.source];
    const keepDetail = !good || slow;
    const overflow = this.bump(day, e.source, good, e.ms, slow, keepDetail);
    if (keepDetail && !overflow) this.detail(e, day);
    // Housekeeping, roughly once a day at the ticker's rate.
    if (e.source === "ticker" && Math.random() < 1 / 144) {
      const sql = this.ctx.storage.sql;
      const cutoff = addDays(localDay(), -KEEP_DAYS);
      sql.exec(`DELETE FROM daily WHERE day < ?`, cutoff);
      sql.exec(`DELETE FROM events WHERE day < ?`, cutoff);
      sql.exec(`DELETE FROM game_sessions WHERE day < ?`, cutoff);
    }
  }

  /**
   * Many events in one call (worker/ludo/room.ts flushes a room's telemetry this way). The counts, histogram, slow-good
   * rule and detail cap are exactly those of `add`; the difference is cost: one upsert per (day, source) in the batch
   * instead of one per event, so ledger load grows with rooms, not with moves.
   */
  addBatch(entries: LedgerEntry[]): void {
    type Group = { day: string; source: ServerSource; total: number; good: number; slow: number; max: number; hist: number[]; details: LedgerEntry[] };
    const groups = new Map<string, Group>();
    for (const e of entries.slice(0, 5_000)) {
      if (!(e.source in SLOW_GOOD_MS)) continue;
      const day = localDay(e.ts);
      const key = `${day}|${e.source}`;
      const g = groups.get(key) ?? { day, source: e.source, total: 0, good: 0, slow: 0, max: 0, hist: Array<number>(HIST).fill(0), details: [] };
      const good = e.outcome === "ok";
      const slow = good && e.ms > SLOW_GOOD_MS[e.source];
      g.total += 1;
      g.good += good ? 1 : 0;
      g.slow += slow ? 1 : 0;
      g.max = Math.max(g.max, Math.round(e.ms));
      const b = bucketOf(e.ms, edgesFor(e.source));
      g.hist[b] = (g.hist[b] ?? 0) + 1;
      if (!good || slow) g.details.push(e);
      groups.set(key, g);
    }
    const sql = this.ctx.storage.sql;
    for (const g of groups.values()) {
      const kept = g.details.length
        ? sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE day = ? AND source = ?`, g.day, g.source).one().n
        : 0;
      const room = Math.max(0, MAX_EVENTS_PER_DAY - kept);
      const overflow = Math.max(0, g.details.length - room);
      sql.exec(
        `INSERT INTO daily (day, source, total, good, bad, slow_good, overflow, max_ms, ${hcols.join(", ")})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${hcols.map(() => "?").join(", ")})
         ON CONFLICT (day, source) DO UPDATE SET
           total = total + excluded.total, good = good + excluded.good, bad = bad + excluded.bad,
           slow_good = slow_good + excluded.slow_good, overflow = overflow + excluded.overflow,
           max_ms = MAX(max_ms, excluded.max_ms), ${hcols.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}`,
        g.day, g.source, g.total, g.good, g.total - g.good, g.slow, overflow, g.max, ...g.hist,
      );
      for (const e of g.details.slice(0, room)) this.detail(e, g.day);
    }
  }

  /** One validated Pulse run event (ADR-015). Never throws on unknown sessions; caps new sessions per day. */
  addGame(e: GameEvent, ts: string, fault: string): void {
    const sql = this.ctx.storage.sql;
    const day = localDay(ts);
    const exists = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM game_sessions WHERE day = ? AND session = ?`, day, e.session).one().n > 0;
    if (!exists) {
      const today = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM game_sessions WHERE day = ?`, day).one().n;
      if (today >= MAX_SESSIONS_PER_DAY) return;
      sql.exec(`INSERT INTO game_sessions (day, session) VALUES (?, ?)`, day, e.session);
    }
    switch (e.type) {
      case "game_start":
        sql.exec(`UPDATE game_sessions SET started = 1 WHERE day = ? AND session = ?`, day, e.session);
        break;
      case "game_over":
        sql.exec(
          `UPDATE game_sessions SET finished = 1, best_score = MAX(best_score, ?) WHERE day = ? AND session = ?`,
          Math.round(e.score), day, e.session,
        );
        break;
      case "game_error": {
        sql.exec(`UPDATE game_sessions SET errored = 1 WHERE day = ? AND session = ?`, day, e.session);
        const overflow = this.bump(day, "game", false, 0, false, true);
        if (!overflow) {
          this.detail({ ts, source: "game", outcome: "error", status: 0, ms: 0, dep: "client", detail: e.message, fault }, day);
        }
        break;
      }
      case "frame_sample": {
        const janky = e.long_frames > 0;
        if (janky) sql.exec(`UPDATE game_sessions SET janky = 1 WHERE day = ? AND session = ?`, day, e.session);
        this.bump(day, "frame", !janky, e.p95_frame_ms, false, false);
        break;
      }
    }
  }

  /**
   * Every detailed record the ledger still keeps (KEEP_DAYS) for the given sources, newest first: the full failure
   * history page. Bounded by the daily detail cap, so it can't grow without limit.
   */
  history(sources: string[], limit = 3_000): EventRow[] {
    const allowed = sources.filter((s) => /^[a-z_]+$/.test(s));
    if (!allowed.length) return [];
    return this.ctx.storage.sql
      .exec<Record<string, string | number>>(
        `SELECT ts, source, outcome, status, ms, dep, detail, fault FROM events WHERE source IN (${allowed.map(() => "?").join(",")}) ORDER BY ts DESC LIMIT ?`,
        ...allowed,
        limit,
      )
      .toArray()
      .map((r) => ({
        ts: String(r.ts),
        source: String(r.source) as LedgerSource,
        outcome: String(r.outcome),
        status: Number(r.status),
        ms: Number(r.ms),
        dep: String(r.dep),
        detail: String(r.detail),
        fault: String(r.fault),
      }));
  }

  /** The last `days` Toronto calendar days, oldest first, plus their detailed events (newest first) and the game summary. */
  read(days: number): { days: DayRow[]; events: EventRow[]; game: GameSummary } {
    const sql = this.ctx.storage.sql;
    const from = addDays(localDay(), -(days - 1));
    const rows = sql
      .exec<Record<string, string | number>>(`SELECT * FROM daily WHERE day >= ? ORDER BY day, source`, from)
      .toArray();
    const frameHist = Array.from({ length: HIST }, () => 0);
    let frameTotal = 0;
    const out: DayRow[] = rows.map((r) => {
      const hist = hcols.map((c) => Number(r[c] ?? 0));
      const total = Number(r.total);
      const source = String(r.source) as LedgerSource;
      const edges = edgesFor(source);
      if (source === "frame") {
        hist.forEach((v, i) => (frameHist[i] = (frameHist[i] ?? 0) + v));
        frameTotal += total;
      }
      return {
        day: String(r.day),
        source,
        total,
        good: Number(r.good),
        bad: Number(r.bad),
        slow_good: Number(r.slow_good),
        overflow: Number(r.overflow),
        p50_ms: percentile(hist, total, 0.5, edges),
        p95_ms: percentile(hist, total, 0.95, edges),
        max_ms: Number(r.max_ms),
      };
    });
    // Newest first, but capped per source: one cap across all sources let Ludo's think-time and round-trip records
    // crowd the site's own failures (game day 1, the 2 Oct outage) out of the window (found 4 Oct 2026).
    const events: EventRow[] = sql
      .exec<Record<string, string | number>>(
        `SELECT ts, source, outcome, status, ms, dep, detail, fault FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY ts DESC) AS rn FROM events WHERE day >= ?
         ) WHERE rn <= ? ORDER BY ts DESC`,
        from,
        EVENTS_PER_SOURCE,
      )
      .toArray()
      .map((r) => ({
        ts: String(r.ts),
        source: String(r.source) as LedgerSource,
        outcome: String(r.outcome),
        status: Number(r.status),
        ms: Number(r.ms),
        dep: String(r.dep),
        detail: String(r.detail),
        fault: String(r.fault),
      }));
    const g = sql
      .exec<Record<string, number>>(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(started),0) AS started, COALESCE(SUM(errored),0) AS errored,
                COALESCE(SUM(janky),0) AS janky, COALESCE(SUM(finished),0) AS finished
         FROM game_sessions WHERE day >= ?`,
        from,
      )
      .one();
    const game: GameSummary = {
      sessions: Number(g.sessions),
      started: Number(g.started),
      errored: Number(g.errored),
      janky: Number(g.janky),
      finished: Number(g.finished),
      frame_samples: frameTotal,
      frame_p95_ms: percentile(frameHist, frameTotal, 0.95, FRAME_EDGES),
    };
    return { days: out, events, game };
  }
}
