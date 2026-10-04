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
  const card = (label) => html.match(new RegExp(`${label}[\\s\\S]*?<strong>([\\d,]+) left</strong>`))[1];
  assert.match(html, new RegExp(`Heartbeat freshness: ${card("Heartbeat freshness")} of 86 failures left`));
  assert.match(html, new RegExp(`Scheduled job success: ${card("Scheduled job success")} of 86 failures left`));
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
  assert.match(html, /Scheduled job success: overspent by 14 of 86/);
});

// The budget bar shows what is left, the way its caption reads.
check("the budget bar fills with what is left", () => {
  const now = Date.parse("2026-11-10T16:00:00Z");
  const html = render(window(now, 30, (i, s) => (s === "pulse" && i === 1 ? 22 : 0)), now); // 22 of 86 used: 64 left
  assert.match(html, /aria-label="Error budget 74% left"><span style="width:74%">/);
});

console.log(`${passed} dashboard checks passed`);
