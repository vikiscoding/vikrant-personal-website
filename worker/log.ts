// One event shape for every SLI-bearing unit of work (docs/log-schema.md).
// Written to places that do not share a failure domain with KV: Workers Logs (console),
// the SLI ledger Durable Object (ADR-012) and, when enabled, Analytics Engine. Never logs IPs, emails or bodies.
import type { Env } from "./env";
import { ledgerSource } from "./ledger";

export type Outcome = "ok" | "degraded" | "error";
export type Dep = "github" | "kv" | "assets" | "none";

export interface SliEvent {
  op: "ticker" | "page" | "pulse_api" | "visits" | "ludo_action" | "ludo_rtt" | "ludo_connect" | "ludo_lobby" | "ludo_game" | "ludo_turn";
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
  const line = JSON.stringify({ v: 1, ts, ...ev });
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
  const source = ledgerSource(ev.op);
  if (ctx && env.LEDGER && source) {
    const stub = env.LEDGER.get(env.LEDGER.idFromName("sli"));
    const entry = {
      ts,
      source,
      outcome: ev.outcome,
      status: ev.status,
      ms: ev.ms,
      dep: ev.dep ?? "none",
      detail: ev.detail ?? "",
      fault: ev.fault ?? "none",
    };
    ctx.waitUntil(Promise.resolve(stub.add(entry)).catch((e) => console.error(JSON.stringify({ v: 1, ts, op: "ledger", outcome: "error", detail: e instanceof Error ? e.message : "add failed" }))));
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
