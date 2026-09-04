/**
 * Turns the raw API shapes into something worth reading — or feeding to a skill that
 * has to pick lunch.
 *
 * The two halves of the menu are genuinely different things and are kept apart:
 *
 *   `dagens`   — five fixed product slots whose *content* changes daily. The product
 *                names are useless ("Dagens rett"); the dish lives in `beskrivelse`.
 *   `alacarte` — a stable catalogue with real names and prices, grouped by category
 *                in the site's own display order.
 */

import { deadlinesFor } from './deadline.mjs';
import { WEEKDAY_EN, WEEKDAY_NB, dayOfWeek, isoWeek, mondayOf, addDays } from './oslo.mjs';

/** Categories the site never renders. */
const HIDDEN_CATEGORIES = new Set(['ukategorisert', 'uncategorized', 'sommermeny']);
/** Discount-group ranges: hidden unless the company's `discountGroup` matches the slug. */
const DISCOUNT_GROUP_CATEGORIES = new Set(['innom', 'hakone']);

/**
 * What actually gets eaten for lunch. The site shows seventeen categories; twelve of
 * them are cake, drinks, buffet platters and groceries. This is the default filter —
 * pass `categories: null` for everything the site would render.
 */
export const LUNCH_CATEGORIES = ['ukesmeny', 'ferdigretter', 'brodmat', 'wraps', 'salater'];

/** The five Ukesmeny slots, by product databaseId. */
export const DAGENS_SLOTS = {
  102367: { key: 'rett', label: 'Dagens rett' },
  1946: { key: 'varmrett', label: 'Dagens varmrett' },
  242: { key: 'vegetar', label: 'Dagens vegetar' },
  2972: { key: 'vegansk', label: 'Dagens vegansk' },
  235: { key: 'paasmurt', label: 'Dagens påsmurt' },
};

/** "79,00kr" -> 7900 (øre). "79,00kr - 89,00kr" -> 7900, i.e. the low end. null stays null. */
export function parsePriceOre(formatted) {
  if (!formatted) return null;
  const first = String(formatted).split('-')[0];
  const m = /(\d[\d\s.]*),(\d{2})/.exec(first) ?? /(\d[\d\s.]*)/.exec(first);
  if (!m) return null;
  const kr = Number(String(m[1]).replace(/[\s.]/g, ''));
  const ore = m[2] ? Number(m[2]) : 0;
  return Number.isFinite(kr) ? kr * 100 + ore : null;
}

export const formatKr = (ore) => (ore == null ? null : `${(ore / 100).toFixed(2).replace('.', ',')} kr`);

/** The API returns "" and "0" for "not measured". Both mean nothing. */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const stripHtml = (html) =>
  String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Does this product's date range cover `date`?
 *
 * Mirrors `isProductVisible` from the site bundle. Note: every product currently
 * carries `availabilityType: "date_range"`, so the bundle's `"weekdays"` branch is
 * dead code — the `weekdays` array a human entered is NOT enforced by the site.
 * We surface it as `weekdayHint` rather than acting on it, so a suggestion skill can
 * decide for itself.
 */
function availableOn(product, date) {
  const a = product.produktTilgjengelighet;
  if (!a?.availabilityType) return true;
  if (a.availabilityType === 'date_range') {
    if (!a.fradato && !a.tildato) return true;
    const from = a.fradato ? String(a.fradato).slice(0, 10) : null;
    const to = a.tildato ? String(a.tildato).slice(0, 10) : null;
    if (!from || !to) return true;
    return date >= from && date <= to;
  }
  if (a.availabilityType === 'weekdays') {
    const day = WEEKDAY_EN[dayOfWeek(date)];
    if (day === 'saturday' || day === 'sunday') return false;
    return !a.weekdays?.length || a.weekdays.includes(day);
  }
  return true;
}

function normaliseProduct(p, date) {
  const cats = p.productCategories?.nodes ?? [];
  const variations = (p.variations?.nodes ?? []).map((v) => ({
    id: v.databaseId,
    name: v.name,
    priceOre: parsePriceOre(v.regularPrice),
    price: formatKr(parsePriceOre(v.regularPrice)),
    kcal: num(v.kalorier),
    co2: num(v.c02),
    restrictedToCompanies: v.restrictedToCompanies ?? [],
  }));
  return {
    id: p.databaseId,
    name: p.name,
    type: p.__typename,
    menuOrder: Number(p.menuOrder) || 0,
    priceOre: parsePriceOre(p.regularPrice),
    price: formatKr(parsePriceOre(p.regularPrice)),
    priceRaw: p.regularPrice ?? null,
    description: stripHtml(p.excerpt),
    allergener: (p.produkt?.allergener?.nodes ?? []).map((a) => a.title),
    kcal: num(p.kalorier),
    co2: num(p.c02),
    categories: cats.map((c) => c.slug),
    minimum: p.minimumsKvantitet?.harMinimumskvantitet ? Number(p.minimumsKvantitet.kvantitet) || null : null,
    availableOn: availableOn(p, date),
    availability: p.produktTilgjengelighet ?? null,
    weekdayHint: p.produktTilgjengelighet?.weekdays ?? null,
    restrictedToCompanies: p.restrictedToCompanies ?? [],
    image: p.image?.mediaItemUrl ?? null,
    variations,
  };
}

/**
 * Category list in the site's display order, with the site's exclusions applied.
 *
 * `categories` narrows the result to those slugs (default: `LUNCH_CATEGORIES`); pass
 * `null` for everything. `discountGroup` is a company setting (unknown until we
 * authenticate) that unlocks the matching range; `includeHidden` keeps the lot.
 */
export function visibleCategories(
  categories,
  { discountGroup = null, includeHidden = false, only = LUNCH_CATEGORIES } = {},
) {
  const group = String(discountGroup ?? 'ingen').toLowerCase();
  const wanted = only ? new Set(only.map((s) => s.toLowerCase())) : null;
  return categories
    .filter((c) => {
      const slug = c.slug.toLowerCase();
      if (wanted && !wanted.has(slug)) return false;
      if (includeHidden) return true;
      if (HIDDEN_CATEGORIES.has(slug)) return false;
      if (DISCOUNT_GROUP_CATEGORIES.has(slug) && slug !== group) return false;
      return true;
    })
    .sort((a, b) => (Number(a.menuOrder) || 0) - (Number(b.menuOrder) || 0));
}

/** Slugs the API knows about, for error messages when someone fat-fingers --categories. */
export const knownCategorySlugs = (catalogue) => catalogue.categories.map((c) => c.slug).sort();

/** The five Ukesmeny slots for one weekday, from a weekly-menu payload. */
function dagensFor(weeklyMenu, date, catalogueById) {
  if (!weeklyMenu) return null;
  const nb = WEEKDAY_NB[dayOfWeek(date)];
  const items = (weeklyMenu.menuItems ?? []).filter((i) => String(i.dag).toLowerCase() === nb);
  if (!items.length) return null;

  const out = {};
  for (const item of items) {
    const slot = DAGENS_SLOTS[Number(item.productId)];
    const product = catalogueById.get(Number(item.productId));
    const key = slot?.key ?? `product-${item.productId}`;
    out[key] = {
      slot: key,
      label: slot?.label ?? product?.name ?? `Produkt ${item.productId}`,
      productId: Number(item.productId),
      dish: String(item.beskrivelse ?? '').trim(),
      allergener: item.allergier ?? [],
      kcal: num(item.kalorier),
      kcalStor: num(item.kalorierStor),
      co2: num(item.co2),
      co2Stor: num(item.co2Stor),
      priceOre: product?.priceOre ?? null,
      price: product?.price ?? null,
      sizes: (product?.variations ?? []).map((v) => ({
        id: v.id,
        name: v.name.replace(/^.*?-\s*/, ''),
        priceOre: v.priceOre,
        price: v.price,
        restrictedToCompanies: v.restrictedToCompanies,
      })),
    };
  }
  return out;
}

/**
 * Everything you need to decide (or be nagged about) lunch on one delivery date.
 */
export function buildDay({ date, weeklyMenu, closedDays, catalogue, now = new Date(), options = {} }) {
  const closed = closedDays.find((c) => c.date === date) ?? null;
  const cats = visibleCategories(catalogue.categories, options);
  const allowedSlugs = new Set(cats.map((c) => c.slug));
  const ukesmenyIncluded = allowedSlugs.has('ukesmeny');
  // The slot products carry the Stor/Vanlig prices `dagens` needs. They live in the
  // ukesmeny category, so look them up directly rather than via the filtered list.
  const slotProducts = catalogue.products.filter((p) => DAGENS_SLOTS[p.databaseId]);

  const products = catalogue.products
    .map((p) => normaliseProduct(p, date))
    .filter((p) => p.categories.some((s) => allowedSlugs.has(s)));

  const alacarte = cats
    .filter((c) => c.slug !== 'ukesmeny')
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      items: products
        .filter((p) => p.categories.includes(c.slug) && p.availableOn)
        .sort((a, b) => a.menuOrder - b.menuOrder || a.name.localeCompare(b.name, 'nb')),
    }))
    .filter((g) => g.items.length);

  const byId = new Map([...slotProducts.map((p) => normaliseProduct(p, date)), ...products].map((p) => [p.id, p]));

  return {
    deliveryDate: date,
    weekday: WEEKDAY_NB[dayOfWeek(date)],
    isoWeek: isoWeek(date),
    menuRotation: weeklyMenu?.title ?? null, // a rotation label ("Meny uke 3"), NOT a calendar week
    isClosed: Boolean(closed),
    closedMessage: closed?.message ?? null,
    deadline: deadlinesFor(date, now),
    ukesmenyIncluded,
    dagens: ukesmenyIncluded ? dagensFor(weeklyMenu, date, byId) : null,
    alacarte,
  };
}

/** Mon–Fri of the week containing `date`. */
export function weekDates(date) {
  const monday = mondayOf(date);
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
}

/**
 * Normalise a multi-day payload for JSON output.
 *
 * The à la carte catalogue is the same every day, so repeating it per day makes a
 * week's snapshot five times bigger than it needs to be. Hoist the products into a
 * single map and leave each day holding only the ids it offers — which is also how
 * per-day availability ends up encoded, since a date-ranged item simply won't appear.
 */
export function normalisePayload(payload) {
  const products = {};
  const days = payload.days.map((day) => ({
    ...day,
    alacarte: day.alacarte.map((group) => {
      const itemIds = group.items.map((item) => {
        if (!products[item.id]) {
          // `availableOn` is per-date and would be a lie in a shared map.
          const { availableOn, ...rest } = item;
          products[item.id] = rest;
        }
        return item.id;
      });
      return { slug: group.slug, name: group.name, itemIds };
    }),
  }));
  return { ...payload, products, days };
}
