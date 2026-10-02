// GET /api/ludo?room=…&key=… (WebSocket upgrade). A public write path, so: same origin only, strict room and key
// formats, and nothing personal stored (the key is a random per-tab seat token, not an identity).
import type { Env } from "../env";
import { record } from "../log";

const ROOM = /^(s-[a-f0-9]{16}|c-[A-Z0-9]{4,6})$/;
const KEY = /^[a-f0-9]{16}$/;
const ALLOWED_ORIGINS = new Set(["https://vikrantsingh.fyi", "https://vikrantsingh-fyi.vikrant-singh1.workers.dev"]);
const isLocal = (o: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

export async function ludoApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const origin = request.headers.get("origin") ?? "";
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
  if (!ALLOWED_ORIGINS.has(origin) && !isLocal(origin)) return new Response("forbidden", { status: 403 });
  const room = url.searchParams.get("room") ?? "";
  const key = url.searchParams.get("key") ?? "";
  if (!ROOM.test(room) || !KEY.test(key)) return new Response("bad room or key", { status: 400 });
  if (!env.LUDO) return new Response("ludo disabled", { status: 503 });

  try {
    const res = await env.LUDO.get(env.LUDO.idFromName(room)).fetch(request);
    // 4xx from the room (full, busy) is a correct answer, not a failure of the service.
    const outcome = res.status === 101 || res.status < 500 ? "ok" : "error";
    record(env, { op: "ludo_connect", outcome, status: res.status, ms: Date.now() - started, detail: room.slice(0, 2) }, ctx);
    return res;
  } catch (e) {
    record(env, { op: "ludo_connect", outcome: "error", status: 500, ms: Date.now() - started, detail: e instanceof Error ? e.message.slice(0, 80) : "connect failed" }, ctx);
    return new Response("room unavailable", { status: 503 });
  }
}
