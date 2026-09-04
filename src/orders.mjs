/**
 * Authenticated order lookups — the "have I already ordered?" half.
 *
 * `checkExistingOrder` is the site's own purpose-built probe, so it's the authority on
 * whether a delivery date is already taken. `getCustomerOrders` is the wider view, used
 * to see what was actually eaten recently (which is what makes a repetition rule work
 * on real data rather than on what I happened to suggest yesterday).
 */

const CHECK_EXISTING = `
query CheckExistingOrder($customerId: Int!, $deliveryDate: String!, $deliveryTimeslot: String, $orderType: String) {
  checkExistingOrder(customerId: $customerId, deliveryDate: $deliveryDate, deliveryTimeslot: $deliveryTimeslot, orderType: $orderType) {
    exists
    order { databaseId status orderNumber }
  }
}`;

const CUSTOMER_ORDERS = `
query GetCustomerOrders($customerId: Int!) {
  orders(where: {customerId: $customerId, orderby: {field: DATE, order: DESC}}, first: 100) {
    nodes {
      databaseId orderNumber date status total
      lineItems(first: 100) {
        nodes {
          quantity
          total
          product { node { databaseId name } }
          variation { node { databaseId name } }
        }
      }
      metaData { key value }
    }
  }
}`;

/** Is `date` already ordered for, per the site's own probe? Returns { exists, order }. */
export async function checkExistingOrder(session, date) {
  const data = await session.gql(CHECK_EXISTING, {
    customerId: Number(session.customerId),
    deliveryDate: date,
  });
  const r = data.checkExistingOrder;
  return { date, exists: Boolean(r?.exists), order: r?.order ?? null };
}

/** Check several dates. Sequential on purpose — no reason to hammer someone's shop. */
export async function checkExistingOrders(session, dates) {
  const out = [];
  for (const date of dates) out.push(await checkExistingOrder(session, date));
  return out;
}

/**
 * Whether each date is already ordered for, cross-checking two sources.
 *
 * `checkExistingOrder` alone is not enough, verified against real data:
 *
 *   - It only matches orders still in PROCESSING. Real orders that had already moved to
 *     PAKKET came back `exists: false`, which reads as "you never ordered" rather than
 *     "that one's already packed". Observed on two separate delivery dates.
 *   - Even when it says `exists: true`, `databaseId` and `orderNumber` come back null —
 *     so the order can't be identified from its answer alone.
 *
 * Order history carries every status and the real order number, so it's the authority on
 * whether a day is taken. The probe is kept because it's the site's own check and may
 * apply logic (timeslots, order types) history doesn't expose — so `exists` is true if
 * *either* source says so. For not-double-booking, a false negative is the dangerous
 * direction; err toward "already ordered".
 */
export async function resolveOrderStatus(session, dates) {
  const probes = new Map((await checkExistingOrders(session, dates)).map((p) => [p.date, p]));
  const orders = await getRecentOrders(session, { limit: 100 });
  const byDate = new Map();
  for (const o of orders) if (o.deliveryDate) byDate.set(o.deliveryDate, o);

  return dates.map((date) => {
    const probe = probes.get(date);
    const historic = byDate.get(date) ?? null;
    const sources = [probe?.exists ? 'checkExistingOrder' : null, historic ? 'history' : null].filter(Boolean);
    return {
      date,
      exists: Boolean(probe?.exists || historic),
      order: historic
        ? { orderNumber: historic.orderNumber, status: historic.status, databaseId: historic.id, items: historic.items }
        : probe?.exists
          ? { orderNumber: probe.order?.orderNumber ?? null, status: probe.order?.status ?? null, databaseId: null, items: [] }
          : null,
      sources,
      // Worth surfacing: the two sources disagreeing means one of these assumptions is stale.
      disagreement: Boolean(probe?.exists) !== Boolean(historic),
    };
  });
}

const metaValue = (order, key) => order.metaData?.find((m) => m.key === key)?.value ?? null;

/**
 * Recent orders, flattened to what a suggestion engine cares about: which delivery date,
 * and which products. `deliveryDate` comes from order meta rather than `date` — `date` is
 * when the order was *placed*, which is a day or more earlier.
 */
export async function getRecentOrders(session, { limit = 30 } = {}) {
  const data = await session.gql(CUSTOMER_ORDERS, { customerId: Number(session.customerId) });
  return (data.orders?.nodes ?? [])
    .map((o) => ({
      id: o.databaseId,
      orderNumber: o.orderNumber,
      placedAt: o.date,
      deliveryDate: (metaValue(o, 'delivery_date') ?? metaValue(o, 'deliveryDate') ?? '').slice(0, 10) || null,
      status: o.status,
      total: o.total,
      subscriptionGenerated: Boolean(metaValue(o, 'subscription_generated')),
      items: (o.lineItems?.nodes ?? []).map((li) => ({
        productId: li.product?.node?.databaseId ?? null,
        name: li.variation?.node?.name ?? li.product?.node?.name ?? null,
        quantity: li.quantity,
      })),
    }))
    .slice(0, limit);
}

/**
 * What was eaten on each of the given dates, from order history.
 *
 * Keyed on the `delivery_date` order meta, which is confirmed present on real orders.
 * Returns an empty map rather than throwing if it's ever missing, since a lost history
 * lookup should degrade the suggestion, not break the run.
 */
export async function historyByDate(session, dates) {
  const orders = await getRecentOrders(session, { limit: 100 });
  const wanted = new Set(dates);
  const map = new Map();
  for (const o of orders) {
    if (o.deliveryDate && wanted.has(o.deliveryDate)) map.set(o.deliveryDate, o);
  }
  return map;
}
