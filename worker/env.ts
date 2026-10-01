export interface Env {
  ASSETS: Fetcher;
  /** Absent in P0a: the heartbeat is off and pages serve their fallback footer. */
  PULSE?: KVNamespace;
  SLI?: AnalyticsEngineDataset;
  VISITS?: DurableObjectNamespace<import("./visits").VisitCounter>;
  /** Our own long-term SLI store (ADR-012). */
  LEDGER?: DurableObjectNamespace<import("./ledger").SliLedger>;
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
