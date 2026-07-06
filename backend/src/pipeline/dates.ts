// Timezone-correct date helpers. The v1 pipeline used
// `new Date().toISOString().split('T')[0]` for "today", which is UTC — wrong
// for Europe/London between midnight and 1am BST. Everything here works on
// date-only strings (YYYY-MM-DD) and named IANA zones; arithmetic on
// date-only values is done via Date.UTC, which never crosses a DST boundary.

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Today's date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Add n days to a YYYY-MM-DD date string. Pure calendar arithmetic — no timezone involved. */
export function addDays(ymd: string, n: number): string {
  assertYmd(ymd);
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Compare two YYYY-MM-DD strings. Negative if a < b. */
export function compareYmd(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isValidYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !YMD.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isValidHm(s: unknown): s is string {
  return typeof s === 'string' && HM.test(s);
}

function assertYmd(s: string): void {
  if (!isValidYmd(s)) throw new Error(`Invalid date: ${s}`);
}
