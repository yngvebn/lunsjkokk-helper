#!/usr/bin/env node
/**
 * The daily check. One command, safe to run every day, designed to be quiet when there's
 * nothing to do.
 *
 *   node scripts/daily.mjs
 *
 * It answers three questions in priority order:
 *
 *   1. Is there an order on a day I'm away?      -> loud, and time-critical to cancel
 *   2. Is there a day needing a decision today?  -> the deadline and a suggestion
 *   3. Anything further out already handled?     -> one summary line
 *
 * Exit codes exist so this can drive a notification without parsing text:
 *   0  nothing needs you
 *   2  a clash: an order on an away day
 *   3  a decision is due today (deadline is today)
 */

import { fetchCatalogue, fetchClosedDays, fetchWeeklyMenu } from '../src/api.mjs';
import { awayDates, describeDate, listAway, pruneAway } from '../src/away.mjs';
import { createSession } from '../src/auth.mjs';
import { deadlinesFor, formatCountdown } from '../src/deadline.mjs';
import { loadPreferences } from '../src/preferences.mjs';
import { buildDay } from '../src/menu.mjs';
import { addDays, dayOfWeek, osloToday } from '../src/oslo.mjs';
import { getRecentOrders, resolveOrderStatus } from '../src/orders.mjs';
import { rankDay } from '../src/suggest.mjs';

const HORIZON = 10; // weekdays ahead to consider

const osloTime = (iso) =>
  new Intl.DateTimeFormat('nb-NO', {
    timeZone: 'Europe/Oslo',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

async function main() {
  const json = process.argv.includes('--json');
  const now = new Date();
  const today = osloToday(now);

  // Housekeeping: past away days are noise, and a daily run is the right place to drop them.
  await pruneAway({ before: today });

  const prefs = await loadPreferences();
  const [closedDays, catalogue] = await Promise.all([fetchClosedDays(), fetchCatalogue()]);
  const closed = new Map(closedDays.map((c) => [c.date, c]));
  const away = await awayDates();

  // Weekdays in the horizon that aren't closed.
  const dates = [];
  for (let i = 0; i < HORIZON * 2 && dates.length < HORIZON; i++) {
    const date = addDays(today, i);
    const dow = dayOfWeek(date);
    if (dow === 0 || dow === 6) continue;
    if (closed.has(date)) continue;
    dates.push(date);
  }

  let session = null;
  let authNote = null;
  try {
    session = await createSession();
  } catch (err) {
    authNote =
      err.code === 'NO_CREDENTIALS'
        ? 'not signed in — run: node scripts/auth.mjs login'
        : `login failed — ${err.message}`;
  }

  const statuses = session ? await resolveOrderStatus(session, dates) : [];
  const byDate = new Map(statuses.map((s) => [s.date, s]));

  // 1. Clashes: away, but ordered. The only genuinely urgent case.
  const clashes = dates
    .filter((d) => away.has(d) && byDate.get(d)?.exists)
    .map((d) => ({ date: d, status: byDate.get(d), deadline: deadlinesFor(d, now) }));

  // 2. Days that still need a decision.
  const open = dates.filter(
    (d) => !away.has(d) && !byDate.get(d)?.exists && !deadlinesFor(d, now).hasPassed,
  );

  // Only suggest for the most urgent open day — a daily nag with five suggestions is a
  // digest nobody reads.
  let suggestion = null;
  const next = open[0];
  if (next) {
    const weeklyMenu = await fetchWeeklyMenu(next);
    const day = buildDay({ date: next, weeklyMenu, closedDays, catalogue, now });
    const cooldownDays = prefs.categories?.occasionalCooldownDays ?? 7;
    const recentNames = session
      ? (await getRecentOrders(session, { limit: 60 }))
          .filter((o) => o.deliveryDate && o.deliveryDate >= addDays(today, -cooldownDays))
          .flatMap((o) => o.items.map((i) => i.name))
          .filter(Boolean)
      : [];
    const ranked = rankDay(day, prefs, { recentNames });
    suggestion = { day, ranked };
  }

  const handled = dates.filter((d) => byDate.get(d)?.exists);
  const awayUpcoming = dates.filter((d) => away.has(d));

  if (json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: now.toISOString(),
          today,
          authNote,
          clashes: clashes.map((c) => ({ date: c.date, order: c.status.order, deadline: c.deadline })),
          needsDecision: open,
          alreadyOrdered: handled.map((d) => ({ date: d, order: byDate.get(d).order })),
          away: awayUpcoming,
          suggestion: suggestion && {
            date: suggestion.day.deliveryDate,
            deadline: suggestion.day.deadline,
            pick: suggestion.ranked.shortlist[0] ?? null,
            alternatives: suggestion.ranked.shortlist.slice(1),
            ukesmeny: suggestion.ranked.ukesmeny.flagged,
          },
        },
        null,
        2,
      ),
    );
  } else {
    renderText({ authNote, clashes, open, suggestion, handled, byDate, awayUpcoming, now, today });
  }

  // Clash beats deadline: cancelling has a hard cutoff and costs money if missed.
  if (clashes.length) process.exitCode = 2;
  else if (next && deadlinesFor(next, now).cutoffDate === today) process.exitCode = 3;
}

function renderText({ authNote, clashes, open, suggestion, handled, byDate, awayUpcoming, now, today }) {
  if (authNote) console.log(`⚠ ${authNote}\n`);

  if (clashes.length) {
    console.log('🚨 ORDER ON A DAY YOU\'RE AWAY');
    for (const c of clashes) {
      const o = c.status.order ?? {};
      const what = o.items?.length ? `: ${o.items.map((i) => i.name).join(', ')}` : '';
      console.log(`   ${describeDate(c.date)} — ${o.orderNumber ? `#${o.orderNumber}` : 'order number unavailable'} (${o.status ?? '?'})${what}`);
      console.log(
        c.deadline.hasPassed
          ? `   deadline passed ${osloTime(c.deadline.at)} — may be too late to cancel`
          : `   cancel before ${osloTime(c.deadline.at)} (${formatCountdown(c.deadline.minutesLeft)} left)`,
      );
    }
    console.log('   Cancelling is not automated: https://lunsjkokkene.no/dashboard\n');
  }

  if (suggestion) {
    const d = suggestion.day.deadline;
    const urgent = d.cutoffDate === today;
    console.log(
      `${urgent ? '⏰' : '⏳'} ${describeDate(suggestion.day.deliveryDate)} needs an order — ` +
        `${formatCountdown(d.minutesLeft)} left (by ${osloTime(d.at)})${urgent ? ' — TODAY' : ''}`,
    );
    const pick = suggestion.ranked.shortlist[0];
    if (pick) console.log(`   Pick: ${pick.name} — ${pick.price}, ${pick.categoryName}`);
    for (const f of suggestion.ranked.ukesmeny.flagged) {
      console.log(`   💡 or ${f.label}: ${f.dish}`);
    }
    if (open.length > 1) console.log(`   (also open, less urgent: ${open.slice(1).join(', ')})`);
    console.log('');
  } else if (!clashes.length) {
    console.log('✅ Nothing needs you.\n');
  }

  const bits = [];
  if (handled.length) bits.push(`${handled.length} day(s) already ordered`);
  if (awayUpcoming.length) bits.push(`${awayUpcoming.length} away`);
  if (bits.length) console.log(`   ${bits.join(', ')}.`);
  if (awayUpcoming.length) console.log(`   away: ${awayUpcoming.map(describeDate).join(', ')}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
