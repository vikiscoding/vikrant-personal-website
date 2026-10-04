export interface Env {
  ASSETS: Fetcher;
  /** Absent = heartbeat off: pages serve their fallback footer and /api/pulse returns 503 "disabled". */
  PULSE?: KVNamespace;
  SLI?: AnalyticsEngineDataset;
  VISITS?: DurableObjectNamespace<import("./visits").VisitCounter>;
  /** Our own long-term SLI store (ADR-012). */
  LEDGER?: DurableObjectNamespace<import("./ledger").SliLedger>;
  /** Ludo rooms, one Durable Object per room (docs/ludo-telemetry.md). Absent = /api/ludo returns 503. */
  LUDO?: DurableObjectNamespace<import("./ludo/room").LudoRoom>;
  /** Reliability dashboard flag: "off" | "auto" (once 30 days of data) | "on". See worker/dashboard.ts. */
  DASHBOARD_MODE?: string;
  /** Feature flag: "off" | "auto" | "on". See worker/visits.ts. */
  VISITS_MODE?: string;
  /** Total page views at which "auto" starts showing the counter. */
  VISITS_THRESHOLD?: string;
  FAULT: string;
  GITHUB_REPO: string;
  GITHUB_TOKEN?: string;
  /** Incident desk (ADR-016): engine repo "owner/name" and a fine-grained token (Contents: read and write) for repository_dispatch. */
  INCIDENTS_REPO?: string;
  INCIDENTS_DISPATCH_TOKEN?: string;
  /** Ledger backfill (worker/backfill.ts): the account whose Workers Logs are queried, and a token with Workers
   *  Observability permission, set in the Cloudflare dashboard. Without them a ledger gap waits instead of backfilling. */
  CF_ACCOUNT_ID?: string;
  CF_OBSERVABILITY_TOKEN?: string;
  /** What could stop this site (ADR-030, worker/limits.ts): a read-only Account Analytics token for today's use of the
   *  free-tier allowances, and the shared secret the deploy pipeline uses to report its own token's expiry. Both set in
   *  the Cloudflare dashboard; the second also as a GitHub Actions secret. */
  CF_ANALYTICS_TOKEN?: string;
  LIMITS_REPORT_TOKEN?: string;
}
