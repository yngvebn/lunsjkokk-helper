# Lunsjkokkene API recon (2026-09-01)

## Architecture

Headless WordPress + WooCommerce, exposed via WPGraphQL / WPGraphQL-WooCommerce,
fronted by a Next.js (pages router) app using Faust.js.

| Piece | Where |
|---|---|
| Frontend | `https://lunsjkokkene.no` (Next.js, build id `W5M3ld62YlZuX-8Dpzhnh`) |
| GraphQL endpoint | `https://lunsjkokkene.wpenginepowered.com/index.php?graphql` (aka `lunsjkokkene.wpengine.com/graphql`) |
| WP REST proxy | `https://lunsjkokkene.no/wp-json/:path*` → rewritten to WP |
| Auth token endpoint | `https://lunsjkokkene.no/api/faust/auth/token` (401 when anonymous) |
| Extras | Cookiebot, GTM/GA4, LinkedIn px, Intercom, Sentry, Vimeo |

CORS: `Access-Control-Allow-Origin: https://lunsjkokkene.no`, credentials allowed,
`woocommerce-session` header exposed (Woo cart session travels as a JWT in that header).
CORS only constrains browsers — verified that server-side requests with **no `Origin`
header at all** are answered normally.

Introspection is **disabled** for public requests, so the schema was recovered by
reading the operations the client bundles ship.

## Anonymous (no auth) — verified with curl

Plain `POST` with `Content-Type: application/json`. Verified with no `Origin`, no cookies
and no token: `customWeeklyMenus`, `products`, `product(idType: DATABASE_ID)`,
`instillinger.stengteDager`.

### Weekly menu for a date

```graphql
query GetCustomWeeklyMenu($selectedDate: String) {
  customWeeklyMenus(selectedDate: $selectedDate) {
    id title fraDato tilDato
    menuItems { productId dag beskrivelse allergier co2 co2Stor kalorier kalorierStor }
  }
}
```

`selectedDate` is `YYYY-MM-DD`; it returns a (single-element) list for the Mon–Fri week
containing that date (`fraDato`/`tilDato` are `DD/MM/YYYY`). `dag` is a Norwegian weekday
name (`mandag`…`fredag`). `productId` ties the day's dish to a Woo product.

Lookahead probed: +2 weeks → "Meny uke 4", +6 weeks → "Meny uke 3". Menus are published
well ahead, and the `title` is a **rotation label, not an ISO week number** (the week of
31/08/2026 is ISO week 36 but is titled "uke 2"). Never parse the title as a date.
A date with no published menu returns an **empty array** (`2025-12-25` → `[]`) — handle
that instead of indexing `[0]`.

### The five fixed slots

The same five `productId`s repeat every weekday with a different `beskrivelse`. The
products are *slots*; the dish is the per-day description:

| productId | name |
|---|---|
| 102367 | Dagens rett (variable: normal/stor, 79–89 kr) |
| 1946 | Dagens varmrett |
| 242 | Dagens vegetar |
| 2972 | Dagens vegansk |
| 235 | Dagens påsmurt |

So reminder text has to render `beskrivelse` per slot — resolving `productId` to a product
name just yields "Dagens rett", which tells you nothing about the food.

### Closed days (holidays)

```graphql
query GetClosedDays {
  instillinger { stengteDager { stengteDager { stengtDag meldingIBestillingsmeny } } }
}
```

`stengtDag` is an ISO date, `meldingIBestillingsmeny` the banner text. Covers Christmas,
New Year, Easter, 1/14/25 May etc. Directly useful for suppressing reminders.

### The à la carte catalogue

`productCategories(where: {hideEmpty: true})` gives the categories with the site's own
display order in `menuOrder`:

| menuOrder | slug | products | notes |
|---|---|---|---|
| 0 | `hakone` | 4 | discount-group range, hidden unless `discountGroup == "hakone"` |
| 1 | `ukesmeny` | 6 | the five rotating slots (+ cutlery) |
| 2 | `ferdigretter` | 3 | Lasagne, Indisk masala, Pad Kra Pao — 89 kr |
| 3 | `brodmat` | 13 | sandwiches, baguettes, focaccia — 79–83 kr |
| 4 | `kaker` | 15 | whole cakes, 45–695 kr |
| 6 | `innom` | 10 | discount-group range, hidden unless `discountGroup == "innom"` |
| 7 | `wraps` | 6 | 79 kr |
| 8 | `salater` | 10 | 89–109 kr (incl. bread/cutlery add-ons) |
| 9 | `lunsjbuffet` | 3 | |
| 10 | `lunsjtallerken` | 6 | 173 kr platters, one seasonal |
| 11 | `lunsjpakke` | 4 | |
| 12 | `bakverk` | 9 | |
| 13 | `drikke` | 10 | |
| 14 | `dessert` | 6 | |
| 15 | `dagligvarer` | 7 | |
| 16–17 | `ukategorisert`, `uncategorized` | 41 | never rendered |

The site's own filter chain, from `chunks/pages/meny-*.js`:

1. Drop categories `ukategorisert`, `uncategorized`, `sommermeny`.
2. Drop `innom` / `hakone` unless the slug equals the company's
   `selskapsdetaljer.discountGroup` (default `"ingen"`).
3. Sort remaining categories by `menuOrder`.
4. Keep only products in a surviving category.
5. Apply `produktTilgjengelighet` (see below).
6. Drop products whose `restrictedToCompanies` is non-empty and doesn't contain the
   company's `databaseId`. Nothing in the public 130 is restricted; **variations can be**
   — "Dagens varmrett – Stor" is restricted to company `186576`.

#### Availability — and one piece of dead code

```js
if (!availabilityType) return true;
if (availabilityType === 'date_range') {
  if (!fradato && !tildato) return true;
  return date >= fradato && date <= tildato;
}
if (availabilityType === 'weekdays') { /* … */ }
```

**Every one of the 130 products currently has `availabilityType: "date_range"`, so the
`weekdays` branch never executes.** Products that carry a `weekdays` array anyway
(e.g. "Club baguette" → mon/wed/fri) are *not* actually restricted on the live site.
Someone entered that data deliberately, so it's worth keeping as a hint — but don't
mistake it for an enforced rule.

Only genuinely date-ranged items get filtered: e.g. "Kald juletallerken",
`2025-11-03 → 2026-01-31`, `minimumsKvantitet 4`.

### Catalogue source of truth: GraphQL, not the Store API

The two disagree, consistently: **GraphQL returns 130 products, the Store API 159.**
Verified that the 130 is stable across orderings and page sizes, so it isn't a pagination
bug — and it's exactly what the site renders. The 29 extras are all published but
catalog-hidden:

- 14 INNOM duplicates beyond the 10 GraphQL exposes
- legacy/duplicate dishes ("Pokebowl med laks fra Osterøy", "Wrap med pulled pork")
- internal placeholders `Spons` and `Rabatt`, both `is_purchasable: false`

GraphQL is also the **only** source for `produktTilgjengelighet`, `minimumsKvantitet`,
`restrictedToCompanies` and the allergen taxonomy. Use it as the catalogue; reach for the
Store API only for the ingredient-list HTML.

### Product catalogue query

`GetMenuProducts(first, after)` — paginated `products` connection, `MENU_ORDER ASC`,
plus `productCategories`. Custom fields worth knowing:

- `minimumsKvantitet { harMinimumskvantitet kvantitet }` — per-product minimum order
- `produktTilgjengelighet { availabilityType fradato tildato weekdays }` — when a product can be ordered
- `produkt { allergener alllergiesToBeAdapted allergitilpasses }`
- `c02`, `kalorier`, `restrictedToCompanies`
- `VariableProduct.variations` carry size (e.g. normal/stor) with own price/CO2/kcal

`GetProductCategoryGroupTop(slug)` returns a category's description
(e.g. slug `ukesmeny`).

### WooCommerce Store API — open, and simpler

The `/wp-json/:path*` rewrite is live and the **Store API needs no auth at all**:

```
GET https://lunsjkokkene.no/wp-json/wc/store/v1/products?per_page=100
GET https://lunsjkokkene.no/wp-json/wc/store/v1/products/102367
```

Plain REST JSON with `prices` (minor units + currency metadata), `categories`,
`is_purchasable`, and full ingredient/allergen `description` HTML. For read-only catalogue
work this beats hand-rolling the GraphQL product query.

Cart/checkout routes exist too (`/cart/add-item`, `/checkout`, …) but the app does **not**
use them — it orders via the custom `createDailyOrder` GraphQL mutation, which is what
attaches the `deliveryDate` / `deliveryDay` meta. Don't order through the Store API.

## Ordering deadline — the bit that matters for reminders

From `chunks/pages/meny-*.js`:

```js
const h = { HOUR: 13, MINUTE: 0 };

isOrderPastDeadline = (deliveryDate) => {
  const now = new Date();
  const d = new Date(deliveryDate);
  const dow = d.getDay();
  const cut = new Date(d);
  if (dow === 1) cut.setDate(cut.getDate() - 3);       // Monday  -> Friday
  else if (dow === 0) cut.setDate(cut.getDate() - 2);  // Sunday  -> Friday
  else cut.setDate(cut.getDate() - 1);                 // else    -> previous day
  cut.setHours(h.HOUR, h.MINUTE, 0, 0);
  return now.getTime() >= cut.getTime();
};
```

**Deadline = 13:00 Europe/Oslo the day before delivery; for Monday (and Sunday)
delivery the deadline is the preceding Friday 13:00.** The UI labels a past-deadline
day "Frist utløpt" / "Fristen har gått ut (kl. 13:00)". Note it's computed in browser
local time, so the server presumably means Oslo time.

#### Two deadlines — a branch, not a footnote

There is a second, separately hardcoded rule: *updating* an order that a **subscription
already generated** has a **10:00** the-day-before deadline
(`getSubscriptionOrderDeadlineInfo` — no Monday/Friday special-casing there, it just walks
Mon–Fri of the current week). Subscriptions started after the Friday deadline begin the
following week.

Which deadline is actionable therefore depends on **order provenance**: a fresh order is
13:00, a change to a subscription-generated day is 10:00 — three hours earlier. Provenance
is visible in the order's `metaData` (`subscription_generated`, `subscription_id`).

**Resolved:** we don't use subscriptions, so the 10:00 rule never applies here. **13:00
the day before is the deadline** (Mon/Sun → preceding Friday). The 10:00 rule stays
documented only so it isn't mistaken later for evidence that 13:00 is wrong.

The `/meny` page defaults `selectedDate` to today + 2 days, consistent with "today's
deadline has likely passed, tomorrow's may have too".

## Authenticated surface (for later — write access)

**Correction.** An earlier pass here claimed a `login($input: LoginInput!)` mutation, read
out of the client bundle. That mutation is dead code — the endpoint answers
`Cannot query field "login" on type "RootMutation"` and `Unknown type "LoginInput"`.
The real flow is Faust's authorization-code exchange, verified against the live API:

```graphql
mutation GenerateAuthorizationCode($email: String, $username: String, $password: String!) {
  generateAuthorizationCode(input: {email: $email, username: $username, password: $password}) {
    code
    error
  }
}
```

Then `GET https://lunsjkokkene.no/api/faust/auth/token?code=<code>` returns
`{ accessToken, accessTokenExpiration }`, and GraphQL requests carry
`Authorization: Bearer <accessToken>`.

Three traps in that flow:

- **Bad credentials are an HTTP 200.** The message arrives in
  `data.generateAuthorizationCode.error` (in Norwegian — *"Ukjent e-postadresse. Sjekk igjen
  eller prøv med ditt brukernavn."*), not in the GraphQL `errors` array. Code an
  unconditional success path and a wrong password looks like a login with a null code.
- **Email and username are separate input fields.** The client tests whether the value looks
  like an address and sends the matching one; sending the wrong field fails.
- The browser also keeps `faustwp-auth` / `faustwp-refresh` in `localStorage` and refreshes
  via a cookie on the same endpoint. A script doesn't need any of that — re-running the
  two-step exchange per process is two requests and leaves no token at rest.

Order-relevant operations found in `_app-*.js`:

- `query CheckExistingOrder(customerId: Int!, deliveryDate: String!, deliveryTimeslot: String, orderType: String)` → `{ exists, order { databaseId status orderNumber } }` — the site's "have I ordered yet?" probe. **Do not trust it alone** — see below.
- `query GetCustomerOrders(customerId: Int!)` → orders with `lineItems` and `metaData`
- `mutation CreateDailyOrder(input: CreateDailyOrderInput!)`; input shape observed:
  `{ customerId, deliveryDate, deliveryDay, deliveryTimeslot?, orderType? ("motemat"),
     metaData: [{key,value}] (subscription_id, subscription_generated, order_note, …), lineItems… }`
- `mutation UpdateOrder`, `ReplaceOrderItems`, `DeleteOrder`
- Subscriptions: `GetSubscriptions`, `CreateSubscription`, `GenerateOrdersFromSubscription`,
  `UpdateSubscription{Content,Meta,PauseDates,Product,Status}`, `UpdateAbonnementBestilling`
- Employee discounts: `ApplyEmployeeDiscount`, `TrackDiscountUsage`, `GetDiscountUsage`, …
- `query GetUserCompany` → `viewer.connectedCompanies[].selskapsdetaljer` — delivery address,
  `leveringTider` / `customLeveringTid`, `weekendDelivery`, `enableSecondDelivery`,
  employees with per-weekday flags and discounts, `lunchManagers`.

Frontend routes (from `_buildManifest.js`): `/`, `/meny`, `/dagens-meny`, `/cart`,
`/checkout`, `/dashboard`, `/admin-dashboard`, `/ansatte`, `/ansatt-rapport`,
`/min-konto`, `/ordreslipper`, `/kjokken-oversikt`, `/framtidig-produksjon`,
`/korttrekk`, `/wallboard`, `/login`, `/registrering`, `/reset-password`, `/preview`,
`/product-categories`, `/artikler`, `/om-oss`, `/kontakt-oss`.

## `checkExistingOrder` is not sufficient on its own

Verified against a real account, and both findings matter for
not-double-booking:

**It only matches orders still in `PROCESSING`.** Real orders that had progressed to
`PAKKET` were reported as absent:

| delivery date | real order | status | `checkExistingOrder` |
|---|---|---|---|
| 2026-08-31 | #2xxxxx | PAKKET | `exists: false` |
| 2026-09-01 | #238816 | PAKKET | `exists: false` |
| 2026-09-04 | #2xxxxx | PROCESSING | `exists: true` |

So a day with a packed order reads as "you never ordered" — a false negative, which is the
dangerous direction for a tool whose job is to avoid ordering twice.

**And when it does match, the identifiers are null.** `exists: true` came back with
`databaseId: null` and `orderNumber: null`, so the order can't be named from its answer.

The fix in `src/orders.mjs` (`resolveOrderStatus`) cross-checks it against
`GetCustomerOrders`, which carries every status *and* the real order number. A date counts
as taken if **either** source says so, and the order number always comes from history. The
probe is kept rather than dropped because it's the site's own logic and may account for
timeslots or order types that history doesn't expose.

**The `delivery_date` order-meta key is confirmed.** Previously a guess; history returns
proper delivery dates for it, so the cooldown and repetition features work on real data.
Note `date` on the order is when it was *placed*, which is a day or more earlier — don't
confuse the two.

## The write surface, verified

Input shapes recovered by sending deliberately invalid values — GraphQL validates before
executing, so a type mismatch confirms a field exists without mutating anything.

```
CreateDailyOrderInput
  customerId   Int!      required
  deliveryDate String!   required
  lineItems    [LineItemInput]!  required
  deliveryDay, status, metaData, deliveryTimeslot, orderType, employeeDiscount

LineItemInput
  productId Int, quantity Int, variationId Int, name String, total String, subtotal String

DeleteOrderInput
  orderId Int, id ID, forceDelete Boolean, clientMutationId String
```

Confirmed against real writes (one order created then removed, another created):

- **`createDailyOrder` returns `wasExisting`.** When true it hands back the *existing*
  order instead of creating one; the site's own code then calls `replaceOrderItems` on it,
  silently overwriting. Treat `wasExisting: true` as a failure unless you actually intend
  to overwrite.
- **The success payload's `order.databaseId` and `order.orderNumber` come back null**, same
  as `checkExistingOrder`. The order *is* created — re-read it through `GetCustomerOrders`
  to get its number.
- **`metaData` is effectively mandatory.** `delivery_date` is what order history exposes as
  the delivery date; without it the order exists but is invisible to any date-based lookup.
  Send `delivery_day` (lowercase Norwegian weekday), `delivery_date`, `order_type`.
- **Don't send `total` / `subtotal`.** They're writable, which means an order can be created
  whose price disagrees with the catalogue. Let the server price from `productId`.
- **Omit `forceDelete`** and `deleteOrder` trashes the order — recoverable. `true` is not.

## The `delivery_day` trap — two weekday vocabularies

This API uses Norwegian weekdays in one place and English in another, and mixing them
creates an order that exists but is **invisible on the website**.

| field | language | example |
|---|---|---|
| `customWeeklyMenus.menuItems.dag` | Norwegian | `mandag`, `torsdag` |
| order meta `delivery_day` | **English** | `monday`, `thursday` |
| `produktTilgjengelighet.weekdays` | English | `monday`, `friday` |

The client keys saved orders with `getOrderKey(day, date)` → `` `${day}-${date}` ``, and the
menu page looks up English weekdays. So an order written with `delivery_day: "torsdag"`
is filed under `torsdag-2026-09-03` while the UI asks for `thursday-2026-09-03`. The order
is in the database, has a correct `delivery_date`, is returned by `GetCustomerOrders` — and
does not appear in the customer's own order view.

Confirmed empirically: every one of ten site-created orders used English. Writing Norwegian
produced exactly the invisible-order symptom, and rewriting with English fixed it.

**Verifying a write by re-reading only the fields you set will not catch this.** Diff a new
order's full `metaData` against a known site-created order instead.

## Variation orders (Dagens rett and friends)

A `VariableProduct` order needs three extra things, verified against a real order (#234319,
"Dagens rett - Vanlig"):

```
lineItems[0].variationId = 102368
lineItems[0].metaData     = [{storrelse: "Vanlig"}, {_allergies: "[]"}]
order metaData            product_102367_variation_102368_dagens_rett_allergies = "[]"
```

Note the allergies meta key takes a **different form** for a variation —
`product_<pid>_variation_<vid>_<slug>_allergies` rather than
`product_<pid>_<slug>_allergies`. The slug comes from the base product name
(`name.split(" - ")[0]`, lowercased, æ→ae / ø→o / å→a, non-alphanumerics dropped, spaces to
underscores).

For Ukesmeny slots the `co2` / `kalorier` order meta comes from the **weekly menu item**,
not the product catalogue — the Dagens rett product itself carries none, and the numbers
differ per day.

## Employee discount

Older orders carry `_discount_percentage: "100"`, `_discount_amount`, `_calculated_discount`
and `_original_total`, with `total` reading `0,00kr`. Freshly created orders show the
undiscounted total (e.g. `90,85kr`); the discount is applied later by the site's own
processing, not at order time. Don't try to send discount meta — `employeeDiscount` exists on
`CreateDailyOrderInput` but the server handles this.

## Client constraint: Cloudflare TLS fingerprinting

Cloudflare fronts the endpoint and rejects some HTTP clients on TLS fingerprint alone,
before the request is ever parsed:

| Client | Result |
|---|---|
| Node `fetch` (undici) | ✅ |
| `curl` | ✅ |
| Python `urllib.request` | ❌ `HTTP 403`, body `error code: 1010` |

A `User-Agent` override does not help — 1010 is "browser signature banned". If a port
starts 403ing, this is why; don't go debugging the query. (Hence the tooling is Node.)

## Implications for a reminder tool

Phase 1 (no auth) is enough to build a real reminder: closed days + weekly menu + the
deadline rule gives "you have N hours left to order lunch for <date>, and here's what's on
the menu" (rendering `beskrivelse` per slot).

Phase 2 (auth) adds `CheckExistingOrder` so it only nags when there's actually no order for
the day, and opens `CreateDailyOrder` if it should order for you.

### Constraints any implementation must honour

- **Pin `Europe/Oslo`** for all deadline math. The bundle computes deadlines in browser
  local time, so Oslo is the implied server timezone — never use host local time.
- Deadline is **13:00 the day before**. The 10:00 subscription-edit rule is out of scope —
  no subscription here.
- Monday and Sunday deliveries roll back to the **preceding Friday**.
- Skip `stengteDager` dates, and surface `meldingIBestillingsmeny` instead of a nag.
- `customWeeklyMenus` can return `[]` — no menu is a valid state, not an error.
- Menu `title` ("Meny uke 3") is a rotation label. Ignore it for scheduling.
