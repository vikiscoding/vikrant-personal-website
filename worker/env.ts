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
}
