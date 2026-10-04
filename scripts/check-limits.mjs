// Daily limits check (ADR-030), run by .github/workflows/limits.yml. Turns the site's own view of what could stop it
// (GET /api/limits, the same data /reliability/ shows) into one GitHub issue per item, escalating as a date nears:
// 90 days P3, 60 days P2, 30 days P1, expired P0; "not recorded" or "couldn't check" P3. One issue per item, a new
// comment only when it gets more urgent, closed by the check itself once fixed. Never an incident (ADR-016).
// Also checks the deploy pipeline's own Cloudflare token, which only CI holds, and reports its expiry to the site.
// No packages: Node 24's fetch. `--dry-run` prints what it would do and changes nothing.
const DRY = process.argv.includes("--dry-run");
const SITE = process.env.SITE ?? "https://vikrantsingh.fyi";
const REPO = process.env.GITHUB_REPOSITORY ?? "vikiscoding/vikrant-personal-website";
const OWNER = process.env.GITHUB_REPOSITORY_OWNER ?? REPO.split("/")[0];
const GH = process.env.GITHUB_TOKEN;
const RUNBOOK = `https://github.com/${REPO}/blob/main/docs/runbook.md#renewals-and-expiries`;

const LEVELS = ["P0", "P1", "P2", "P3"];
const COLOURS = { P0: "b60205", P1: "d93f0b", P2: "fbca04", P3: "c5def5", limits: "5319e7" };

/** The issue level an item needs today, or null when it needs none. */
function levelFor(e) {
  switch (e.status) {
    case "expired":
      return "P0";
    case "urgent":
      return "P1";
    case "due":
      return e.days_left !== null && e.days_left <= 60 ? "P2" : "P3";
    case "missing":
    case "unchecked":
      return "P3";
    default:
      return null; // ok, or no expiry set
  }
}

async function verifyCloudflare(token, account) {
  const paths = ["https://api.cloudflare.com/client/v4/user/tokens/verify"];
  if (account) paths.push(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`);
  for (const p of paths) {
    const r = await fetch(p, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) continue;
    const b = await r.json();
    const exp = b.result?.expires_on ?? null;
    return { expires_at: exp ? new Date(exp).toISOString() : null, no_expiry: !exp };
  }
  return null;
}

async function gh(method, path, body) {
  if (DRY && method !== "GET") {
    console.log(`  [dry run] ${method} ${path}${body ? ` ${JSON.stringify(body).slice(0, 160)}` : ""}`);
    return {};
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: { authorization: `Bearer ${GH}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "limits-check" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && !(method === "POST" && path === "/labels" && r.status === 422)) throw new Error(`GitHub ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? {} : r.json().catch(() => ({}));
}

const bodyFor = (e, level) =>
  [
    `**${e.label}**: ${e.status_text}.`,
    e.expires_at ? `Expires: ${e.expires_at.slice(0, 10)} (${e.source}).` : `Source: ${e.source}.`,
    `If it lapses: ${e.breaks}`,
    "",
    `Priority **${level}** (90 days P3, 60 days P2, 30 days P1, expired P0). Renewal steps: ${RUNBOOK}`,
    `This issue escalates and closes on its own: the daily limits check reads ${SITE}/api/limits, the same data as ${SITE}/reliability/#limits.`,
  ].join("\n");

async function main() {
  // 1. The deploy pipeline's own token: only CI holds it, so CI checks it and tells the site.
  const cf = process.env.CLOUDFLARE_API_TOKEN;
  if (cf) {
    const ci = await verifyCloudflare(cf, process.env.CF_ACCOUNT_ID);
    console.log(`Cloudflare deploy token: ${ci ? (ci.expires_at ?? "no expiry set") : "could not verify"}`);
    if (ci && process.env.LIMITS_REPORT_TOKEN && !DRY) {
      const r = await fetch(`${SITE}/api/limits/ci`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.LIMITS_REPORT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(ci),
      });
      console.log(`Reported to the site: ${r.status}`);
      if (r.status !== 204) console.log(`  ${await r.text()}`);
    } else if (!process.env.LIMITS_REPORT_TOKEN) {
      console.log("LIMITS_REPORT_TOKEN is not set: the site will show the deploy token as not reported.");
    }
  }

  // 2. What the site says could stop it.
  const res = await fetch(`${SITE}/api/limits`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${SITE}/api/limits answered ${res.status}`);
  const view = await res.json();

  // 3. One issue per item, escalating.
  if (!GH) throw new Error("GITHUB_TOKEN is not set");
  for (const name of ["limits", ...LEVELS]) await gh("POST", "/labels", { name, color: COLOURS[name] });
  const open = await gh("GET", "/issues?labels=limits&state=open&per_page=100");
  for (const e of view.expiries) {
    const level = levelFor(e);
    const title = `Limits: ${e.label}`;
    const issue = (Array.isArray(open) ? open : []).find((i) => i.title === title);
    const had = issue?.labels?.map((l) => l.name).find((n) => LEVELS.includes(n)) ?? null;
    console.log(`${e.label}: ${e.status_text} -> ${level ?? "no issue"}${issue ? ` (open #${issue.number}, ${had})` : ""}`);
    if (level && !issue) {
      await gh("POST", "/issues", { title, body: bodyFor(e, level), labels: ["limits", level], assignees: [OWNER] });
    } else if (level && issue && had !== level) {
      await gh("PUT", `/issues/${issue.number}/labels`, { labels: ["limits", level] });
      // A comment re-notifies; only when it gets more urgent, so a calm item never nags daily.
      if (!had || LEVELS.indexOf(level) < LEVELS.indexOf(had)) await gh("POST", `/issues/${issue.number}/comments`, { body: `Now **${level}**: ${e.status_text}.` });
    } else if (!level && issue) {
      await gh("POST", `/issues/${issue.number}/comments`, { body: `Resolved: ${e.status_text}. Closing.` });
      await gh("PATCH", `/issues/${issue.number}`, { state: "closed" });
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
