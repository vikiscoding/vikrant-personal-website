// Capacity, not failure: the account runs on Cloudflare's Workers Free plan, whose Durable Object allowances
// (100,000 rows written a day, among others) are shared by every Worker on the account and reset at 00:00 UTC.
// When one is used up, storage calls throw. Pages that depend on Durable Objects say so plainly and show when the
// allowance comes back; nothing on the incident path uses Durable Objects, so running out can never raise an incident.

/** True when an error is Cloudflare refusing work because a free-tier allowance is used up. */
export function isCapacity(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /exceeded allowed .*free tier|free tier .*(limit|exceeded)|exceeded .*daily .*limit/i.test(msg);
}

/** When the daily allowances reset: the next 00:00 UTC, in epoch milliseconds. */
export function nextReset(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** "5 h 12 min" until `at`. */
export function untilText(at: number, now = Date.now()): string {
  const mins = Math.max(1, Math.round((at - now) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}
