# lunsjkokk-helper

Reads the [Lunsjkokkene](https://lunsjkokkene.no) menu, works out how long is left to
order, suggests something you'd actually eat, and can place or cancel the order — so lunch
stops being a thing you forget until 14:00.

Zero dependencies. Reading the menu needs no auth at all; only the order-related parts need
your login. The API was reverse-engineered from the site's own JS bundles —
[`docs/api-recon.md`](docs/api-recon.md) is the map, including the traps.

## Setup

Node 18+, no dependencies to install.

```bash
git clone <this repo> && cd lunsjkokk-helper
node scripts/auth.mjs login      # your Lunsjkokkene credentials, stored by the OS keystore
/lunsj-preferences               # interview that writes your food profile
node scripts/daily.mjs           # from then on, this is the whole tool
```

Two files are personal and deliberately **not** in the repository, so a clone doesn't
inherit anyone else's taste or schedule:

| file | what | if missing |
|---|---|---|
| `preferences.json` | your food profile | scripts explain how to create it |
| `away.json` | days you're out of the office | treated as "no away days" |

`preferences.example.json` is the annotated template if you'd rather hand-edit than be
interviewed.

## Use it

The one command that answers the actual question:

```bash
node scripts/suggest.mjs        # or: npm run lunch
```

Deadline countdown, whether you've already ordered, and a pick from `preferences.json`.
Takes a date, `--week`, `--json`, `--vary-week`, `--no-auth`.

Menu without opinions:

```bash
node scripts/fetch-menu.mjs                     # next date you can still order for
node scripts/fetch-menu.mjs 2026-09-03          # a specific delivery date
node scripts/fetch-menu.mjs --week              # Mon–Fri of this week
node scripts/fetch-menu.mjs --week 2026-09-14   # Mon–Fri of that week
node scripts/fetch-menu.mjs --json              # machine-readable
node scripts/fetch-menu.mjs --compact           # names and prices only
node scripts/fetch-menu.mjs --out data          # also write the file
node scripts/test.mjs                           # 83 tests
node scripts/test-credentials.mjs               # credential store round-trip
```

Only the five categories worth eating for lunch are shown: **Ukesmeny, Ferdigretter,
Brødmat, Wraps, Salater**. The site has twelve more — cake, drinks, buffet platters,
groceries — and they're one flag away when you want them:

```bash
node scripts/fetch-menu.mjs --categories wraps,salater   # narrow further
node scripts/fetch-menu.mjs --all-categories             # everything the site renders
```

Or `npm run menu` / `npm run week` / `npm run snapshot`.

## What comes out

```
## torsdag 2026-09-03 (uke 36 · Meny uke 2 (NY))

⏳ 22h 6m left — order by ons. 02.09., 13:00.

### Ukesmeny
- Dagens rett — Frittata-omelett, servert med fetaost, skinke, salat fra Elstøen…
  Stor 89,00 kr / Vanlig 79,00 kr · allergener: Egg, Sennep, Sulfitt, Melk · 707 kcal
...
### Brødmat
- Club baguette — 79,00 kr (oppgitt: mon/wed/fri)
```

Single-day JSON is denormalised (each à la carte item inline). Week JSON is normalised:
products are hoisted into a `products` map and each day's groups hold `itemIds`, which
keeps a week's snapshot at ~110 KB instead of ~560 KB. A date-ranged item simply doesn't
appear in the days it isn't available.

## The two halves of the menu

They are different animals and the code keeps them apart, because a suggestion engine
needs the distinction:

- **`dagens` (Ukesmeny)** — five *fixed product slots* (`rett`, `varmrett`, `vegetar`,
  `vegansk`, `paasmurt`) whose content rotates daily. The product names are useless —
  every Monday's chicken salad is still called "Dagens rett". The actual dish lives in
  the per-day `beskrivelse`, with its own allergens, kcal and CO₂.
- **`alacarte`** — the standing catalogue: Ferdigretter, Brødmat, Wraps, Salater by
  default. Stable names, stable prices, available every day unless date-ranged.

Drop `ukesmeny` from `--categories` and the `dagens` section disappears with it.

## Deadlines

**13:00 Europe/Oslo the day before delivery.** Monday and Sunday deliveries roll back to
the preceding Friday. `deadline.at` is an absolute ISO instant computed against Oslo, not
against whatever the host machine thinks the time is — the site's own bundle uses
browser-local time, which is only correct by geographic accident.

The bundle also carries a hardcoded 10:00 deadline for editing days a *subscription*
generated. We don't use subscriptions, so it never applies; it's documented in
`src/deadline.mjs` purely so nobody rediscovers it and assumes the 13:00 is wrong.

## Layout

```
src/oslo.mjs        Europe/Oslo wall clock + calendar helpers
src/deadline.mjs    the deadline rule, and "what's the next orderable day"
src/api.mjs         WPGraphQL client (queries recovered from the site's bundles)
src/menu.mjs        raw API shapes -> dagens / alacarte payload
src/render.mjs      markdown for the menu
src/credentials.mjs credential store (Windows / macOS / Linux backends)
src/auth.mjs        Faust authorization-code login
src/orders.mjs      order existence (two sources) + history
src/away.mjs        days out of the office
src/mutations.mjs   order create/delete, with the one-per-day guards
src/suggest.mjs     preferences.json -> ranked shortlist
scripts/suggest.mjs     CLI: what should I have, have I ordered
scripts/fetch-menu.mjs  CLI: just the menu
scripts/auth.mjs        CLI: credentials
scripts/away.mjs        CLI: days out of the office
scripts/daily.mjs       CLI: the everyday check
scripts/order-add.mjs     CLI: place an order (dry run by default)
scripts/order-remove.mjs  CLI: remove an order (dry run by default)
away.json               marked away days (created on first use)
scripts/test.mjs        83 tests
scripts/test-credentials.mjs  credential store round-trip
src/preferences.mjs     profile loading, validation, shared defaults
preferences.example.json  annotated template (yours is gitignored)
.claude/skills/lunsj/             the everyday skill
.claude/skills/lunsj-preferences/ the profile interview
docs/api-recon.md       how the API works, including the write surface
```

## Gotchas worth knowing before you touch this

- **Cloudflare blocks some HTTP clients on TLS fingerprint alone.** Python's `urllib`
  gets `error code: 1010`; Node's `fetch` and `curl` are fine. If a port suddenly 403s,
  that's why — not the query.
- **GraphQL is the authoritative catalogue**, not the Store API. GraphQL returns the 130
  products the site actually renders; `/wp-json/wc/store/v1/products` returns 159,
  the extra 29 being INNOM duplicates, catalog-hidden legacy items and internal
  `Spons`/`Rabatt` placeholders. GraphQL is also the only source of availability rules
  and minimum quantities.
- **The `weekdays` availability field is dead code on the live site.** Every product is
  `availabilityType: "date_range"`, so the bundle's `"weekdays"` branch never fires and
  "Club baguette, Mon/Wed/Fri" isn't actually enforced. We emit it as `weekdayHint` and
  don't filter on it — someone entered it deliberately, so a suggestion skill can decide.
- **The menu title is a rotation label, not a week number.** "Meny uke 2" covers ISO week
  36. Never parse it as a date.
- **`customWeeklyMenus` can return an empty list.** No published menu is a valid state.
- **INNOM and Hakone are discount-group ranges**, hidden unless the company's
  `discountGroup` matches. Pass `--discount-group innom` or `--include-hidden` to see them.
  Whether either is ours is still unknown. Both sit outside the default category filter
  anyway.

## Days out of the office

```bash
node scripts/away.mjs add 2026-09-02 2026-09-03 --reason "kundemøte"
node scripts/away.mjs list
node scripts/away.mjs remove 2026-09-03
node scripts/away.mjs check      # orders on away days? exits 2 if so
node scripts/away.mjs prune      # drop past entries
```

Marked days are stored in `away.json`, are never suggested again, and only come back on an
explicit `remove`. Marking is idempotent, so a daily job can re-assert the same dates
without corrupting anything.

**ISO dates only, on purpose.** "Wednesday this week" is resolved by whoever is asking, and
`add` echoes the weekday back (`marked away: onsdag 2026-09-02`) so a mis-resolved date gets
caught by a human rather than at lunchtime.

### The case that must never be quiet

Away **and** an order exists is not "nothing to do" — it's money about to buy a lunch nobody
will eat, with a hard cancellation cutoff. So it's escalated everywhere: `suggest.mjs` prints
it under the away notice with the deadline, `away.mjs check` and `daily.mjs` exit `2`.
Cancelling isn't automated — that needs a write mutation, and the user can do it on the site.

## The daily check

```bash
node scripts/daily.mjs           # or: npm run daily
```

Designed to be run every day and to say nothing when nothing is needed. Priority order:
away-day clashes first, then the single most urgent day needing a decision, then a one-line
summary. Exit codes let it drive a notification without parsing output:

| code | meaning |
|---|---|
| 0 | nothing needs you |
| 2 | an order exists on a day you're away |
| 3 | a deadline falls today |

It also prunes past away days, so the file doesn't grow forever.

## Ordering and cancelling

```bash
node scripts/order-add.mjs 2026-09-09              # dry run: prints the exact mutation
node scripts/order-add.mjs 2026-09-09 --yes        # order the suggested pick
node scripts/order-add.mjs 2026-09-09 --name "Club Sandwich" --yes
node scripts/order-add.mjs 2026-09-09 --dagens rett --yes       # the day's Ukesmeny dish
node scripts/order-remove.mjs 2026-09-09 --yes     # remove that day's order
```

**Dry run is the default** — `--yes` is required to write anything. The dry run names the
food, the weekday and the deadline, because the mistake worth catching is a correct-looking
order on the wrong day.

### What stops a double order

Only one item per day is allowed, and that's enforced twice:

1. `resolveOrderStatus` before the write — covers every status, including the `PAKKET`
   orders the site's own probe misses.
2. **`wasExisting` on the mutation response** — catches an order placed between the check
   and the write.

That second one matters more than it looks. `createDailyOrder` returns
`wasExisting: true` and hands back the *existing* order rather than creating one, and the
site's own code then follows up with `replaceOrderItems` — silently overwriting whatever
was there. This tool treats `wasExisting` as a hard failure instead: nothing created,
nothing changed, non-zero exit.

Other guards, all of which the user can override but the tool won't override on its own:
past deadline (`--allow-late`), weekends (`--allow-weekend`), closed days, days marked away,
and products with a minimum quantity above one.

### The bug worth knowing about

An early version wrote `delivery_day` as a **Norwegian** weekday, because the menu's `dag`
field genuinely is Norwegian. The order meta is **English**. The client keys orders as
`` `${delivery_day}-${date}` `` and the menu page looks up English weekdays, so the order
existed, had a correct `delivery_date`, was returned by order history, passed the script's
own post-write verification — and was invisible in the customer's order view.

The lesson generalises: **verifying a write by re-reading the fields you set proves nothing.**
The check that found it was diffing the new order's full `metaData` against a site-created
order. Worth doing again for any new write path.

### What stops a bad cancellation

- No `forceDelete`, so the order is trashed and recoverable from the WordPress admin.
- Refuses any status past `PROCESSING` / `ON_HOLD` / `PENDING` without `--force-status` —
  a `PAKKET` order is food that has already been made.
- Warns when the deadline has passed, because removing then leaves the day with no lunch
  and no way to order another.

Both scripts verify by re-reading through `resolveOrderStatus` afterwards rather than
trusting the mutation's echo — which comes back with `databaseId: null` and
`orderNumber: null` even on success, exactly like `checkExistingOrder` does. That re-read is
also what proves the `delivery_date` meta landed; without it the order would be invisible to
every other feature here.

## Signing in

Needed only for the order check — everything else works anonymously.

```bash
node scripts/auth.mjs login     # prompts, stores encrypted, verifies
node scripts/auth.mjs status
node scripts/auth.mjs logout
```

One backend per platform, picked automatically:

| platform | store | needs |
|---|---|---|
| Windows | DPAPI (`ConvertFrom-SecureString`) | PowerShell with the crypto cmdlets |
| macOS | Keychain (`security`) | built in |
| Linux | libsecret (`secret-tool`) | `apt install libsecret-tools` or equivalent |
| anywhere | `LUNSJ_USERNAME` / `LUNSJ_PASSWORD` env vars | takes priority over the above |

Rules every backend follows:

- **The password is never a command-line argument** — those are readable by any process
  listing. It moves over stdin pipes, or is collected by the platform's own prompt.
- **`store` reads back what it wrote and fails if it doesn't match.** Only the Windows path
  has actually been executed by the author; macOS and Linux are written blind, so they have
  to detect their own failure rather than silently storing nothing.
- **No hand-rolled encrypted-file fallback.** A platform with no keystore fails and points
  at the env vars. A file encrypted with a key sitting next to it is worse than an env var,
  because it looks safer than it is.

The username is not secret and lives in a small JSON file (`credentials.json`) beside the
store; only the password goes into the keystore. On Windows that file holds the DPAPI blob,
which is inert on any other account or machine.

**Honest status:** Windows is tested end to end. macOS and Linux are implemented and
self-verifying but unrun — if you're first on either, run
`node scripts/test-credentials.mjs` right after `login` and tell me what breaks.

```bash
node scripts/test-credentials.mjs   # round-trip the store with a throwaway secret
```

Not part of `npm test` — it needs PowerShell and touches the real store path (backing up
and restoring anything already there). Run it after changing `src/credentials.mjs`.

Two things that bit during implementation and will bite again:

- **The script goes in `-EncodedCommand`, never `-Command -`.** `-Command -` makes
  PowerShell read its *script* from stdin, which collides with using stdin for the secret.
  The first version did both, so PowerShell read the script as input and encrypted *that*.
  Every shallow check passed — a file appeared, it held ciphertext, nothing errored. Only a
  full round-trip caught it, which is why `test-credentials.mjs` exists.
- **`powershell.exe` 5.1 cannot be relied on.** On this machine it fails to load
  `Microsoft.PowerShell.Security` (a type-data conflict on
  `System.Security.AccessControl.ObjectSecurity`), so `ConvertTo-SecureString` doesn't
  exist there at all. `pwsh` 7 is fine. The module probes both for a host that actually has
  the crypto cmdlets rather than assuming; `LUNSJ_PWSH` overrides.

### How authentication actually works

Not a `login` mutation — `login` doesn't exist on `RootMutation` here. It's Faust's
authorization-code exchange:

1. `generateAuthorizationCode(input: {email|username, password})` -> `{ code, error }`.
   **A wrong password is an HTTP 200** with the message in `data`, not in `errors` — check
   `error` explicitly or a failed login looks like a success with a null code.
2. `GET lunsjkokkene.no/api/faust/auth/token?code=<code>` -> `{ accessToken, accessTokenExpiration }`
3. `Authorization: Bearer <accessToken>` on subsequent GraphQL calls.

Tokens are held in memory for the life of one process and never written to disk. Logging in
costs two extra requests per run, which is cheaper than owning a persisted bearer token.

## Not double-booking

`suggest.mjs` resolves order status for each date before suggesting anything. If an order
exists it says so and stops — no alternative, no encouragement to order again. When not
signed in it says the check didn't happen, rather than letting a menu ranking read as
"you haven't ordered".

**Two sources, deliberately.** The site's `checkExistingOrder` probe turned out to match
only orders still in `PROCESSING` — real `PAKKET` orders came back `exists: false`, and even
on a match its `orderNumber` and `databaseId` are null. So it's cross-checked against order
history, which carries every status and the real order number. A date is taken if *either*
source says so: for this job a false negative (suggesting a lunch you already ordered) is
much worse than a false positive.

## Preferences

`preferences.json` is your own profile — rules and weights rather than a favourites list, so
it survives the Ukesmeny rotation. Build it with the **`/lunsj-preferences`** skill, which
interviews you against the real menu and then checks the resulting profile behaves, or copy
`preferences.example.json` and edit by hand.

Things that are facts about the menu rather than about a person are **not** in the profile:
the add-on exclusions (cutlery, a whole sourdough loaf) live in `src/preferences.mjs`, and
the calibrations below live here and in `docs/api-recon.md`. Five colleagues shouldn't each
carry a copy.

Three calibration findings are recorded in there because they'd otherwise get rediscovered
the hard way:

- **Don't rank on kcal.** 13 of 31 items have none — every wrap included — so a kcal
  ranking silently buries them. Category and protein first, kcal as a tiebreaker.
- **"Flag the Ukesmeny when it has a protein I like" fires 75% of the time** (measured over
  four published rotations, 20 weekdays). Chicken and pork are on the daily menu almost
  every day, so an absolute trigger is noise. The implemented rule is comparative — a
  preferred protein *plus* either genuine novelty against today's à la carte list, or a
  repeat-blocked pick. Re-measured: **25%**, about one day a week. It correctly skips days
  where the daily dish duplicates something standing (a kyllingcurry focaccia when there's
  already a kyllingcurry baguette).
- **An "occasional favourite" must not be a score penalty.** Expressing Lasagne's cooldown
  as negative points ranked it below Indisk masala — a dish actively marked `low`. On
  cooldown isn't worse, it's just not on offer, so it keeps its natural rank and is
  withheld from the shortlist with a stated reason instead.

## Not done yet

- Actually reminding anyone. The data and the countdown are here; the trigger isn't.
- Anything authenticated: "have I already ordered today?" (`CheckExistingOrder`) and
  placing an order (`createDailyOrder`). Both are mapped in the recon doc. Without this a
  reminder can only say "the deadline is in N hours", never "…and you haven't ordered".
- **Cancelling from the away-day flow.** `daily.mjs` and `away.mjs check` detect an order
  on a day you're away, but still tell you to cancel it yourself. Wiring that to
  `order-remove.mjs` would work — it's left manual on purpose, because auto-cancelling food
  based on a calendar entry is a bad thing to get wrong.
- **`replaceOrderItems` is mapped but unused.** Changing an existing order means
  remove-then-add today, which briefly leaves the day empty. Fine while the deadline is
  hours away, wrong if it's minutes.
- **No bulk ordering.** A week means five invocations. Deliberate for now — one failure
  mid-loop is easier to reason about than a partially-applied batch.
- Nothing outstanding on the read side: the first authenticated run confirmed the
  `delivery_date` meta key and turned up the `checkExistingOrder` gap documented above.
