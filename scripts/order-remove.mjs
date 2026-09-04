#!/usr/bin/env node
/**
 * Remove the order for a delivery date.
 *
 *   node scripts/order-remove.mjs 2026-09-04              # dry run, shows what it would do
 *   node scripts/order-remove.mjs 2026-09-04 --yes        # actually do it
 *   node scripts/order-remove.mjs 2026-09-04 --yes --force-status   # even if not PROCESSING
 *
 * Dry run is the default. The confirmation names the food and the weekday, not just an
 * order id — the mistake worth guarding against is removing the right-shaped thing on
 * the wrong day.
 *
 * Removal trashes the order rather than hard-deleting it, so it's recoverable from the
 * WordPress admin. It does NOT re-open the deadline: if the cutoff has passed you may not
 * be able to order anything else for that day, so the script says so before acting.
 */

import { createSession } from '../src/auth.mjs';
import { awayEntry } from '../src/away.mjs';
import { deadlinesFor, formatCountdown } from '../src/deadline.mjs';
import { deleteOrder } from '../src/mutations.mjs';
import { resolveOrderStatus } from '../src/orders.mjs';
import { WEEKDAY_NB, dayOfWeek, parseIsoDate } from '../src/oslo.mjs';

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
  const opts = { date: null, yes: false, forceStatus: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--force-status') opts.forceStatus = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) throw new Error('Give a delivery date: node scripts/order-remove.mjs YYYY-MM-DD [--yes]');
  parseIsoDate(opts.date);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  const session = await createSession();

  const [status] = await resolveOrderStatus(session, [opts.date]);
  const label = `${WEEKDAY_NB[dayOfWeek(opts.date)]} ${opts.date}`;

  if (!status.exists) {
    console.log(`Nothing to remove — no order for ${label}.`);
    return;
  }

  const order = status.order ?? {};
  const items = order.items?.length ? order.items.map((i) => `${i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ') : 'unknown contents';
  const deadline = deadlinesFor(opts.date, now);

  // Everything a human needs to spot a wrong-day mistake, before anything happens.
  console.log(`Order for ${label}`);
  console.log(`  ${order.orderNumber ? `#${order.orderNumber}` : 'order number unavailable'} · ${order.status ?? 'status unknown'} · ${items}`);
  console.log(`  seen by: ${status.sources.join(' + ')}`);
  if (!order.databaseId) {
    console.error('\nCannot remove: no order id available (checkExistingOrder returns nulls, and history had no id).');
    process.exitCode = 1;
    return;
  }

  const away = await awayEntry(opts.date);
  if (away) console.log(`  you are marked away this day${away.reason ? ` (${away.reason})` : ''} — removing is probably right`);

  if (deadline.hasPassed) {
    console.log(`\n⚠ The ${opts.date} deadline passed ${osloTime(deadline.at)}.`);
    console.log('  Removing will NOT let you order something else for this day, and the kitchen may already have this in production.');
  } else {
    console.log(`\n  Deadline ${osloTime(deadline.at)} — ${formatCountdown(deadline.minutesLeft)} left, so you can still order something else after removing.`);
  }

  if (!opts.yes) {
    console.log('\nDRY RUN — nothing was changed.');
    console.log(`  would run: deleteOrder(input: { orderId: ${order.databaseId} })`);
    console.log('  (no forceDelete, so it goes to trash and is recoverable)');
    console.log(`\nTo do it: node scripts/order-remove.mjs ${opts.date} --yes`);
    return;
  }

  const removed = await deleteOrder(session, {
    orderId: order.databaseId,
    status: order.status,
    allowAnyStatus: opts.forceStatus,
  });

  console.log(`\n✅ Removed ${removed?.orderNumber ? `#${removed.orderNumber}` : `order ${order.databaseId}`} for ${label}.`);

  // Verify rather than trust the mutation's own echo.
  const [after] = await resolveOrderStatus(session, [opts.date]);
  console.log(after.exists ? `⚠ but the day still shows an order (${after.sources.join(' + ')}) — check the site.` : `   verified: ${label} now has no order.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = err.code === 'STATUS_NOT_DELETABLE' ? 2 : 1;
});
