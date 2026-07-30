/**
 * The affix pool.
 *
 * Prefixes carry body stats, suffixes carry utility - the split is arbitrary in
 * isolation but it is what makes "1 prefix" and "1 prefix + 1 suffix" mean
 * different things rather than just different counts.
 *
 * An item never rolls the same affix twice, so with four prefixes in the pool a
 * rare (2 prefixes) must take two different ones. That bounds stacking: the
 * best possible loadout is four items each carrying at most one Brutal, not
 * eight Brutals.
 *
 * ## Layers
 *
 * Every affix here is `flat` or `increased`. **Nothing in the rollable pool is
 * `more`** - the compounding layer belongs to uniques and to the gold upgrade
 * tracks, both of which are bounded by something (an authored list, a cost
 * curve). A rollable `more` affix is bounded by nothing, which is precisely how
 * the old all-multiplier pool ended up squeezing every value down to a few
 * percent. See ModLayer in ./schema.ts.
 *
 * Most stats carry a flat variant *and* an increased variant, deliberately. The
 * two multiply each other, so a player holding a lot of `increased damage` wants
 * flat next and vice versa - which is a real decision, where two multipliers on
 * the same stat were interchangeable.
 *
 * Two stats have no flat variant: `toughness` and `goldFind` are multipliers
 * already, so adding to their base of 1.0 *is* an increase. Offering both would
 * be two names for one operation.
 *
 * ## Tier values and the power budget
 *
 * Sized at top tier across four items, best pair per side. Because a layer sums
 * rather than multiplies, "four copies of the same affix" is `1 + 4v`, not
 * `(1+v)^4` - which is the whole reason a fifth and sixth affix row is now
 * affordable.
 *
 *   offence   damage (1+4x0.08) x (60+4x4.8)/60 x aps (1+4x0.06) x crit  ~= 2.25x
 *   defence   maxHp  (1+4x0.12) x (100+4x14)/100                         ~= 2.31x
 *   -----------------------------------------------------------------------------
 *   combined                                                             ~= 5.2x
 *
 * The split is not cosmetic. Clear time holds steady only while offence and
 * defence grow together - that is the invariant recorded in src/sim/README.md,
 * and the first cut of this pool broke it by putting the whole budget on DPS.
 * The harness caught it: stage 222 resolved in 11.9s against a 20s floor.
 *
 * Two tests guard this - a composite band and a separate ceiling on DPS alone.
 * Adding affixes without re-checking both is how a loot system quietly outgrows
 * the ladder it was balanced against.
 */

import { BASE_AFFIXES } from './bases';
import type { AffixDefinition } from './schema';

/**
 * Tier gates. An item may only roll tiers whose minStage it meets, so a stage-3
 * drop is capped at the weakest tier forever - which is what makes pushing
 * deeper worth doing for loot rather than only for gold.
 */
const GATES = [1, 15, 40, 80] as const;

const tiers = (values: readonly [number, number, number, number]) =>
  values.map((value, i) => ({ minStage: GATES[i], value }));

export const PREFIXES: AffixDefinition[] = [
  {
    id: 'brutal',
    kind: 'prefix',
    nameFragment: 'Brutal',
    effect: { kind: 'statMod', stat: 'damage', op: 'increased' },
    tiers: tiers([0.026, 0.039, 0.052, 0.07]),
  },
  {
    /**
     * The flat counterpart to Brutal.
     *
     * Flat damage is added to a base of 60 before any percentage applies, so it
     * is amplified by every damage upgrade the player buys and never goes stale.
     * That is also why it needs no item-level scaling - see the note in
     * src/sim/curves.ts.
     */
    id: 'honed',
    kind: 'prefix',
    nameFragment: 'Honed',
    effect: { kind: 'statMod', stat: 'damage', op: 'flat' },
    tiers: tiers([1.6, 2.6, 3.5, 4.2]),
  },
  {
    id: 'vital',
    kind: 'prefix',
    nameFragment: 'Vital',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'increased' },
    tiers: tiers([0.045, 0.062, 0.08, 0.105]),
  },
  {
    id: 'bulwark',
    kind: 'prefix',
    nameFragment: 'Bulwark',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'flat' },
    tiers: tiers([3.5, 6, 9, 12]),
  },
  {
    id: 'armoured',
    kind: 'prefix',
    nameFragment: 'Armoured',
    effect: { kind: 'statMod', stat: 'toughness', op: 'increased' },
    tiers: tiers([0.035, 0.048, 0.06, 0.075]),
  },
  {
    id: 'sweeping',
    kind: 'prefix',
    nameFragment: 'Sweeping',
    effect: { kind: 'statMod', stat: 'area', op: 'flat' },
    tiers: tiers([0.3, 0.5, 0.65, 0.8]),
  },
  {
    /**
     * The third defensive affix, and the reason spirits are not offence-only.
     *
     * With just Vital and Armoured, both defensive mods fit inside a rare's two
     * prefix rows - so the extra row a dune spirit grants could raise offence
     * and could not raise defence, at any roll. That is the offence-outruns-
     * defence failure again, arriving structurally rather than through tuning,
     * and the craft-ceiling symmetry test caught it.
     *
     * Now that Bulwark exists there are four defensive prefixes rather than two,
     * so the structural fault is gone - but the affix stays. It is what makes
     * "increase toughness" a choice between two magnitudes rather than a single
     * forced pick, and removing it would silently re-narrow the defensive pool.
     */
    id: 'warded',
    kind: 'prefix',
    nameFragment: 'Warded',
    effect: { kind: 'statMod', stat: 'toughness', op: 'increased' },
    // No value here may equal one of Armoured's, at any tier - not just at the
    // same tier. Two toughness affixes both land in the `increased` layer and
    // sum, so an item carrying Armoured T3 and Warded T2 at the same value would
    // render the identical line twice and read as a bug.
    tiers: tiers([0.04, 0.052, 0.065, 0.08]),
  },
];

export const SUFFIXES: AffixDefinition[] = [
  {
    id: 'of-haste',
    kind: 'suffix',
    nameFragment: 'of Haste',
    effect: { kind: 'statMod', stat: 'attackSpeed', op: 'increased' },
    tiers: tiers([0.022, 0.035, 0.044, 0.052]),
  },
  {
    id: 'of-precision',
    kind: 'suffix',
    nameFragment: 'of Precision',
    effect: { kind: 'statMod', stat: 'critChance', op: 'flat' },
    tiers: tiers([0.009, 0.016, 0.022, 0.026]),
  },
  {
    /**
     * Increased crit chance, which multiplies the flat pool rather than adding
     * to it. Worthless on its own at a 5% base and strong beside Precision - the
     * clearest example in the pool of the two layers needing each other.
     */
    id: 'of-focus',
    kind: 'suffix',
    nameFragment: 'of Focus',
    effect: { kind: 'statMod', stat: 'critChance', op: 'increased' },
    tiers: tiers([0.08, 0.12, 0.16, 0.2]),
  },
  {
    id: 'of-ruin',
    kind: 'suffix',
    nameFragment: 'of Ruin',
    effect: { kind: 'statMod', stat: 'critMult', op: 'flat' },
    tiers: tiers([0.12, 0.2, 0.28, 0.36]),
  },
  {
    id: 'of-avarice',
    kind: 'suffix',
    nameFragment: 'of Avarice',
    effect: { kind: 'statMod', stat: 'goldFind', op: 'increased' },
    tiers: tiers([0.06, 0.09, 0.12, 0.15]),
  },
];

/** The rollable pool. Implicits are deliberately not in here - they never roll. */
export const AFFIXES: AffixDefinition[] = [...PREFIXES, ...SUFFIXES];

/** Base implicits, as a flat list for validation. */
export const IMPLICIT_AFFIXES: AffixDefinition[] = Object.values(BASE_AFFIXES);

/**
 * One resolver for every affix, rolled or implicit.
 *
 * Implicits share the AffixDefinition shape so the display path, the tier
 * machinery and the effect templates all work on them unchanged - only the
 * roll and reroll paths know the difference. Their `kind` and `nameFragment`
 * are inert: an implicit is neither prefix nor suffix for row-counting, and it
 * does not compose the item's name.
 */
const byId = new Map([...AFFIXES, ...IMPLICIT_AFFIXES].map((a) => [a.id, a]));

export function getAffix(id: string): AffixDefinition | undefined {
  return byId.get(id);
}

/** Tiers of an affix an item of this level may roll. Always at least one. */
export function availableTiers(affix: AffixDefinition, itemLevel: number): number[] {
  const indices = affix.tiers
    .map((tier, index) => ({ tier, index }))
    .filter(({ tier }) => itemLevel >= tier.minStage)
    .map(({ index }) => index);
  // GATES starts at 1, so every item qualifies for tier 0. The fallback exists
  // so a future gate change cannot produce an unrollable affix.
  return indices.length > 0 ? indices : [0];
}

/**
 * Display tier, counting down from the best like Path of Exile.
 *
 * Stored tiers are indices into an ascending table, so index 3 of 4 is the
 * strongest - but "T1" reading as best is the convention players expect.
 */
export function displayTier(affix: AffixDefinition, tier: number): number {
  return affix.tiers.length - tier;
}
