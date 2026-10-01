// POST /api/rum: Pulse run's client telemetry (ADR-015). The only public write path on the site, so zero trust:
// same-origin only, ≤ 1 KB, four event types, strict shapes and bounds. Stores no IP, user agent or cookie.
// The signal is client-only and spoofable: it never feeds an SLO or an alert.
import type { Env } from "./env";
import { activeFault } from "./faults";
import type { GameEvent } from "./ledger";

const MAX_BYTES = 1024;
const SESSION = /^[a-f0-9]{16}$/;
const ALLOWED_ORIGINS = new Set(["https://vikrantsingh.fyi", "https://vikrantsingh-fyi.vikrant-singh1.workers.dev"]);
const isLocal = (o: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;

/** Error text: printable only, query strings and fragments stripped from any URL, 120 characters max. */
function cleanMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/(https?:\/\/[^\s?#]*)[?#]\S*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return s.length ? s : null;
}

export function parseGameEvent(body: unknown): GameEvent | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.session !== "string" || !SESSION.test(b.session)) return null;
  const session = b.session;
  switch (b.type) {
    case "game_start":
      return { type: "game_start", session };
    case "game_over": {
      const score = num(b.score, 0, 1_000_000);
      const duration_s = num(b.duration_s, 0, 3_600);
      return score === null || duration_s === null ? null : { type: "game_over", session, score, duration_s };
    }
    case "game_error": {
      const message = cleanMessage(b.message);
      return message === null ? null : { type: "game_error", session, message };
    }
    case "frame_sample": {
      const p95_frame_ms = num(b.p95_frame_ms, 0, 5_000);
      const long_frames = num(b.long_frames, 0, 10_000);
      return p95_frame_ms === null || long_frames === null ? null : { type: "frame_sample", session, p95_frame_ms, long_frames };
    }
    default:
      return null;
  }
}

const empty = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

export async function rumApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return empty(405);

  // Same origin only. sendBeacon sends Origin on POST; fall back to Fetch Metadata when it is absent.
  const origin = request.headers.get("origin");
  const sameSite = request.headers.get("sec-fetch-site");
  const originOk = origin ? ALLOWED_ORIGINS.has(origin) || isLocal(origin) : sameSite === "same-origin";
  if (!originOk) return empty(403);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return empty(413);
  const text = await request.text();
  if (text.length > MAX_BYTES) return empty(413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty(400);
  }
  const event = parseGameEvent(parsed);
  if (!event) return empty(400);

  if (env.LEDGER) {
    const stub = env.LEDGER.get(env.LEDGER.idFromName("sli"));
    const ts = new Date().toISOString();
    ctx.waitUntil(
      Promise.resolve(stub.addGame(event, ts, activeFault(env))).catch((e) =>
        console.error(JSON.stringify({ v: 1, ts, op: "rum", outcome: "error", detail: e instanceof Error ? e.message : "addGame failed" })),
      ),
    );
  }
  return empty(204);
}
