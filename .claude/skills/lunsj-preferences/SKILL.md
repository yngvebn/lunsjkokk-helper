---
name: lunsj-preferences
description: Interview someone about their lunch taste and write preferences.json for the Lunsjkokkene helper, then check the resulting profile against the live menu. Use when setting up the lunsj tool for the first time, when a script reports "No food profile found", when someone says their suggestions are wrong or boring, or when they ask to change what lunch gets suggested.
---

# Lunsj preferences

Build someone's food profile by interviewing them **against the real menu**, then prove the
profile behaves before saving it. The template is `preferences.example.json`; the output is
`preferences.json` (personal, gitignored).

## Why the checking step is not optional

When this profile was first built for its author, **two of his own answers were measurably
wrong**, and only running the ranking against live data caught it:

- He asked for "whatever has the most in it" — but **13 of 31 items have no kcal at all**,
  including every wrap. Ranking on kcal would have silently buried exactly the items he
  might want.
- He wanted the Ukesmeny flagged when it had a protein he likes — measured, that fires on
  **15 of 20 weekdays**. Chicken and pork are on the daily menu nearly every day, so the
  trigger was noise, not signal.

An interview that ends at "profile saved" will produce a kcal-ranked profile with a 75%
flag rate, because those are the intuitive answers. **Always run step 4.**

## 1. Look at the menu first

```bash
node scripts/fetch-menu.mjs --week --compact
node scripts/fetch-menu.mjs --all-categories --compact   # if they want cake and drinks too
```

Ask questions grounded in what's actually there — "chicken shows up in 10 of the 31 items,
is that a draw or a default?" beats "what proteins do you like?".

## 2. Interview

Cover these. Use `AskUserQuestion` with concrete options naming real dishes and prices.

| topic | what you need | maps to |
|---|---|---|
| Proteins | which are a draw, which are merely fine | `proteins.preferred` / `.acceptable` |
| Exclusions | **allergy or dislike?** | `avoid.hard` vs `avoid.soft` |
| Warm or cold | only Ferdigretter and Dagens varmrett are warm | `temperature` |
| Categories | where they actually order from | `categories.primary/secondary/occasional` |
| Portion | Dagens rett Vanlig 79 kr or Stor 89 kr | `portion.dagensRett` |
| Ukesmeny vs à la carte | lead with which | `menuStrategy.default` |
| Specific dishes | a favourite that would bore them daily; a dish to bury | `categories.perDishOverrides` |
| Repetition | how much sameness is fine | `repetition` |
| Discount range | do they see INNOM or Hakone categories on the site? | `--discount-group` on the CLIs |

Rules while interviewing:

- **"Allergy or dislike" is the one question you must not skip or guess.** `hard` excludes
  outright; `soft` only deprioritises. Getting this wrong is the only way this tool can
  actually harm someone. Also tell them plainly: this reads a website's allergen field, so
  it is never a medical guarantee.
- **Push back when two answers conflict.** "Cold food" plus "I order Ferdigretter" is a
  contradiction worth resolving — for the author it resolved to *Lasagne specifically*, an
  `occasional-favourite`, not the whole warm category.
- A category listed in no tier is **never suggested**. Say so before they omit something.
- Don't ask about add-ons (cutlery, a whole loaf) — those are excluded in code for everyone.

## 3. Write the file

Write `preferences.json` in the repo root, following `preferences.example.json`. Only
include what the interview elicited: shared defaults (the add-on exclusions, cooldown
mechanics) live in `src/preferences.mjs`, and the menu calibrations live in
`docs/api-recon.md`. Don't copy those into someone's profile.

## 4. Check it against reality, then show them

```bash
node scripts/suggest.mjs --no-auth              # today's ranking
node scripts/suggest.mjs --week --no-auth --vary-week
```

Report back, and ask them to confirm or correct:

- **The top three and the bottom three picks.** If a bottom pick is something they'd
  happily eat, or a top pick is something they wouldn't, the weights are wrong.
- **Whether the whole week is one category.** Category weight dominates protein weight, so
  a bread-first profile yields five bread days. That's faithful, but they should choose it
  knowingly.
- **The Ukesmeny flag rate.** Measure it rather than assuming:

```bash
node -e "
import('./src/api.mjs').then(async ({fetchCatalogue, fetchClosedDays, fetchWeeklyMenu}) => {
  const {buildDay} = await import('./src/menu.mjs');
  const {rankDay} = await import('./src/suggest.mjs');
  const {loadPreferences} = await import('./src/preferences.mjs');
  const {addDays, mondayOf, osloToday} = await import('./src/oslo.mjs');
  const prefs = await loadPreferences();
  const [closedDays, catalogue] = await Promise.all([fetchClosedDays(), fetchCatalogue()]);
  let fired = 0, total = 0;
  for (let w = 0; w < 4; w++) {
    const monday = addDays(mondayOf(osloToday()), w * 7);
    const menu = await fetchWeeklyMenu(monday);
    if (!menu) continue;
    for (let i = 0; i < 5; i++) {
      const day = buildDay({date: addDays(monday, i), weeklyMenu: menu, closedDays, catalogue});
      total++;
      if (rankDay(day, prefs).ukesmeny.flagged.length) fired++;
    }
  }
  console.log(\`Ukesmeny flag fires on \${fired}/\${total} weekdays (\${Math.round(fired/total*100)}%)\`);
});"
```

Roughly 20–35% is useful — about one day a week. Above ~50% it's noise and the person will
learn to ignore it; at 0% they'll never hear about a good daily dish. Tune
`proteins.preferred` or the category tiers and re-measure, rather than guessing.

## 5. Iterate

Changing a profile is editing `preferences.json` and re-running step 4. Do that rather than
reasoning about what the change *should* do — the scoring has enough interacting parts that
predicting it is unreliable.

## Notes

- `node scripts/test.mjs` should still pass afterwards; it asserts the scoring behaviour,
  not anyone's taste.
- If they have no credentials yet, `--no-auth` is the right flag throughout. Order history
  only sharpens the cooldown; it isn't needed to build a profile.
- Someone with a genuine allergy should be pointed at the site's own allergen filtering as
  the authority, not this tool.
