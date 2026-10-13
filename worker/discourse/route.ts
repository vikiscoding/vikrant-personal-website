// /discourse/api/*: forwards to the one room. Same origin only; nothing is logged or recorded (no SLI, no telemetry),
// so this stays out of the site's objectives and out of its logs.
import type { Env } from "../env";
import { isCapacity } from "../capacity";

const isLocal = (o: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

export async function discourseApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const headers = { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" };
  const origin = request.headers.get("origin") ?? "";
  // Writes and the socket must come from a page this Worker served; reads carry no Origin header.
  if (origin && origin !== url.origin && !isLocal(origin)) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers });
  if (request.method !== "GET" && !origin) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers });
  if (!env.DISCOURSE) return new Response(JSON.stringify({ error: "disabled" }), { status: 503, headers });
  try {
    return await env.DISCOURSE.get(env.DISCOURSE.idFromName("room")).fetch(request);
  } catch (e) {
    return new Response(JSON.stringify({ error: isCapacity(e) ? "capacity" : "unavailable" }), { status: 503, headers });
  }
}
