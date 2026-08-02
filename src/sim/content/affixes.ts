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
import { ELEMENTS, type AffixDefinition, type Element, type MonsterAxis } from './schema';

/**
 * Tier gates. An item may only roll tiers whose minStage it meets, so a stage-3
 * drop is capped at the weakest tier forever - which is what makes pushing
 * deeper worth doing for loot rather than only for gold.
 */
const GATES = [1, 15, 40, 80] as const;

const tiers = (values: readonly [number, number, number, number]) =>
  values.map((value, i) => ({ minStage: GATES[i], value }));

/**
 * The name each element wears as a prefix.
 *
 * Written out rather than derived from the element id, because "Shadowed" is not a
 * transformation of "darkness" and an item called a "Darkness Whetstone" reads like a
 * placeholder.
 */
const ELEMENT_FRAGMENT: Record<Element, string> = {
  physical: 'Weighted',
  fire: 'Smouldering',
  cold: 'Rimed',
  lightning: 'Charged',
  darkness: 'Shadowed',
};

/**
 * "Gain X% of damage as extra <element>", one per element.
 *
 * Generated rather than written out five times. The only thing that differs between
 * them is which element they name, and five hand-copied blocks is five places for the
 * tier table to drift.
 *
 * ## Sized BELOW Brutal, on purpose
 *
 * On the ladder resistance is uniform, so an extra share is mitigated exactly like
 * your own damage and `gain 3% as extra fire` is worth precisely `3% increased
 * damage`. Against Brutal's 5.5% these are strictly worse there, which is what keeps
 * the power ceiling - and therefore the ladder's pacing - exactly where it was.
 *
 * They are not worse in a DUNGEON, where the affinity resists one element and is weak
 * to another. That is the whole design in one number: on the ladder elements are a
 * scaling axis you can ignore, and in the content that carries an affinity they are
 * the difference between a clear and a wasted key.
 *
 * Five rather than four. The one that names your own skill's element is simply a plain
 * damage roll - a real if boring modifier, not a dead row - and which one that is
 * depends on the weapon in your hand, so no entry here is dead for everybody.
 */
function extraElementPrefix(element: Element): AffixDefinition {
  return {
    id: `extra-${element}`,
    kind: 'prefix',
    nameFragment: ELEMENT_FRAGMENT[element],
    effect: { kind: 'extraElement', element },
    tiers: tiers([0.012, 0.019, 0.025, 0.033]),
  };
}

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
  ...ELEMENTS.map(extraElementPrefix),
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
  {
    /**
     * The only affix in the pool whose worth rises with depth rather than with its
     * own tier, because what it cancels is a function of the stage.
     *
     * Flat and nothing else - penetration's base is zero, so a percentage of it is
     * zero forever. validateRegistry enforces that.
     *
     * Sized so that at stage 300, where ladder resistance is about 18%, the best roll
     * is worth roughly 3% more damage - under Of Haste's 4.2% and well under Brutal.
     * It is deliberately near-worthless in the first few stages, where there is
     * almost nothing to penetrate: an affix that grows into relevance is honest, and
     * the alternative is inflating it until it is the correct pick everywhere and
     * elements stop being a choice.
     */
    id: 'of-sundering',
    kind: 'suffix',
    nameFragment: 'of Sundering',
    effect: { kind: 'statMod', stat: 'penetration', op: 'flat' },
    tiers: tiers([0.008, 0.014, 0.02, 0.026]),
  },
];

// --- Accessory extras -----------------------------------------------------

/**
 * Tier gates for accessory-only affixes.
 *
 * Kept in step with ACCESSORY_GATES in bases.ts, for the same reason the implicit gates
 * match the rolled ones everywhere else: an accessory whose implicit jumped a tier while
 * its affixes did not is something no player could work out.
 */
const ACCESSORY_GATES = [80, 128, 176, 224] as const;

const accessoryTiers = (values: readonly [number, number, number, number]) =>
  values.map((value, i) => ({ minStage: ACCESSORY_GATES[i], value }));

/**
 * What only an accessory can roll.
 *
 * **Additive, not a partition.** Unlike the tablet pool, these JOIN what gear can roll
 * rather than replacing it - an accessory rolls everything a Whetstone can, plus these.
 * That is the difference between the two, and `eligibleAffixes` says so in one branch.
 *
 * ## This is where the spike lives
 *
 * Accessories drop only from the Abyss, one tablet at a time, past floor 80. Their
 * implicits are held to the same third-of-a-rolled-affix bound everything else obeys, so
 * if these were ordinary the whole item type would be a Whetstone with a different icon.
 * The reason to farm is here, in the half a player chases.
 *
 * ## Skill levels, and why they are the headline
 *
 * A skill level raises the skill's BASE - the position `flat` adds to and `increased` and
 * `more` both multiply - so it compounds with every other thing a character owns. Three
 * accessories at +2 is `1.06^6` ~= **1.42x damage before a single percentage rolls**.
 * Everything else here is sized against that rather than beside it.
 *
 * Still weapon-TYPE locked in effect: `physicalSkillLevel` does nothing for a caster. On
 * a weapon that would be a dead row, which is why the weapon versions are `rollsOn`
 * gated; on an accessory it is a build decision, because a player chooses which ring to
 * wear and can simply not wear that one.
 *
 * ## The defensive half has to MATCH, and cannot match in kind
 *
 * Nothing defensive touches `base` - there is no such thing as an HP skill level - so
 * defence cannot answer skill levels with the same mechanism. It answers with magnitude
 * instead, on the layer it already uses. The offence/defence invariant is measured as a
 * ratio of resulting multipliers, so what has to match is the multiplier, not the trick
 * that produced it.
 *
 * Every value here is provisional until the budget is re-derived with three extra slots
 * in the search. Measure; do not read these as settled.
 */
const ACCESSORY_PREFIXES: AffixDefinition[] = [
  {
    id: 'abyssal-might',
    kind: 'prefix',
    nameFragment: 'Abyssal',
    effect: { kind: 'statMod', stat: 'damage', op: 'increased' },
    rollsOn: 'accessory',
    tiers: accessoryTiers([0.04, 0.06, 0.08, 0.11]),
  },
  {
    id: 'abyssal-vitality',
    kind: 'prefix',
    nameFragment: 'Undying',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'increased' },
    rollsOn: 'accessory',
    tiers: accessoryTiers([0.042, 0.062, 0.082, 0.112]),
  },
];

const ACCESSORY_SUFFIXES: AffixDefinition[] = [
  {
    /**
     * TWO tiers, not four, and that is forced rather than stylistic.
     *
     * A skill level is an integer and the accessory range has to stay small - there are
     * three accessory slots against one weapon, so of-Mastery's 1-4 would be +12 levels
     * from jewellery alone. Squeezing four tiers into that range means repeating a
     * value, and two tiers granting the identical +1 is a tier that does nothing.
     *
     * validateRegistry caught exactly that: a repeated value inside one table trips the
     * duplicate-line guard against itself, which is the guard being right.
     */
    id: 'of-ascendancy',
    kind: 'suffix',
    nameFragment: 'of Ascendancy',
    effect: { kind: 'statMod', stat: 'physicalSkillLevel', op: 'flat' },
    rollsOn: 'accessory',
    tiers: [
      { minStage: ACCESSORY_GATES[0], value: 1 },
      { minStage: ACCESSORY_GATES[2], value: 2 },
    ],
  },
  {
    id: 'of-communion',
    kind: 'suffix',
    nameFragment: 'of Communion',
    effect: { kind: 'statMod', stat: 'magicalSkillLevel', op: 'flat' },
    rollsOn: 'accessory',
    tiers: [
      { minStage: ACCESSORY_GATES[0], value: 1 },
      { minStage: ACCESSORY_GATES[2], value: 2 },
    ],
  },
  {
    id: 'of-warding',
    kind: 'suffix',
    nameFragment: 'of Warding',
    effect: { kind: 'statMod', stat: 'toughness', op: 'increased' },
    rollsOn: 'accessory',
    tiers: accessoryTiers([0.038, 0.055, 0.072, 0.098]),
  },
  {
    /**
     * The offensive suffix that is NOT a skill level.
     *
     * Half the skill-level pool is dead for any given character - a physical ring does
     * nothing for a caster - so without this an offensive accessory build would be
     * hunting one specific affix. Crit multiplier is `flat` here, like every other
     * critMult roll: it multiplies into DPS through critFactor already, so a `more`
     * layer on top would compound twice and validateRegistry rejects it.
     */
    id: 'of-annihilation',
    kind: 'suffix',
    nameFragment: 'of Annihilation',
    effect: { kind: 'statMod', stat: 'critMult', op: 'flat' },
    rollsOn: 'accessory',
    tiers: accessoryTiers([0.115, 0.165, 0.215, 0.285]),
  },
];

// --- Tablet modifiers -----------------------------------------------------

/**
 * Tier gates for tablet modifiers.
 *
 * TIERS, not stages. A tablet's `itemLevel` carries its tier of 1..15, so `availableTiers`
 * compares against these unchanged - the same mechanism, a different scale. The gear
 * GATES of [1, 15, 40, 80] are stage numbers and would mean a T15 tablet was still stuck
 * on the weakest roll of everything.
 */
const TABLET_GATES = [1, 4, 8, 12] as const;

const tabletTiers = (values: readonly [number, number, number, number]) =>
  values.map((value, i) => ({ minStage: TABLET_GATES[i], value }));

/**
 * The tablet pool.
 *
 * Every entry is pure downside - it raises danger and pays nothing. The implicit is what
 * pays, and it scales with the sum of these, so applying one is buying reward with risk.
 * `validateRegistry` rejects a tablet modifier whose value is not positive, because a
 * free one would break that trade in the only direction that matters.
 *
 * ## The two halves differ in kind, not only in number
 *
 * Prefixes are the deep, heavily gated modifiers: a T1 tablet can only roll the weakest
 * of them, and the biggest are out of reach until T12. Suffixes are cheaper and available
 * from the first tier. So a shallow tablet is shaped mostly by its suffixes and a deep
 * one by its prefixes, which is the same job the gear pool's lean does - it makes
 * "1 prefix" and "1 suffix" mean different things rather than different counts.
 *
 * ## Four per side against three rows
 *
 * A rare rolls 3 of 4, so there is a lottery. Three per side would make every rare
 * tablet identical, which would turn rarity into a number rather than a roll.
 *
 * ## Sizing
 *
 * Deliberately modest. These sum into `(1 + Σ)` and multiply against a tier curve that
 * is already exponential, so a fully-rolled rare at T15 carries six of them - the six
 * biggest together are roughly +180% danger on top of the tier, and the implicit pays
 * the same multiple back. Measure before believing any of these numbers: the harness is
 * the instrument, not this comment.
 */
const TABLET_PREFIXES: AffixDefinition[] = [
  {
    id: 'tablet-bloated',
    kind: 'prefix',
    nameFragment: 'Bloated',
    effect: { kind: 'monsterBuff', axis: 'hp' },
    rollsOn: 'tablet',
    tiers: tabletTiers([0.15, 0.25, 0.35, 0.45]),
  },
  {
    id: 'tablet-savage',
    kind: 'prefix',
    nameFragment: 'Savage',
    effect: { kind: 'monsterBuff', axis: 'damage' },
    rollsOn: 'tablet',
    tiers: tabletTiers([0.12, 0.2, 0.28, 0.36]),
  },
  {
    id: 'tablet-teeming',
    kind: 'prefix',
    nameFragment: 'Teeming',
    effect: { kind: 'monsterBuff', axis: 'count' },
    rollsOn: 'tablet',
    tiers: tabletTiers([0.14, 0.22, 0.3, 0.4]),
  },
  {
    /**
     * The one that only means anything because health carries across the run.
     *
     * More waves against a pool that never refills is pure accumulated exposure. In a
     * run that healed between fights this would be a time cost and nothing else.
     */
    id: 'tablet-endless',
    kind: 'prefix',
    nameFragment: 'Endless',
    effect: { kind: 'monsterBuff', axis: 'waves' },
    rollsOn: 'tablet',
    tiers: tabletTiers([0.2, 0.3, 0.4, 0.5]),
  },
];

const TABLET_SUFFIXES: AffixDefinition[] = [
  {
    id: 'tablet-of-stone',
    kind: 'suffix',
    nameFragment: 'of Stone',
    effect: { kind: 'monsterBuff', axis: 'hp' },
    rollsOn: 'tablet',
    tiers: tabletTiers([0.08, 0.13, 0.18, 0.24]),
  },
  {
    id: 'tablet-of-fury',
    kind: 'suffix',
    nameFragment: 'of Fury',
    effect: { kind: 'monsterBuff', axis: 'damage' },
    rollsOn: 'tablet',
    tiers: tabletTiers([0.07, 0.11, 0.15, 0.2]),
  },
  {
    id: 'tablet-of-the-swarm',
    kind: 'suffix',
    nameFragment: 'of the Swarm',
    effect: { kind: 'monsterBuff', axis: 'count' },
    rollsOn: 'tablet',
    tiers: tabletTiers([0.09, 0.14, 0.19, 0.25]),
  },
  {
    id: 'tablet-of-descent',
    kind: 'suffix',
    nameFragment: 'of Descent',
    effect: { kind: 'monsterBuff', axis: 'waves' },
    rollsOn: 'tablet',
    tiers: tabletTiers([0.1, 0.16, 0.22, 0.28]),
  },
];

/**
 * The rollable pool.
 *
 * Tablet modifiers are in here, and they have to be: `getAffix` resolves every stored
 * id through this list, so leaving them out would render a crafted tablet as six unknown
 * modifiers. `eligibleAffixes` is what keeps them off gear - see the partition note there
 * and the pair of assertions in validateRegistry.
 *
 * Implicits are deliberately not in here - they never roll.
 */
export const AFFIXES: AffixDefinition[] = [
  ...PREFIXES,
  ...SUFFIXES,
  ...ACCESSORY_PREFIXES,
  ...ACCESSORY_SUFFIXES,
  ...TABLET_PREFIXES,
  ...TABLET_SUFFIXES,
];

/** Every prefix in the game, whatever it rolls on. Filtered at roll time, never here. */
export const ALL_PREFIXES: AffixDefinition[] = [
  ...PREFIXES,
  ...ACCESSORY_PREFIXES,
  ...TABLET_PREFIXES,
];
export const ALL_SUFFIXES: AffixDefinition[] = [
  ...SUFFIXES,
  ...ACCESSORY_SUFFIXES,
  ...TABLET_SUFFIXES,
];

/**
 * The danger a rolled tablet modifier adds, and on which axis.
 *
 * The counterpart to `affixEffect` for the pool that has no Effects: between them they
 * partition the registry exactly as the pool itself is partitioned, and neither can
 * return anything for the other's half.
 *
 * Here rather than beside `affixEffect` in items.ts so content/tablets.ts can read it
 * without importing a module that already depends on the content registry.
 */
export function affixDanger(rolled: {
  affixId: string;
  value: number;
}): { axis: MonsterAxis; value: number } | null {
  const template = byId.get(rolled.affixId)?.effect;
  if (template?.kind !== 'monsterBuff') return null;
  return { axis: template.axis, value: rolled.value };
}

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
