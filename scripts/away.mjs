#!/usr/bin/env node
/**
 * Manage the days you won't be in the office.
 *
 *   node scripts/away.mjs list
 *   node scripts/away.mjs add 2026-09-02 2026-09-03 --reason "kundemøte"
 *   node scripts/away.mjs remove 2026-09-03
 *   node scripts/away.mjs prune
 *   node scripts/away.mjs check          # any orders on away days? (needs login)
 *
 * ISO dates only. "Wednesday this week" is not parsed here on purpose — whoever is
 * translating that should resolve it and then read back the weekday this command prints,
 * so a wrong Wednesday gets caught by a human rather than discovered at lunchtime.
 */

import { AWAY_PATH, clearAway, describeDate, listAway, markAway, pruneAway } from '../src/away.mjs';
import { createSession } from '../src/auth.mjs';
import { resolveOrderStatus } from '../src/orders.mjs';
import { osloToday } from '../src/oslo.mjs';

const USAGE = `usage: node scripts/away.mjs <command> [dates...] [options]

  list [--from D] [--to D]     show marked days (default: today onwards)
  add <YYYY-MM-DD...>          mark days away  [--reason "text"]
  remove <YYYY-MM-DD...>       un-mark days (the explicit change of mind)
  prune [--before D]           drop past entries (default: before today)
  check                        warn about orders that exist on away days

Stored at ${AWAY_PATH}`;

function parse(argv) {
  const opts = { cmd: argv[0], dates: [], reason: null, from: null, to: null, before: null, json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reason') opts.reason = argv[++i] ?? null;
    else if (a === '--from') opts.from = argv[++i] ?? null;
    else if (a === '--to') opts.to = argv[++i] ?? null;
    else if (a === '--before') opts.before = argv[++i] ?? null;
    else if (a === '--json') opts.json = true;
    else if (a === '--all') opts.from = '0000-01-01';
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) opts.dates.push(a);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parse(process.argv.slice(2));

  switch (opts.cmd) {
    case 'list': {
      const entries = await listAway({ from: opts.from ?? osloToday(), to: opts.to });
      if (opts.json) return console.log(JSON.stringify(entries, null, 2));
      if (!entries.length) return console.log('No away days marked.');
      console.log(`Away days (${entries.length}):`);
      for (const e of entries) console.log(`  ${describeDate(e.date)}${e.reason ? ` — ${e.reason}` : ''}`);
      return;
    }

    case 'add': {
      if (!opts.dates.length) throw new Error('Give at least one ISO date. ' + USAGE);
      const r = await markAway(opts.dates, { reason: opts.reason });
      // Echo the weekday so a mis-resolved date is obvious at a glance.
      for (const d of r.added) console.log(`marked away: ${describeDate(d)}`);
      for (const d of r.updated) console.log(`updated reason: ${describeDate(d)}`);
      for (const d of r.alreadyMarked) console.log(`already marked: ${describeDate(d)}`);
      return;
    }

    case 'remove': {
      if (!opts.dates.length) throw new Error('Give at least one ISO date. ' + USAGE);
      const r = await clearAway(opts.dates);
      for (const d of r.removed) console.log(`back in office: ${describeDate(d)}`);
      for (const d of r.notMarked) console.log(`was not marked away: ${describeDate(d)}`);
      return;
    }

    case 'prune': {
      const r = await pruneAway({ before: opts.before });
      console.log(r.pruned.length ? `pruned ${r.pruned.length} entries before ${r.cutoff}` : `nothing to prune before ${r.cutoff}`);
      return;
    }

    case 'check': {
      const entries = await listAway({ from: osloToday() });
      if (!entries.length) return console.log('No upcoming away days to check.');
      const session = await createSession();
      const statuses = await resolveOrderStatus(session, entries.map((e) => e.date));
      const clashes = statuses.filter((s) => s.exists);
      if (!clashes.length) {
        console.log(`ok — no orders on any of the ${entries.length} upcoming away day(s).`);
        return;
      }
      // Exit non-zero: this is the case a daily job exists to catch.
      console.log(`⚠ ${clashes.length} order(s) on days you're away:`);
      for (const c of clashes) {
        const o = c.order ?? {};
        console.log(`  ${describeDate(c.date)} — ${o.orderNumber ? `#${o.orderNumber}` : 'order number unavailable'} (${o.status ?? '?'})${o.items?.length ? `: ${o.items.map((i) => i.name).join(', ')}` : ''}`);
      }
      // Cancelling IS automated (order-remove.mjs). Name the exact command rather than
      // the website: the point of this tool is that nobody has to go clicking.
      console.log('\nTo cancel, dry run first, then add --yes:');
      for (const c of clashes) console.log(`  node scripts/order-remove.mjs ${c.date}`);
      console.log('Or by hand at https://lunsjkokkene.no/dashboard');
      process.exitCode = 2;
      return;
    }

    default:
      console.log(USAGE);
      if (opts.cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
