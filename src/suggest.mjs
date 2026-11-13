/**
 * Turns `preferences.json` plus a day's menu into a ranked shortlist.
 *
 * Design notes worth keeping:
 *
 *  - Category weight dominates protein weight, because "Brødmat is my home category" is a
 *    stronger statement than "this one has chicken in it". That does mean the top of the
 *    list is bread-heavy; `shortlist` deliberately reaches down into other categories so
 *    there's something to rotate to.
 *  - kcal contributes at most a few points. 13 of 31 items have none, so anything more
 *    would rank items by *whether the data exists* rather than by how filling they are.
 *  - The Ukesmeny flag is comparative, not absolute. An absolute "has a protein I like"
 *    trigger was measured firing on 75% of weekdays, which is noise.
 */

/**
 * Is an `occasional-favourite` due today?
 *
 * With order history: due unless it was eaten inside the cooldown window. That's the
 * honest reading of "not every day" — it uses what was actually ordered.
 *
 * Without history (anonymous run) there's nothing to reason from, so it falls back to a
 * fixed weekday. That day is an assumption, not something you told me — it's
 * `occasionalFallbackWeekday` in preferences.json, change it freely.
 */
function occasionalEligibility(day, prefs, recentNames, weekday) {
  const cooldownDays = prefs.categories?.occasionalCooldownDays ?? 7;
  const fallbackDay = (prefs.categories?.occasionalFallbackWeekday ?? 'fredag').toLowerCase();
  const recent = new Set(recentNames);
  const haveHistory = recentNames.length > 0 || prefs.__historyAvailable === true;

  return (name) => {
    if (prefs.categories?.perDishOverrides?.[name] !== 'occasional-favourite') {
      return { eligible: true, reason: null };
    }
    if (haveHistory) {
      return recent.has(name)
        ? { eligible: false, reason: `a favourite, but ordered in the last ${cooldownDays} days` }
        : { eligible: true, reason: null };
    }
    const today = (weekday ?? day.weekday ?? '').toLowerCase();
    return today === fallbackDay
      ? { eligible: true, reason: null }
      : { eligible: false, reason: `a favourite, saved for ${fallbackDay} (no order history to check)` };
  };
}

const CATEGORY_WEIGHT = { primary: 100, secondary: 70, occasional: 25 };
const PROTEIN_PREFERRED = 80;
const PROTEIN_ACCEPTABLE = 20;
const SOFT_AVOID = -60;
const DISH_FAVOURITE = 60;
const DISH_LOW = -60;
const REPEAT_PENALTY = -120;
const MUST_HAVE = 400;
// A nudge, not a takeover: enough to reorder within a category, not to beat the home
// category on its own. The bigger effect is on the Ukesmeny flag below.
const LIKED = 25;

/** Only these Ukesmeny slots are cold, so only these are ever candidates. */
const COLD_SLOTS = ['rett', 'paasmurt'];

const wordRx = (words) => (words?.length ? new RegExp(words.map(escapeRx).join('|'), 'i') : null);
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which `avoid` terms an item hits. A term matches an allergen by its exact API spelling,
 * or the item's text as a case-insensitive substring. Both, because a dislike like "sopp"
 * is an ingredient rather than an allergen and only exists in the description, and
 * Norwegian compounds ("kantarellsopp", "valnøtter") rule out whole-word matching.
 * Substring errs towards over-matching, which is the right direction for an exclusion.
 */
export function avoidHits(terms, text, allergener = []) {
  if (!terms?.length) return [];
  const haystack = String(text ?? '').toLowerCase();
  return terms.filter((t) => allergener.includes(t) || haystack.includes(String(t).toLowerCase()));
}

function categoryTier(prefs, slug) {
  if (prefs.categories.primary?.includes(slug)) return 'primary';
  if (prefs.categories.secondary?.includes(slug)) return 'secondary';
  if (prefs.categories.occasional?.includes(slug)) return 'occasional';
  return null;
}

/**
 * Score one candidate. `reasons` is populated as we go so the output can explain itself —
 * a suggestion you can't interrogate is one you can't correct.
 */
function scoreItem(item, slug, prefs, { avoidNames = new Set(), eligible = true, cooldownReason = null } = {}) {
  let heldBack = false;
  let heldBackReason = null;
  const preferred = wordRx(prefs.proteins.preferred);
  const acceptable = wordRx(prefs.proteins.acceptable);
  const tier = categoryTier(prefs, slug);
  const text = `${item.name} ${item.description ?? ''}`;
  const reasons = [];

  let score = CATEGORY_WEIGHT[tier] ?? 0;
  if (tier && tier !== 'primary') reasons.push(`${tier} category`);

  const override = prefs.categories.perDishOverrides?.[item.name];
  if (preferred?.test(text)) {
    score += PROTEIN_PREFERRED;
    reasons.push('preferred protein');
  } else if (override === 'occasional-favourite') {
    // A named favourite already says "I want this" — the protein rule is a proxy for that
    // and shouldn't overrule it. Without this, a meatless favourite (Middelhavssalat) sat
    // below every chicken wrap even when due.
    score += PROTEIN_PREFERRED;
    reasons.push('favourite, protein rule waived');
  } else if (acceptable?.test(text)) {
    score += PROTEIN_ACCEPTABLE;
    reasons.push('acceptable protein');
  } else {
    reasons.push('no preferred protein');
  }

  const softHits = avoidHits(prefs.avoid?.soft, text, item.allergener ?? []);
  if (softHits.length) {
    score += SOFT_AVOID;
    reasons.push(`contains ${softHits.join(', ')} (disliked, not excluded)`);
  }

  if (override === 'occasional-favourite') {
    // "I love lasagne, but not every day" — a favourite that ranks second every single day
    // isn't a treat, it's a fixture. But being on cooldown doesn't make it *worse* than a
    // dish you actively dislike, so don't express it as a score penalty (that ranked
    // Lasagne below Indisk masala). Keep the natural score and withhold it from the
    // shortlist instead: not offered today, still clearly liked.
    if (eligible) {
      score += DISH_FAVOURITE;
      reasons.push('a favourite, and due');
    } else {
      heldBack = true;
      heldBackReason = cooldownReason ?? 'a favourite, but had recently';
      reasons.push(cooldownReason ?? 'a favourite, but had recently');
    }
  } else if (override === 'low') {
    score += DISH_LOW;
    reasons.push('specifically deprioritised');
  }

  if (item.kcal) score += item.kcal / 100;
  else reasons.push('no kcal data');

  if (prefs.mustHaveRx?.test(`${item.name} ${item.description ?? ''}`)) {
    score += MUST_HAVE;
    reasons.push('a must-have');
  }

  const liked = prefs.likedRx && `${item.name} ${item.description ?? ''}`.match(prefs.likedRx);
  if (liked) {
    score += LIKED;
    reasons.push(`liked (${liked[0].toLowerCase()})`);
  }

  if (avoidNames.has(item.name)) {
    score += REPEAT_PENALTY;
    reasons.push('had or suggested this yesterday');
  }

  return { score, reasons, tier, heldBack, heldBackReason };
}

/**
 * Rank a day.
 *
 * @param day        a `buildDay` result
 * @param prefs      parsed preferences.json
 * @param avoidNames item names to push down (yesterday's order or suggestion)
 */
export function rankDay(day, prefs, { avoidNames = new Set(), recentNames = [], weekday = null } = {}) {
  const exclude = new Set(prefs.excludeFromMealRanking ?? []);
  prefs = { ...prefs, mustHaveRx: wordRx(prefs.menuStrategy?.mustHave), likedRx: wordRx(prefs.menuStrategy?.likes) };
  const occasional = occasionalEligibility(day, prefs, recentNames, weekday);

  const candidates = [];
  const extras = [];
  for (const group of day.alacarte) {
    for (const item of group.items) {
      const entry = { ...item, category: group.slug, categoryName: group.name };
      if (exclude.has(item.name)) {
        extras.push(entry);
        continue;
      }
      // A dish they've ruled out: not an add-on, so not in extras either — just gone.
      if (prefs.categories.perDishOverrides?.[item.name] === 'never') continue;
      // Same for anything on the hard list — that's what "hard" promises (an allergy, or
      // "I won't eat that"), so it must never reach a suggestion, not merely rank low.
      if (avoidHits(prefs.avoid?.hard, `${item.name} ${item.description ?? ''}`, item.allergener ?? []).length) continue;
      const elig = occasional(item.name);
      const { score, reasons, tier, heldBack, heldBackReason } = scoreItem(entry, group.slug, prefs, {
        avoidNames,
        eligible: elig.eligible,
        cooldownReason: elig.reason,
      });
      if (tier === null) continue; // a category the profile says nothing about
      candidates.push({ ...entry, score, reasons, heldBack, heldBackReason });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'nb'));

  // Reach past the top of the list for one item from each other category, so there's
  // always something to rotate to rather than five near-identical baguettes. Items on
  // cooldown stay in `candidates` (with their reason) but are never offered.
  const offerable = candidates.filter((c) => !c.heldBack);
  const shortlist = [];
  const seenCategories = new Set();
  for (const c of offerable) {
    if (shortlist.length >= 5) break;
    if (seenCategories.has(c.category) && seenCategories.size < 3) continue;
    shortlist.push(c);
    seenCategories.add(c.category);
  }
  for (const c of offerable) {
    if (shortlist.length >= 5) break;
    if (!shortlist.includes(c)) shortlist.push(c);
  }

  return {
    candidates,
    shortlist,
    extras,
    heldBack: candidates.filter((c) => c.heldBack),
    ukesmeny: rankUkesmeny(day, prefs, shortlist[0], candidates),
  };
}

/**
 * Norwegian filler plus the words that appear in half the catalogue anyway. Without this,
 * "servert", "hjemmelaget" and "salat" would make every dish look novel.
 */
const STOPWORDS = new Set([
  'servert', 'hjemmelaget', 'fylt', 'marinert', 'syltet', 'bakte', 'blandet', 'kremet',
  'salat', 'salatbasert', 'sandwich', 'wraps', 'wrap', 'brod', 'brød', 'focaccia', 'baguette',
  'dagens', 'vart', 'vår', 'våre', 'egen', 'friske', 'sprø', 'spro', 'liten', 'stor',
  'med', 'og', 'fra', 'til', 'som', 'den', 'det', 'for', 'har', 'ikke', 'eller',
]);

/**
 * ø, æ and å are single codepoints, so NFD leaves them alone and a naive [^a-z] split
 * chops words in half — "firkornsbrød" became "firkornsbr". Transliterate them first.
 */
const foldNordic = (s) =>
  s
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const contentWords = (text) =>
  new Set(
    foldNordic(String(text ?? ''))
      .split(/[^a-z]+/)
      .filter((w) => w.length > 4 && !STOPWORDS.has(foldNordic(w))),
  );

/**
 * Should the Ukesmeny interrupt the à la carte pick?
 *
 * Comparative, because absolute isn't a signal: "contains a protein I like" was measured
 * firing on 15 of 20 weekdays. A preferred protein is therefore necessary but not
 * sufficient — the dish also has to earn the interruption, by one of the two triggers the
 * profile actually names:
 *
 *   repeat  — the best à la carte pick is repeat-penalised, so the usuals ARE repetitive
 *   novel   — the dish offers ingredients today's à la carte catalogue doesn't have,
 *             i.e. it's something you couldn't order anyway
 *   liked   — it matches `menuStrategy.likes` (a cuisine or style, e.g. tex-mex). Narrow
 *             by construction, so it doesn't reintroduce the absolute trigger's noise.
 *
 * `menuStrategy.mustHave` overrides all of it, in every slot — warm ones included. A
 * dish you'd be upset to miss is not something to weigh against the usual sandwich.
 */
function rankUkesmeny(day, prefs, best, candidates = []) {
  if (!day.dagens) return { available: false, flagged: [], mustHaves: [], considered: [] };
  const preferred = wordRx(prefs.proteins.preferred);

  // Everything today's à la carte list already offers, as a bag of words.
  const catalogueWords = new Set();
  for (const c of candidates) for (const w of contentWords(`${c.name} ${c.description ?? ''}`)) catalogueWords.add(w);

  const bestIsRepeat = Boolean(best?.reasons?.some((r) => r.includes('yesterday')));

  const considered = Object.values(day.dagens)
    .filter((slot) => slot && (COLD_SLOTS.includes(slot.slot) || prefs.mustHaveRx?.test(slot.dish)))
    // A hard exclusion beats a must-have: "chili con carne" with something you can't eat
    // in it is still something you can't eat.
    .filter((slot) => !avoidHits(prefs.avoid?.hard, slot.dish, slot.allergener ?? []).length)
    .map((slot) => {
      const mustHave = Boolean(prefs.mustHaveRx?.test(slot.dish));
      const hitsProtein = Boolean(preferred?.test(slot.dish));
      const hitsAvoid = avoidHits(prefs.avoid?.soft, slot.dish, slot.allergener ?? []).length > 0;

      const novelWords = [...contentWords(slot.dish)].filter((w) => !catalogueWords.has(w));
      const isNovel = novelWords.length >= 3;
      const likedMatch = prefs.likedRx ? slot.dish.match(prefs.likedRx) : null;

      const reasons = [];
      if (mustHave) reasons.push('a must-have');
      if (hitsProtein) reasons.push('preferred protein');
      if (hitsAvoid) reasons.push('contains something disliked');
      if (bestIsRepeat) reasons.push('à la carte pick would repeat');
      if (isNovel) reasons.push(`offers ${novelWords.slice(0, 4).join(', ')}`);
      if (likedMatch) reasons.push(`liked (${likedMatch[0].toLowerCase()})`);

      return {
        slot: slot.slot,
        label: slot.label,
        dish: slot.dish,
        allergener: slot.allergener,
        kcal: slot.kcal,
        price:
          prefs.portion?.dagensRett === 'Vanlig'
            ? (slot.sizes?.find((s) => /vanlig/i.test(s.name))?.price ?? slot.price)
            : (slot.sizes?.at(0)?.price ?? slot.price),
        hitsProtein,
        hitsAvoid,
        isNovel,
        novelWords,
        reasons,
        mustHave,
        flagged: mustHave || (hitsProtein && !hitsAvoid && (bestIsRepeat || isNovel || Boolean(likedMatch))),
      };
    });

  return {
    available: true,
    considered,
    flagged: considered.filter((c) => c.flagged && !c.mustHave),
    mustHaves: considered.filter((c) => c.mustHave),
  };
}
