// Game-day fault switch (ADR-010). Set by deploy only:
//   npx wrangler deploy --var FAULT:github_5xx
// There is no request-time toggle, so there is no public attack surface.
import type { Env } from "./env";

export const FAULTS = ["none", "github_5xx", "github_slow", "kv_read_fail", "kv_write_fail", "game_js_error"] as const;
export type Fault = (typeof FAULTS)[number];

export function activeFault(env: Env): Fault {
  return (FAULTS as readonly string[]).includes(env.FAULT) ? (env.FAULT as Fault) : "none";
}
