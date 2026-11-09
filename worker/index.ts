import type { Env } from "./env";
import { pulseApi, servePage } from "./pulse";
import { ludoApi } from "./ludo/route";
import { rumApi } from "./rum";
import { sloApi } from "./slo";
import { runTicker } from "./ticker";
import { limitsApi, refreshLimits } from "./limits";
import { refreshRuns } from "./incidents";

export { VisitCounter } from "./visits";
export { SliLedger } from "./ledger";
export { LudoRoom } from "./ludo/room";

const GOOGLE_VERIFICATION = "/google7b4bacaf47625010.html";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    // Canonical origin: https://vikrantsingh.fyi. workers.dev and localhost are left alone.
    const isSiteHost = url.hostname === "vikrantsingh.fyi" || url.hostname === "www.vikrantsingh.fyi";
    if (isSiteHost && (url.protocol === "http:" || url.hostname.startsWith("www."))) {
      url.protocol = "https:";
      url.hostname = "vikrantsingh.fyi";
      return Response.redirect(url.toString(), 301);
    }
    const { pathname } = url;
    // Google Search Console ownership file. Answered here because static assets redirect any *.html URL (307 to the
    // bare path), and Google's file check expects a 200 at this exact URL. Removing it unverifies the property.
    if (pathname === GOOGLE_VERIFICATION) {
      return new Response(`google-site-verification: ${GOOGLE_VERIFICATION.slice(1)}`, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    }
    if (pathname === "/api/pulse" && request.method === "GET") return pulseApi(env, ctx);
    if (pathname === "/api/slo" && request.method === "GET") return sloApi(env, url);
    if (pathname === "/api/rum") return rumApi(request, env, ctx);
    if (pathname === "/api/ludo" && request.method === "GET") return ludoApi(request, env, ctx);
    if (pathname === "/api/limits" || pathname === "/api/limits/ci") return limitsApi(request, env);
    if (pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return servePage(request, env, ctx);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    // Beside the scheduled job, never inside it: a limits check can never fail or slow a run (ADR-030).
    ctx.waitUntil(refreshLimits(env));
    ctx.waitUntil(refreshRuns(env, controller.scheduledTime));
    await runTicker(env, ctx);
  },
} satisfies ExportedHandler<Env>;
