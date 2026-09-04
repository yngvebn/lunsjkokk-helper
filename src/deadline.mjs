/**
 * Order deadline rules, reverse-engineered from
 * https://lunsjkokkene.no/_next/static/chunks/pages/meny-*.js
 *
 * `isOrderPastDeadline` + `{HOUR:13, MINUTE:0}`: ordering closes at **13:00 Europe/Oslo
 * the day before delivery**, except Monday and Sunday deliveries, which roll back to the
 * preceding Friday.
 *
 * The bundle also carries a separate hardcoded 10:00 deadline
 * (`getSubscriptionOrderDeadlineInfo`) for editing a day that a *subscription* already
 * generated. We don't use subscriptions, so that rule never applies here — it's noted
 * only so nobody rediscovers it and assumes the 13:00 above is wrong.
 */

import { addDays, dayOfWeek, osloInstant, parseIsoDate } from './oslo.mjs';

export const CUTOFF = { hour: 13, minute: 0 };

/** The calendar date on which ordering for `deliveryDate` closes. */
export function cutoffDateFor(deliveryDate) {
  const dow = dayOfWeek(deliveryDate);
  if (dow === 1) return addDays(deliveryDate, -3); // Monday    -> Friday
  if (dow === 0) return addDays(deliveryDate, -2); // Sunday    -> Friday
  return addDays(deliveryDate, -1); //               otherwise -> day before
}

/** Deadline picture for one delivery date. `at` is an absolute instant. */
export function deadlinesFor(deliveryDate, now = new Date()) {
  const cutoffDate = cutoffDateFor(deliveryDate);
  const { y, m, d } = parseIsoDate(cutoffDate);
  const at = osloInstant(y, m, d, CUTOFF.hour, CUTOFF.minute);
  return {
    cutoffDate,
    at: at.toISOString(),
    hasPassed: now.getTime() >= at.getTime(),
    minutesLeft: Math.floor((at.getTime() - now.getTime()) / 60000),
  };
}

/**
 * The next delivery date you can still order for, walking forward from `from`.
 * Skips weekends, closed days, and days whose deadline has already gone.
 */
export function nextOrderableDate(from, closedDates, now = new Date(), { horizon = 21 } = {}) {
  const closed = new Set(closedDates ?? []);
  for (let i = 0; i < horizon; i++) {
    const date = addDays(from, i);
    const dow = dayOfWeek(date);
    if (dow === 0 || dow === 6) continue;
    if (closed.has(date)) continue;
    if (!deadlinesFor(date, now).hasPassed) return date;
  }
  return null;
}

export function formatCountdown(minutes) {
  if (minutes < 0) return 'passed';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}
