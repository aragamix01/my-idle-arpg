/**
 * Content registry entry point.
 *
 * CONTENT_VERSION is stamped into every save. The server recomputes offline
 * progress from saves that may be weeks old — without the stamp, a balance
 * patch silently corrupts those numbers.
 *
 * Bump it whenever the affix pool, the effect schema, or TUNING changes in a
 * way that alters outcomes. A bump that also changes the *shape* of a save
 * needs a matching step in src/sim/migrate.ts.
 */

import { AFFIXES, IMPLICIT_AFFIXES } from './affixes';
import { BASE_AFFIXES, BASES } from './bases';
import { CURRENCIES, DISSEMBLE_YIELD, RARITY_RANK } from './currency';
import { UNIQUES } from './uniques';
import { EffectSchema, UniqueSchema } from './schema';
import { BASE_STATS } from '../types';

/** 2: artifacts became rolled item instances with prefixes and suffixes. */
/** 3: bases carry implicits, drops come in threes, and "artifact" became "item". */
/** 4: crafting currency, fragments, spirits, and dissembling. */
/** 5: modifiers carry a layer - flat, increased, more - instead of add/mul. */
export const CONTENT_VERSION = 5;

export * from './schema';
export * from './affixes';
export * from './bases';
export * from './currency';
export * from './uniques';

/**
 * Validates the whole registry.
 *
 * Called by a test rather than at runtime. Types already cover shape; this
 * catches what they cannot - duplicate ids, tier tables that are not ascending,
 * and affix templates that produce effects the interpreter would reject.
 */
export function validateRegistry(): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const seenAffix = new Set<string>();
  // Implicits go through the identical checks - they share the definition
  // shape precisely so they cannot drift into a second, unvalidated format.
  for (const affix of [...AFFIXES, ...IMPLICIT_AFFIXES]) {
    if (seenAffix.has(affix.id)) errors.push(`duplicate affix id: ${affix.id}`);
    seenAffix.add(affix.id);

    if (affix.tiers.length === 0) errors.push(`${affix.id}: no tiers`);
    for (let i = 1; i < affix.tiers.length; i++) {
      if (affix.tiers[i].minStage < affix.tiers[i - 1].minStage) {
        errors.push(`${affix.id}: tier ${i} unlocks before tier ${i - 1}`);
      }
    }
    // Tier 0 must be reachable at stage 1 or nothing can roll the affix.
    if (affix.tiers[0]?.minStage > 1) errors.push(`${affix.id}: lowest tier is gated above stage 1`);

    // Every template must produce an effect the interpreter accepts.
    const sample =
      affix.effect.kind === 'goldOnKill'
        ? { kind: 'goldOnKill' as const, multiplier: affix.tiers[0].value }
        : {
            kind: 'statMod' as const,
            stat: affix.effect.stat,
            op: affix.effect.op,
            value: affix.tiers[0].value,
          };
    const parsed = EffectSchema.safeParse(sample);
    if (!parsed.success) errors.push(`${affix.id}: produces an invalid effect`);

    if (affix.effect.kind === 'statMod') {
      const { stat, op } = affix.effect;

      // The rollable pool must not compound. A `more` affix multiplies rather
      // than summing, so N copies grow as a product and the marginal value of the
      // next roll rises with the last - which is the pathology the layer system
      // was introduced to remove. `more` is reserved for content bounded by
      // something: an authored unique list, or a gold cost curve.
      if (op === 'more') errors.push(`${affix.id}: rollable affixes may not use the more layer`);

      // For a stat whose base is already a multiplier, adding to the base *is*
      // increasing it, so a flat table would be a second name for one operation
      // and would render as a duplicate line.
      if (op === 'flat' && BASE_STATS[stat] === 1) {
        errors.push(`${affix.id}: ${stat} is a multiplier and has no meaningful flat layer`);
      }

      // Crit multiplier already multiplies into DPS through critFactor. A `more`
      // layer on top of that compounds twice over.
      if (stat === 'critMult' && op !== 'flat') {
        errors.push(`${affix.id}: critMult takes flat modifiers only`);
      }
    }
  }

  const seenBase = new Set<string>();
  for (const base of BASES) {
    if (seenBase.has(base.id)) errors.push(`duplicate base id: ${base.id}`);
    seenBase.add(base.id);
    // A base with no implicit is strictly worse than every other base, which
    // makes it dead content rather than a choice.
    if (!BASE_AFFIXES[base.id]) errors.push(`${base.id}: no implicit affix`);
  }

  // Two affixes on the same stat must never share a value at any tier, or an
  // item carrying both renders the identical line twice and reads as a bug.
  // The roll-sampling test catches this too, but only for combinations it
  // happens to roll; this catches it the moment a table is edited.
  const byStat = new Map<string, { id: string; value: number }[]>();
  for (const affix of [...AFFIXES, ...IMPLICIT_AFFIXES]) {
    if (affix.effect.kind !== 'statMod') continue;
    const key = `${affix.effect.stat}:${affix.effect.op}`;
    const seen = byStat.get(key) ?? [];
    for (const tier of affix.tiers) {
      const clash = seen.find((other) => other.value === tier.value);
      if (clash) errors.push(`${affix.id} and ${clash.id} both grant ${tier.value} ${key}`);
      seen.push({ id: affix.id, value: tier.value });
    }
    byStat.set(key, seen);
  }

  const seenCurrency = new Set<string>();
  for (const currency of CURRENCIES) {
    if (seenCurrency.has(currency.id)) errors.push(`duplicate currency id: ${currency.id}`);
    seenCurrency.add(currency.id);

    const action = currency.action;
    // A combine pointing at a missing currency, or at itself, would be a
    // fragment that either vanishes or duplicates forever.
    if (action.kind === 'combine') {
      if (!CURRENCIES.some((c) => c.id === action.into)) {
        errors.push(`${currency.id}: combines into unknown ${action.into}`);
      }
      if (action.into === currency.id) errors.push(`${currency.id}: combines into itself`);
      if (action.count < 2) errors.push(`${currency.id}: combine count must exceed one`);
    }
    // An upgrade that does not raise rarity is a reroll wearing a disguise.
    if (action.kind === 'upgradeRarity' && RARITY_RANK[action.to] <= RARITY_RANK[action.from]) {
      errors.push(`${currency.id}: ${action.from} -> ${action.to} does not raise rarity`);
    }
    if (action.kind === 'gamble' && (action.successChance <= 0 || action.successChance >= 1)) {
      errors.push(`${currency.id}: a gamble needs odds strictly between 0 and 1`);
    }
  }

  // Every dissemble yield must exist, or destroying an item pays nothing.
  for (const [rarity, id] of Object.entries(DISSEMBLE_YIELD)) {
    if (!CURRENCIES.some((c) => c.id === id)) {
      errors.push(`dissembling ${rarity} yields unknown currency ${id}`);
    }
  }

  const seenUnique = new Set<string>();
  for (const unique of UNIQUES) {
    if (seenUnique.has(unique.id)) errors.push(`duplicate unique id: ${unique.id}`);
    seenUnique.add(unique.id);
    const parsed = UniqueSchema.safeParse(unique);
    if (!parsed.success) {
      errors.push(`${unique.id}: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
