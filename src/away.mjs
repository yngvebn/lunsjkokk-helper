/**
 * Days you won't be in the office.
 *
 * The point is to be told once. Marking a date away means:
 *   - it is never suggested again, and never counted as a missed deadline
 *   - if an order somehow exists for it, that gets escalated rather than ignored —
 *     lunch you won't eat is worse than lunch you forgot to order
 *   - only an explicit `remove` brings it back
 *
 * Stored as plain JSON next to the code so it's trivial to read, edit or diff by hand.
 * Dates are ISO `YYYY-MM-DD` only: this module deliberately does no natural-language
 * parsing. "Wednesday this week" is resolved by the caller, which then echoes the
 * resolved weekday back for confirmation — a date parser that silently picks the wrong
 * Wednesday is exactly the bug you'd never notice until you had no lunch.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { WEEKDAY_NB, dayOfWeek, osloToday, parseIsoDate } from './oslo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const AWAY_PATH = process.env.LUNSJ_AWAY_PATH ?? join(ROOT, 'away.json');

const EMPTY = { away: [] };

export async function loadAway(path = AWAY_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return { away: Array.isArray(parsed.away) ? parsed.away : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...EMPTY, away: [] };
    // A corrupt file must not be silently replaced with an empty one — that would
    // quietly resurrect every away day and start suggesting lunch again.
    throw new Error(`Could not read ${path}: ${err.message}`);
  }
}

async function saveAway(store, path = AWAY_PATH) {
  const away = [...store.away].sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(path, JSON.stringify({ away }, null, 2) + '\n', 'utf8');
  return away;
}

/** Human label for a date, so callers can echo back what they actually resolved. */
export const describeDate = (date) => `${WEEKDAY_NB[dayOfWeek(date)]} ${date}`;

/**
 * Mark dates away. Idempotent — re-marking an existing date updates its reason rather
 * than duplicating it, so a daily job can be careless without corrupting the file.
 */
export async function markAway(dates, { reason = null, path = AWAY_PATH } = {}) {
  const store = await loadAway(path);
  const byDate = new Map(store.away.map((a) => [a.date, a]));
  const added = [];
  const updated = [];

  for (const raw of dates) {
    const date = String(raw).trim();
    parseIsoDate(date); // throws on anything that isn't a real ISO date
    const existing = byDate.get(date);
    if (existing) {
      if (reason && existing.reason !== reason) {
        existing.reason = reason;
        updated.push(date);
      }
    } else {
      byDate.set(date, { date, reason, setAt: new Date().toISOString() });
      added.push(date);
    }
  }

  store.away = [...byDate.values()];
  await saveAway(store, path);
  return { added, updated, alreadyMarked: dates.map(String).filter((d) => !added.includes(d) && !updated.includes(d)) };
}

/** Un-mark dates — the explicit change of mind. */
export async function clearAway(dates, { path = AWAY_PATH } = {}) {
  const store = await loadAway(path);
  const wanted = new Set(dates.map((d) => String(d).trim()));
  for (const d of wanted) parseIsoDate(d);
  const removed = store.away.filter((a) => wanted.has(a.date)).map((a) => a.date);
  store.away = store.away.filter((a) => !wanted.has(a.date));
  await saveAway(store, path);
  return { removed, notMarked: [...wanted].filter((d) => !removed.includes(d)) };
}

/** Drop entries before `before` (default: today in Oslo). Housekeeping only. */
export async function pruneAway({ before = null, path = AWAY_PATH } = {}) {
  const cutoff = before ?? osloToday();
  parseIsoDate(cutoff);
  const store = await loadAway(path);
  const pruned = store.away.filter((a) => a.date < cutoff).map((a) => a.date);
  store.away = store.away.filter((a) => a.date >= cutoff);
  await saveAway(store, path);
  return { pruned, cutoff };
}

export async function listAway({ from = null, to = null, path = AWAY_PATH } = {}) {
  const store = await loadAway(path);
  return store.away
    .filter((a) => (!from || a.date >= from) && (!to || a.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** A Set of away dates, for the fast "skip this day" checks. */
export async function awayDates({ path = AWAY_PATH } = {}) {
  return new Set((await loadAway(path)).away.map((a) => a.date));
}

/** The full entry for one date, or null. */
export async function awayEntry(date, { path = AWAY_PATH } = {}) {
  return (await loadAway(path)).away.find((a) => a.date === date) ?? null;
}
