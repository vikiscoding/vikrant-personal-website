// Checks for the server-rendered /reliability/ dashboard (worker/dashboard.ts), run by `npm run check` and CI.
// No test framework or new package: Node 24 runs the Worker's TypeScript directly. The hooks below only stub the
// one Workers-only import and resolve the Worker's extensionless imports, so the real rendering code is what runs.
// Each check is a promise the page makes in its copy or an ADR; the comment names it.
import assert from "node:assert/strict";
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(spec, ctx, next) {
  if (spec === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
  if (/^\\.\\.?\\//.test(spec) && !/\\.\\w+$/.test(spec) && ctx.parentURL) {
    const u = new URL(spec + ".ts", ctx.parentURL);
    if (existsSync(fileURLToPath(u))) return { url: u.href, shortCircuit: true };
  }
  return next(spec, ctx);
}`),
);

const { renderDashboard } = await import("../worker/dashboard.ts");
const { addDays, localDay } = await import("../worker/time.ts");

const row = (day, source, bad) => {
  const total = source === "pulse" ? 288 : 144;
  return { day, source, total, good: total - bad, bad, slow_good: 0, overflow: 0, p50_ms: 50, p95_ms: 100, max_ms: 200 };
};
/** A window whose first recorded day is `firstBack` days before `now`, with `bad` failures per day and source. */
function window(now, firstBack, bad = () => 0, skip = new Set()) {
  const today = localDay(now);
  const days = [];
  for (let i = firstBack; i >= 0; i--) {
    if (skip.has(i)) continue;
    days.push(row(addDays(today, -i), "pulse", bad(i, "pulse")), row(addDays(today, -i), "ticker", bad(i, "ticker")));
  }
  const keep = new Set(Array.from({ length: 30 }, (_, i) => addDays(today, -i)));
  const sum = (s) => {
    const r = days.filter((d) => d.source === s && keep.has(d.day));
    const total = r.reduce((a, b) => a + b.total, 0);
    const good = r.reduce((a, b) => a + b.good, 0);
    return { source: s, total, good, bad: total - good, sli: total ? good / total : null, target: null, budget_left: null, days_with_data: r.length };
  };
  const game = { sessions: 0, played: 0, errors: 0, jank: 0, p95_frame: null, finished: 0 };
  return { generated_at: new Date(now).toISOString(), window_days: 30, summary: [sum("pulse"), sum("ticker")], days, events: [], game };
}
const render = (win, now) => renderDashboard(win, null, null, null, now);
const hasChart = (html) => html.includes('class="dash-burn"');
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// No claim ahead of evidence: the burn-down appears on the day the collecting banner names (first recorded day + 30),
// at local midnight in Toronto (ADR-014), and not a minute before.
check("burn-down hidden before the first full window, shown from its first day", () => {
  const before = Date.parse("2026-10-30T03:59:00Z"); // 29 Oct, 23:59 EDT
  const after = Date.parse("2026-10-30T04:01:00Z"); // 30 Oct, 00:01 EDT
  const first = (now) => {
    const w = window(now, 0);
    w.days.unshift(row("2026-09-30", "pulse", 0));
    return w;
  };
  assert.equal(hasChart(render(first(before), before)), false);
  assert.equal(hasChart(render(first(after), after)), true);
});

// By age, not by days with data: one empty day must not hold the chart back.
check("a day without data does not delay the burn-down", () => {
  const now = Date.parse("2026-11-10T16:00:00Z");
  assert.equal(hasChart(render(window(now, 30, undefined, new Set([12])), now)), true);
});

// The chart and the SLO cards are drawn from the same records, so they must never disagree.
check("burn-down figures match the SLO cards", () => {
  const now = Date.parse("2026-11-10T16:00:00Z");
  const html = render(window(now, 30, (i, s) => (s === "pulse" ? (i % 5 === 0 ? 2 : 0) : i % 7 === 0 ? 1 : 0)), now);
  const re = (s) => s.replace(/[()]/g, "\\$&");
  const card = (label) => html.match(new RegExp(`${re(label)}[\\s\\S]*?<strong>([\\d,]+) left</strong>`))[1];
  for (const label of ["Availability (outside probe)", "Cron job success (GitHub sync)"]) {
    assert.match(html, new RegExp(`${re(label)}: ${card(label)} of 86 failures left`));
  }
});

// A missing day breaks the line instead of joining across it.
check("a day without data breaks the line", () => {
  const now = Date.parse("2026-11-10T16:00:00Z");
  const html = render(window(now, 30, undefined, new Set([12])), now);
  const d = html.match(/<path d="([^"]*)" class="burn-hb"/)[1];
  assert.equal(d.match(/M/g).length, 2);
});

// Overspent is said in words, the bar fills red at full width, and the chart says it too.
check("an overspent budget is stated, not hidden", () => {
  const now = Date.parse("2026-11-10T16:00:00Z");
  const html = render(window(now, 30, (i, s) => (s === "ticker" && i === 3 ? 100 : 0)), now);
  assert.match(html, /Objective missed:/);
  assert.match(html, /aria-label="Error budget overspent"><span style="width:100%">/);
  assert.match(html, /Cron job success \(GitHub sync\): overspent by 14 of 86/);
});

// The budget bar shows what is left, the way its caption reads.
check("the budget bar fills with what is left", () => {
  const now = Date.parse("2026-11-10T16:00:00Z");
  const html = render(window(now, 30, (i, s) => (s === "pulse" && i === 1 ? 22 : 0)), now); // 22 of 86 used: 64 left
  assert.match(html, /aria-label="Error budget 74% left"><span style="width:74%">/);
});

// The failure list shows the latest 10 and always links to the full history; the history groups every failure by day.
const { renderHistory } = await import("../worker/dashboard.ts");
const fail = (ts, source = "ticker", fault = "none") => ({ ts, source, outcome: "error", status: 504, ms: 5000, dep: "github", detail: "TimeoutError", fault });
check("failures: latest 5 shown, the rest counted, full history linked", () => {
  const now = Date.parse("2026-11-10T16:00:00Z");
  const w = window(now, 30);
  w.events = Array.from({ length: 14 }, (_, i) => fail(new Date(now - i * 3_600_000).toISOString()));
  const html = render(w, now);
  const section = html.slice(html.indexOf('id="failures"'), html.indexOf("</section>", html.indexOf('id="failures"')));
  assert.equal((section.match(/<li>/g) ?? []).length, 5);
  assert.match(section, /Showing the latest 5 of 14/);
  assert.match(section, /href="\/reliability\/failures\/"/);
});
check("history: every site failure, grouped by Toronto day, game days counted, games' records left out", () => {
  const html = renderHistory([
    fail("2026-10-03T22:10:35Z"),
    fail("2026-10-02T05:06:00Z", "pulse", "github_5xx"),
    fail("2026-10-02T04:40:00Z", "ticker", "github_5xx"),
    { ...fail("2026-10-02T04:00:00Z", "ludo_turn"), outcome: "degraded" },
  ], Date.parse("2026-10-04T12:00:00Z"));
  assert.match(html, /3 failures<\/strong> on 2 days/);
  assert.match(html, /2 Oct 2026 <span[^>]*>· 2 failures, 2 on a game day/);
  assert.doesNotMatch(html, /Ludo/);
});

// What could stop this site (ADR-030): the thresholds the page and the reminder issues both depend on.
const { expiryStatus, parseGithubExpiry } = await import("../worker/limits.ts");
check("expiry statuses: 90/30-day thresholds, expired, missing, stale, failed, no expiry", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const at = new Date(now).toISOString();
  const inDays = (d) => new Date(now + d * 86_400_000 + 3_600_000).toISOString();
  const st = (c) => expiryStatus(c && { id: "x", checkedAt: at, ...c }, now).status;
  assert.equal(st({ expiresAt: inDays(91) }), "ok");
  assert.equal(st({ expiresAt: inDays(90) }), "due");
  assert.equal(st({ expiresAt: inDays(31) }), "due");
  assert.equal(st({ expiresAt: inDays(30) }), "urgent");
  assert.equal(st({ expiresAt: inDays(-2) }), "expired");
  assert.equal(st({ expiresAt: null }), "missing"); // nobody could read a date: a risk, never fine
  assert.equal(st(undefined), "missing");
  assert.equal(st({ expiresAt: null, noExpiry: true }), "none");
  assert.equal(st({ expiresAt: null, error: "not set" }), "unchecked");
  // A checker that stopped is not believed: an old "OK" turns into "couldn't check".
  assert.equal(expiryStatus({ id: "x", expiresAt: inDays(200), checkedAt: new Date(now - 4 * 86_400_000).toISOString() }, now).status, "unchecked");
});
const { mergeChecks } = await import("../worker/limits.ts");
check("merge: transient errors keep the last good date, real answers replace it, stale goods expire", () => {
  const now = Date.parse("2026-10-04T22:30:00Z");
  const good = { id: "domain", expiresAt: "2027-09-29T23:31:29.531Z", checkedAt: "2026-10-04T20:30:00Z" };
  const busy = { id: "domain", expiresAt: null, error: "registry http 429", checkedAt: "2026-10-04T22:20:00Z" };
  assert.deepEqual(mergeChecks([good], [busy], now), [good]);
  const unset = { id: "analytics_token", expiresAt: null, error: "not set", checkedAt: "2026-10-04T22:20:00Z" };
  const okTok = { id: "analytics_token", expiresAt: "2027-10-04T00:00:00Z", checkedAt: "2026-10-04T20:30:00Z" };
  assert.deepEqual(mergeChecks([okTok], [unset], now), [unset]);
  const oldGood = { ...good, checkedAt: "2026-09-30T00:00:00Z" };
  assert.deepEqual(mergeChecks([oldGood], [busy], now), [busy]);
  // A retry of one item leaves the others as they were.
  const other = { id: "github_token", expiresAt: "2027-08-30T04:00:00Z", checkedAt: "2026-10-04T20:30:00Z" };
  assert.deepEqual(mergeChecks([busy, other], [good], now).map((c) => c.id).sort(), ["domain", "github_token"]);
});
const { readLimits } = await import("../worker/limits.ts");
{
  const now = Date.parse("2026-10-04T23:45:00Z");
  const kv = (rec, ci) => ({ PULSE: { get: async (k) => (k === "limits" ? rec : k === "limits:ci" ? ci : null) } });
  const rec = (domain) => ({ expiries: [domain], expiriesAt: "2026-10-04T22:20:00Z", usage: null, usageAt: null });
  const ci = { expiresAt: "2028-03-31T23:59:59Z", noExpiry: false, checkedAt: "2026-10-04T23:44:00Z", domainExpiresAt: "2027-09-29T23:31:29.531Z" };
  const failed = { id: "domain", expiresAt: null, error: "rdap.identitydigital.services http 429", checkedAt: "2026-10-04T23:40:00Z" };
  const fine = { id: "domain", expiresAt: "2027-09-29T23:31:29.531Z", checkedAt: "2026-10-04T23:40:00Z" };
  const a = (await readLimits(kv(rec(failed), ci), now)).expiries.find((e) => e.id === "domain");
  assert.equal(a.status, "ok");
  assert.match(a.source, /read by the deploy pipeline/);
  const b = (await readLimits(kv(rec(fine), ci), now)).expiries.find((e) => e.id === "domain");
  assert.equal(b.source, "domain registry");
  const c = (await readLimits(kv(rec(failed), { ...ci, domainExpiresAt: null }), now)).expiries.find((e) => e.id === "domain");
  assert.equal(c.status, "unchecked");
  console.log("ok - domain: the site's own lookup wins; when it fails, the pipeline's reading stands in");
  passed++;
}
{
  // Just after the 00:00 UTC reset: the page says why the figures are near zero, and shows yesterday's totals.
  const now = Date.parse("2026-10-05T00:05:00Z");
  const kv = { PULSE: { get: async (k) => (k === "limits" ? {
    expiries: [], expiriesAt: "2026-10-04T23:40:00Z", usageAt: "2026-10-05T00:00:03Z",
    usage: [{ id: "do_rows_written", used: 0 }],
    yesterday: { day: "2026-10-04", usage: [{ id: "do_rows_written", used: 12_400 }, { id: "kv_writes", used: 310 }] },
  } : null) }, CF_ANALYTICS_TOKEN: "x" };
  const v = await readLimits(kv, now);
  assert.equal(v.usage.new_day, true);
  assert.equal(v.yesterday.day, "2026-10-04");
  const html = render({ ...window(now, 30) }, now).replace(/x/, "x"); // dashboard without limits: unaffected
  assert.doesNotMatch(html, /A new day began/);
  const { renderDashboard: rd } = await import("../worker/dashboard.ts");
  const withLimits = rd(window(now, 30), null, null, null, now, null, null, v);
  assert.match(withLimits, /A new day began at 20:00/);
  assert.match(withLimits, /Yesterday \(UTC day 2026-10-04\): database rows written 12,400 \(12%\)/);
  console.log("ok - after the daily reset: the page explains the zeros and shows yesterday's totals");
  passed++;
}
// Low-priority tickets on the incident desk (ADR-031): only the workflow's own issues are accepted, the link is built
// by the site, and tickets are counted apart from incidents.
const { parseTickets } = await import("../worker/limits.ts");
const ticket = (o = {}) => ({ number: 4, title: "Limits: Domain vikrantsingh.fyi", level: "P3", state: "closed", opened_at: "2026-10-08T19:17:22Z", closed_at: "2026-10-09T18:49:45Z", ...o });
check("tickets: the report is checked field by field", () => {
  assert.equal(parseTickets([ticket()]).length, 1);
  assert.equal(parseTickets([]).length, 0);
  assert.equal(parseTickets([ticket({ title: "Anything else" })]), null);
  assert.equal(parseTickets([ticket({ title: "Limits: <script>" })]), null);
  assert.equal(parseTickets([ticket({ level: "P9" })]), null);
  assert.equal(parseTickets([ticket({ state: "open" })]), null); // open with a closed date
  assert.equal(parseTickets([ticket({ number: 1.5 })]), null);
  assert.equal(parseTickets(Array.from({ length: 11 }, () => ticket())), null);
  assert.equal(parseTickets("x"), null);
});
{
  const now = Date.parse("2026-10-09T20:00:00Z");
  const tix = { reportedAt: "2026-10-09T18:50:00Z", items: [ticket({ number: 5, title: "Limits: Usage feed token", state: "open", closed_at: null }), ticket()] };
  const kv = { GITHUB_REPO: "o/r", PULSE: { get: async (k) => (k === "limits:tickets" ? tix : null) } };
  const v = await readLimits(kv, now);
  assert.equal(v.tickets.items[1].url, "https://github.com/o/r/issues/4");
  const feed = { generated_at: "x", repo: "o/e", incidents: [{ id: "i", title: "t", state: "CLOSED", priority: "Low", created_at: "2026-10-01T00:00:00Z", updated_at: "", triage: null, gate: "g", drafts_unsent: 0, recovered_at: null, issue_url: null, timeline: [] }] };
  const html = renderDashboard(window(now, 30), null, feed, null, now, null, null, v);
  assert.match(html, /no open incidents · <a href="#incident-desk">1 open low-priority ticket<\/a>/);
  assert.match(html, /Low-priority tickets/);
  assert.match(html, /OPEN<\/span><span class="dash-badge" data-state="warn">P3<\/span><a href="https:\/\/github.com\/o\/r\/issues\/5">Usage feed token<\/a>/);
  assert.match(html, /1 closed ticket</);
  assert.match(html, /data-state="none">LOW<\/span>/);
  const none = renderDashboard(window(now, 30), null, feed, null, now, null, null, { ...v, tickets: null });
  assert.match(none, /Not reported yet: the daily check/);
  assert.doesNotMatch(none, /low-priority ticket</);
  console.log("ok - tickets: listed on the desk, open first, counted apart from incidents");
  passed++;
}
// Failed workflow runs (ADR-031): failures only, inside 30 days, "fixed" once a later run of the same workflow passed.
const { failedRuns } = await import("../worker/incidents.ts");
{
  const now = Date.parse("2026-10-10T12:00:00Z");
  const run = (id, name, conclusion, daysAgo) => ({ id, name, conclusion, status: "completed", created_at: new Date(now - daysAgo * 86_400_000).toISOString() });
  const runs = [
    run(6, "limits", "failure", 0.1),
    run(5, "ci-cd", "success", 1),
    run(4, "ci-cd", "failure", 2),
    run(3, "ci-cd", "cancelled", 3),
    run(2, "limits", "success", 4),
    run(1, "ci-cd", "timed_out", 40),
  ];
  const f = failedRuns(runs, now);
  assert.deepEqual(f.map((x) => [x.id, x.resolved]), [[6, false], [4, true]]);
  const rec = { checkedAt: new Date(now).toISOString(), repo: "o/r", items: f };
  const html = renderDashboard(window(now, 30), null, null, null, now, null, null, null, rec);
  assert.match(html, /1 open low-priority ticket</);
  assert.match(html, /FAILED<\/span><span class="dash-badge" data-state="none">LOW<\/span><a href="https:\/\/github.com\/o\/r\/actions\/runs\/6">limits<\/a>/);
  assert.match(html, /1 fixed by a later run/);
  assert.match(renderDashboard(window(now, 30), null, null, null, now), /Not read yet: the list is read from GitHub once an hour/);
  console.log("ok - failed workflow runs: failures in the window, fixed by a later pass, counted as low priority");
  passed++;
}
check("GitHub's token-expiry header is read in both of its formats", () => {
  assert.equal(parseGithubExpiry("2027-08-30 00:00:00 UTC"), "2027-08-30T00:00:00.000Z");
  assert.equal(parseGithubExpiry("2027-08-30 00:00:00 -0700"), "2027-08-30T07:00:00.000Z");
  assert.equal(parseGithubExpiry(null), null);
  assert.equal(parseGithubExpiry("soon"), null);
});

console.log(`${passed} dashboard checks passed`);
