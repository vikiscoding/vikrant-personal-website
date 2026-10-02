// Pure helpers for the ledger backfill (worker/backfill.ts): find this site's structured log lines inside a Workers
// Logs query result and turn them back into ledger entries. No Workers APIs here, so they are unit-testable in Node.

/** One of this site's log lines (docs/log-schema.md), as written by worker/log.ts. */
export interface LogRecord {
  v: number;
  ts: string;
  op: string;
  outcome?: string;
  status?: number;
  ms?: number;
  dep?: string;
  detail?: string;
  fault?: string;
  /** Present on `ledger_unrecorded` lines: the exact entry the ledger refused. */
  entry?: Record<string, unknown>;
}

/**
 * The query API nests each log line inside an event object whose exact layout is the platform's to choose (parsed
 * fields, or the raw message string). Search the event for a `{ v: 1, op, ts }` object, parsing JSON strings on the way.
 */
export function findRecord(x: unknown, depth = 0): LogRecord | null {
  if (depth > 5 || x === null || x === undefined) return null;
  if (typeof x === "string") {
    const s = x.trim();
    if (!s.startsWith("{") || !s.includes('"op"')) return null;
    try {
      return findRecord(JSON.parse(s), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (o.v === 1 && typeof o.op === "string" && typeof o.ts === "string") return o as unknown as LogRecord;
  for (const val of Object.values(o)) {
    const r = findRecord(val, depth + 1);
    if (r) return r;
  }
  return null;
}

export interface BackfillEntry {
  ts: string;
  source: string;
  outcome: "ok" | "degraded" | "error";
  status: number;
  ms: number;
  dep: string;
  detail: string;
  fault: string;
}

const OUTCOMES = new Set(["ok", "degraded", "error"]);
const mark = (detail: string) => (detail ? `${detail} · backfilled` : "backfilled");

/**
 * A ledger entry rebuilt from a log line, marked "backfilled" so the record stays honest about where it came from.
 * `sourceOf` maps a log `op` to its ledger source (worker/ledger.ts `ledgerSource`), null for ops the ledger keeps no count of.
 */
export function toEntry(rec: LogRecord, sourceOf: (op: string) => string | null): BackfillEntry | null {
  if (rec.op === "ledger_unrecorded") {
    const e = rec.entry;
    if (!e || typeof e.ts !== "string" || typeof e.source !== "string" || !OUTCOMES.has(String(e.outcome))) return null;
    return {
      ts: e.ts,
      source: e.source,
      outcome: e.outcome as BackfillEntry["outcome"],
      status: Number(e.status) || 0,
      ms: Number(e.ms) || 0,
      dep: String(e.dep ?? "none"),
      detail: mark(String(e.detail ?? "")),
      fault: String(e.fault ?? "none"),
    };
  }
  const source = sourceOf(rec.op);
  if (!source || !OUTCOMES.has(String(rec.outcome))) return null;
  return {
    ts: rec.ts,
    source,
    outcome: rec.outcome as BackfillEntry["outcome"],
    status: Number(rec.status) || 0,
    ms: Number(rec.ms) || 0,
    dep: rec.dep ?? "none",
    detail: mark(rec.detail ?? ""),
    fault: rec.fault ?? "none",
  };
}

/** Is this log line the ledger refusing a write for capacity (the first one marks where an outage began)? */
export const isCapacityLine = (rec: LogRecord) =>
  (rec.op === "ledger" || rec.op === "ledger_unrecorded" || rec.op === "slo_api") && /free tier/i.test(rec.detail ?? "");
