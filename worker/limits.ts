// What could stop this site (ADR-030): every credential and renewal it depends on, with its expiry read from the
// source wherever possible, and today's use of the free-tier allowances. Shown on /reliability/, served as
// GET /api/limits, and read by the daily limits workflow, which turns it into escalating GitHub issues.
//
// Rules:
// - Detect, don't type. A date is read from the service that issued it (GitHub's response header, Cloudflare's
//   token check, the domain registry). A date nobody can read shows as "Not recorded", never as fine.
// - Never on the measured path. Checks run beside the scheduled job (waitUntil), each with a timeout, and a failed
//   check is shown as "Couldn't check", never as a failed run. Expiries are checked daily; usage every 30 minutes.
// - Only dates, statuses and what breaks are published. Never a token, its prefix or its scopes.
// - Expiring is not an incident (ADR-016) and a used-up allowance is not one either: the workflow opens issues.
// Every new secret, token or renewal gets an entry in ITEMS.
import type { Env } from "./env";
import { nextReset } from "./capacity";

const KEY = "limits";
const CI_KEY = "limits:ci";
const TIMEOUT_MS = 5_000;
const EXPIRY_EVERY_MS = 24 * 3_600_000;
const USAGE_EVERY_MS = 30 * 60_000;
/** A check older than this means the checker itself has stopped: shown as "Couldn't check", not as the old answer. */
const STALE_MS = 3 * 24 * 3_600_000;
const UA = { "user-agent": "vikrantsingh.fyi limits check" };

type Source = "registry" | "github" | "cloudflare" | "ci";
interface Item {
  id: string;
  label: string;
  /** What stops if it lapses, in plain words. */
  breaks: string;
  source: Source;
}

/** The list itself is the commitment: a dependency that expires and is not here is the real miss. */
export const ITEMS: Item[] = [
  { id: "domain", label: "Domain vikrantsingh.fyi", breaks: "The site goes offline.", source: "registry" },
  { id: "github_token", label: "GitHub token (scheduled job)", breaks: "Every run fails; the heartbeat goes stale and the outside monitor alerts.", source: "github" },
  { id: "dispatch_token", label: "Incident desk token", breaks: "Real failures stop reaching the incident desk (the outside monitor still alerts).", source: "github" },
  { id: "observability_token", label: "Log backfill token", breaks: "Readings missed in an outage wait instead of being rebuilt.", source: "cloudflare" },
  { id: "analytics_token", label: "Usage feed token", breaks: "The allowance figures below stop updating.", source: "cloudflare" },
  { id: "ci_token", label: "Cloudflare deploy token", breaks: "Deploys fail; the live site keeps running.", source: "ci" },
];

const SOURCE_TEXT: Record<Source, string> = {
  registry: "domain registry",
  github: "read from GitHub",
  cloudflare: "read from Cloudflare",
  ci: "reported by the deploy pipeline",
};

/** Cloudflare Workers Free plan, per day, reset at 00:00 UTC; shared by every Worker on the account. */
const ALLOWANCES = [
  { id: "do_rows_written", label: "Database rows written", limit: 100_000 },
  { id: "do_rows_read", label: "Database rows read", limit: 5_000_000 },
  { id: "do_requests", label: "Database requests", limit: 100_000 },
  { id: "worker_requests", label: "Site requests", limit: 100_000 },
  { id: "kv_writes", label: "Status store writes", limit: 1_000 },
] as const;

interface Checked {
  id: string;
  /** ISO date, or null when none could be read. */
  expiresAt: string | null;
  /** The issuer says this never expires. */
  noExpiry?: boolean;
  /** Why the check could not be made. */
  error?: string;
  checkedAt: string;
}
interface UsageRow {
  id: string;
  used: number;
}
interface Record_ {
  expiries: Checked[];
  expiriesAt: string | null;
  usage: UsageRow[] | null;
  usageAt: string | null;
  usageError?: string;
}
/** What the deploy pipeline reports about its own token (POST /api/limits/ci). */
interface CiReport {
  expiresAt: string | null;
  noExpiry: boolean;
  checkedAt: string;
  /**
   * The domain's expiry as the pipeline read it from the registry. The registries rate-limit Cloudflare's shared
   * addresses (429 from both, 4 Oct 2026), so the Worker's own lookup can fail where GitHub's runners succeed.
   */
  domainExpiresAt?: string | null;
}

async function timed(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}
const isoOrNull = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** GitHub answers "2027-08-30 00:00:00 UTC" or "2027-08-30 00:00:00 -0700" in github-authentication-token-expiration. */
export function parseGithubExpiry(h: string | null): string | null {
  if (!h) return null;
  const s = h.trim().replace(" ", "T").replace(/ UTC$/, "Z").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2");
  return isoOrNull(s);
}

/**
 * The .fyi registry's own RDAP service (IANA's bootstrap list, data.iana.org/rdap/dns.json), with rdap.org as the
 * fallback. rdap.org is a shared redirector that rate-limits Cloudflare's shared addresses (429, 4 Oct 2026).
 */
const RDAP = ["https://rdap.identitydigital.services/rdap/domain/vikrantsingh.fyi", "https://rdap.org/domain/vikrantsingh.fyi"];

async function checkDomain(): Promise<Omit<Checked, "id" | "checkedAt">> {
  let res: Response | null = null;
  const refused: string[] = [];
  for (const url of RDAP) {
    res = await timed(url, { headers: { accept: "application/rdap+json", ...UA } }).catch(() => null);
    if (res?.ok) break;
    refused.push(`${new URL(url).hostname} ${res ? `http ${res.status}` : "unreachable"}`);
  }
  if (!res?.ok) return { expiresAt: null, error: refused.join(", ") };
  const body = (await res.json()) as { events?: { eventAction?: string; eventDate?: string }[] };
  const exp = isoOrNull(body.events?.find((e) => e.eventAction === "expiration")?.eventDate);
  return exp ? { expiresAt: exp } : { expiresAt: null, error: "registry gave no expiry" };
}

async function checkGithub(token: string | undefined, repo: string | undefined): Promise<Omit<Checked, "id" | "checkedAt">> {
  if (!token || !repo) return { expiresAt: null, error: "not set" };
  const res = await timed(`https://api.github.com/repos/${repo}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", ...UA } });
  if (res.status === 401) return { expiresAt: null, error: "rejected by GitHub (expired or revoked)" };
  if (!res.ok) return { expiresAt: null, error: `github http ${res.status}` };
  const exp = parseGithubExpiry(res.headers.get("github-authentication-token-expiration"));
  return exp ? { expiresAt: exp } : { expiresAt: null, noExpiry: true };
}

/** Cloudflare's own token check; user-owned tokens and account-owned tokens answer at different paths. */
export async function checkCloudflare(token: string | undefined, account: string | undefined): Promise<Omit<Checked, "id" | "checkedAt">> {
  if (!token) return { expiresAt: null, error: "not set" };
  const paths = ["https://api.cloudflare.com/client/v4/user/tokens/verify"];
  if (account) paths.push(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`);
  let last = 0;
  for (const p of paths) {
    const res = await timed(p, { headers: { authorization: `Bearer ${token}`, ...UA } });
    last = res.status;
    if (!res.ok) continue;
    const body = (await res.json()) as { result?: { status?: string; expires_on?: string } };
    if (body.result?.status && body.result.status !== "active") return { expiresAt: null, error: `token ${body.result.status}` };
    const exp = isoOrNull(body.result?.expires_on);
    return exp ? { expiresAt: exp } : { expiresAt: null, noExpiry: true };
  }
  return { expiresAt: null, error: `cloudflare http ${last}` };
}

/** Only these, when given: a retry re-checks what failed, not everything (the registry rate-limits, 4 Oct 2026). */
async function checkExpiries(env: Env, only?: Set<string>): Promise<Checked[]> {
  const at = new Date().toISOString();
  const run = async (id: string, f: () => Promise<Omit<Checked, "id" | "checkedAt">>): Promise<Checked> => {
    try {
      return { id, ...(await f()), checkedAt: at };
    } catch (e) {
      return { id, expiresAt: null, error: e instanceof Error ? e.name : "check failed", checkedAt: at };
    }
  };
  const checks: [string, () => Promise<Omit<Checked, "id" | "checkedAt">>][] = [
    ["domain", checkDomain],
    ["github_token", () => checkGithub(env.GITHUB_TOKEN, env.GITHUB_REPO)],
    ["dispatch_token", () => checkGithub(env.INCIDENTS_DISPATCH_TOKEN, env.INCIDENTS_REPO)],
    ["observability_token", () => checkCloudflare(env.CF_OBSERVABILITY_TOKEN, env.CF_ACCOUNT_ID)],
    ["analytics_token", () => checkCloudflare(env.CF_ANALYTICS_TOKEN, env.CF_ACCOUNT_ID)],
  ];
  return Promise.all(checks.filter(([id]) => !only || only.has(id)).map(([id, f]) => run(id, f)));
}

/** An issuer that was busy or slow, as opposed to an answer about the token itself (not set, rejected, revoked). */
const TRANSIENT = /http (429|5\d\d)|Timeout|Abort|check failed/i;

/**
 * Fold new results into the old. A transient error never replaces a good reading: the last good date stays, with
 * its own checked time, so it still turns "Couldn't check" once it is over 3 days old (STALE_MS). An answer about the
 * token itself (not set, rejected) always replaces it.
 */
export function mergeChecks(prev: Checked[], next: Checked[], now = Date.now()): Checked[] {
  const out = new Map(prev.map((c) => [c.id, c]));
  for (const c of next) {
    const old = out.get(c.id);
    const keepOld = c.error && TRANSIENT.test(c.error) && old && !old.error && now - Date.parse(old.checkedAt) <= STALE_MS;
    if (!keepOld) out.set(c.id, c);
  }
  return [...out.values()];
}

/** Today's (UTC) use of each daily allowance, for the whole account, from Cloudflare's analytics. */
async function readUsage(env: Env): Promise<UsageRow[]> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) throw new Error("not connected");
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const query = `query($a:String!,$d:Date!,$f:Time!,$t:Time!){viewer{accounts(filter:{accountTag:$a}){
    rows: durableObjectsPeriodicGroups(limit:1000, filter:{datetimeMinute_geq:$f, datetimeMinute_leq:$t}){ sum{ rowsWritten rowsRead } }
    doReq: durableObjectsInvocationsAdaptiveGroups(limit:1000, filter:{date:$d}){ sum{ requests } }
    workers: workersInvocationsAdaptive(limit:1000, filter:{date:$d}){ sum{ requests } }
    kv: kvOperationsAdaptiveGroups(limit:1000, filter:{date:$d, actionType:"write"}){ sum{ requests } }
  }}}`;
  const res = await timed("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "application/json", ...UA },
    body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, d: day, f: `${day}T00:00:00Z`, t: now.toISOString() } }),
  });
  if (!res.ok) throw new Error(`analytics http ${res.status}`);
  type Sum<K extends string> = { sum: Record<K, number> }[];
  const body = (await res.json()) as {
    errors?: { message: string }[];
    data?: { viewer?: { accounts?: { rows: Sum<"rowsWritten" | "rowsRead">; doReq: Sum<"requests">; workers: Sum<"requests">; kv: Sum<"requests"> }[] } };
  };
  if (body.errors?.length) throw new Error(body.errors[0]!.message.slice(0, 80));
  const a = body.data?.viewer?.accounts?.[0];
  if (!a) throw new Error("no account data");
  const total = <K extends string>(g: Sum<K>, k: K) => g.reduce((n, x) => n + (x.sum[k] ?? 0), 0);
  return [
    { id: "do_rows_written", used: total(a.rows, "rowsWritten") },
    { id: "do_rows_read", used: total(a.rows, "rowsRead") },
    { id: "do_requests", used: total(a.doReq, "requests") },
    { id: "worker_requests", used: total(a.workers, "requests") },
    { id: "kv_writes", used: total(a.kv, "requests") },
  ];
}

/** Called beside every scheduled run. Does work only when a check is due; one KV write at most. Never throws. */
export async function refreshLimits(env: Env): Promise<void> {
  if (!env.PULSE) return;
  try {
    const now = Date.now();
    const rec = (await env.PULSE.get<Record_>(KEY, "json")) ?? { expiries: [], expiriesAt: null, usage: null, usageAt: null };
    // Everything is checked daily. A check that failed (a token not set yet, an issuer that didn't answer) is retried
    // on its own every 30 minutes, so a fix shows within half an hour without re-asking the issuers that answered.
    const fullDue = !rec.expiriesAt || now - Date.parse(rec.expiriesAt) >= EXPIRY_EVERY_MS;
    const retry = new Set(rec.expiries.filter((c) => c.error && now - Date.parse(c.checkedAt) >= USAGE_EVERY_MS - 60_000).map((c) => c.id));
    const expiriesDue = fullDue || retry.size > 0;
    // The day's figures restart at 00:00 UTC: refresh then too, so the card never shows yesterday's total as today's.
    const newDay = rec.usageAt !== null && rec.usageAt.slice(0, 10) !== new Date(now).toISOString().slice(0, 10);
    const usageDue = !rec.usageAt || now - Date.parse(rec.usageAt) >= USAGE_EVERY_MS - 60_000 || newDay;
    if (!expiriesDue && !usageDue) return;
    if (expiriesDue) {
      rec.expiries = mergeChecks(rec.expiries, await checkExpiries(env, fullDue ? undefined : retry), now);
      if (fullDue) rec.expiriesAt = new Date().toISOString();
    }
    if (usageDue) {
      try {
        rec.usage = await readUsage(env);
        rec.usageError = undefined;
      } catch (e) {
        rec.usage = null;
        rec.usageError = e instanceof Error ? e.message : "usage failed";
      }
      rec.usageAt = new Date().toISOString();
    }
    await env.PULSE.put(KEY, JSON.stringify(rec));
  } catch (e) {
    console.error(JSON.stringify({ v: 2, ts: new Date().toISOString(), op: "limits", outcome: "error", detail: (e instanceof Error ? e.message : "refresh failed").slice(0, 160) }));
  }
}

export type ExpiryStatus = "ok" | "due" | "urgent" | "expired" | "missing" | "unchecked" | "none";
export interface ExpiryView {
  id: string;
  label: string;
  breaks: string;
  source: string;
  expires_at: string | null;
  days_left: number | null;
  status: ExpiryStatus;
  /** Plain words for the status, as the page prints them. */
  status_text: string;
  checked_at: string | null;
}
export interface UsageView {
  id: string;
  label: string;
  used: number;
  limit: number;
  share: number;
}
export interface LimitsView {
  generated_at: string;
  expiries: ExpiryView[];
  usage: { as_of: string; resets_at: string; items: UsageView[] } | null;
  usage_note: string | null;
}

/** Days until a date, by whole days from now (negative once it has passed). */
const daysUntil = (iso: string, now: number) => Math.floor((Date.parse(iso) - now) / 86_400_000);

export function expiryStatus(c: Checked | undefined, now: number): Pick<ExpiryView, "status" | "status_text" | "days_left"> {
  if (!c) return { status: "missing", status_text: "Not recorded: owner to add", days_left: null };
  if (now - Date.parse(c.checkedAt) > STALE_MS) return { status: "unchecked", status_text: "Couldn't check: the last check is over 3 days old", days_left: null };
  if (c.error) return { status: "unchecked", status_text: `Couldn't check: ${c.error}`, days_left: null };
  if (!c.expiresAt) return c.noExpiry ? { status: "none", status_text: "No expiry set", days_left: null } : { status: "missing", status_text: "Not recorded: owner to add", days_left: null };
  const d = daysUntil(c.expiresAt, now);
  if (d < 0) return { status: "expired", status_text: `Expired ${-d} day${d === -1 ? "" : "s"} ago`, days_left: d };
  if (d <= 30) return { status: "urgent", status_text: `Renew now: ${d} day${d === 1 ? "" : "s"} left`, days_left: d };
  if (d <= 90) return { status: "due", status_text: `Renew soon: ${d} days left`, days_left: d };
  return { status: "ok", status_text: `OK: ${d} days left`, days_left: d };
}

/** The public view: what the page shows and the workflow reads. Degrades to "Not recorded" rows; never throws. */
export async function readLimits(env: Env, now = Date.now()): Promise<LimitsView> {
  let rec: Record_ | null = null;
  let ci: CiReport | null = null;
  try {
    [rec, ci] = env.PULSE ? await Promise.all([env.PULSE.get<Record_>(KEY, "json"), env.PULSE.get<CiReport>(CI_KEY, "json")]) : [null, null];
  } catch {
    // The status store is unreadable: every row says it could not be checked, which is the truth.
  }
  const checked = new Map((rec?.expiries ?? []).map((c) => [c.id, c]));
  if (ci) checked.set("ci_token", { id: "ci_token", expiresAt: ci.expiresAt, noExpiry: ci.noExpiry, checkedAt: ci.checkedAt });
  // The Worker's own domain lookup wins when it works; when it can't, the pipeline's daily reading stands in.
  const own = checked.get("domain");
  const viaCi = !!ci?.domainExpiresAt && (!own || !!own.error);
  if (viaCi) checked.set("domain", { id: "domain", expiresAt: ci!.domainExpiresAt!, checkedAt: ci!.checkedAt });
  const expiries = ITEMS.map((it) => {
    const c = checked.get(it.id);
    const s = it.id === "ci_token" && !c ? { status: "missing" as const, status_text: "Not reported yet: the deploy pipeline reports it daily", days_left: null } : expiryStatus(c, now);
    const source = it.id === "domain" && viaCi ? "domain registry, read by the deploy pipeline" : SOURCE_TEXT[it.source];
    return { id: it.id, label: it.label, breaks: it.breaks, source, expires_at: c?.expiresAt ?? null, checked_at: c?.checkedAt ?? null, ...s };
  });
  const usage =
    rec?.usage && rec.usageAt && rec.usageAt.slice(0, 10) === new Date(now).toISOString().slice(0, 10)
      ? {
          as_of: rec.usageAt,
          resets_at: new Date(nextReset()).toISOString(),
          items: ALLOWANCES.map((a) => {
            const used = rec!.usage!.find((u) => u.id === a.id)?.used ?? 0;
            return { id: a.id, label: a.label, used, limit: a.limit, share: used / a.limit };
          }),
        }
      : null;
  const usage_note = usage
    ? null
    : rec?.usageError === "not connected" || !env.CF_ANALYTICS_TOKEN
      ? "Not connected yet: the usage feed needs a read-only analytics token."
      : rec?.usageError
        ? `Couldn't read today's figures: ${rec.usageError}.`
        : "No reading yet today.";
  return { generated_at: new Date(now).toISOString(), expiries, usage, usage_note };
}

export async function limitsApi(request: Request, env: Env): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const url = new URL(request.url);
  if (url.pathname === "/api/limits" && request.method === "GET") return json(await readLimits(env));
  if (url.pathname === "/api/limits/ci" && request.method === "POST") return ciReport(request, env, json);
  return json({ error: "not_found" }, 404);
}

/**
 * The deploy pipeline's report of its own Cloudflare token (ADR-030). Not a public write path: it needs the shared
 * LIMITS_REPORT_TOKEN (set in the Cloudflare and GitHub dashboards), takes one tiny, fully validated body and stores
 * only a date. Without the secret configured it refuses everything.
 */
async function ciReport(request: Request, env: Env, json: (b: unknown, s?: number) => Response): Promise<Response> {
  // 403, not 5xx: only /api/pulse and /api/slo may fail on purpose (AGENTS.md, Degrade open).
  if (!env.LIMITS_REPORT_TOKEN || !env.PULSE) return json({ error: "not_configured" }, 403);
  const auth = request.headers.get("authorization") ?? "";
  const given = new TextEncoder().encode(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  const want = new TextEncoder().encode(env.LIMITS_REPORT_TOKEN);
  if (given.byteLength !== want.byteLength || !crypto.subtle.timingSafeEqual(given, want)) return json({ error: "unauthorized" }, 401);
  const raw = await request.text();
  if (raw.length > 256) return json({ error: "too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const b = body as { expires_at?: unknown; no_expiry?: unknown; domain_expires_at?: unknown };
  const badDomain = b.domain_expires_at !== undefined && b.domain_expires_at !== null && isoOrNull(b.domain_expires_at) === null;
  if (!body || typeof body !== "object" || typeof b.no_expiry !== "boolean" || (b.expires_at !== null && isoOrNull(b.expires_at) === null) || badDomain) {
    return json({ error: "bad_body" }, 400);
  }
  const report: CiReport = {
    expiresAt: b.expires_at === null ? null : isoOrNull(b.expires_at),
    noExpiry: b.no_expiry,
    checkedAt: new Date().toISOString(),
    domainExpiresAt: isoOrNull(b.domain_expires_at),
  };
  await env.PULSE.put(CI_KEY, JSON.stringify(report));
  return new Response(null, { status: 204 });
}
