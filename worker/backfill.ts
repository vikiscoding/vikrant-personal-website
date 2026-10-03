// Ledger backfill: when the SLI ledger cannot record (a capacity limit or any outage), rebuild what it missed from
// Workers Logs, which every event is also written to (worker/log.ts) and which do not share the ledger's failure domain.
//
// How it runs (all from the scheduled job, worker/ticker.ts):
//   1. Each run awaits its own ledger write. Refused → KV `ledger:gap` = { from, mode: "unrecorded" } (one write per outage).
//   2. Every refused write anywhere is also logged as `ledger_unrecorded` with the exact entry (log.ts, ludo/room.ts).
//   3. The first run whose write succeeds while a gap is open replays the gap's `ledger_unrecorded` lines into the ledger,
//      one 30-minute slice per run (inside the Free plan's CPU limit), marked "backfilled", moving `from` forward after
//      each slice so a retry never counts anything twice. Gap closed → the key is deleted.
//   Mode "events" (a gap opened before `ledger_unrecorded` existed, seeded by hand with the exact outage start found in
//   the logs) replays the ordinary SLI lines in [from, to). Logs are kept 3 days on the Free plan; an older gap is
//   abandoned with a log line. The query API returns newest first and parses JSON log lines into `source`, so the
//   backfill uses exact field filters (op = ledger_unrecorded) or reads every event in a slice, never a text search.
// Needs CF_ACCOUNT_ID (var) and CF_OBSERVABILITY_TOKEN (secret, Workers Observability permission). Without them the gap
// stays open and waits. Never throws; never raises an incident.
import { nextReset } from "./capacity";
import type { Env } from "./env";
import { findRecord, toEntry, type BackfillEntry } from "./backfill-parse";
import { ledgerSource, type LedgerEntry } from "./ledger";

export const GAP_KEY = "ledger:gap";
const SLICE_MS = 30 * 60_000;
const MIN_SLICE_MS = 60_000;
const LIMIT = 500;
const KEEP_MS = 3 * 86_400_000 - 3_600_000; // inside the 3-day log retention, with an hour of margin
/** Only the production Worker's lines: the dev Worker logs the same ops and must never reach this ledger. */
const SERVICE = "vikrantsingh-fyi";
const serviceOf = (ev: unknown) => ((ev as { $metadata?: { service?: unknown } })?.$metadata?.service as string | undefined) ?? null;

export interface Gap {
  /** Start of what is still to replay (epoch ms); moves forward as slices land. */
  from: number;
  /** End of the gap, when known (mode "events"); otherwise up to the run that closes it. */
  to?: number;
  mode: "unrecorded" | "events";
  /** Why recording stopped, for the dashboard's banner. */
  cause?: "capacity" | "outage";
  /** Capacity: when the allowance resets and writes resume (epoch ms). */
  resumeAt?: number;
  /** Slice length in ms; halved when a slice hits the query limit. */
  step?: number;
  /** Entries restored so far. */
  restored?: number;
  opened: string;
}

const log = (outcome: "ok" | "degraded" | "error", detail: string) =>
  console.log(JSON.stringify({ v: 2, ts: new Date().toISOString(), op: "ledger_backfill", outcome, detail: detail.slice(0, 200) }));

/** The open gap, if any: the dashboard and /api/slo use it to say recording is paused, or catching up. Never throws. */
export async function readGap(env: Env): Promise<Gap | null> {
  try {
    return env.PULSE ? await env.PULSE.get<Gap>(GAP_KEY, "json") : null;
  } catch {
    return null;
  }
}

/** Called once per scheduled run with whether that run's own ledger write landed. Never throws. */
export async function reconcileLedger(env: Env, ledger: "ok" | "failed" | "capacity" | "none"): Promise<void> {
  if (!env.PULSE || ledger === "none") return;
  try {
    const gap = await env.PULSE.get<Gap>(GAP_KEY, "json");
    if (ledger === "failed" || ledger === "capacity") {
      if (!gap) {
        // Other writes may have failed a little before this run noticed: start 20 minutes back. Only events that were
        // actually refused are logged as unrecorded, so the margin cannot double-count.
        const g: Gap = {
          from: Date.now() - 20 * 60_000,
          mode: "unrecorded",
          cause: ledger === "capacity" ? "capacity" : "outage",
          ...(ledger === "capacity" ? { resumeAt: nextReset() } : {}),
          opened: new Date().toISOString(),
        };
        await env.PULSE.put(GAP_KEY, JSON.stringify(g));
        log("degraded", "ledger writes refused; gap opened, will backfill from logs on restore");
      }
      return;
    }
    if (!gap) return;
    if (Date.now() - gap.from > KEEP_MS) {
      await env.PULSE.delete(GAP_KEY);
      log("error", `gap from ${new Date(gap.from).toISOString()} is older than log retention; abandoned`);
      return;
    }
    if (!env.CF_ACCOUNT_ID || !env.CF_OBSERVABILITY_TOKEN) {
      log("degraded", "gap open; waiting for CF_ACCOUNT_ID and CF_OBSERVABILITY_TOKEN to backfill");
      return;
    }
    await step(env, gap);
  } catch (e) {
    log("error", e instanceof Error ? e.message : "reconcile failed");
  }
}

/** One slice of replay per run. */
async function step(env: Env, gap: Gap): Promise<void> {
  const end = Math.min(gap.to ?? Date.now(), Date.now());
  if (gap.from >= end) {
    await env.PULSE!.delete(GAP_KEY);
    log("ok", `gap closed; ${gap.restored ?? 0} entries restored from logs`);
    return;
  }
  const len = gap.step ?? SLICE_MS;
  const sliceEnd = Math.min(gap.from + len, end);
  // Exact field filter for refused entries; for an "events" gap every event in the slice (filtered below by op).
  const params = gap.mode === "unrecorded" ? { filters: [{ key: "op", operation: "eq", type: "string", value: "ledger_unrecorded" }] } : {};
  const events = await query(env, gap.from, sliceEnd, params);
  if (events.length >= LIMIT && len > MIN_SLICE_MS) {
    gap.step = Math.max(MIN_SLICE_MS, Math.floor(len / 2)); // too many in one slice: smaller slices, same start
    await env.PULSE!.put(GAP_KEY, JSON.stringify(gap));
    return;
  }
  const lo = new Date(gap.from).toISOString();
  const hi = new Date(sliceEnd).toISOString();
  const seen = new Set<string>();
  const entries: BackfillEntry[] = [];
  for (const ev of events) {
    if (serviceOf(ev) !== SERVICE) continue;
    const rec = findRecord(ev);
    if (!rec) continue;
    const entry = toEntry(rec, (op) => ledgerSource(op as never));
    if (!entry || entry.ts < lo || entry.ts >= hi) continue; // each slice owns [from, sliceEnd): no overlaps
    if (gap.mode === "events" && rec.op === "ledger_unrecorded") continue;
    const key = `${entry.ts}|${entry.source}|${entry.outcome}|${entry.ms}|${entry.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  if (entries.length && env.LEDGER) {
    await env.LEDGER.get(env.LEDGER.idFromName("sli")).addBatch(entries as unknown as LedgerEntry[]);
  }
  gap.from = sliceEnd;
  gap.restored = (gap.restored ?? 0) + entries.length;
  gap.step = Math.min(SLICE_MS, len * 2);
  await env.PULSE!.put(GAP_KEY, JSON.stringify(gap));
  log("ok", `restored ${entries.length} entries for ${lo} to ${hi}`);
}

/** One Workers Logs query over [from, to). Newest first, at most LIMIT events (a full page halves the slice). */
async function query(env: Env, from: number, to: number, parameters: object): Promise<unknown[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/observability/telemetry/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_OBSERVABILITY_TOKEN!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      queryId: `ledger-backfill-${from}`,
      timeframe: { from, to },
      view: "events",
      limit: LIMIT,
      parameters,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`logs query http ${res.status}`);
  const body = (await res.json()) as { result?: { events?: { events?: unknown[] } | unknown[] } };
  const ev = body.result?.events;
  return Array.isArray(ev) ? ev : Array.isArray(ev?.events) ? ev.events : [];
}
