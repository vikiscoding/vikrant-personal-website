// Site time (ADR-014): Toronto, EDT/EST switched automatically by the IANA zone. Machine data (/api/slo `ts`) stays UTC.
export const SITE_TZ = "America/Toronto";

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const zoneFmt = new Intl.DateTimeFormat("en-US", { timeZone: SITE_TZ, timeZoneName: "short" });

/** Toronto calendar date, "YYYY-MM-DD". The ledger's day boundary. */
export function localDay(t: string | number | Date = Date.now()): string {
  return dayFmt.format(new Date(t));
}

/** Shift a "YYYY-MM-DD" date by whole days. Pure calendar math, so DST days (23 h / 25 h) never skip or repeat a date. */
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** "2026-09-30 16:21 EDT" (or EST in winter). */
export function localStamp(t: string | number | Date): string {
  const d = new Date(t);
  const zone = zoneFmt.formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "ET";
  return `${dayFmt.format(d)} ${timeFmt.format(d)} ${zone}`;
}
