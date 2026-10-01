// The heartbeat. Real work on a clock against a dependency we do not control (GitHub).
// Its failures are genuine, which is what makes its SLO more than theatre.
import type { Env } from "./env";
import { activeFault } from "./faults";
import { DepError, record } from "./log";
import { incidentSignal, refreshFeed } from "./incidents";

export const SNAPSHOT_KEY = "snapshot:v1";
const GITHUB_TIMEOUT_MS = 5_000;

export interface Snapshot {
  v: 1;
  fetchedAt: string;
  lastCommitAt: string;
  lastCommitSha: string;
  ciConclusion: string | null; // "success" | "failure" | ... | null while running
}

async function github<T>(env: Env, path: string): Promise<T> {
  const fault = activeFault(env);
  if (fault === "github_5xx") throw new DepError("github", "injected 503", 503);
  if (fault === "github_slow") {
    await new Promise((r) => setTimeout(r, GITHUB_TIMEOUT_MS + 1_000));
    throw new DepError("github", "injected timeout", 504);
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "vikrantsingh-fyi-ticker", // GitHub rejects requests without one
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Unauthenticated calls share Cloudflare egress IPs and hit the 60/h limit, and a private repo answers 404.
  // Trim: a pasted secret can carry a trailing newline or spaces.
  const token = env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const auth = token ? `token ${token.slice(0, 11)}…` : "no token";

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
      headers,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    throw new DepError("github", e instanceof Error ? e.name : "fetch failed", 504);
  }
  if (!res.ok) throw new DepError("github", `http ${res.status} (${auth})`, res.status);
  return (await res.json()) as T;
}

async function fetchSnapshot(env: Env): Promise<Snapshot> {
  type Commit = { sha: string; commit: { committer: { date: string } } };
  type Runs = { workflow_runs: { conclusion: string | null }[] };
  const [commits, runs] = await Promise.all([
    github<Commit[]>(env, "/commits?per_page=1"),
    github<Runs>(env, "/actions/runs?branch=main&per_page=1"),
  ]);
  const head = commits[0];
  if (!head) throw new DepError("github", "no commits in response");
  return {
    v: 1,
    fetchedAt: new Date().toISOString(),
    lastCommitAt: head.commit.committer.date,
    lastCommitSha: head.sha.slice(0, 7),
    ciConclusion: runs.workflow_runs[0]?.conclusion ?? null,
  };
}

export async function runTicker(env: Env, ctx?: ExecutionContext): Promise<void> {
  const started = Date.now();
  const fault = activeFault(env);
  try {
    const snap = await fetchSnapshot(env);
    if (fault === "kv_write_fail") throw new DepError("kv", "injected write failure", 500);
    if (!env.PULSE) throw new DepError("kv", "PULSE binding missing", 500);
    try {
      await env.PULSE.put(SNAPSHOT_KEY, JSON.stringify(snap));
    } catch (e) {
      throw new DepError("kv", e instanceof Error ? e.message : "put failed", 500);
    }
    record(env, { op: "ticker", outcome: "ok", status: 200, ms: Date.now() - started, dep: "none", fault }, ctx);
    await incidentSignal(env, true, "", fault); // after the SLI is recorded, so the desk never skews it
    await refreshFeed(env);
  } catch (e) {
    const err = e instanceof DepError ? e : new DepError("github", String(e), 500);
    record(env, {
      op: "ticker",
      outcome: "error",
      status: err.status,
      ms: Date.now() - started,
      dep: err.dep,
      detail: err.detail,
      fault,
    }, ctx);
    await incidentSignal(env, false, `${err.detail} (${err.dep})`, fault);
    await refreshFeed(env);
    // No re-throw: a thrown scheduled handler may drop the ledger write registered above,
    // and a failed tick is the one event the ledger must never lose. Logs and ledger carry it.
  }
}
