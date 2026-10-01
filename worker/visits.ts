// Page-view counter (ADR-011). Stores one number, nothing about the visitor.
// Always counts; shows in the footer only when the VISITS_MODE flag allows it.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { record } from "./log";

/** One Durable Object instance holds the site-wide total, so increments are exact. */
export class VisitCounter extends DurableObject<Env> {
  async hit(): Promise<number> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}

export type VisitsMode = "off" | "auto" | "on";

/** off = count, never show. auto = show once the total reaches VISITS_THRESHOLD. on = always show. */
export function visitsMode(env: Env): VisitsMode {
  return env.VISITS_MODE === "on" || env.VISITS_MODE === "auto" ? env.VISITS_MODE : "off";
}

// Crawlers, link previews, scripts and monitors. Anything without a user agent is also skipped.
const NOT_A_PERSON =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|pagespeed|curl|wget|python|go-http|java\/|okhttp|httpclient|axios|node-fetch|monitor|uptime|probe|check/i;

export function isCountable(request: Request, status: number): boolean {
  if (request.method !== "GET" || status !== 200) return false;
  const ua = request.headers.get("user-agent");
  if (!ua || NOT_A_PERSON.test(ua)) return false;
  // Prefetches are not views.
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  return !/prefetch|prerender/i.test(purpose);
}

const HIT_TIMEOUT_MS = 300;

/** Count this view. Returns the new total, or null if counting failed or was too slow. Never throws. */
export async function countVisit(env: Env): Promise<number | null> {
  if (!env.VISITS) return null;
  const started = Date.now();
  try {
    const stub = env.VISITS.get(env.VISITS.idFromName("site"));
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), HIT_TIMEOUT_MS));
    const n = await Promise.race([stub.hit(), timeout]);
    if (n === null) record(env, { op: "visits", outcome: "degraded", status: 504, ms: Date.now() - started, detail: "timeout" });
    return n;
  } catch (e) {
    record(env, { op: "visits", outcome: "error", status: 500, ms: Date.now() - started, detail: e instanceof Error ? e.message : "hit failed" });
    return null;
  }
}

/** The footer text, or null when the flag says stay hidden. */
export function visitsText(env: Env, total: number | null): string | null {
  if (total === null) return null;
  const mode = visitsMode(env);
  const threshold = Number.parseInt(env.VISITS_THRESHOLD ?? "", 10);
  const show = mode === "on" || (mode === "auto" && Number.isFinite(threshold) && total >= threshold);
  return show ? `Viewed ${total.toLocaleString("en-CA")} times` : null;
}
