/**
 * Loading and defaulting the food profile.
 *
 * `preferences.json` holds only what an interview actually elicits. Everything that is a
 * fact about the *menu* rather than about a person lives here as a default, so five
 * colleagues don't each carry a copy of it:
 *
 *  - `excludeFromMealRanking` — cutlery and a whole sourdough loaf are add-ons for
 *    everybody. A loaf scores 650 kcal and would otherwise rank as a top lunch.
 *  - the cooldown mechanics for an occasional favourite.
 *
 * The API calibrations that shaped the scoring (kcal is missing on 13 of 31 items; an
 * absolute Ukesmeny trigger fires on 75% of weekdays) are documented in docs/api-recon.md
 * and encoded in src/suggest.mjs, not repeated in each person's profile.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PREFERENCES_PATH = process.env.LUNSJ_PREFERENCES ?? join(ROOT, 'preferences.json');
export const EXAMPLE_PATH = join(ROOT, 'preferences.example.json');

/** Add-ons and non-food that sit in food categories. Not personal — true for everyone. */
export const DEFAULT_EXCLUDED = [
  'Engangsbestikk og serviett',
  'Helt oppskåret surdeigsbrød',
  'Focaccia og aioli',
  '3 stk surdeigsbrødskive',
  'Aioli fra Metervare',
  'Leverpostei fra Metervare',
];

const DEFAULTS = {
  proteins: { preferred: [], acceptable: [] },
  avoid: { hard: [], soft: [] },
  temperature: { default: 'any', warmExceptions: [] },
  categories: {
    primary: [],
    secondary: [],
    occasional: [],
    perDishOverrides: {},
    occasionalCooldownDays: 7,
    // Only consulted when there's no order history to check against, which is why it has
    // a default rather than being asked about.
    occasionalFallbackWeekday: 'fredag',
  },
  portion: { dagensRett: 'Vanlig' },
  menuStrategy: { default: 'alacarte' },
  repetition: { rule: 'never suggest the same item two days running' },
  excludeFromMealRanking: DEFAULT_EXCLUDED,
};

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Shallow-merge one level deep: enough for this shape, and predictable. */
function withDefaults(profile) {
  const out = { ...DEFAULTS, ...profile };
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (isObject(value)) out[key] = { ...value, ...(profile[key] ?? {}) };
  }
  // An empty array in the file is a deliberate "nothing excluded", but a missing key means
  // "use the shared list".
  if (!('excludeFromMealRanking' in profile)) out.excludeFromMealRanking = DEFAULT_EXCLUDED;
  return out;
}

/**
 * Load the profile, or fail with something a first-time user can act on.
 * A missing file is the normal state for a fresh clone, not an error to stack-trace.
 */
export async function loadPreferences(path = PREFERENCES_PATH) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error(
        `No food profile found at ${path}.\n` +
          '\nThis file is personal, so it is not in the repository. Create yours by running\n' +
          'the interview:\n\n' +
          '    /lunsj-preferences\n\n' +
          `or copy ${EXAMPLE_PATH} to preferences.json and edit it by hand.`,
      );
      e.code = 'NO_PREFERENCES';
      throw e;
    }
    throw new Error(`Could not read ${path}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }

  const problems = validatePreferences(parsed);
  if (problems.length) {
    throw new Error(`${path} has problems:\n` + problems.map((p) => `  - ${p}`).join('\n'));
  }
  return withDefaults(parsed);
}

/**
 * Structural checks only — this cannot tell whether someone actually likes chicken, but it
 * can catch the mistakes that produce a silently empty shortlist.
 */
export function validatePreferences(profile) {
  const problems = [];
  if (!isObject(profile)) return ['the file must contain a JSON object'];

  const cats = profile.categories;
  if (!isObject(cats)) {
    problems.push('missing "categories"');
  } else {
    const tiers = ['primary', 'secondary', 'occasional'];
    for (const t of tiers) {
      if (cats[t] != null && !Array.isArray(cats[t])) problems.push(`categories.${t} must be an array`);
    }
    const total = tiers.flatMap((t) => cats[t] ?? []);
    if (!total.length) problems.push('no categories listed — every suggestion would be empty');
    const dupes = total.filter((s, i) => total.indexOf(s) !== i);
    if (dupes.length) problems.push(`category in more than one tier: ${[...new Set(dupes)].join(', ')}`);
  }

  if (profile.proteins != null && !isObject(profile.proteins)) problems.push('"proteins" must be an object');
  if (isObject(profile.proteins)) {
    for (const k of ['preferred', 'acceptable']) {
      if (profile.proteins[k] != null && !Array.isArray(profile.proteins[k])) {
        problems.push(`proteins.${k} must be an array`);
      }
    }
  }
  if (isObject(profile.avoid)) {
    for (const k of ['hard', 'soft']) {
      if (profile.avoid[k] != null && !Array.isArray(profile.avoid[k])) problems.push(`avoid.${k} must be an array`);
    }
  }
  if (profile.portion?.dagensRett != null && !/^(vanlig|stor)$/i.test(profile.portion.dagensRett)) {
    problems.push('portion.dagensRett must be "Vanlig" or "Stor"');
  }
  return problems;
}
