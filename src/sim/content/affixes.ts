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
 * ## Tier values and the power budget
 *
 * The budget is ~4x total power, and it is deliberately **split across offence
 * and defence** rather than loaded onto damage.
 *
 *   offence   damage 1.10^4 x attackSpeed 1.06^4 x crit  ~= 2.06x
 *   defence   maxHp  1.16^4 x toughness    1.03^4        ~= 2.04x
 *   ------------------------------------------------------------
 *   combined                                             ~= 4.2x
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
    effect: { kind: 'statMod', stat: 'damage', op: 'mul' },
    tiers: tiers([1.04, 1.06, 1.08, 1.1]),
  },
  {
    id: 'vital',
    kind: 'prefix',
    nameFragment: 'Vital',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'mul' },
    tiers: tiers([1.07, 1.1, 1.13, 1.16]),
  },
  {
    id: 'armoured',
    kind: 'prefix',
    nameFragment: 'Armoured',
    effect: { kind: 'statMod', stat: 'toughness', op: 'mul' },
    tiers: tiers([1.015, 1.02, 1.025, 1.03]),
  },
  {
    id: 'sweeping',
    kind: 'prefix',
    nameFragment: 'Sweeping',
    effect: { kind: 'statMod', stat: 'area', op: 'add' },
    tiers: tiers([0.3, 0.5, 0.65, 0.8]),
  },
];

export const SUFFIXES: AffixDefinition[] = [
  {
    id: 'of-haste',
    kind: 'suffix',
    nameFragment: 'of Haste',
    effect: { kind: 'statMod', stat: 'attackSpeed', op: 'mul' },
    tiers: tiers([1.025, 1.04, 1.05, 1.06]),
  },
  {
    id: 'of-precision',
    kind: 'suffix',
    nameFragment: 'of Precision',
    effect: { kind: 'statMod', stat: 'critChance', op: 'add' },
    tiers: tiers([0.01, 0.018, 0.025, 0.03]),
  },
  {
    id: 'of-ruin',
    kind: 'suffix',
    nameFragment: 'of Ruin',
    effect: { kind: 'statMod', stat: 'critMult', op: 'add' },
    tiers: tiers([0.08, 0.13, 0.18, 0.22]),
  },
  {
    id: 'of-avarice',
    kind: 'suffix',
    nameFragment: 'of Avarice',
    effect: { kind: 'statMod', stat: 'goldFind', op: 'mul' },
    tiers: tiers([1.06, 1.09, 1.12, 1.15]),
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
