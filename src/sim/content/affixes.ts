/**
 * The affix pool.
 *
 * Prefixes lean toward the big pools - damage, max HP, area - and suffixes toward
 * the multipliers and utility - attack speed, crit, gold. The split is arbitrary
 * in isolation but it is what makes "1 prefix" and "1 prefix + 1 suffix" mean
 * different things rather than just different counts.
 *
 * It is a lean and not a rule, deliberately: **each half has to carry both
 * offensive and defensive options**, for the reason below.
 *
 * An item never rolls the same affix twice, so with eight prefixes in the pool a
 * rare (3 prefixes) must take three different ones. That bounds stacking: the
 * best possible loadout is four items each carrying at most one Brutal, not
 * twelve Brutals.
 *
 * ## Both sides must be able to build defensively
 *
 * The rows went to 3/3, and that broke the offence/defence invariant
 * *structurally* before a single number changed. Count the rows each side can
 * actually use: offence had two useful prefixes (Brutal, Honed - area does not
 * enter statsDps) and every suffix, so five of its six rows did something.
 * Defence had four useful prefixes to fit in three rows and **no useful suffix at
 * all**, so three. Three against five is the stage-222 failure arriving
 * structurally, which is exactly how the Warded fault arrived in Phase 1.
 *
 * Hence Of Stone and Of Vigour: defensive suffixes, so defence also reaches five
 * useful rows. A half that can only build one side caps that side's usable rows,
 * and no amount of retuning the values fixes a row that has nothing to put in it.
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
 * Because a layer sums rather than multiplies, "four copies of the same affix" is
 * `1 + 4v`, not `(1+v)^4` - which is the whole reason six affix rows are
 * affordable at all.
 *
 * The rows widened from 2/2 to 3/3 and the **ceiling deliberately did not move**:
 * roughly 5.4x from drops and 8.6x fully crafted, which is what the ladder is
 * tuned against. So these values came *down* to pay for the new rows. Do not read
 * a smaller number here as a nerf - a rare carries six of them now.
 *
 * The exact figures are not written out any more, because they were wrong within
 * one commit of being written and a stale worked example is worse than none. Run
 * the power-budget suite in tests/sim.test.ts: it searches the pool for the real
 * best-in-slot loadout and prints it on failure.
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
    tiers: tiers([0.021, 0.031, 0.041, 0.055]),
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
    tiers: tiers([1.3, 2.1, 2.8, 3.4]),
  },
  {
    id: 'vital',
    rollsOn: 'gear',
    kind: 'prefix',
    nameFragment: 'Vital',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'increased' },
    // Sized level with the toughness affixes on purpose. maxHp and toughness both
    // multiply straight into effective HP, so a magnitude gap between them would
    // make one strictly better and the other dead content.
    tiers: tiers([0.018, 0.028, 0.038, 0.05]),
  },
  {
    id: 'bulwark',
    rollsOn: 'gear',
    kind: 'prefix',
    nameFragment: 'Bulwark',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'flat' },
    tiers: tiers([1.5, 2.6, 3.8, 5]),
  },
  {
    id: 'armoured',
    rollsOn: 'gear',
    kind: 'prefix',
    nameFragment: 'Armoured',
    effect: { kind: 'statMod', stat: 'toughness', op: 'increased' },
    tiers: tiers([0.017, 0.027, 0.036, 0.048]),
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
     * Flat damage on a weapon, and stronger than Honed because it can only ever
     * appear on one item. Honed rolls on all five; these two roll on one.
     */
    id: 'savage',
    rollsOn: 'physical',
    kind: 'prefix',
    nameFragment: 'Savage',
    effect: { kind: 'statMod', stat: 'damage', op: 'flat' },
    tiers: tiers([2.6, 4.2, 5.6, 6.8]),
  },
  {
    id: 'arcane',
    rollsOn: 'magical',
    kind: 'prefix',
    nameFragment: 'Arcane',
    effect: { kind: 'statMod', stat: 'damage', op: 'flat' },
    // Must not collide with Honed or Savage at any tier.
    tiers: tiers([2.4, 3.9, 5.2, 6.4]),
  },
  {
    /**
     * Gear's own route to sustain.
     *
     * Flat regen where the weapon-locked ones are increased, so the two stack in the
     * way flat and increased always do: gear gives a caster a floor to work from,
     * and the weapon multiplies it.
     */
    id: 'resolute',
    rollsOn: 'gear',
    kind: 'prefix',
    nameFragment: 'Resolute',
    effect: { kind: 'statMod', stat: 'resourceRegen', op: 'flat' },
    tiers: tiers([0.06, 0.1, 0.14, 0.18]),
  },
  {
    /** The increased counterpart to Sweeping, on a base of 2 targets. */
    id: 'titanic',
    kind: 'prefix',
    nameFragment: 'Titanic',
    effect: { kind: 'statMod', stat: 'area', op: 'increased' },
    tiers: tiers([0.05, 0.08, 0.11, 0.14]),
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
     * Now that Bulwark and the defensive suffixes exist the structural fault is
     * gone - but the affix stays. It is what makes "increase toughness" a choice
     * between magnitudes rather than a single forced pick, and removing it would
     * silently re-narrow the defensive pool.
     */
    id: 'warded',
    rollsOn: 'gear',
    kind: 'prefix',
    nameFragment: 'Warded',
    effect: { kind: 'statMod', stat: 'toughness', op: 'increased' },
    // No value here may equal Armoured's or Of Stone's, at any tier - not just at
    // the same tier. All three toughness affixes land in the `increased` layer and
    // sum, so an item carrying Armoured T3 and Warded T2 at the same value would
    // render the identical line twice and read as a bug. validateRegistry checks
    // it, because three overlapping tables are past what anyone eyeballs.
    tiers: tiers([0.019, 0.029, 0.04, 0.052]),
  },
];

export const SUFFIXES: AffixDefinition[] = [
  {
    id: 'of-haste',
    kind: 'suffix',
    nameFragment: 'of Haste',
    effect: { kind: 'statMod', stat: 'attackSpeed', op: 'increased' },
    tiers: tiers([0.015, 0.023, 0.031, 0.042]),
  },
  {
    /** Flat attack speed, on a base of 1.5 swings per second. */
    id: 'of-fury',
    kind: 'suffix',
    nameFragment: 'of Fury',
    effect: { kind: 'statMod', stat: 'attackSpeed', op: 'flat' },
    tiers: tiers([0.024, 0.039, 0.053, 0.065]),
  },
  {
    id: 'of-precision',
    kind: 'suffix',
    nameFragment: 'of Precision',
    effect: { kind: 'statMod', stat: 'critChance', op: 'flat' },
    tiers: tiers([0.007, 0.013, 0.018, 0.022]),
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
    tiers: tiers([0.058, 0.092, 0.126, 0.16]),
  },
  {
    id: 'of-ruin',
    kind: 'suffix',
    nameFragment: 'of Ruin',
    effect: { kind: 'statMod', stat: 'critMult', op: 'flat' },
    tiers: tiers([0.1, 0.16, 0.22, 0.29]),
  },
  {
    /**
     * Increased crit damage, scaling the whole x2.00 base rather than adding to
     * it. Legal where a `more` crit multiplier is not: critMult already multiplies
     * into DPS through critFactor, so a `more` layer on it would compound twice
     * over, but an `increased` layer just widens the pool it multiplies.
     */
    id: 'of-cruelty',
    kind: 'suffix',
    nameFragment: 'of Cruelty',
    effect: { kind: 'statMod', stat: 'critMult', op: 'increased' },
    tiers: tiers([0.032, 0.052, 0.071, 0.092]),
  },
  {
    id: 'of-avarice',
    rollsOn: 'gear',
    kind: 'suffix',
    nameFragment: 'of Avarice',
    effect: { kind: 'statMod', stat: 'goldFind', op: 'increased' },
    tiers: tiers([0.06, 0.09, 0.12, 0.15]),
  },
  {
    /**
     * The defensive suffixes. Without these, defence has nothing to put in a
     * suffix row and caps at three useful rows against offence's five - see the
     * header. They are the structural fix, not flavour.
     */
    id: 'of-stone',
    rollsOn: 'gear',
    kind: 'suffix',
    nameFragment: 'of Stone',
    effect: { kind: 'statMod', stat: 'toughness', op: 'increased' },
    // Must not collide with Armoured or Warded at any tier.
    tiers: tiers([0.015, 0.024, 0.033, 0.043]),
  },
  {
    id: 'of-vigour',
    rollsOn: 'gear',
    kind: 'suffix',
    nameFragment: 'of Vigour',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'increased' },
    // Must not collide with Vital at any tier.
    tiers: tiers([0.016, 0.025, 0.034, 0.045]),
  },
  {
    /**
     * The weapon mods, and the only affixes in the pool locked to a base type.
     *
     * A skill level raises the equipped skill's BASE damage, which is a position no
     * other affix occupies - flat adds to base, increased and more multiply it, and
     * this moves the thing they all act on. So it is worth more than any single
     * affix, and being weapon-locked is what bounds it: only one item in a loadout is
     * a weapon, so a build carries one of these rather than four.
     *
     * Locked rather than merely weak on the wrong weapon. `+3 to Physical Skill
     * Levels` on a wand would be a row that renders as a bonus and does nothing at
     * all, which is worse than a row that is a poor pick.
     */
    /**
     * The resource affixes, one per weapon kind.
     *
     * Same stat and near-identical values, and that is not duplication: they can
     * never appear together, because no item is both a physical and a magical
     * weapon. The two names exist so the line a player reads matches the resource
     * their weapon actually spends.
     *
     * They arrive at opposite times. Stamina regen is worthless on a fresh Axe and
     * becomes the affix that unlocks attack speed you already paid for; mana regen
     * is the first thing a caster needs and stays that way.
     */
    id: 'of-endurance',
    rollsOn: 'physical',
    kind: 'suffix',
    nameFragment: 'of Endurance',
    effect: { kind: 'statMod', stat: 'resourceRegen', op: 'increased' },
    tiers: tiers([0.05, 0.08, 0.11, 0.145]),
  },
  {
    id: 'of-clarity',
    rollsOn: 'magical',
    kind: 'suffix',
    nameFragment: 'of Clarity',
    effect: { kind: 'statMod', stat: 'resourceRegen', op: 'increased' },
    // Must not collide with Of Endurance, Of Recovery or the Staff implicit at any
    // tier. Four tables share this stat, which is past what anyone eyeballs - the
    // registry guard caught two overlaps here that would have rendered twice.
    tiers: tiers([0.057, 0.088, 0.122, 0.158]),
  },
  {
    id: 'of-recovery',
    rollsOn: 'gear',
    kind: 'suffix',
    nameFragment: 'of Recovery',
    effect: { kind: 'statMod', stat: 'resourceRegen', op: 'increased' },
    tiers: tiers([0.035, 0.06, 0.085, 0.105]),
  },
  {
    id: 'of-mastery',
    kind: 'suffix',
    nameFragment: 'of Mastery',
    effect: { kind: 'statMod', stat: 'physicalSkillLevel', op: 'flat' },
    rollsOn: 'physical',
    tiers: tiers([1, 2, 3, 4]),
  },
  {
    id: 'of-attunement',
    kind: 'suffix',
    nameFragment: 'of Attunement',
    effect: { kind: 'statMod', stat: 'magicalSkillLevel', op: 'flat' },
    rollsOn: 'magical',
    tiers: tiers([1, 2, 3, 4]),
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
