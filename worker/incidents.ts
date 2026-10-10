// Incident desk (ADR-016): the site raises real incidents in the incident engine repo and reads back its public feed.
// The site never decides anything about an incident; it only reports "failing" and "recovered".
// Paging stays with UptimeRobot: if GitHub is down, dispatch fails and is retried on the next tick.
import type { Env } from "./env";

const STATE_KEY = "incident:state";
const FEED_KEY = "incidents:feed";
/** Consecutive failed ticks (10 min apart) before an incident is raised: one blip is not an incident. */
const OPEN_AFTER_FAILURES = 2;

interface DeskState {
  failures: number;
  open: boolean;
  pending: "site_alert" | "site_recovered" | null;
  lastDetail: string;
}

export interface FeedIncident {
  id: string;
  title: string;
  state: string;
  priority: string | null;
  created_at: string;
  updated_at: string;
  triage: { priority: string; confidence: number; reasoning: string } | null;
  gate: string;
  /** The owner's latest /note (engine feed), e.g. context a reader of the desk alone would miss. */
  note?: string | null;
  drafts_unsent: number;
  recovered_at: string | null;
  issue_url: string | null;
  timeline: { at: string; kind: "service" | "ai" | "human" | "other"; event: string; to: string | null }[];
}

export interface Feed {
  generated_at: string | null;
  repo: string;
  incidents: FeedIncident[];
}

const fresh = (): DeskState => ({ failures: 0, open: false, pending: null, lastDetail: "" });

async function dispatch(env: Env, type: "site_alert" | "site_recovered", message: string): Promise<boolean> {
  if (!env.INCIDENTS_DISPATCH_TOKEN || !env.INCIDENTS_REPO) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${env.INCIDENTS_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.INCIDENTS_DISPATCH_TOKEN.trim()}`,
        "User-Agent": "vikrantsingh-fyi-incident-desk",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: type,
        client_payload: {
          monitor: "vikrantsingh.fyi heartbeat",
          service: "vikrantsingh.fyi",
          message: message.slice(0, 280),
          fired_at: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/** Called once per tick with the tick's outcome. Never throws; a desk problem must not break the heartbeat. */
export async function incidentSignal(env: Env, ok: boolean, detail: string, fault: string): Promise<void> {
  if (!env.PULSE) return;
  try {
    const before = (await env.PULSE.get<DeskState>(STATE_KEY, "json")) ?? fresh();
    const s: DeskState = { ...before };
    if (ok) {
      s.failures = 0;
      if (s.open && !s.pending) s.pending = "site_recovered";
    } else {
      s.failures += 1;
      // Fix the message at the moment the alert is raised, so a late delivery still reports the real count.
      s.lastDetail = `${s.failures} ${s.failures === 1 ? "run" : "runs"} in a row: ${detail}`;
      if (!s.open && s.failures >= OPEN_AFTER_FAILURES && s.pending !== "site_alert") s.pending = "site_alert";
      if (s.pending === "site_recovered") s.pending = null; // failing again before the recovery was sent
    }
    if (s.pending) {
      const gameDay = fault !== "none" ? ` (game day: ${fault})` : "";
      const message =
        s.pending === "site_alert"
          ? `Scheduled job failed ${s.lastDetail}${gameDay}${ok ? " (delivered after the site recovered; GitHub was unreachable)" : ""}`
          : `Scheduled job healthy again after failing ${s.lastDetail}`;
      if (await dispatch(env, s.pending, message)) {
        s.open = s.pending === "site_alert";
        s.pending = null;
      }
    }
    if (JSON.stringify(s) !== JSON.stringify(before)) await env.PULSE.put(STATE_KEY, JSON.stringify(s));
  } catch (e) {
    console.error(JSON.stringify({ v: 2, ts: new Date().toISOString(), op: "incident_desk", outcome: "error", detail: e instanceof Error ? e.message : "signal failed" }));
  }
}

/** The latest run's outcome as the desk saw it (consecutive failures and the last failure). Never throws. */
export async function readDeskState(env: Env): Promise<{ failures: number; lastDetail: string } | null> {
  if (!env.PULSE) return null;
  try {
    const s = await env.PULSE.get<DeskState>(STATE_KEY, "json");
    return s ? { failures: s.failures, lastDetail: s.lastDetail } : null;
  } catch {
    return null;
  }
}

/** Pull the engine's public feed into KV, writing only when it changed. Never throws. */
export async function refreshFeed(env: Env): Promise<void> {
  if (!env.PULSE || !env.INCIDENTS_REPO) return;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${env.INCIDENTS_REPO}/incident-data/feed.json`, {
      headers: { "User-Agent": "vikrantsingh-fyi-incident-desk" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return;
    const text = await res.text();
    if (text.length > 200_000) return;
    const feed = JSON.parse(text) as Feed;
    if (!Array.isArray(feed.incidents)) return;
    const current = await env.PULSE.get<Feed>(FEED_KEY, "json");
    if (current?.generated_at !== feed.generated_at) await env.PULSE.put(FEED_KEY, JSON.stringify(feed));
  } catch {
    // The desk is optional; the next tick tries again.
  }
}

export async function readFeed(env: Env): Promise<Feed | null> {
  if (!env.PULSE) return null;
  try {
    return await env.PULSE.get<Feed>(FEED_KEY, "json");
  } catch {
    return null;
  }
}

/*
 * Failed GitHub Actions runs (ADR-031, 10 Oct 2026): a failed deploy or limits check is a low-priority incident in
 * the ordinary sense (the live site keeps serving the last good version), so the desk lists it beside the tickets.
 * Read hourly beside the scheduled job, never inside it, with the token the job already holds. Only the workflow's
 * name, outcome, time and run id are kept: never who triggered it, the branch or the commit message.
 */
const RUNS_KEY = "incidents:runs";
const RUNS_WINDOW_MS = 30 * 86_400_000;
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

export interface FailedRun {
  id: number;
  workflow: string;
  conclusion: string;
  at: string;
  /** A later run of the same workflow succeeded. */
  resolved: boolean;
}
export interface RunsRecord {
  checkedAt: string;
  /** "owner/name" from the Worker's own config, for the run links. */
  repo: string;
  items: FailedRun[];
}

type ApiRun = { id: number; name: string | null; conclusion: string | null; status: string; created_at: string };

/** Newest first in, newest first out: each failure of the window, and whether a later run of its workflow passed. */
export function failedRuns(runs: ApiRun[], now: number): FailedRun[] {
  const out: FailedRun[] = [];
  runs.forEach((r, i) => {
    if (!r.conclusion || !FAILED.has(r.conclusion) || now - Date.parse(r.created_at) > RUNS_WINDOW_MS) return;
    const resolved = runs.slice(0, i).some((later) => later.name === r.name && later.conclusion === "success");
    out.push({ id: r.id, workflow: (r.name ?? "workflow").slice(0, 60), conclusion: r.conclusion, at: r.created_at, resolved });
  });
  return out.slice(0, 20);
}

/** Once an hour (the first tick of each hour), from the scheduled handler's waitUntil. Never throws. */
export async function refreshRuns(env: Env, scheduledTime: number): Promise<void> {
  if (!env.PULSE || new Date(scheduledTime).getUTCMinutes() >= 10) return;
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "vikrantsingh-fyi-incident-desk", "X-GitHub-Api-Version": "2022-11-28" };
    const token = env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs?per_page=100`, { headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return; // the last good list stays; its "as of" time says how old it is
    const body = (await res.json()) as { workflow_runs?: ApiRun[] };
    if (!Array.isArray(body.workflow_runs)) return;
    const rec: RunsRecord = { checkedAt: new Date().toISOString(), repo: env.GITHUB_REPO, items: failedRuns(body.workflow_runs, Date.now()) };
    await env.PULSE.put(RUNS_KEY, JSON.stringify(rec));
  } catch {
    // Optional, like the feed: the next hour tries again.
  }
}

export async function readRuns(env: Env): Promise<RunsRecord | null> {
  if (!env.PULSE) return null;
  try {
    return await env.PULSE.get<RunsRecord>(RUNS_KEY, "json");
  } catch {
    return null;
  }
}
