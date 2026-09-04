#!/usr/bin/env node
/**
 * "What should I have for lunch, and have I already ordered?"
 *
 *   node scripts/suggest.mjs                  next orderable day
 *   node scripts/suggest.mjs 2026-09-08       a specific delivery date
 *   node scripts/suggest.mjs --week           Mon–Fri, with order status per day
 *   node scripts/suggest.mjs --json           machine-readable
 *   node scripts/suggest.mjs --no-auth        skip the order check entirely
 *   node scripts/suggest.mjs --vary-week      don't repeat anything within the whole view
 *   node scripts/suggest.mjs --include-away    show away days instead of skipping them
 *
 * The default repetition rule is the one in preferences.json: never the same item two days
 * running. Across a week that alternates A/B/A/B/A — compliant, but dull. --vary-week
 * widens it to "nothing twice in this view", which is the stricter rule that was declined
 * when the profile was set up; it's here because it's one line and easy to change your mind
 * about.
 *
 * Without credentials it still ranks the menu; it just can't tell you whether you've
 * already ordered. With them, an existing order short-circuits the suggestion — the
 * whole point being not to double-book.
 */

import { fetchCatalogue, fetchClosedDays, fetchWeeklyMenu } from '../src/api.mjs';
import { awayEntry, listAway } from '../src/away.mjs';
import { createSession } from '../src/auth.mjs';
import { formatCountdown, nextOrderableDate } from '../src/deadline.mjs';
import { loadPreferences } from '../src/preferences.mjs';
import { buildDay, weekDates } from '../src/menu.mjs';
import { addDays, mondayOf, osloToday, parseIsoDate } from '../src/oslo.mjs';
import { getRecentOrders, historyByDate, resolveOrderStatus } from '../src/orders.mjs';
import { rankDay } from '../src/suggest.mjs';

const osloTime = (iso) =>
  new Intl.DateTimeFormat('nb-NO', {
    timeZone: 'Europe/Oslo',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

function parseArgs(argv) {
  const opts = { week: false, json: false, auth: true, varyWeek: false, includeAway: false, date: null };
  for (const a of argv) {
    if (a === '--week') opts.week = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-auth') opts.auth = false;
    else if (a === '--vary-week') opts.varyWeek = true;
    else if (a === '--include-away') opts.includeAway = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.date) parseIsoDate(opts.date);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  const today = osloToday(now);
  const prefs = await loadPreferences();

  const [closedDays, catalogue] = await Promise.all([fetchClosedDays(), fetchCatalogue()]);
  const closedDates = closedDays.map((c) => c.date);

  let dates;
  if (opts.week) dates = weekDates(opts.date ?? today);
  else if (opts.date) dates = [opts.date];
  else {
    // Away days are excluded the same way closed days are, so the default view lands on a
    // day that actually needs a decision. --include-away opts back in.
    const awayList = opts.includeAway ? [] : (await listAway({ from: today })).map((a) => a.date);
    const next = nextOrderableDate(today, [...closedDates, ...awayList], now);
    if (!next) throw new Error('No orderable delivery date in the next three weeks.');
    dates = [next];
  }

  // Authenticate if we can. A missing credential store is a normal state, not an error —
  // degrade to menu-only rather than refusing to run.
  let session = null;
  let authNote = null;
  if (opts.auth) {
    try {
      session = await createSession();
    } catch (err) {
      authNote = err.code === 'NO_CREDENTIALS' ? 'not signed in — run: node scripts/auth.mjs login' : `login failed — ${err.message}`;
    }
  } else {
    authNote = 'order check skipped (--no-auth)';
  }

  const away = new Map();
  for (const date of dates) {
    const entry = await awayEntry(date);
    if (entry) away.set(date, entry);
  }

  const existing = session ? await resolveOrderStatus(session, dates) : [];
  const existingByDate = new Map(existing.map((e) => [e.date, e]));
  // Yesterday's actual order is what the repetition rule should key on, not what I
  // suggested last time — but it needs history, so fall back to nothing when anonymous.
  const history = session ? await historyByDate(session, dates.map((d) => addDays(d, -1))) : new Map();
  // Everything ordered inside the occasional-favourite cooldown, so a treat isn't offered
  // twice in a week. Empty when anonymous, which the ranker falls back from explicitly.
  const cooldownDays = prefs.categories?.occasionalCooldownDays ?? 7;
  const recentNames = session
    ? (await getRecentOrders(session, { limit: 60 }))
        .filter((o) => o.deliveryDate && o.deliveryDate >= addDays(today, -cooldownDays))
        .flatMap((o) => o.items.map((i) => i.name))
        .filter(Boolean)
    : [];

  const menuCache = new Map();
  const results = [];
  // Carries the previous day's pick forward, so a multi-day view doesn't recommend the
  // same baguette five times. Order history seeds it where we have it; otherwise the
  // chain starts empty and builds as we go.
  let previousPick = null;
  const pickedThisRun = new Set();
  for (const date of dates) {
    const menuKey = mondayOf(date);
    if (!menuCache.has(menuKey)) menuCache.set(menuKey, await fetchWeeklyMenu(date));
    const day = buildDay({ date, weeklyMenu: menuCache.get(menuKey), closedDays, catalogue, now });

    const yesterday = history.get(addDays(date, -1));
    const avoidNames = new Set(
      [
        ...(yesterday?.items ?? []).map((i) => i.name),
        ...(opts.varyWeek ? pickedThisRun : [previousPick]),
      ].filter(Boolean),
    );

    const awayOn = away.get(date) ?? null;
    const ranked = rankDay(day, prefs, { avoidNames, recentNames });
    // An away day never contributes to the repetition chain — you didn't eat it.
    if (!awayOn && !day.isClosed && !day.deadline.hasPassed && !existingByDate.get(date)?.exists) {
      const pick = ranked.shortlist[0]?.name;
      if (pick) {
        previousPick = pick;
        pickedThisRun.add(pick);
      }
    }

    results.push({
      day,
      away: awayOn,
      order: existingByDate.get(date) ?? null,
      ateYesterday: yesterday ? yesterday.items.map((i) => i.name) : null,
      avoidedYesterdaysPick: avoidNames.size ? [...avoidNames] : null,
      ...ranked,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({ generatedAt: now.toISOString(), authNote, results }, null, 2));
    return;
  }

  if (authNote) console.log(`⚠ ${authNote}\n`);
  else console.log(`signed in as ${session.viewer.username} (customerId ${session.customerId})\n`);

  for (const r of results) console.log(renderSuggestion(r, { includeAway: opts.includeAway }), '');
}

function renderSuggestion(r, { includeAway = false } = {}) {
  const { day, order } = r;
  const out = [`## ${day.weekday} ${day.deliveryDate}`];

  if (day.isClosed) return [...out, `🚫 Stengt. ${day.closedMessage ?? ''}`.trim()].join('\n');

  if (r.away) {
    const why = r.away.reason ? ` (${r.away.reason})` : '';
    out.push(`🏠 Not in the office${why} — no lunch needed.`);
    // The one case that must never be quiet: away, but an order exists. That's money
    // about to buy a lunch nobody will eat, and only the user can cancel it.
    if (order?.exists) {
      const o = order.order ?? {};
      out.push(
        '',
        `⚠️ **But there IS an order for this day** — ${o.orderNumber ? `#${o.orderNumber}` : 'order number unavailable'} (${o.status ?? 'status unknown'})${o.items?.length ? `: ${o.items.map((i) => i.name).join(', ')}` : ''}.`,
        day.deadline.hasPassed
          ? `  The ${'13:00'} deadline passed ${osloTime(day.deadline.at)}, so it may be too late to cancel.`
          : `  Cancel before ${osloTime(day.deadline.at)} — not automated, do it at https://lunsjkokkene.no/dashboard`,
      );
    }
    return out.join('\n');
  }

  const d = day.deadline;
  out.push(d.hasPassed ? `Frist utløpt ${osloTime(d.at)} — too late.` : `⏳ ${formatCountdown(d.minutesLeft)} left — order by ${osloTime(d.at)}.`);

  if (order?.exists) {
    const o = order.order ?? {};
    const what = o.items?.length ? `: ${o.items.map((i) => i.name).join(', ')}` : '';
    const num = o.orderNumber ? `#${o.orderNumber}` : 'order number unavailable';
    out.push(`✅ Already ordered — ${num} (${o.status ?? 'status unknown'})${what}. Nothing to do.`);
    if (order.disagreement) {
      out.push(
        `  _note: only ${order.sources.join(' + ')} sees it — checkExistingOrder misses non-PROCESSING orders._`,
      );
    }
    return out.join('\n');
  }
  if (order) out.push('❌ No order for this day yet.');
  if (d.hasPassed) return out.join('\n');

  if (r.ateYesterday?.length) out.push(`_yesterday: ${r.ateYesterday.join(', ')}_`);

  const [top, ...rest] = r.shortlist;
  if (!top) {
    out.push('No candidate matched the profile — check the category filter.');
    return out.join('\n');
  }
  out.push('', `**Pick: ${top.name}** — ${top.price}, ${top.categoryName}`);
  out.push(`  ${top.reasons.join(' · ')}`);
  if (top.description) out.push(`  ${top.description.slice(0, 150)}`);

  if (rest.length) {
    out.push('', 'Also:');
    for (const c of rest) out.push(`  - ${c.name} — ${c.price}, ${c.categoryName} (${c.reasons.join(', ')})`);
  }

  // Say what's being withheld and why — a silent omission looks like the profile
  // forgot about it, which is exactly the kind of thing you'd want to correct.
  if (r.heldBack?.length) {
    out.push('', ...r.heldBack.map((c) => `_holding back ${c.name} — ${c.heldBackReason}_`));
  }

  const flagged = r.ukesmeny.flagged;
  if (flagged.length) {
    out.push('', '💡 Worth breaking the routine for:');
    for (const f of flagged) {
      out.push(`  **${f.label}** — ${f.dish}`);
      out.push(`    ${[f.price, ...f.reasons].filter(Boolean).join(' · ')}`);
    }
  }
  return out.join('\n');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
