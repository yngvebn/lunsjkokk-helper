/**
 * Write operations. These create and remove real food orders.
 *
 * Rules encoded here, each learned the hard way from the site's own bundle or from
 * probing the schema:
 *
 *  1. **`createDailyOrder` is not safe to call blindly.** Its payload carries
 *     `wasExisting`, and the site's own code, when it sees `wasExisting: true`, does NOT
 *     stop — it switches to `replaceOrderItems` against the returned order. So calling
 *     create on a day that already has an order quietly hands back that order instead of
 *     creating one. Treating that as success would report "ordered" having ordered
 *     nothing, or worse, silently replace a different lunch. We treat it as a failure.
 *
 *  2. **The metaData block is effectively mandatory.** The schema says otherwise, but
 *     `delivery_date` meta is what every history feature reads (order history, the
 *     cooldown, the history arm of `resolveOrderStatus`). An order without it is
 *     invisible to this tool — the day would read as free after you'd ordered it.
 *
 *  3. **Never send `total` / `subtotal`.** They're writable Strings on `LineItemInput`,
 *     which is a trap: let the server price the line from `productId`/`variationId` so
 *     the order can't disagree with the catalogue.
 *
 *  4. **Never pass `forceDelete`.** Omitted, WooCommerce trashes the order, which is
 *     recoverable. `forceDelete: true` is not.
 *
 *  5. **`delivery_day` is an ENGLISH lowercase weekday.** Two weekday vocabularies exist
 *     in this API and mixing them produces an order the website cannot see. See the
 *     comment in `buildOrderInput`.
 */

import { WEEKDAY_EN, dayOfWeek } from './oslo.mjs';
import { resolveOrderStatus } from './orders.mjs';

const CREATE_DAILY_ORDER = `
mutation CreateDailyOrder($input: CreateDailyOrderInput!) {
  createDailyOrder(input: $input) {
    wasExisting
    order {
      id
      databaseId
      orderNumber
      status
      total
      lineItems(first: 20) {
        nodes { quantity product { node { databaseId name } } variation { node { databaseId name } } }
      }
      metaData { key value }
    }
  }
}`;

const DELETE_ORDER = `
mutation DeleteOrder($input: DeleteOrderInput!) {
  deleteOrder(input: $input) {
    order { id databaseId orderNumber status }
  }
}`;

/** Statuses it's safe to remove without an override: the kitchen hasn't acted yet. */
export const DELETABLE_STATUSES = ['PROCESSING', 'ON_HOLD', 'PENDING'];

/**
 * Build the createDailyOrder input. Pure, so it can be printed for a dry run and
 * asserted in tests without touching the network.
 */
export function buildOrderInput({
  customerId,
  date,
  productId,
  variationId = null,
  name,
  quantity = 1,
  note = null,
  co2 = null,
  kalorier = null,
  size = null,
}) {
  if (!Number.isInteger(Number(customerId))) throw new Error(`customerId must be an integer, got ${customerId}`);
  if (!Number.isInteger(Number(productId))) throw new Error(`productId must be an integer, got ${productId}`);
  if (quantity < 1) throw new Error(`quantity must be at least 1, got ${quantity}`);

  // ENGLISH lowercase, and this matters more than it looks. Verified against every
  // site-created order: delivery_day is "tuesday", "friday", "monday". The menu page
  // matches orders to days on this value, so a Norwegian weekday here produces an order
  // that exists in the API, has a correct delivery_date, is found by order history — and
  // is invisible on the website. Do not "fix" this to match customWeeklyMenus.dag, which
  // is a different field and genuinely IS Norwegian.
  const weekday = WEEKDAY_EN[dayOfWeek(date)];

  return {
    customerId: Number(customerId),
    deliveryDate: date,
    deliveryDay: weekday,
    status: 'PROCESSING',
    lineItems: [
      {
        productId: Number(productId),
        quantity,
        ...(variationId ? { variationId: Number(variationId) } : {}),
        name,
        metaData: [
          // A variable product carries its chosen size as `storrelse` on the line.
          // Verified on a real Dagens rett order: [{storrelse: "Vanlig"}, {_allergies: "[]"}].
          ...(size ? [{ key: 'storrelse', value: size }] : []),
          { key: '_allergies', value: JSON.stringify([]) },
        ],
      },
    ],
    metaData: [
      { key: 'delivery_day', value: weekday },
      { key: 'delivery_date', value: date },
      { key: 'order_type', value: 'personal' },
      ...(note ? [{ key: 'order_note', value: note }] : []),
      // Per-product meta the site always writes. `parseOrder` in the client reads the
      // allergies key back by exactly this name, and the co2/kalorier values are passed
      // through from the catalogue verbatim (they're formatted strings like "0,37", not
      // numbers — do not normalise them).
      { key: allergyMetaKey(productId, variationId, name), value: JSON.stringify([]) },
      ...(co2 != null ? [{ key: `product_${Number(productId)}_co2`, value: String(co2) }] : []),
      ...(kalorier != null ? [{ key: `product_${Number(productId)}_kalorier`, value: String(kalorier) }] : []),
    ],
  };
}

/**
 * The order-meta key the client reads allergies back from. Two forms, straight out of
 * `parseOrder`:
 *
 *   simple    product_<pid>_<slug>_allergies
 *   variation product_<pid>_variation_<vid>_<slug>_allergies
 *
 * Verified against a real Dagens rett order:
 * `product_102367_variation_102368_dagens_rett_allergies`.
 */
export function allergyMetaKey(productId, variationId, name) {
  const slug = productSlug(name);
  return variationId
    ? `product_${Number(productId)}_variation_${Number(variationId)}_${slug}_allergies`
    : `product_${Number(productId)}_${slug}_allergies`;
}

/**
 * The site's product-name-to-meta-key slug, copied from `parseOrder` in the client
 * bundle. Verified to reproduce real keys: "Sandwich med spicy eggesalat" ->
 * `sandwich_med_spicy_eggesalat`, "Foccacia med Brie & pesto" -> `foccacia_med_brie_pesto`.
 *
 * Note it splits on " - " first, so a variation name like "Dagens rett - Vanlig" keys off
 * the base product name.
 */
export function productSlug(name) {
  return String(name ?? '')
    .split(' - ')[0]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[æøå]/g, (c) => ({ æ: 'ae', ø: 'o', å: 'a' })[c])
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

/**
 * Place an order for one day, refusing if one already exists.
 *
 * Two guards, deliberately both: `resolveOrderStatus` before the write (catches every
 * status, including the PAKKET orders the site's own probe misses), and `wasExisting`
 * after it (catches an order placed between our check and our write).
 */
export async function createOrder(session, { date, productId, variationId, name, quantity = 1, note = null, co2 = null, kalorier = null, size = null }) {
  const [status] = await resolveOrderStatus(session, [date]);
  if (status.exists) {
    const o = status.order ?? {};
    const err = new Error(
      `${date} already has an order${o.orderNumber ? ` (#${o.orderNumber}` : ''}${o.status ? `, ${o.status}` : ''}${o.orderNumber ? ')' : ''}` +
        `${o.items?.length ? `: ${o.items.map((i) => i.name).join(', ')}` : ''}. One item per day — remove it first.`,
    );
    err.code = 'ALREADY_ORDERED';
    err.existing = status;
    throw err;
  }

  const input = buildOrderInput({ customerId: session.customerId, date, productId, variationId, name, quantity, note, co2, kalorier, size });
  const data = await session.gql(CREATE_DAILY_ORDER, { input });
  const result = data.createDailyOrder;

  if (result?.wasExisting) {
    // The server found an order we didn't. Do NOT follow the site's replace-items path:
    // silently overwriting a lunch someone else just ordered is worse than failing.
    const err = new Error(
      `Refusing to continue: the server reports an order already existed for ${date} ` +
        `(#${result.order?.orderNumber ?? result.order?.databaseId ?? '?'}). Nothing was created or changed.`,
    );
    err.code = 'RACED';
    err.order = result.order;
    throw err;
  }

  return { order: result?.order ?? null, input };
}

/**
 * Remove an order. Trashes rather than hard-deletes (no `forceDelete`), so it can be
 * recovered from the WordPress admin if this turns out to be a mistake.
 *
 * Refuses statuses the kitchen may already have acted on unless `allowAnyStatus` is set:
 * a PAKKET order is food that has already been made.
 */
export async function deleteOrder(session, { orderId, status = null, allowAnyStatus = false }) {
  if (!Number.isInteger(Number(orderId))) throw new Error(`orderId must be an integer, got ${orderId}`);

  if (status && !allowAnyStatus && !DELETABLE_STATUSES.includes(status)) {
    const err = new Error(
      `Order status is ${status}, not one of ${DELETABLE_STATUSES.join('/')} — the kitchen may already have made this food. ` +
        'Pass --force-status if you really mean it.',
    );
    err.code = 'STATUS_NOT_DELETABLE';
    throw err;
  }

  const data = await session.gql(DELETE_ORDER, { input: { orderId: Number(orderId) } });
  return data.deleteOrder?.order ?? null;
}
