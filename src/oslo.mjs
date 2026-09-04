/**
 * Oslo wall-clock helpers.
 *
 * The Lunsjkokkene frontend does its deadline math with plain `new Date()` local-time
 * methods, which is only correct because the people running it happen to sit in Oslo.
 * We don't get to assume that, so everything here is pinned to Europe/Oslo explicitly
 * and returns absolute instants.
 */

const TZ = 'Europe/Oslo';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Oslo wall-clock fields for an instant. */
export function osloParts(instant = new Date()) {
  const p = Object.fromEntries(
    PARTS.formatToParts(instant)
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, Number(x.value)]),
  );
  // Intl can render midnight as hour 24.
  return { y: p.year, m: p.month, d: p.day, hh: p.hour % 24, mi: p.minute, ss: p.second };
}

/** Minutes Oslo is ahead of UTC at the given instant (+60 or +120). */
function osloOffsetMinutes(instant) {
  const { y, m, d, hh, mi, ss } = osloParts(instant);
  const asIfUtc = Date.UTC(y, m - 1, d, hh, mi, ss);
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asIfUtc - whole) / 60000);
}

/**
 * The instant at which the given Oslo wall-clock time occurs.
 * Two passes are enough to settle DST: the first guess picks an offset, the second
 * re-reads the offset at the corrected instant.
 */
export function osloInstant(y, m, d, hh = 0, mi = 0) {
  let ts = Date.UTC(y, m - 1, d, hh, mi);
  for (let i = 0; i < 2; i++) {
    const off = osloOffsetMinutes(new Date(ts));
    ts = Date.UTC(y, m - 1, d, hh, mi) - off * 60000;
  }
  return new Date(ts);
}

/** Today's date in Oslo, as YYYY-MM-DD. */
export function osloToday(now = new Date()) {
  const { y, m, d } = osloParts(now);
  return isoDate(y, m, d);
}

export function isoDate(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Parse YYYY-MM-DD into {y,m,d}. Throws on anything else — silent coercion here is how you ship a reminder for the wrong day. */
export function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Not an ISO date (YYYY-MM-DD): ${s}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== mo || probe.getUTCDate() !== d) {
    throw new Error(`Not a real date: ${s}`);
  }
  return { y, m: mo, d };
}

/** Day of week for a calendar date, 0=Sunday..6=Saturday. Calendar-only, no timezone involved. */
export function dayOfWeek(iso) {
  const { y, m, d } = parseIsoDate(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Shift a calendar date by whole days. */
export function addDays(iso, days) {
  const { y, m, d } = parseIsoDate(iso);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Monday of the week containing the given date. */
export function mondayOf(iso) {
  const dow = dayOfWeek(iso);
  return addDays(iso, dow === 0 ? -6 : 1 - dow);
}

export const WEEKDAY_NB = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
export const WEEKDAY_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** ISO-8601 week number, for humans reading the output. Not used for scheduling. */
export function isoWeek(iso) {
  const { y, m, d } = parseIsoDate(iso);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}
