#!/usr/bin/env node
/**
 * Order lunch for a day that doesn't have one yet.
 *
 *   node scripts/order-add.mjs 2026-09-04                     # dry run, uses the suggested pick
 *   node scripts/order-add.mjs 2026-09-04 --yes                # actually order it
 *   node scripts/order-add.mjs 2026-09-04 --product 127154     # a specific product
 *   node scripts/order-add.mjs 2026-09-04 --name "Club Sand"   # match by name
 *   node scripts/order-add.mjs 2026-09-04 --dagens rett        # the day's Ukesmeny dish
 *
 * Dry run is the default and prints the exact mutation. Refuses if an order already
 * exists — one item per day — and refuses if the deadline has passed or the day is
 * closed or marked away.
 */

import { fetchCatalogue, fetchClosedDays, fetchWeeklyMenu } from '../src/api.mjs';
import { createSession } from '../src/auth.mjs';
import { awayEntry } from '../src/away.mjs';
import { deadlinesFor, formatCountdown } from '../src/deadline.mjs';
import { loadPreferences } from '../src/preferences.mjs';
import { buildDay } from '../src/menu.mjs';
import { buildOrderInput, createOrder } from '../src/mutations.mjs';
import { getRecentOrders, resolveOrderStatus } from '../src/orders.mjs';
import { WEEKDAY_NB, addDays, dayOfWeek, osloToday, parseIsoDate } from '../src/oslo.mjs';
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
  const opts = { date: null, yes: false, productId: null, name: null, dagens: null, allowLate: false, allowWeekend: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--product') opts.productId = Number(argv[++i]);
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '--dagens') opts.dagens = (argv[++i] ?? '').toLowerCase();
    else if (a === '--allow-late') opts.allowLate = true;
    else if (a === '--allow-weekend') opts.allowWeekend = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) throw new Error('Give a delivery date: node scripts/order-add.mjs YYYY-MM-DD [--yes]');
  parseIsoDate(opts.date);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  const today = osloToday(now);
  const label = `${WEEKDAY_NB[dayOfWeek(opts.date)]} ${opts.date}`;

  const prefs = await loadPreferences();
  const session = await createSession();

  // --- refuse early, before touching anything ---
  const [status] = await resolveOrderStatus(session, [opts.date]);
  if (status.exists) {
    const o = status.order ?? {};
    console.error(
      `Refusing: ${label} already has an order — ${o.orderNumber ? `#${o.orderNumber}` : 'order number unavailable'} (${o.status ?? '?'})` +
        `${o.items?.length ? `: ${o.items.map((i) => i.name).join(', ')}` : ''}.`,
    );
    console.error('One item per day. Remove it first: node scripts/order-remove.mjs ' + opts.date + ' --yes');
    process.exitCode = 2;
    return;
  }

  const deadline = deadlinesFor(opts.date, now);
  if (deadline.hasPassed && !opts.allowLate) {
    console.error(`Refusing: the ${opts.date} deadline passed ${osloTime(deadline.at)}. The order would likely be rejected or arrive as a surprise.`);
    console.error('  (--allow-late to try anyway)');
    process.exitCode = 2;
    return;
  }

  const dow = dayOfWeek(opts.date);
  if ((dow === 0 || dow === 6) && !opts.allowWeekend) {
    // Every published Ukesmeny is Mon-Fri, and weekend delivery is a per-company setting
    // we don't read. Refusing by default beats ordering food for a Saturday office.
    console.error(`Refusing: ${label} is a weekend. Lunsjkokkene publishes Mon-Fri menus, and weekend delivery is a company setting this tool doesn't check.`);
    console.error('  (--allow-weekend to try anyway)');
    process.exitCode = 2;
    return;
  }

  const away = await awayEntry(opts.date);
  if (away) {
    console.error(`Refusing: you're marked away on ${label}${away.reason ? ` (${away.reason})` : ''}.`);
    console.error(`  If that changed: node scripts/away.mjs remove ${opts.date}`);
    process.exitCode = 2;
    return;
  }

  const [closedDays, catalogue] = await Promise.all([fetchClosedDays(), fetchCatalogue()]);
  const closed = closedDays.find((c) => c.date === opts.date);
  if (closed) {
    console.error(`Refusing: Lunsjkokkene is closed on ${label}. ${closed.message ?? ''}`.trim());
    process.exitCode = 2;
    return;
  }

  // --- pick what to order ---
  const day = buildDay({ date: opts.date, weeklyMenu: await fetchWeeklyMenu(opts.date), closedDays, catalogue, now });
  const cooldownDays = prefs.categories?.occasionalCooldownDays ?? 7;
  const recentNames = (await getRecentOrders(session, { limit: 60 }))
    .filter((o) => o.deliveryDate && o.deliveryDate >= addDays(today, -cooldownDays))
    .flatMap((o) => o.items.map((i) => i.name))
    .filter(Boolean);
  const ranked = rankDay(day, prefs, { recentNames });

  const allItems = day.alacarte.flatMap((g) => g.items.map((i) => ({ ...i, category: g.slug, categoryName: g.name })));

  // Ukesmeny slots are NOT in `alacarte` — buildDay renders them separately as `dagens`,
  // so they were unreachable here. Fold them in as candidates, keeping the per-day co2 and
  // kalorier from the weekly menu (for Dagens rett the product catalogue has none; the
  // numbers live on the day's menu item, and the site writes those into order meta).
  const weeklyMenu = await fetchWeeklyMenu(opts.date);
  const rawSlotFor = (productId) =>
    (weeklyMenu?.menuItems ?? []).find(
      (m) => Number(m.productId) === Number(productId) && String(m.dag).toLowerCase() === WEEKDAY_NB[dayOfWeek(opts.date)],
    ) ?? {};

  const dagensItems = Object.values(day.dagens ?? {}).map((slot) => {
    const raw = rawSlotFor(slot.productId);
    const product = catalogue.products.find((p) => p.databaseId === slot.productId) ?? {};
    return {
      id: slot.productId,
      slot: slot.slot,
      // The line item takes the PRODUCT name ("Dagens rett"); the dish is menu content.
      name: product.name ?? slot.label,
      dish: slot.dish,
      price: slot.sizes?.find((v) => /vanlig/i.test(v.name))?.price ?? slot.price,
      categoryName: `Ukesmeny (${slot.label})`,
      category: 'ukesmeny',
      allergener: slot.allergener ?? [],
      minimum: null,
      variations: (product.variations?.nodes ?? []).map((v) => ({
        id: v.databaseId,
        name: v.name,
        price: v.regularPrice,
      })),
      rawCo2: raw.co2 || null,
      rawKalorier: raw.kalorier || null,
    };
  });

  const candidates = [...allItems, ...dagensItems];
  let chosen;
  let why;
  if (opts.dagens) {
    chosen = dagensItems.find((i) => i.slot === opts.dagens);
    if (!chosen) {
      throw new Error(
        `No Ukesmeny slot "${opts.dagens}" on ${opts.date}. Available: ${dagensItems.map((i) => i.slot).join(', ') || 'none'}`,
      );
    }
    why = `the day's Ukesmeny ${opts.dagens}`;
  } else if (opts.productId) {
    chosen = candidates.find((i) => i.id === opts.productId);
    if (!chosen) throw new Error(`Product ${opts.productId} is not on the menu for ${opts.date}.`);
    why = 'you named this product';
  } else if (opts.name) {
    const needle = opts.name.toLowerCase();
    const matches = candidates.filter((i) => i.name.toLowerCase().includes(needle));
    if (!matches.length) throw new Error(`Nothing on ${opts.date}'s menu matches "${opts.name}".`);
    if (matches.length > 1) {
      throw new Error(
        `"${opts.name}" matches ${matches.length} items — be more specific:\n` + matches.map((m) => `  ${m.id}  ${m.name}`).join('\n'),
      );
    }
    chosen = matches[0];
    why = `matched "${opts.name}"`;
  } else {
    chosen = ranked.shortlist[0];
    if (!chosen) throw new Error(`No candidate matched your preferences for ${opts.date}.`);
    why = ranked.shortlist[0].reasons.join(', ');
  }

  if (chosen.minimum && chosen.minimum > 1) {
    console.error(`Refusing: ${chosen.name} has a minimum quantity of ${chosen.minimum}, which conflicts with one item per day.`);
    process.exitCode = 2;
    return;
  }

  // A variable product needs a variation. Default to Vanlig, per preferences.json.
  const wantSize = (prefs.portion?.dagensRett ?? 'Vanlig').toLowerCase();
  const variation = chosen.variations?.length
    ? chosen.variations.find((v) => v.name.toLowerCase().includes(wantSize)) ?? chosen.variations[0]
    : null;
  const sizeLabel = variation ? variation.name.replace(/^.*?-\s*/, '') : null;

  // The site writes raw c02/kalorier strings into order meta. Our normalised numbers
  // would lose comma decimals ("0,37" parses to NaN), so use raw values: from the weekly
  // menu for a Ukesmeny slot, from the catalogue node otherwise.
  const rawProduct = catalogue.products.find((p) => p.databaseId === chosen.id) ?? {};
  const orderExtras = {
    co2: chosen.rawCo2 ?? rawProduct.c02 ?? null,
    kalorier: chosen.rawKalorier ?? rawProduct.kalorier ?? null,
    size: null,
  };

  const input = buildOrderInput({
    customerId: session.customerId,
    date: opts.date,
    productId: chosen.id,
    variationId: variation?.id ?? null,
    name: chosen.name,
    ...orderExtras,
    size: sizeLabel,
  });

  // --- show it, name the food, then act ---
  console.log(`Order for ${label}`);
  console.log(`  ${chosen.name}${sizeLabel ? ` (${sizeLabel})` : ''} — ${variation?.price ?? chosen.price}, ${chosen.categoryName}`);
  if (chosen.dish) console.log(`  dish: ${chosen.dish}`);
  console.log(`  why: ${why}`);
  if (chosen.allergener?.length) console.log(`  allergener: ${chosen.allergener.join(', ')}`);
  console.log(`  deadline ${osloTime(deadline.at)} — ${formatCountdown(deadline.minutesLeft)} left`);

  if (!opts.yes) {
    console.log('\nDRY RUN — nothing was ordered.');
    console.log('  would run createDailyOrder with:');
    console.log(JSON.stringify(input, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
    console.log(`\nTo do it: node scripts/order-add.mjs ${opts.date} --yes`);
    return;
  }

  const { order } = await createOrder(session, {
    date: opts.date,
    productId: chosen.id,
    variationId: variation?.id ?? null,
    name: chosen.name,
    ...orderExtras,
    size: sizeLabel,
  });

  // Verify through the same path the rest of the tool reads, rather than trusting the
  // mutation's echo — which comes back with null id and orderNumber, exactly like
  // checkExistingOrder does. This re-read is also what proves the delivery_date meta
  // landed; without that meta the day would still look free to every other feature.
  const [after] = await resolveOrderStatus(session, [opts.date]);
  const confirmed = after.order ?? {};
  const number = confirmed.orderNumber ?? order?.orderNumber ?? null;

  if (after.exists) {
    console.log(`\n✅ Ordered ${number ? `#${number}` : '(order number unavailable)'} — ${chosen.name} for ${label}.`);
    console.log(
      `   verified via ${after.sources.join(' + ')}: ${confirmed.items?.map((i) => i.name).join(', ') || 'order present'}` +
        `${confirmed.status ? ` (${confirmed.status})` : ''}`,
    );
  } else {
    console.log(`\n⚠ The mutation reported success, but ${label} still shows no order on a re-check.`);
    console.log('   The delivery_date meta may not have stuck. Check https://lunsjkokkene.no/dashboard before ordering again.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = err.code === 'ALREADY_ORDERED' || err.code === 'RACED' ? 2 : 1;
});
