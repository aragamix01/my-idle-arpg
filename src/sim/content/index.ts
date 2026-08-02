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
import { eligibleAffixes } from '../items';
import { BASE_AFFIXES, BASES, getBase } from './bases';
import { CURRENCIES, DISSEMBLE_YIELD, RARITY_RANK } from './currency';
import { UNIQUES } from './uniques';
import { wavesForTier } from './tablets';
import {
  AFFIX_LIMITS,
  EffectSchema,
  UNIQUE_TIER_WEIGHTS,
  UniqueSchema,
  type AffixDefinition,
  type UniqueEffect,
} from './schema';
import { ABYSS_UNLOCK_STAGE, BASE_STATS, MAX_TABLET_TIER } from '../types';

/** 2: artifacts became rolled item instances with prefixes and suffixes. */
/** 3: bases carry implicits, drops come in threes, and "artifact" became "item". */
/** 4: crafting currency, fragments, spirits, and dissembling. */
/** 5: modifiers carry a layer - flat, increased, more - instead of add/mul. */
/** 6: weapons grant skills, skills cost a resource, and uniques roll their values. */
/** 7: gold is a decimal string, so magnitudes are no longer capped at 1.8e308. */
/** 8: equip slots are derived, so the loadout array is MAX_ITEM_SLOTS long. */
/** 9: skills carry an element, targets carry resistance, and penetration is a stat. */
/** 10: Abyssal tablets - a tier you hold, with modifiers, in its own save array. */
/** 11: a tablet is an item - rarity for rows, an implicit that pays, explicits that buff monsters. */
/** 12: accessories - two rings and an amulet, from the Abyss only. */
export const CONTENT_VERSION = 12;

export * from './schema';
export * from './affixes';
export * from './bases';
export * from './currency';
export * from './skills';
export * from './uniques';
export * from './tablets';

/**
 * The shallowest item level anything carrying this affix can have.
 *
 * Implicits are keyed by base id rather than tagged, so the base is what says which
 * scale an implicit's gates are on. Rolled affixes read it off `rollsOn`.
 */
function affixFloor(affix: AffixDefinition): number {
  if (affix.rollsOn === 'accessory') return ABYSS_UNLOCK_STAGE;
  // Implicits carry no `rollsOn` - they are keyed by base id - so the base is what says
  // which scale their gates are on.
  const owner = Object.entries(BASE_AFFIXES).find(([, a]) => a.id === affix.id)?.[0];
  if (owner && getBase(owner)?.wear) return ABYSS_UNLOCK_STAGE;
  // Tablets count their itemLevel in TIERS from 1, and gear starts at stage 1, so both
  // floors are the same number by coincidence rather than by sharing a scale.
  return 1;
}

/**
 * Whether two affixes can ever land on the same item.
 *
 * The duplicate-value rule exists because an item carrying two affixes that render the
 * identical line reads as a bug. Two affixes that can never co-roll cannot do that, and
 * holding them apart anyway forbids perfectly good content: `of-Ascendancy` grants +1
 * physical skill level on an accessory and `of-Mastery` grants +1 on a weapon, and since
 * skill levels are integers there is no way to make them differ that is not arbitrary.
 *
 * Decided by asking every base, rather than by reasoning about the tags - the eligibility
 * rules live in `eligibleAffixes` and this must not become a second copy of them that can
 * disagree.
 */
function canCoRoll(a: AffixDefinition, b: AffixDefinition): boolean {
  return BASES.some((base) => {
    const eligible = eligibleAffixes([a, b], base.id);
    return eligible.length === 2;
  });
}

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
    /*
      Tier 0 must be reachable by the shallowest item that can carry the affix, or
      nothing can ever roll it.

      "Stage 1" was that floor while every item could drop at stage 1. An accessory
      cannot: it comes only from the Abyss, so the shallowest one that exists is at
      `abyssalDepth(1)` and gating its tier 0 there is exactly what gating a Whetstone's
      at stage 1 means. Checking accessories against 1 would demand a tier no accessory
      could ever be shallow enough to want.
    */
    const floor = affixFloor(affix);
    if (affix.tiers[0]?.minStage > floor) {
      errors.push(`${affix.id}: lowest tier is gated above ${floor}, so nothing can roll it`);
    }

    // THE PARTITION, asserted in both directions.
    //
    // A tablet is stored as an ItemInstance, so nothing but this stops `rerollAffixes`
    // handing one increased crit chance, or a Whetstone rolling "monsters have 40% more
    // health". Storing tablets in a separate type used to enforce it; a pair of checks
    // that run on every build enforces it better, and without the duplicate type.
    if ((affix.effect.kind === 'monsterBuff') !== (affix.rollsOn === 'tablet')) {
      errors.push(
        affix.effect.kind === 'monsterBuff'
          ? `${affix.id}: buffs monsters but is not tagged rollsOn: 'tablet'`
          : `${affix.id}: is tagged rollsOn: 'tablet' but does not buff monsters`,
      );
    }

    // Every template must produce an effect the interpreter accepts - except the two
    // that deliberately produce none. A tablet's modifiers act on the RUN, so there is
    // nothing here to parse; the partition check above is what holds them in place.
    const template = affix.effect;
    const runOnly = template.kind === 'monsterBuff' || template.kind === 'tabletReward';
    if (template.kind === 'goldOnKill' || template.kind === 'extraElement' || template.kind === 'statMod') {
      const sample =
        template.kind === 'goldOnKill'
          ? { kind: 'goldOnKill' as const, multiplier: affix.tiers[0].value }
          : template.kind === 'extraElement'
            ? {
                kind: 'extraElement' as const,
                element: template.element,
                fraction: affix.tiers[0].value,
              }
            : {
                kind: 'statMod' as const,
                stat: template.stat,
                op: template.op,
                value: affix.tiers[0].value,
              };
      const parsed = EffectSchema.safeParse(sample);
      if (!parsed.success) errors.push(`${affix.id}: produces an invalid effect`);
    }

    // A tablet modifier is pure downside on its own - the implicit is what pays for it.
    // One that added no danger would be a free reward multiplier, which collapses the
    // trade the whole mode rests on.
    if (runOnly && affix.tiers.some((tier) => tier.value <= 0)) {
      errors.push(`${affix.id}: a tablet modifier must carry a positive magnitude`);
    }

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

      // The mirror of the rule above. Penetration's base is zero, so a percentage of
      // it is zero forever - an affix that reads as a bonus and does literally nothing,
      // which is worse than one that is merely weak.
      if (op !== 'flat' && BASE_STATS[stat] === 0) {
        errors.push(`${affix.id}: ${stat} has a base of zero, so only a flat layer moves it`);
      }

      // Crit multiplier already multiplies into DPS through critFactor, so a
      // `more` layer on top of that compounds twice over. `increased` is fine and
      // Of Cruelty uses it - it widens the pool critFactor multiplies rather than
      // multiplying the result again. The pool-wide `more` ban above already
      // covers rollable affixes; this is the rule uniques are held to as well.
      if (stat === 'critMult' && op === 'more') {
        errors.push(`${affix.id}: critMult must not take a more modifier`);
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

  /*
    Two affixes on the same stat must never share a value at any tier, or an item
    carrying both renders the identical line twice and reads as a bug. The roll-sampling
    test catches this too, but only for combinations it happens to roll; this catches it
    the moment a table is edited.

    Only for pairs that can actually CO-ROLL. `of-Ascendancy` grants +1 physical skill
    level on an accessory and `of-Mastery` grants +1 on a weapon, and no item is both -
    skill levels are integers, so forbidding the overlap would mean picking arbitrary
    different integers for no reader's benefit.
  */
  const byStat = new Map<string, { affix: AffixDefinition; value: number }[]>();
  for (const affix of [...AFFIXES, ...IMPLICIT_AFFIXES]) {
    if (affix.effect.kind !== 'statMod') continue;
    const key = `${affix.effect.stat}:${affix.effect.op}`;
    const seen = byStat.get(key) ?? [];
    for (const tier of affix.tiers) {
      const clash = seen.find(
        (other) => other.value === tier.value && canCoRoll(affix, other.affix),
      );
      if (clash) errors.push(`${affix.id} and ${clash.affix.id} both grant ${tier.value} ${key}`);
      seen.push({ affix, value: tier.value });
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

    // Widened, because `as const satisfies` narrows every authored value to a
    // literal and a check the CURRENT roster happens to satisfy would be reported as
    // dead code rather than run. These guards exist for the next entry, not this one.
    for (const [i, effect] of (unique.effects as readonly UniqueEffect[]).entries()) {
      // Uniques are the one place `more` is allowed, but critMult already multiplies
      // into DPS through critFactor, so a `more` on top compounds twice over. The
      // rollable pool is barred from this by the loop above; this is the same rule
      // held against authored content.
      if (effect.kind === 'statMod' && effect.stat === 'critMult' && effect.op === 'more') {
        errors.push(`${unique.id}: critMult must not take a more modifier`);
      }
      // Both ends of a range must be resolvable by the interpreter, not just the
      // midpoint - a range straddling a value the schema rejects would produce an
      // item that works until the day someone rolls the bad end of it.
      for (const value of [effect.roll.min, effect.roll.max]) {
        // Each kind carries its magnitude under a different field name, so the sample
        // has to be built per kind rather than by dropping `value` into a shared one.
        const sample =
          effect.kind === 'statMod'
            ? { kind: 'statMod' as const, stat: effect.stat, op: effect.op, value }
            : effect.kind === 'equipSlots'
              ? { kind: 'equipSlots' as const, delta: Math.round(value) }
              : { kind: effect.kind as 'goldOnKill' | 'keyDrop' | 'amplifyOthers', multiplier: value };
        if (!EffectSchema.safeParse(sample).success) {
          errors.push(`${unique.id} effect ${i}: ${value} produces an invalid effect`);
        }
      }
    }

    // A unique whose ranges are all constants can never be improved, which makes
    // Angel Flame refuse it - fine for one authored downside, wrong for a whole item.
    if (unique.effects.every((e) => e.roll.max === e.roll.min)) {
      errors.push(`${unique.id}: every effect is a constant, so nothing can be rolled`);
    }
  }

  // A tablet base must pay something, and its implicit must be a reward rather than a
  // stat - otherwise a run would hand the player a permanent modifier for clearing it.
  for (const base of BASES.filter((b) => b.pays)) {
    if (BASE_AFFIXES[base.id]?.effect.kind !== 'tabletReward') {
      errors.push(`${base.id}: a tablet base's implicit must be a tabletReward`);
    }
  }
  for (const [baseId, affix] of Object.entries(BASE_AFFIXES)) {
    if (affix.effect.kind === 'tabletReward' && !getBase(baseId)?.pays) {
      errors.push(`${baseId}: pays out like a tablet but is not one`);
    }
  }

  // A rare needs three rows per side, so the tablet pool has to hold at least that many
  // on each - otherwise a rare tablet silently rolls fewer modifiers than it claims.
  const tabletPool = AFFIXES.filter((a) => a.rollsOn === 'tablet');
  for (const side of ['prefix', 'suffix'] as const) {
    const available = tabletPool.filter((a) => a.kind === side).length;
    const needed = AFFIX_LIMITS.rare[side];
    if (available < needed) {
      errors.push(`tablet ${side} pool: ${needed} rows but only ${available} modifiers`);
    }
  }

  // Every tier must be able to roll something, or a shallow tablet has no modifiers at
  // all and its implicit pays the bare base rate forever.
  for (let tier = 1; tier <= MAX_TABLET_TIER; tier++) {
    if (!tabletPool.some((a) => a.tiers[0].minStage <= tier)) {
      errors.push(`tablet tier ${tier}: nothing in the pool can roll`);
    }
    if (wavesForTier(tier) < 1) errors.push(`tablet tier ${tier}: a run with no waves`);
  }

  // Every tier must have at least one unique, or its share of the drop weight is
  // silently redistributed and the roster's shape is not what the table says.
  for (const tier of Object.keys(UNIQUE_TIER_WEIGHTS)) {
    if (!UNIQUES.some((u) => u.tier === tier)) errors.push(`no unique in the ${tier} tier`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
