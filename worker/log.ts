// One event shape for every SLI-bearing unit of work (docs/log-schema.md).
// Written to places that do not share a failure domain with KV: Workers Logs (console),
// the SLI ledger Durable Object (ADR-012) and, when enabled, Analytics Engine. Never logs IPs, emails or bodies.
import type { Env } from "./env";
import { isCapacity } from "./capacity";
import { ledgerSource, type LedgerEntry } from "./ledger";

export type Outcome = "ok" | "degraded" | "error";
export type Dep = "github" | "kv" | "assets" | "none";

export interface SliEvent {
  op: "ticker" | "page" | "pulse_api" | "visits" | "ludo_action" | "ludo_bot" | "ludo_rtt" | "ludo_connect" | "ludo_lobby" | "ludo_game" | "ludo_turn";
  outcome: Outcome;
  status: number;
  ms: number;
  path?: string;
  dep?: Dep;
  detail?: string;
  fault?: string;
}

/** Log one SLI event. With `ctx`, it is also written to the ledger in the background (never blocks, never throws). */
export function record(env: Env, ev: SliEvent, ctx?: ExecutionContext): void {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ v: 2, ts, ...ev });
  if (ev.outcome === "error") console.error(line);
  else console.log(line);
  try {
    env.SLI?.writeDataPoint({
      indexes: [ev.op],
      blobs: [ev.op, ev.outcome, ev.path ?? "", ev.dep ?? "none", ev.detail ?? "", ev.fault ?? "none"],
      doubles: [ev.status, ev.ms],
    });
  } catch {
    // Telemetry export failing must never fail the request.
  }
  const entry = ledgerEntry(ev, ts);
  if (ctx && env.LEDGER && entry) {
    const stub = env.LEDGER.get(env.LEDGER.idFromName("sli"));
    ctx.waitUntil(Promise.resolve(stub.add(entry)).catch((e) => logUnrecorded([entry], e)));
  }
}

function ledgerEntry(ev: SliEvent, ts: string): LedgerEntry | null {
  const source = ledgerSource(ev.op);
  if (!source) return null;
  return { ts, source, outcome: ev.outcome, status: ev.status, ms: ev.ms, dep: ev.dep ?? "none", detail: ev.detail ?? "", fault: ev.fault ?? "none" };
}

/**
 * The ledger refused these entries (capacity or outage). Each is logged in full as `ledger_unrecorded`, so the
 * backfill (worker/backfill.ts) can replay exactly what was missed, and nothing that did land is counted twice.
 */
export function logUnrecorded(entries: LedgerEntry[], e: unknown): void {
  const detail = e instanceof Error ? e.message : "add failed";
  for (const entry of entries) {
    console.error(JSON.stringify({ v: 2, ts: new Date().toISOString(), op: "ledger_unrecorded", outcome: "error", detail: detail.slice(0, 160), entry }));
  }
}

/**
 * Like `record`, but waits for the ledger write and says whether it landed. The scheduled job uses it once per run:
 * that answer is how a ledger outage is noticed (and later backfilled). Never throws.
 */
export async function recordAwait(env: Env, ev: SliEvent): Promise<"ok" | "failed" | "capacity" | "none"> {
  const ts = new Date().toISOString();
  record(env, ev);
  const entry = ledgerEntry(ev, ts);
  if (!env.LEDGER || !entry) return "none";
  try {
    await env.LEDGER.get(env.LEDGER.idFromName("sli")).add(entry);
    return "ok";
  } catch (e) {
    logUnrecorded([entry], e);
    return isCapacity(e) ? "capacity" : "failed";
  }
}

export class DepError extends Error {
  constructor(
    readonly dep: "github" | "kv",
    readonly detail: string,
    readonly status = 502,
  ) {
    super(`${dep}: ${detail}`);
  }
}
