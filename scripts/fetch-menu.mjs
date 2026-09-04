#!/usr/bin/env node
/**
 * Pull the Lunsjkokkene menu down in a readable shape.
 *
 *   node scripts/fetch-menu.mjs                     next date you can still order for
 *   node scripts/fetch-menu.mjs 2026-09-03          a specific delivery date
 *   node scripts/fetch-menu.mjs --week              Mon–Fri of the current week
 *   node scripts/fetch-menu.mjs --week 2026-09-07   Mon–Fri of that week
 *   node scripts/fetch-menu.mjs --json              JSON instead of markdown
 *   node scripts/fetch-menu.mjs --out data          also write to data/
 *   node scripts/fetch-menu.mjs --compact           drop allergens/kcal detail
 *   node scripts/fetch-menu.mjs --include-hidden    keep INNOM/Hakone/uncategorised
 *   node scripts/fetch-menu.mjs --discount-group innom   unlock one discount range
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fetchCatalogue, fetchClosedDays, fetchWeeklyMenu } from '../src/api.mjs';
import { nextOrderableDate } from '../src/deadline.mjs';
import { LUNCH_CATEGORIES, buildDay, knownCategorySlugs, normalisePayload, weekDates } from '../src/menu.mjs';
import { mondayOf, osloToday, parseIsoDate } from '../src/oslo.mjs';
import { renderDay, renderWeek } from '../src/render.mjs';

const USAGE = `fetch-menu — pull the Lunsjkokkene menu down in a readable shape

  node scripts/fetch-menu.mjs                     next date you can still order for
  node scripts/fetch-menu.mjs 2026-09-03          a specific delivery date
  node scripts/fetch-menu.mjs --week [date]       Mon-Fri of that week (default: this week)
  node scripts/fetch-menu.mjs --json              JSON instead of markdown
  node scripts/fetch-menu.mjs --out data          also write to data/
  node scripts/fetch-menu.mjs --compact           drop allergen/kcal detail
  node scripts/fetch-menu.mjs --include-hidden    keep INNOM/Hakone/uncategorised
  node scripts/fetch-menu.mjs --discount-group innom   unlock one discount range

Only ${LUNCH_CATEGORIES.join(', ')} are shown by default.

  node scripts/fetch-menu.mjs --categories wraps,salater   just these
  node scripts/fetch-menu.mjs --all-categories             cake, drinks, groceries too`;

function parseArgs(argv) {
  const opts = {
    week: false,
    json: false,
    compact: false,
    includeHidden: false,
    categories: LUNCH_CATEGORIES,
    out: null,
    discountGroup: null,
    date: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--week') opts.week = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--compact') opts.compact = true;
    else if (a === '--include-hidden') opts.includeHidden = true;
    else if (a === '--all-categories') opts.categories = null;
    else if (a === '--categories') {
      const raw = argv[++i];
      if (!raw) throw new Error('--categories needs a comma-separated list of slugs');
      opts.categories = raw
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
    }
    else if (a === '--out') opts.out = argv[++i] ?? 'data';
    else if (a === '--discount-group') opts.discountGroup = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.date) parseIsoDate(opts.date);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const now = new Date();
  const today = osloToday(now);

  const [closedDays, catalogue] = await Promise.all([fetchClosedDays(), fetchCatalogue()]);
  const closedDates = closedDays.map((c) => c.date);

  // A typo in --categories would otherwise show up as a silently empty menu.
  if (opts.categories) {
    const known = new Set(knownCategorySlugs(catalogue));
    const unknown = opts.categories.filter((slug) => !known.has(slug));
    if (unknown.length) {
      throw new Error(`Unknown category ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
    }
  }

  let dates;
  if (opts.week) {
    dates = weekDates(opts.date ?? today);
  } else if (opts.date) {
    dates = [opts.date];
  } else {
    const next = nextOrderableDate(today, closedDates, now);
    if (!next) {
      console.error('No orderable delivery date in the next three weeks — check closed days.');
      process.exitCode = 1;
      return;
    }
    dates = [next];
  }

  // One weekly-menu fetch per calendar week, not per day. Keyed on the week's Monday
  // so that a week with no published menu caches its `null` too, instead of refetching
  // an empty result once per weekday.
  const menuCache = new Map();
  const weeklyFor = async (date) => {
    const key = mondayOf(date);
    if (!menuCache.has(key)) menuCache.set(key, await fetchWeeklyMenu(date));
    return menuCache.get(key);
  };

  const days = [];
  for (const date of dates) {
    const weeklyMenu = await weeklyFor(date);
    days.push(
      buildDay({
        date,
        weeklyMenu,
        closedDays,
        catalogue,
        now,
        options: {
          discountGroup: opts.discountGroup,
          includeHidden: opts.includeHidden,
          only: opts.categories,
        },
      }),
    );
  }

  const payload = {
    generatedAt: now.toISOString(),
    osloToday: today,
    source: 'lunsjkokkene.no (WPGraphQL, unauthenticated)',
    closedDays,
    days,
  };

  const text = opts.json
    ? JSON.stringify(days.length > 1 ? normalisePayload(payload) : payload, null, 2)
    : days.length > 1
      ? renderWeek(days, { compact: opts.compact })
      : renderDay(days[0], { compact: opts.compact });

  console.log(text);

  if (opts.out) {
    await mkdir(opts.out, { recursive: true });
    const stem = days.length > 1 ? `week-${days[0].deliveryDate}` : days[0].deliveryDate;
    const file = join(opts.out, `${stem}.${opts.json ? 'json' : 'md'}`);
    await writeFile(file, text.endsWith('\n') ? text : text + '\n', 'utf8');
    console.error(`\nwrote ${file}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
