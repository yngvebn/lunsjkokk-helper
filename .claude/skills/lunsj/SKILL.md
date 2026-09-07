---
name: lunsj
description: Check the Lunsjkokkene lunch order deadline, whether an order already exists for a delivery date, and suggest what to order based on preferences.json. Also records the days the user won't be in the office so those days are never suggested again. Use whenever the user asks about lunch, the lunch menu, what's for lunch, whether they've ordered, the order deadline/frist, or says "lunsj", "lunch", "ukesmeny", "bestille lunsj", asks for a lunch suggestion, or mentions being away / not in the office / working from home / on holiday on particular days.
---

# Lunsj

Everything here is a script. Run them; don't reimplement their logic in conversation.

## The daily check

```bash
node scripts/daily.mjs
```

Safe to run every day and quiet when there's nothing to do. Exit codes, so no text parsing:
`0` nothing needs you, `2` an order exists on an away day (urgent — money about to be spent
on uneaten lunch), `3` a decision is due today.

## Days out of the office

When the user says they won't be in — "I'm out Wednesday and Thursday", "borte torsdag",
"WFH next week" — record it. Those days then stop being suggested, permanently, until they
say otherwise.

```bash
node scripts/away.mjs add 2026-09-02 2026-09-03 --reason "kundemøte"
node scripts/away.mjs list
node scripts/away.mjs remove 2026-09-03      # only on an explicit change of mind
node scripts/away.mjs check                  # orders on away days? exits 2 if so
```

**You resolve the dates; the script does not parse language.** It takes ISO dates only, and
deliberately so — a date parser that quietly picks the wrong Wednesday is a bug discovered
at lunchtime. So:

1. Work out the actual dates from today's date (`node -e "console.log(new Date())"` or the
   `osloToday` helper if you need certainty about the current day in Oslo).
2. Pass them to `away.mjs add`.
3. **Read back the weekdays it prints** — it echoes `marked away: onsdag 2026-09-02`. If a
   weekday doesn't match what the user said, you resolved the wrong date; fix it with
   `remove` and re-add.

Marking is idempotent, so re-running is harmless. Never remove an away day unless the user
explicitly asks to be back in the office that day — the whole point is being asked once.

If `add`, `away.mjs check` or `daily.mjs` reports an **order already exists on an away
day**, say so prominently with the cancellation deadline, and do not bury it under a
suggestion.

**Then offer to cancel it — cancelling IS automated.** `order-remove.mjs` does the write,
with the same rules as any other order write: run the dry run, show what it says, and add
`--yes` only once the user has said yes to that specific day.

```bash
node scripts/order-remove.mjs 2026-09-09          # dry run
node scripts/order-remove.mjs 2026-09-09 --yes    # after the user confirms
```

Never say the user has to go to the dashboard themselves — that was true before
`order-remove.mjs` existed and is now just an excuse to make them click. The dashboard is
the fallback for the cases the script refuses: no `databaseId`, or a status past
PROCESSING/ON_HOLD/PENDING, where the food is already made.

Cancelling does **not** reopen the deadline. Before the cutoff, removing frees the day to
order something else; after it, the day is simply lunchless. The dry run states which.

## Answering "what should I have for lunch?"

```bash
node scripts/suggest.mjs
```

That's the whole answer for the common case. It picks the next delivery date you can still
order for, checks whether an order already exists, and ranks the menu against
`preferences.json`. Add a date (`2026-09-08`) or `--week` for the week; `--json` for
structured output; `--no-auth` to skip the order check.

**Report what it says, and lead with the deadline.** The countdown is the actionable part —
a perfect suggestion delivered after 13:00 is useless.

## Answering "have I ordered?" / avoiding double-booking

`suggest.mjs` already checks. If it prints `✅ Already ordered`, say so and **stop** — do not
suggest an alternative, and never imply another order should be placed. Two orders for one
day is the failure mode this exists to prevent.

Away days print `🏠 Not in the office` and are skipped by default — that is correct, not a
gap. `--include-away` shows them if the user asks.

If it prints `⚠ not signed in`, the order check didn't happen. Say that plainly rather than
letting a menu ranking read as confirmation that nothing is ordered. Then:

```bash
node scripts/auth.mjs status
```

## Just the menu, no opinions

```bash
node scripts/fetch-menu.mjs            # next orderable day
node scripts/fetch-menu.mjs --week     # Mon–Fri
```

Filtered to Ukesmeny, Ferdigretter, Brødmat, Wraps and Salater. `--all-categories` for cake,
drinks and groceries.

## Credentials

**Never ask the user to type their password into the conversation, and never accept it if
offered.** Setup is theirs to run, in their own terminal:

```
! node scripts/auth.mjs login
```

The `!` prefix runs it in their session, so the PowerShell `Read-Host -AsSecureString`
prompt reaches them directly. The password is encrypted with Windows DPAPI under their user
account and stored at `%LOCALAPPDATA%\lunsjkokk-helper\credentials.json`. It never appears
in a command line, in shell history, or in your context.

If a script reports a login failure, offer `node scripts/auth.mjs login` to re-enter — never
try to read, guess, or reconstruct the credential file.

After changing anything under `src/credentials.mjs`, run `node scripts/test-credentials.mjs`.
The failure mode there is silent: it once encrypted the wrong string entirely while every
shallow check still passed.

## Facts worth not re-deriving

- **Deadline: 13:00 Europe/Oslo the day before delivery.** Monday and Sunday deliveries roll
  back to the preceding **Friday**. There is a 10:00 rule in the site's code — it applies
  only to subscription-generated orders. If you do not use subscriptions, ignore it.
- **The Ukesmeny product names are meaningless.** Every day's chicken salad is called
  "Dagens rett". The dish is in `beskrivelse`. Quote the description, never the product name.
  When ordering one, `--dagens rett` handles the variation and size; the confirmation prints
  the dish so the user can see what they're actually getting.
- **`delivery_day` order meta is ENGLISH** (`monday`), while the menu's `dag` field is
  Norwegian (`mandag`). Mixing them produces an order the website cannot display. The code
  handles it — don't "correct" it.
- **Don't rank on kcal.** 13 of 31 items have none, including every wrap.
- Closed days come from the API; a closed day means no lunch, not a missed deadline.
- **Order existence comes from two sources, and the scripts already merge them.** The site's
  `checkExistingOrder` only sees `PROCESSING` orders and returns null identifiers; order
  history fills both gaps. Never call `checkExistingOrder` directly to answer "have I
  ordered" — use `suggest.mjs`, or `resolveOrderStatus` from `src/orders.mjs`.

## Placing and removing orders

These write to the real account and cause real food to be made. Billing is typically to
the employer, monthly and after delivery — so the usual risk is unwanted food arriving,
not a surprise card charge. Confirm that assumption for your own company.

```bash
node scripts/order-add.mjs 2026-09-09                  # DRY RUN, shows the exact mutation
node scripts/order-add.mjs 2026-09-09 --yes            # actually order
node scripts/order-add.mjs 2026-09-09 --name "Club Sandwich" --yes
node scripts/order-add.mjs 2026-09-09 --product 127154 --yes
node scripts/order-add.mjs 2026-09-09 --dagens rett --yes    # the day's Ukesmeny dish

node scripts/order-remove.mjs 2026-09-09               # DRY RUN
node scripts/order-remove.mjs 2026-09-09 --yes         # actually remove
```

**Rules for you, not just for the scripts:**

- **Always run the dry run first and show the user what it says** before adding `--yes`.
  The dry run names the food, the weekday and the deadline — that's what catches a
  right-shaped order on the wrong day.
- **Never pass `--yes` unless the user asked for that specific day's order in this
  conversation.** "Order lunch" for one day is not standing permission for the week.
  A request covering several days ("order next week") is permission for those days — but
  show the picks and let the user choose before writing five orders.
- **A full week of the top-ranked pick is five Brødmat items**, because category weight
  dominates. Offer `--vary-week`, or a mix with `--dagens`, rather than ordering five
  sandwiches silently.
- **One item per day is enforced, and you must not work around it.** If `order-add` exits 2
  with "already has an order", report that and stop. Do not remove the existing order to
  make room unless the user explicitly asks for the swap.
- **`--allow-late`, `--allow-weekend` and `--force-status` exist for the user to choose,
  not for you to reach for** when a guard fires. A guard firing is information.
- If a write reports success but the verification line says the day still shows no order,
  say so and **do not retry** — point at https://lunsjkokkene.no/dashboard. A retry risks
  two orders.

Both scripts verify by re-reading through `resolveOrderStatus` rather than trusting the
mutation's own response, which comes back with null ids.

**If the user says an order isn't showing on the website, do not assume they're wrong.**
A write can succeed, verify, and still be invisible — that exact bug happened, caused by
`delivery_day` being Norwegian instead of English. Diagnose by diffing the new order's full
`metaData` against a site-created one, not by re-reading the fields the script set. See
docs/api-recon.md.

Removal trashes rather than hard-deletes (no `forceDelete`), so it's recoverable from the
WordPress admin, and it refuses statuses past PROCESSING/ON_HOLD/PENDING — a PAKKET order
is food already made.

Removal does **not** reopen the deadline: if the cutoff has passed, removing leaves the day
with no lunch and no way to order. The dry run says so.

## Changing preferences, or setting someone up

Use the **`lunsj-preferences`** skill — it interviews against the real menu and then checks
the profile behaves. Reach for it when:

- a script reports "No food profile found" (a fresh clone; the file is personal and
  gitignored)
- someone says the suggestions are wrong, boring, or all the same
- a colleague is setting this up for themselves

For a small tweak, editing `preferences.json` directly is fine — but re-run
`node scripts/suggest.mjs --week --no-auth` afterwards rather than reasoning about what the
change should do. The scoring has enough interacting parts that predicting it is unreliable.

Two calibrations are documented in docs/api-recon.md and must not be "simplified" away: kcal
is missing on 13 of 31 items so it cannot be the ranking signal, and an absolute Ukesmeny
trigger fires on 75% of weekdays where the comparative one fires on 25%.
