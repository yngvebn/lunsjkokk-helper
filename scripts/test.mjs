#!/usr/bin/env node
/** Smoke tests for the bits where being quietly wrong would ship a reminder on the wrong day. */

import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { awayDates, clearAway, describeDate, listAway, loadAway, markAway, pruneAway } from '../src/away.mjs';

import { cutoffDateFor, deadlinesFor, nextOrderableDate } from '../src/deadline.mjs';
import { LUNCH_CATEGORIES, formatKr, parsePriceOre, visibleCategories } from '../src/menu.mjs';
import { addDays, isoWeek, mondayOf, osloInstant, osloParts, osloToday } from '../src/oslo.mjs';
import { allergyMetaKey, buildOrderInput, createOrder, deleteOrder, productSlug } from '../src/mutations.mjs';
import { resolveOrderStatus } from '../src/orders.mjs';
import { DEFAULT_EXCLUDED, loadPreferences, validatePreferences } from '../src/preferences.mjs';
import { rankDay } from '../src/suggest.mjs';

const EXAMPLE_PROFILE = JSON.parse(
  await readFile(new URL('../preferences.example.json', import.meta.url), 'utf8'),
);

/** Deliberately not anyone's real customer id. */
const FAKE_CUSTOMER_ID = 1234;

let ran = 0;
const test = (name, fn) => {
  try {
    fn();
    ran++;
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

// --- Oslo wall clock -------------------------------------------------------
test('summer time is UTC+2', () => {
  // 2026-07-01 13:00 Oslo (CEST) == 11:00Z
  assert.equal(osloInstant(2026, 7, 1, 13, 0).toISOString(), '2026-07-01T11:00:00.000Z');
});

test('winter time is UTC+1', () => {
  // 2026-01-15 13:00 Oslo (CET) == 12:00Z
  assert.equal(osloInstant(2026, 1, 15, 13, 0).toISOString(), '2026-01-15T12:00:00.000Z');
});

test('DST spring-forward boundary', () => {
  // Oslo springs forward 2026-03-29 02:00 -> 03:00. 13:00 that day is CEST.
  assert.equal(osloInstant(2026, 3, 29, 13, 0).toISOString(), '2026-03-29T11:00:00.000Z');
  // The day before is still CET.
  assert.equal(osloInstant(2026, 3, 28, 13, 0).toISOString(), '2026-03-28T12:00:00.000Z');
});

test('DST autumn-back boundary', () => {
  // Oslo falls back 2026-10-25 03:00 -> 02:00.
  assert.equal(osloInstant(2026, 10, 24, 13, 0).toISOString(), '2026-10-24T11:00:00.000Z');
  assert.equal(osloInstant(2026, 10, 26, 13, 0).toISOString(), '2026-10-26T12:00:00.000Z');
});

test('round-trips through osloParts', () => {
  for (const [m, d] of [[1, 15], [3, 29], [7, 1], [10, 25], [12, 31]]) {
    const p = osloParts(osloInstant(2026, m, d, 13, 0));
    assert.deepEqual([p.y, p.m, p.d, p.hh, p.mi], [2026, m, d, 13, 0]);
  }
});

test('osloToday is timezone-pinned, not host-local', () => {
  // 2026-06-30 23:30Z is already 2026-07-01 in Oslo.
  assert.equal(osloToday(new Date('2026-06-30T23:30:00Z')), '2026-07-01');
  // 2026-01-01 00:30Z is still 2026-01-01 in Oslo (UTC+1).
  assert.equal(osloToday(new Date('2026-01-01T00:30:00Z')), '2026-01-01');
});

// --- calendar helpers -----------------------------------------------------
test('mondayOf handles Sunday', () => {
  assert.equal(mondayOf('2026-09-06'), '2026-08-31'); // Sunday -> previous Monday
  assert.equal(mondayOf('2026-08-31'), '2026-08-31');
  assert.equal(mondayOf('2026-09-04'), '2026-08-31');
});

test('addDays crosses month and year', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('isoWeek', () => {
  assert.equal(isoWeek('2026-08-31'), 36);
  assert.equal(isoWeek('2026-01-01'), 1);
});

// --- deadline rules -------------------------------------------------------
test('Monday delivery rolls back to Friday', () => {
  assert.equal(cutoffDateFor('2026-08-31'), '2026-08-28'); // Mon -> Fri
});

test('Sunday delivery rolls back to Friday', () => {
  assert.equal(cutoffDateFor('2026-09-06'), '2026-09-04'); // Sun -> Fri
});

test('midweek delivery closes the day before', () => {
  assert.equal(cutoffDateFor('2026-09-03'), '2026-09-02'); // Thu -> Wed
  assert.equal(cutoffDateFor('2026-09-01'), '2026-08-31'); // Tue -> Mon
});

test('deadline is 13:00 Oslo on the cutoff date', () => {
  const d = deadlinesFor('2026-09-03', new Date('2026-09-01T00:00:00Z'));
  assert.equal(d.cutoffDate, '2026-09-02');
  assert.equal(d.at, '2026-09-02T11:00:00.000Z'); // 13:00 CEST
});

test('deadline follows Oslo across DST, not a fixed UTC offset', () => {
  // Delivery Thu 2026-01-15 -> cutoff Wed 14th 13:00 CET == 12:00Z
  assert.equal(deadlinesFor('2026-01-15').at, '2026-01-14T12:00:00.000Z');
});

test('hasPassed flips exactly at the cutoff instant', () => {
  const just = deadlinesFor('2026-09-03', new Date('2026-09-02T10:59:59Z'));
  assert.equal(just.hasPassed, false);
  const gone = deadlinesFor('2026-09-03', new Date('2026-09-02T11:00:00Z'));
  assert.equal(gone.hasPassed, true);
});

test('nextOrderableDate skips weekends, closed days and passed deadlines', () => {
  // Tuesday 2026-09-01 09:00 Oslo — Wednesday's 13:00 cutoff is still open.
  const now = new Date('2026-09-01T07:00:00Z');
  assert.equal(nextOrderableDate('2026-09-01', [], now), '2026-09-02');
  // 13:00 Oslo == 11:00Z: Wednesday has just closed, so Thursday is next.
  assert.equal(nextOrderableDate('2026-09-01', [], new Date('2026-09-01T11:00:00Z')), '2026-09-03');
  // Closing Wednesday and Thursday pushes it to Friday.
  assert.equal(nextOrderableDate('2026-09-01', ['2026-09-02', '2026-09-03'], now), '2026-09-04');
});

test('nextOrderableDate never returns a weekend', () => {
  // Friday 2026-09-04 15:00 Oslo — everything this week is gone.
  const next = nextOrderableDate('2026-09-04', [], new Date('2026-09-04T13:00:00Z'));
  assert.equal(next, '2026-09-08'); // Tuesday: Monday's Friday-13:00 cutoff has passed
});

// --- category filtering ---------------------------------------------------
const CATS = [
  { slug: 'hakone', name: 'Hakone', menuOrder: 0 },
  { slug: 'ukesmeny', name: 'Ukesmeny', menuOrder: 1 },
  { slug: 'ferdigretter', name: 'Ferdigretter', menuOrder: 2 },
  { slug: 'brodmat', name: 'Brødmat', menuOrder: 3 },
  { slug: 'kaker', name: 'Kaker', menuOrder: 4 },
  { slug: 'innom', name: 'INNOM', menuOrder: 6 },
  { slug: 'wraps', name: 'Wraps', menuOrder: 7 },
  { slug: 'salater', name: 'Salater', menuOrder: 8 },
  { slug: 'drikke', name: 'Drikkevarer', menuOrder: 13 },
  { slug: 'uncategorized', name: 'Uncategorized', menuOrder: 17 },
];
const slugs = (opts) => visibleCategories(CATS, opts).map((c) => c.slug);

test('default filter keeps only the five lunch categories, in menuOrder', () => {
  assert.deepEqual(slugs({}), ['ukesmeny', 'ferdigretter', 'brodmat', 'wraps', 'salater']);
});

test('LUNCH_CATEGORIES is what the default filter uses', () => {
  assert.deepEqual([...LUNCH_CATEGORIES].sort(), [...slugs({})].sort());
});

test('only: null falls back to the site rules', () => {
  const all = slugs({ only: null });
  assert.ok(all.includes('kaker') && all.includes('drikke'));
  assert.ok(!all.includes('uncategorized'), 'uncategorized stays hidden');
  assert.ok(!all.includes('innom'), 'discount ranges stay hidden without a group');
  assert.ok(!all.includes('hakone'));
});

test('a matching discountGroup unlocks its range', () => {
  assert.ok(slugs({ only: null, discountGroup: 'innom' }).includes('innom'));
  assert.ok(!slugs({ only: null, discountGroup: 'innom' }).includes('hakone'));
});

test('an explicit slug list wins over the default', () => {
  assert.deepEqual(slugs({ only: ['wraps', 'salater'] }), ['wraps', 'salater']);
  // Order comes from menuOrder, not the argument order.
  assert.deepEqual(slugs({ only: ['salater', 'brodmat'] }), ['brodmat', 'salater']);
});

test('explicit filtering still respects the site exclusions', () => {
  assert.deepEqual(slugs({ only: ['kaker', 'uncategorized'] }), ['kaker']);
  assert.deepEqual(slugs({ only: ['kaker', 'uncategorized'], includeHidden: true }), ['kaker', 'uncategorized']);
});

// --- price parsing --------------------------------------------------------
test('parsePriceOre', () => {
  assert.equal(parsePriceOre('79,00kr'), 7900);
  assert.equal(parsePriceOre('64,57kr'), 6457);
  assert.equal(parsePriceOre('79,00kr - 89,00kr'), 7900);
  assert.equal(parsePriceOre('1 250,00kr'), 125000);
  assert.equal(parsePriceOre(null), null);
  assert.equal(parsePriceOre(''), null);
});

test('formatKr', () => {
  assert.equal(formatKr(7900), '79,00 kr');
  assert.equal(formatKr(null), null);
});

// --- suggestion ranking ---------------------------------------------------
const PREFS = {
  proteins: { preferred: ['kylling', 'skinke'], acceptable: ['laks', 'ost'] },
  avoid: { hard: [], soft: ['Nøtter'] },
  categories: {
    primary: ['brodmat'],
    secondary: ['wraps'],
    occasional: ['ferdigretter'],
    perDishOverrides: { Lasagne: 'occasional-favourite', 'Indisk masala': 'low' },
    occasionalCooldownDays: 7,
    occasionalFallbackWeekday: 'fredag',
  },
  portion: { dagensRett: 'Vanlig' },
  excludeFromMealRanking: ['Engangsbestikk og serviett'],
};

const item = (name, extra = {}) => ({ name, description: '', allergener: [], kcal: null, price: '79,00 kr', ...extra });
const dagens = (dish, extra = {}) => ({ slot: 'rett', label: 'Dagens rett', dish, allergener: [], sizes: [], ...extra });
const makeDay = (over = {}) => ({
  weekday: 'torsdag',
  deliveryDate: '2026-09-03',
  isClosed: false,
  deadline: { hasPassed: false },
  dagens: null,
  alacarte: [
    { slug: 'brodmat', name: 'Brødmat', items: [item('Sandwich med skinke'), item('Baguette med ost'), item('Engangsbestikk og serviett')] },
    { slug: 'wraps', name: 'Wraps', items: [item('Kyllingwrap')] },
    { slug: 'ferdigretter', name: 'Ferdigretter', items: [item('Lasagne'), item('Indisk masala')] },
    { slug: 'kaker', name: 'Kaker', items: [item('Brownies')] },
  ],
  ...over,
});

test('primary category with a preferred protein wins', () => {
  assert.equal(rankDay(makeDay(), PREFS).shortlist[0].name, 'Sandwich med skinke');
});

test('a category the profile says nothing about is dropped entirely', () => {
  assert.ok(!rankDay(makeDay(), PREFS).candidates.some((c) => c.name === 'Brownies'));
});

test('excluded add-ons go to extras, never candidates', () => {
  const r = rankDay(makeDay(), PREFS);
  assert.ok(!r.candidates.some((c) => c.name === 'Engangsbestikk og serviett'));
  assert.ok(r.extras.some((e) => e.name === 'Engangsbestikk og serviett'));
});

test('a disliked allergen sinks an item but never removes it', () => {
  const day = makeDay({
    alacarte: [
      {
        slug: 'brodmat',
        name: 'Brødmat',
        items: [item('Nøttesandwich med skinke', { allergener: ['Nøtter'] }), item('Baguette med ost')],
      },
    ],
  });
  const r = rankDay(day, PREFS);
  assert.ok(r.candidates.some((c) => c.name === 'Nøttesandwich med skinke'), 'dislike, not allergy — stays selectable');
  assert.equal(r.candidates[0].name, 'Baguette med ost', 'but ranked below');
});

test('a "low" override sinks below a normal item in the same category', () => {
  // fredag, so Lasagne is due and scored on its merits rather than held back.
  const names = rankDay(makeDay({ weekday: 'fredag' }), PREFS).candidates.map((c) => c.name);
  assert.ok(names.indexOf('Indisk masala') > names.indexOf('Lasagne'));
});

test('a held-back favourite keeps its rank but is never offered', () => {
  const r = rankDay(makeDay({ weekday: 'torsdag' }), PREFS);
  const lasagne = r.candidates.find((c) => c.name === 'Lasagne');
  const masala = r.candidates.find((c) => c.name === 'Indisk masala');
  assert.equal(lasagne.heldBack, true);
  assert.ok(lasagne.score > masala.score, 'on cooldown is not the same as disliked');
  assert.ok(!r.shortlist.some((c) => c.name === 'Lasagne'), 'but not offered today');
  assert.ok(r.heldBack.some((c) => c.name === 'Lasagne'), 'and reported as held back');
});

test('occasional favourite is held back off its fallback weekday', () => {
  const thu = rankDay(makeDay({ weekday: 'torsdag' }), PREFS);
  const fri = rankDay(makeDay({ weekday: 'fredag' }), PREFS);
  assert.ok(!thu.shortlist.some((c) => c.name === 'Lasagne'), 'not offered on torsdag');
  assert.ok(fri.shortlist.some((c) => c.name === 'Lasagne'), 'offered on fredag');
  assert.ok(thu.candidates.find((c) => c.name === 'Lasagne').reasons.some((x) => x.includes('fredag')));
});

test('order history overrides the weekday fallback', () => {
  const r = rankDay(makeDay({ weekday: 'torsdag' }), PREFS, { recentNames: ['Baguette med ost'] });
  const lasagne = r.candidates.find((c) => c.name === 'Lasagne');
  assert.ok(lasagne.reasons.some((x) => x.includes('due')), 'not eaten recently, so due whatever the weekday');
});

test('a recently ordered favourite is suppressed even when due by weekday', () => {
  const r = rankDay(makeDay({ weekday: 'fredag' }), PREFS, { recentNames: ['Lasagne'] });
  const lasagne = r.candidates.find((c) => c.name === 'Lasagne');
  assert.ok(lasagne.reasons.some((x) => x.includes('last 7 days')));
  assert.ok(!r.shortlist.some((c) => c.name === 'Lasagne'));
});

test('avoidNames pushes yesterday down', () => {
  const r = rankDay(makeDay(), PREFS, { avoidNames: new Set(['Sandwich med skinke']) });
  assert.notEqual(r.shortlist[0].name, 'Sandwich med skinke');
});

test('shortlist spans categories rather than five near-identical breads', () => {
  assert.ok(new Set(rankDay(makeDay(), PREFS).shortlist.map((c) => c.category)).size >= 2);
});

test('ukesmeny flag needs more than a preferred protein', () => {
  // The dish duplicates an à la carte item: nothing novel, no repeat pressure.
  const day = makeDay({ dagens: { rett: dagens('Baguette med ost og skinke') } });
  assert.equal(rankDay(day, PREFS).ukesmeny.flagged.length, 0);
});

test('ukesmeny flags a genuinely novel dish with a preferred protein', () => {
  const day = makeDay({ dagens: { rett: dagens('Rissalat med cayennebakt blomkål, stekt skinke og reddiker') } });
  const flagged = rankDay(day, PREFS).ukesmeny.flagged;
  assert.equal(flagged.length, 1);
  assert.ok(flagged[0].isNovel);
});

test('ukesmeny never flags a dish containing something disliked', () => {
  const day = makeDay({ dagens: { rett: dagens('Rissalat med cayennebakt blomkål og skinke', { allergener: ['Nøtter'] }) } });
  assert.equal(rankDay(day, PREFS).ukesmeny.flagged.length, 0);
});

test('warm ukesmeny slots are never even considered', () => {
  const day = makeDay({
    dagens: { varmrett: { slot: 'varmrett', label: 'Dagens varmrett', dish: 'Kyllinggryte med cayennebakt blomkål', allergener: [], sizes: [] } },
  });
  assert.equal(rankDay(day, PREFS).ukesmeny.considered.length, 0);
});

test('Vanlig is priced, not Stor', () => {
  const day = makeDay({
    dagens: {
      rett: dagens('Rissalat med cayennebakt blomkål og skinke', {
        price: '79,00 kr',
        sizes: [{ name: 'Stor', price: '89,00 kr' }, { name: 'Vanlig', price: '79,00 kr' }],
      }),
    },
  });
  assert.equal(rankDay(day, PREFS).ukesmeny.considered[0].price, '79,00 kr');
});

test('ø/æ/å do not split words when measuring novelty', () => {
  const day = makeDay({ dagens: { rett: dagens('Firkornsbrød med aspargesbønner og skinke') } });
  const c = rankDay(day, PREFS).ukesmeny.considered[0];
  assert.ok(c.novelWords.includes('firkornsbrod'), `got ${JSON.stringify(c.novelWords)}`);
  assert.ok(c.novelWords.includes('aspargesbonner'));
});

test('a closed or menu-less day produces no ukesmeny candidates', () => {
  assert.equal(rankDay(makeDay({ dagens: null }), PREFS).ukesmeny.available, false);
});

// --- order existence -------------------------------------------------------
// Modelled on real responses: checkExistingOrder only matches PROCESSING orders and
// returns null identifiers even when it does match, so history has to fill both gaps.
function fakeSession({ probe = {}, orders = [] } = {}) {
  return {
    customerId: FAKE_CUSTOMER_ID,
    gql: async (query, vars) => {
      if (query.includes('checkExistingOrder')) {
        const hit = probe[vars.deliveryDate];
        return { checkExistingOrder: hit ? { exists: true, order: hit } : { exists: false, order: null } };
      }
      return {
        orders: {
          nodes: orders.map((o) => ({
            databaseId: o.id,
            orderNumber: o.orderNumber,
            date: '2026-08-30T10:00:00',
            status: o.status,
            total: '79,00 kr',
            lineItems: { nodes: [{ quantity: 1, total: '79', product: { node: { databaseId: 1, name: o.item } } }] },
            metaData: [{ key: 'delivery_date', value: o.deliveryDate }],
          })),
        },
      };
    },
  };
}

const asyncTest = async (name, fn) => {
  try {
    await fn();
    ran++;
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

await asyncTest('a PAKKET order the probe misses is still found via history', async () => {
  const session = fakeSession({
    probe: {},
    orders: [{ id: 1, orderNumber: '240198', status: 'PAKKET', item: 'Baguette', deliveryDate: '2026-08-31' }],
  });
  const [r] = await resolveOrderStatus(session, ['2026-08-31']);
  assert.equal(r.exists, true, 'must not report an ordered day as free');
  assert.equal(r.order.orderNumber, '240198');
  assert.deepEqual(r.sources, ['history']);
  assert.equal(r.disagreement, true);
});

await asyncTest('the probe supplies the order number from history, not its own nulls', async () => {
  const session = fakeSession({
    probe: { '2026-09-04': { databaseId: null, status: 'PROCESSING', orderNumber: null } },
    orders: [{ id: 9, orderNumber: '241809', status: 'PROCESSING', item: 'Lasagne', deliveryDate: '2026-09-04' }],
  });
  const [r] = await resolveOrderStatus(session, ['2026-09-04']);
  assert.equal(r.order.orderNumber, '241809');
  assert.deepEqual(r.sources, ['checkExistingOrder', 'history']);
  assert.equal(r.disagreement, false);
});

await asyncTest('a genuinely free day reports free', async () => {
  const [r] = await resolveOrderStatus(fakeSession(), ['2026-09-02']);
  assert.equal(r.exists, false);
  assert.equal(r.order, null);
});

await asyncTest('the probe alone is trusted when history has no delivery date', async () => {
  const session = fakeSession({ probe: { '2026-09-04': { databaseId: null, status: 'PROCESSING', orderNumber: null } } });
  const [r] = await resolveOrderStatus(session, ['2026-09-04']);
  assert.equal(r.exists, true, 'never lose an order because history metadata is missing');
  assert.equal(r.order.status, 'PROCESSING');
});

// --- away days -------------------------------------------------------------
// Uses a temp file so the real away.json is never touched.
const AWAY_TMP = join(tmpdir(), `lunsj-away-test-${process.pid}.json`);
const awayOpts = { path: AWAY_TMP };

await asyncTest('marking a day away is remembered with its weekday and reason', async () => {
  await rm(AWAY_TMP, { force: true });
  const r = await markAway(['2026-09-02', '2026-09-03'], { reason: 'kundemøte', ...awayOpts });
  assert.deepEqual(r.added, ['2026-09-02', '2026-09-03']);
  const list = await listAway(awayOpts);
  assert.equal(list.length, 2);
  assert.equal(list[0].reason, 'kundemøte');
  assert.ok(list[0].setAt, 'records when it was set');
  assert.equal(describeDate('2026-09-02'), 'onsdag 2026-09-02');
});

await asyncTest('re-marking is idempotent — a careless daily job cannot duplicate', async () => {
  const r = await markAway(['2026-09-02', '2026-09-03'], awayOpts);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.alreadyMarked, ['2026-09-02', '2026-09-03']);
  assert.equal((await listAway(awayOpts)).length, 2, 'still two entries, not four');
});

await asyncTest('away dates are exposed as a set for skip checks', async () => {
  const set = await awayDates(awayOpts);
  assert.ok(set.has('2026-09-03'));
  assert.ok(!set.has('2026-09-04'));
});

await asyncTest('nextOrderableDate skips away days like closed days', async () => {
  const set = [...(await awayDates(awayOpts))];
  // Tuesday 09:00 Oslo; Wed and Thu are away, so Friday is the next day needing a decision.
  const next = nextOrderableDate('2026-09-01', set, new Date('2026-09-01T07:00:00Z'));
  assert.equal(next, '2026-09-04');
});

await asyncTest('only an explicit remove brings a day back', async () => {
  const r = await clearAway(['2026-09-02'], awayOpts);
  assert.deepEqual(r.removed, ['2026-09-02']);
  const set = await awayDates(awayOpts);
  assert.ok(!set.has('2026-09-02'), 'back in play');
  assert.ok(set.has('2026-09-03'), 'the other day is untouched');
});

await asyncTest('removing a day that was never marked is reported, not silent', async () => {
  const r = await clearAway(['2026-09-09'], awayOpts);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.notMarked, ['2026-09-09']);
});

await asyncTest('a re-mark with a new reason updates rather than duplicating', async () => {
  await markAway(['2026-09-03'], { reason: 'ferie', ...awayOpts });
  const list = await listAway(awayOpts);
  assert.equal(list.filter((a) => a.date === '2026-09-03').length, 1);
  assert.equal(list.find((a) => a.date === '2026-09-03').reason, 'ferie');
});

await asyncTest('prune drops past entries only', async () => {
  await markAway(['2026-08-20', '2026-12-24'], awayOpts);
  const r = await pruneAway({ before: '2026-09-01', ...awayOpts });
  assert.deepEqual(r.pruned, ['2026-08-20']);
  const set = await awayDates(awayOpts);
  assert.ok(set.has('2026-12-24'));
  assert.ok(!set.has('2026-08-20'));
});

await asyncTest('a bad date is rejected instead of stored', async () => {
  await assert.rejects(() => markAway(['2026-13-01'], awayOpts), /Not a real date|Not an ISO date/);
  await assert.rejects(() => markAway(['wednesday'], awayOpts), /Not an ISO date/);
  const set = await awayDates(awayOpts);
  assert.ok(!set.has('wednesday'));
});

await asyncTest('a missing file reads as empty, a corrupt one throws', async () => {
  const missing = join(tmpdir(), `lunsj-away-nope-${process.pid}.json`);
  assert.deepEqual((await loadAway(missing)).away, []);
  const corrupt = join(tmpdir(), `lunsj-away-bad-${process.pid}.json`);
  await writeFile(corrupt, '{ not json', 'utf8');
  // Silently treating corruption as empty would resurrect every away day.
  await assert.rejects(() => loadAway(corrupt), /Could not read/);
  await rm(corrupt, { force: true });
});

await rm(AWAY_TMP, { force: true });

// --- mutations --------------------------------------------------------------
test('buildOrderInput carries the meta every history feature depends on', () => {
  const input = buildOrderInput({ customerId: FAKE_CUSTOMER_ID, date: '2026-09-09', productId: 127154, name: 'Club Sandwich' });
  const meta = Object.fromEntries(input.metaData.map((m) => [m.key, m.value]));
  // Without delivery_date the order is invisible to getRecentOrders/resolveOrderStatus,
  // so the day would read as free after ordering it.
  assert.equal(meta.delivery_date, '2026-09-09');
  assert.equal(meta.order_type, 'personal');
  assert.equal(input.status, 'PROCESSING');
  assert.equal(input.customerId, FAKE_CUSTOMER_ID);
});

test('delivery_day is ENGLISH — the website cannot see the order otherwise', () => {
  // Regression test for a real bug. The client keys orders as `${delivery_day}-${date}`
  // (getOrderKey) and the menu page looks up English weekdays, so a Norwegian value
  // produces an order that exists, has a correct delivery_date, is found by order
  // history — and is invisible in the UI. Verified against every site-created order:
  // "monday", "tuesday", "friday".
  const cases = [
    ['2026-09-07', 'monday'],
    ['2026-09-08', 'tuesday'],
    ['2026-09-09', 'wednesday'],
    ['2026-09-03', 'thursday'],
    ['2026-09-04', 'friday'],
  ];
  for (const [date, expected] of cases) {
    const input = buildOrderInput({ customerId: 1, date, productId: 1, name: 'x' });
    const meta = Object.fromEntries(input.metaData.map((m) => [m.key, m.value]));
    assert.equal(meta.delivery_day, expected, `${date} should be ${expected}`);
    assert.equal(input.deliveryDay, expected, 'the input field must match the meta');
  }
});

test('the order key the site builds matches what the UI would look up', () => {
  // getOrderKey(day, date) => `${day}-${date}`
  const input = buildOrderInput({ customerId: 1, date: '2026-09-03', productId: 1, name: 'x' });
  const meta = Object.fromEntries(input.metaData.map((m) => [m.key, m.value]));
  assert.equal(`${meta.delivery_day}-${meta.delivery_date}`, 'thursday-2026-09-03');
});

test('productSlug reproduces the site meta key names', () => {
  assert.equal(productSlug('Sandwich med spicy eggesalat'), 'sandwich_med_spicy_eggesalat');
  assert.equal(productSlug('Foccacia med Brie & pesto'), 'foccacia_med_brie_pesto');
  assert.equal(productSlug('Lasagne'), 'lasagne');
  assert.equal(productSlug('Club Sandwich'), 'club_sandwich');
  // Splits on " - " so a variation keys off the base product name.
  assert.equal(productSlug('Dagens rett - Vanlig'), 'dagens_rett');
  // Nordic characters transliterate rather than being stripped.
  assert.equal(productSlug('Rødbetsalat med chèvre'), 'rodbetsalat_med_chevre');
});

test('per-product meta matches the site, and passes co2 through verbatim', () => {
  const input = buildOrderInput({
    customerId: 1,
    date: '2026-09-09',
    productId: 127150,
    name: 'Sandwich med spicy eggesalat',
    co2: '0,37',
    kalorier: '615',
  });
  const meta = Object.fromEntries(input.metaData.map((m) => [m.key, m.value]));
  assert.equal(meta['product_127150_sandwich_med_spicy_eggesalat_allergies'], '[]');
  // Comma decimals must survive: Number('0,37') is NaN, so these are strings end to end.
  assert.equal(meta['product_127150_co2'], '0,37');
  assert.equal(meta['product_127150_kalorier'], '615');
});

test('a variation order matches the site meta shape exactly', () => {
  // Verified against real order #234319 (Dagens rett - Vanlig):
  //   product_102367_variation_102368_dagens_rett_allergies
  //   line meta [{storrelse: "Vanlig"}, {_allergies: "[]"}]
  const input = buildOrderInput({
    customerId: FAKE_CUSTOMER_ID,
    date: '2026-09-08',
    productId: 102367,
    variationId: 102368,
    name: 'Dagens rett',
    size: 'Vanlig',
    co2: '2135',
    kalorier: '383',
  });
  const meta = Object.fromEntries(input.metaData.map((m) => [m.key, m.value]));
  assert.equal(meta['product_102367_variation_102368_dagens_rett_allergies'], '[]');
  assert.ok(!('product_102367_dagens_rett_allergies' in meta), 'the simple form must not be used for a variation');
  const line = input.lineItems[0];
  assert.equal(line.variationId, 102368);
  assert.deepEqual(line.metaData, [
    { key: 'storrelse', value: 'Vanlig' },
    { key: '_allergies', value: '[]' },
  ]);
});

test('allergyMetaKey picks the right form', () => {
  assert.equal(allergyMetaKey(127154, null, 'Club Sandwich'), 'product_127154_club_sandwich_allergies');
  assert.equal(allergyMetaKey(102367, 102368, 'Dagens rett'), 'product_102367_variation_102368_dagens_rett_allergies');
});

test('a simple product carries no storrelse', () => {
  const input = buildOrderInput({ customerId: 1, date: '2026-09-09', productId: 127154, name: 'Club Sandwich' });
  assert.deepEqual(input.lineItems[0].metaData, [{ key: '_allergies', value: '[]' }]);
});

test('per-product co2/kalorier meta is omitted when the catalogue has none', () => {
  const input = buildOrderInput({ customerId: 1, date: '2026-09-09', productId: 164932, name: 'Lasagne' });
  const keys = input.metaData.map((m) => m.key);
  assert.ok(keys.includes('product_164932_lasagne_allergies'));
  assert.ok(!keys.includes('product_164932_co2'), 'absent rather than null, as on real orders');
});

test('buildOrderInput never sends a price — the server prices the line', () => {
  const [line] = buildOrderInput({ customerId: 1, date: '2026-09-09', productId: 5, name: 'x' }).lineItems;
  assert.ok(!('total' in line), 'total would let the order disagree with the catalogue');
  assert.ok(!('subtotal' in line));
  assert.equal(line.quantity, 1);
});

test('buildOrderInput omits variationId unless there is one', () => {
  const plain = buildOrderInput({ customerId: 1, date: '2026-09-09', productId: 5, name: 'x' });
  assert.ok(!('variationId' in plain.lineItems[0]));
  const varied = buildOrderInput({ customerId: 1, date: '2026-09-09', productId: 5, variationId: 9, name: 'x' });
  assert.equal(varied.lineItems[0].variationId, 9);
});

test('buildOrderInput rejects nonsense rather than sending it', () => {
  assert.throws(() => buildOrderInput({ customerId: 'abc', date: '2026-09-09', productId: 1, name: 'x' }), /customerId/);
  assert.throws(() => buildOrderInput({ customerId: 1, date: '2026-09-09', productId: 'x', name: 'x' }), /productId/);
  assert.throws(() => buildOrderInput({ customerId: 1, date: '2026-09-09', productId: 1, name: 'x', quantity: 0 }), /quantity/);
  assert.throws(() => buildOrderInput({ customerId: 1, date: 'friday', productId: 1, name: 'x' }), /ISO date/);
});

function mutationSession({ orders = [], probe = {}, onMutate = null, wasExisting = false } = {}) {
  const calls = [];
  return {
    calls,
    customerId: FAKE_CUSTOMER_ID,
    gql: async (query, vars) => {
      if (query.includes('checkExistingOrder')) {
        const hit = probe[vars.deliveryDate];
        return { checkExistingOrder: hit ? { exists: true, order: hit } : { exists: false, order: null } };
      }
      if (query.includes('GetCustomerOrders')) {
        return {
          orders: {
            nodes: orders.map((o) => ({
              databaseId: o.id,
              orderNumber: o.orderNumber,
              date: '2026-09-01T10:00:00',
              status: o.status,
              total: '79,00 kr',
              lineItems: { nodes: [{ quantity: 1, total: '79', product: { node: { databaseId: 1, name: o.item } } }] },
              metaData: [{ key: 'delivery_date', value: o.deliveryDate }],
            })),
          },
        };
      }
      calls.push({ query, vars });
      if (onMutate) return onMutate(query, vars);
      if (query.includes('createDailyOrder')) {
        return { createDailyOrder: { wasExisting, order: { databaseId: 999, orderNumber: '999', status: 'PROCESSING' } } };
      }
      return { deleteOrder: { order: { databaseId: vars.input.orderId, orderNumber: 'X', status: 'TRASH' } } };
    },
  };
}

await asyncTest('createOrder refuses a day that already has an order', async () => {
  const session = mutationSession({
    orders: [{ id: 1, orderNumber: '241809', status: 'PROCESSING', item: 'Lasagne', deliveryDate: '2026-09-04' }],
  });
  await assert.rejects(
    () => createOrder(session, { date: '2026-09-04', productId: 5, name: 'x' }),
    (e) => e.code === 'ALREADY_ORDERED' && /Lasagne/.test(e.message),
  );
  assert.equal(session.calls.length, 0, 'must not have issued any mutation');
});

await asyncTest('createOrder refuses a PAKKET day the site probe would miss', async () => {
  const session = mutationSession({
    orders: [{ id: 2, orderNumber: '240198', status: 'PAKKET', item: 'Baguette', deliveryDate: '2026-08-31' }],
  });
  await assert.rejects(() => createOrder(session, { date: '2026-08-31', productId: 5, name: 'x' }), /already has an order/);
  assert.equal(session.calls.length, 0);
});

await asyncTest('createOrder treats wasExisting as a failure, never as success', async () => {
  // The site's own code would follow this with replaceOrderItems, silently overwriting
  // whatever was there. Refusing is the whole point of the guard.
  const session = mutationSession({ wasExisting: true });
  await assert.rejects(
    () => createOrder(session, { date: '2026-09-09', productId: 5, name: 'x' }),
    (e) => e.code === 'RACED' && /Nothing was created or changed/.test(e.message),
  );
  assert.equal(session.calls.filter((c) => c.query.includes('replaceOrderItems')).length, 0, 'must not fall through to replace');
});

await asyncTest('createOrder places the order on a free day', async () => {
  const session = mutationSession();
  const { order } = await createOrder(session, { date: '2026-09-09', productId: 127154, name: 'Club Sandwich' });
  assert.equal(order.orderNumber, '999');
  const create = session.calls.find((c) => c.query.includes('createDailyOrder'));
  assert.ok(create, 'issued the create');
  assert.equal(create.vars.input.metaData.find((m) => m.key === 'delivery_date').value, '2026-09-09');
});

await asyncTest('deleteOrder never hard-deletes', async () => {
  const session = mutationSession();
  await deleteOrder(session, { orderId: 242193, status: 'PROCESSING' });
  const del = session.calls.find((c) => c.query.includes('deleteOrder'));
  assert.equal(del.vars.input.orderId, 242193);
  assert.ok(!('forceDelete' in del.vars.input), 'omitted, so the order is trashed and recoverable');
});

await asyncTest('deleteOrder refuses a status the kitchen may have acted on', async () => {
  const session = mutationSession();
  await assert.rejects(
    () => deleteOrder(session, { orderId: 240198, status: 'PAKKET' }),
    (e) => e.code === 'STATUS_NOT_DELETABLE' && /already have made this food/.test(e.message),
  );
  assert.equal(session.calls.length, 0);
});

await asyncTest('deleteOrder allows an unusual status behind an explicit override', async () => {
  const session = mutationSession();
  await deleteOrder(session, { orderId: 240198, status: 'PAKKET', allowAnyStatus: true });
  assert.equal(session.calls.length, 1);
});

await asyncTest('deleteOrder rejects a non-integer id', async () => {
  await assert.rejects(() => deleteOrder(mutationSession(), { orderId: 'abc' }), /orderId/);
});

// --- preferences loading -----------------------------------------------------
const PREFS_TMP = join(tmpdir(), `lunsj-prefs-test-${process.pid}.json`);

await asyncTest('a missing profile explains itself instead of stack-tracing', async () => {
  await assert.rejects(
    () => loadPreferences(join(tmpdir(), 'definitely-not-here.json')),
    (e) => e.code === 'NO_PREFERENCES' && /lunsj-preferences/.test(e.message),
  );
});

await asyncTest('shared defaults fill in what a profile omits', async () => {
  await writeFile(PREFS_TMP, JSON.stringify({ categories: { primary: ['brodmat'] } }), 'utf8');
  const p = await loadPreferences(PREFS_TMP);
  // Add-ons are excluded for everyone, so they must not have to be listed per person.
  assert.deepEqual(p.excludeFromMealRanking, DEFAULT_EXCLUDED);
  assert.ok(p.excludeFromMealRanking.includes('Engangsbestikk og serviett'));
  assert.equal(p.categories.occasionalCooldownDays, 7);
  assert.equal(p.portion.dagensRett, 'Vanlig');
  // And the person's own values survive the merge.
  assert.deepEqual(p.categories.primary, ['brodmat']);
});

await asyncTest('an explicit empty exclusion list is respected, not overwritten', async () => {
  await writeFile(PREFS_TMP, JSON.stringify({ categories: { primary: ['brodmat'] }, excludeFromMealRanking: [] }), 'utf8');
  const p = await loadPreferences(PREFS_TMP);
  assert.deepEqual(p.excludeFromMealRanking, [], 'deliberate empty differs from absent');
});

await asyncTest('invalid JSON and bad shapes are reported, not swallowed', async () => {
  await writeFile(PREFS_TMP, '{ nope', 'utf8');
  await assert.rejects(() => loadPreferences(PREFS_TMP), /not valid JSON/);
  await writeFile(PREFS_TMP, JSON.stringify({ categories: { primary: 'brodmat' } }), 'utf8');
  await assert.rejects(() => loadPreferences(PREFS_TMP), /must be an array/);
});

test('validatePreferences catches the mistakes that empty the shortlist', () => {
  assert.deepEqual(validatePreferences({ categories: { primary: ['brodmat'] } }), []);
  assert.match(validatePreferences({ categories: {} })[0], /no categories listed/);
  assert.match(
    validatePreferences({ categories: { primary: ['brodmat'], secondary: ['brodmat'] } })[0],
    /more than one tier/,
  );
  assert.match(validatePreferences({ categories: { primary: ['x'] }, portion: { dagensRett: 'Enorm' } })[0], /Vanlig/);
  assert.match(validatePreferences({ categories: { primary: ['x'] }, proteins: { preferred: 'kylling' } })[0], /must be an array/);
});

test('the shipped example profile is valid', () => {
  // A template that fails validation is worse than no template.
  assert.deepEqual(validatePreferences(EXAMPLE_PROFILE), []);
});

await rm(PREFS_TMP, { force: true });

if (!process.exitCode) console.log(`ok — ${ran} tests passed`);
