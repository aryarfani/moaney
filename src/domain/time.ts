// Asia/Jakarta has no DST, so a fixed +07:00 offset is exact.
const OFFSET_MS = 7 * 3600_000;

export function jakartaNow(date = new Date()): string {
  return new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 19) + '+07:00';
}

export function today(date = new Date()): string {
  return jakartaNow(date).slice(0, 10);
}

/** Accepts YYYY-MM-DD, YYYY-MM-DD[T ]HH:mm[:ss] (optionally +07:00) and normalises. */
export function normaliseOccurredAt(input: string | undefined | null, fallback = jakartaNow()): string {
  if (!input) return fallback;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\+07:00)?$/.exec(input.trim());
  if (!m) throw new Error(`Bad date: ${input}`);
  const [, d, hh = '00', mm = '00', ss = '00'] = m;
  const check = new Date(`${d}T${hh}:${mm}:${ss}Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== d) throw new Error(`Bad date: ${input}`);
  return `${d}T${hh}:${mm}:${ss}+07:00`;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

/** Same day-of-month one month earlier, clamped to that month's length. */
export function sameDayLastMonth(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const dim = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return `${py}-${String(pm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}
