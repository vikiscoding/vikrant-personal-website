// Ludo telemetry schema (docs/ludo-telemetry.md). Every Ludo event is an ordinary SliEvent (worker/log.ts:
// op, outcome, status, ms, fault) whose `detail` is a fixed set of key=value pairs per op, so logs and the
// ledger can be filtered without parsing free text. Values are enums or integers: never names, IPs or keys.

export type Mode = "solo" | "code" | "unknown";

/** The allowed detail keys for each op. Adding a key is a schema change: update the doc first. */
export interface LudoDetail {
  ludo_connect: { mode: Mode; result: "open" | "full" | "busy" | "rejected" | "error" | "capacity"; reason?: string };
  ludo_action: { mode: Mode; actor: "human" | "bot"; kind: "roll" | "move" | "start"; lag?: number };
  ludo_rtt: { mode: Mode };
  ludo_turn: { mode: Mode; result: "acted" | "timeout"; kind: "roll" | "move" | "start" };
  ludo_lobby: { result: "started" | "abandoned"; humans: number; bots: number };
  ludo_game: { mode: Mode; result: "won" | "abandoned"; humans: number; winner: string; actions: number };
}

/** "mode=solo actor=bot kind=roll lag=12": stable key order, no spaces inside values, 200 characters max.
 * Only the shapes in LudoDetail type-check, so a free-text field cannot slip in. */
export function detail(fields: LudoDetail[keyof LudoDetail]): string {
  return Object.entries(fields as Record<string, string | number | undefined>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v).replace(/[\s=]+/g, "_")}`)
    .join(" ")
    .slice(0, 200);
}
