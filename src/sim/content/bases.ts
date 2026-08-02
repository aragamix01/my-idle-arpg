/**
 * Base types.
 *
 * A base contributes a name, an icon, and **one implicit affix fixed to that
 * base type**. The implicit is rolled once when the item drops and is never
 * rerollable - not by gold, not by any currency. That is what makes choosing a
 * Whetstone over an Idol a decision rather than a cosmetic preference: the
 * rolled affixes are a lottery, but the implicit is guaranteed and known.
 *
 * The implicit is deliberately weaker than a rolled affix of the same tier -
 * roughly a third. A guaranteed mod that was also the strongest mod would make
 * the rolled half decorative.
 *
 * ## Sizing
 *
 * The values below are set from the power budget, not from feel: roughly a third
 * of the rolled affix on the same stat, matching the "weaker than a rolled affix"
 * rule above. Four items of one base, top tier:
 *
 *   offence   affixes 2.25x  x  implicit (1+4x0.026) = 1.10x  ~= 2.48x
 *   defence   affixes 2.31x  x  implicit (1+4x0.040) = 1.16x  ~= 2.68x
 *
 * These are now `increased` and `flat` like everything else, so four copies sum
 * to `1 + 4v` rather than compounding to `(1+v)^4`. That is what let them come
 * *up* off the old 1.038 ceiling and become readable numbers again: under the old
 * all-multiplier model a first pass at ~1.075 per item put the combined ceiling
 * at 8.8x on its own, spending the whole budget before currency existed.
 *
 * Names are plain nouns so composition reads: "Brutal Whetstone of Haste"
 * works, "Brutal Executioner's Mark of Haste" does not.
 */

import type { AffixDefinition, ItemBase } from './schema';

/**
 * Implicit tier gates.
 *
 * Deliberately the same stages as the rolled-affix gates in affixes.ts. Two
 * different gate schedules would mean a stage-40 item whose implicit jumped a
 * tier while its affixes did not, and no player could work out why.
 */
const GATES = [1, 15, 40, 80] as const;

const tiers = (values: readonly [number, number, number, number]) =>
  values.map((value, i) => ({ minStage: GATES[i], value }));

/**
 * Tier gates for tablet implicits.
 *
 * Kept in step with TABLET_GATES in affixes.ts, for the same reason the implicit gates
 * above match the rolled ones: a tablet whose implicit jumped a tier while its explicits
 * did not is something no player could work out.
 */
const TABLET_GATES = [1, 4, 8, 12] as const;

const tabletTiers = (values: readonly [number, number, number, number]) =>
  values.map((value, i) => ({ minStage: TABLET_GATES[i], value }));

/**
 * The implicit affix of each base, keyed by base id.
 *
 * These are AffixDefinitions like any other - same tier machinery, same effect
 * templates, same display path - so nothing downstream needs to know an
 * implicit is special. Only the roll and reroll paths do.
 */
export const BASE_AFFIXES: Record<string, AffixDefinition> = {
  whetstone: {
    id: 'implicit-damage',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'damage', op: 'increased' },
    tiers: tiers([0.007, 0.01, 0.014, 0.018]),
  },
  glove: {
    id: 'implicit-attack-speed',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'attackSpeed', op: 'increased' },
    // No value here may equal one of of-Haste's, or an item carrying both renders
    // the same line twice. validateRegistry enforces it across every tier pair.
    tiers: tiers([0.005, 0.008, 0.01, 0.014]),
  },
  purse: {
    id: 'implicit-gold-find',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'goldFind', op: 'increased' },
    tiers: tiers([0.02, 0.03, 0.04, 0.05]),
  },
  sigil: {
    id: 'implicit-crit-chance',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'critChance', op: 'flat' },
    tiers: tiers([0.0025, 0.004, 0.006, 0.0075]),
  },
  blade: {
    id: 'implicit-crit-mult',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'critMult', op: 'flat' },
    tiers: tiers([0.033, 0.052, 0.073, 0.096]),
  },
  lens: {
    id: 'implicit-area',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'area', op: 'flat' },
    // Likewise 0.3 would collide with Sweeping's weakest tier.
    tiers: tiers([0.1, 0.16, 0.22, 0.28]),
  },
  charm: {
    id: 'implicit-max-hp',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'increased' },
    tiers: tiers([0.005, 0.008, 0.011, 0.015]),
  },
  idol: {
    id: 'implicit-toughness',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'toughness', op: 'increased' },
    tiers: tiers([0.005, 0.008, 0.011, 0.014]),
  },

  /**
   * Weapon implicits.
   *
   * A weapon already carries by far the largest guaranteed contribution on any item -
   * its skill, and the skill level its own item level grants. So its implicit is
   * deliberately ordinary and on the stat that fits the weapon's role rather than
   * being a second headline: crit for the duelling weapon, area for the wide one.
   */
  axe: {
    id: 'implicit-axe-crit',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'critChance', op: 'flat' },
    // Must collide with neither the Sigil's crit implicit nor of-Precision at any
    // tier. 0.007 was of-Precision's weakest roll, and the guard caught it.
    tiers: tiers([0.002, 0.0035, 0.005, 0.0065]),
  },
  wand: {
    id: 'implicit-wand-area',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'area', op: 'increased' },
    // 0.05 was Titanic's weakest roll, so a Wand carrying both rendered "5.0%
    // increased Area" twice. Caught by the guard, and by a rendering test.
    tiers: tiers([0.018, 0.028, 0.038, 0.048]),
  },
  maul: {
    id: 'implicit-maul-area',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'area', op: 'flat' },
    tiers: tiers([0.09, 0.14, 0.19, 0.25]),
  },
  staff: {
    // The resource implicit goes on the widest, thirstiest skill, where sustain is
    // the thing a player feels first.
    id: 'implicit-staff-regen',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'resourceRegen', op: 'increased' },
    // Held to about a third of Of Recovery, the weakest rolled peer on this stat.
    tiers: tiers([0.012, 0.02, 0.028, 0.036]),
  },

  /*
    Tablet implicits.

    Gated on TIER, not on stage - a tablet's itemLevel carries its tier of 1..15, so
    these use TABLET_GATES rather than the stage GATES above. A T15 tablet whose implicit
    was still stuck on the weakest roll because 15 < 40 would make deep tiers pay a
    shallow rate, which is the exact opposite of what the tier is for.

    The magnitudes are the BASE rate, before the explicit coupling multiplies them - a
    bare tablet pays these, and a fully-rolled rare pays several times more. Which is why
    they can afford to look small.
  */
  'hoarding-tablet': {
    id: 'implicit-tablet-quantity',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'tabletReward' },
    tiers: tabletTiers([0.3, 0.5, 0.7, 0.9]),
  },
  'auspicious-tablet': {
    /**
     * Rarity is the one reward that reaches the power ceiling rather than the economy -
     * it changes WHAT drops, not how much - so it is sized well under the other two.
     */
    id: 'implicit-tablet-rarity',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'tabletReward' },
    tiers: tabletTiers([0.2, 0.32, 0.44, 0.56]),
  },
  'gilded-tablet': {
    // Gold is the reward with the least reach: it feeds the upgrade tracks, which are
    // already bounded by a cost curve. So it can afford to be the largest number here.
    id: 'implicit-tablet-gold',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'tabletReward' },
    tiers: tabletTiers([0.5, 0.85, 1.2, 1.55]),
  },
};

/**
 * Weapon bases.
 *
 * Kept in their own list because they roll into a different slot and because
 * `rollItem` needs to decide gear-or-weapon before it picks a base. A `skillId` is
 * what makes a base a weapon - there is no second flag that could disagree with it.
 */
export const WEAPON_BASES: ItemBase[] = [
  // An Axe rather than a Sword because the tile sheet has no free sword: 104 is the
  // player's swing animation and 105-107 are already bound. A base whose name and
  // icon disagree is the kind of defect only a screenshot catches, so the name
  // followed the art.
  { id: 'axe', name: 'Axe', sprite: 'item.axe', skillId: 'sunder' },
  { id: 'maul', name: 'Maul', sprite: 'item.maul', skillId: 'cleave' },
  { id: 'wand', name: 'Wand', sprite: 'item.wand', skillId: 'fireball' },
  { id: 'staff', name: 'Staff', sprite: 'item.staff', skillId: 'frost-nova' },
];

export const GEAR_BASES: ItemBase[] = [
  { id: 'whetstone', name: 'Whetstone', sprite: 'item.whetstone' },
  { id: 'glove', name: 'Glove', sprite: 'item.quickdraw_glove' },
  { id: 'purse', name: 'Purse', sprite: 'item.coin_purse' },
  { id: 'sigil', name: 'Sigil', sprite: 'item.executioners_mark' },
  { id: 'blade', name: 'Blade', sprite: 'item.giant_slayer' },
  { id: 'lens', name: 'Lens', sprite: 'item.swarm_lens' },
  { id: 'charm', name: 'Charm', sprite: 'item.bloodstone' },
  { id: 'idol', name: 'Idol', sprite: 'item.deep_delvers_idol' },
];

/**
 * Tablet bases.
 *
 * `pays` is what makes a base a tablet, following the rule `skillId` set for weapons:
 * one field, so nothing can disagree about what kind of thing this is.
 *
 * Three bases and three reward axes, one each. A tablet that raised every reward at once
 * would make the bases interchangeable and picking one up would stop being a decision
 * about what you are short of.
 *
 * The implicits are in BASE_AFFIXES below, and unlike every other implicit they are
 * `tabletReward` - they produce no Effect at all, and their magnitude is amplified by
 * whatever explicits the tablet carries. See content/tablets.ts for the coupling.
 */
export const TABLET_BASES: ItemBase[] = [
  { id: 'hoarding-tablet', name: 'Hoarding Tablet', sprite: 'item.deep_delvers_idol', pays: 'quantity' },
  { id: 'auspicious-tablet', name: 'Auspicious Tablet', sprite: 'item.swarm_lens', pays: 'rarity' },
  { id: 'gilded-tablet', name: 'Gilded Tablet', sprite: 'item.coin_purse', pays: 'gold' },
];

/**
 * Every base: gear, weapon and tablet.
 *
 * Kept as the flat list it always was, so validation, sprite checks and the display
 * path do not have to know the split exists. Only the roll path does.
 */
export const BASES: ItemBase[] = [...GEAR_BASES, ...WEAPON_BASES, ...TABLET_BASES];

const byId = new Map(BASES.map((b) => [b.id, b]));

export function getBase(id: string): ItemBase | undefined {
  return byId.get(id);
}

/** The implicit affix definition for a base, or undefined for uniques. */
export function getBaseAffix(baseId: string): AffixDefinition | undefined {
  return BASE_AFFIXES[baseId];
}

/** The skill a base grants, or undefined when the base is gear. */
export function baseSkillId(baseId: string): string | undefined {
  return getBase(baseId)?.skillId;
}

export function isWeaponBase(baseId: string): boolean {
  return baseSkillId(baseId) !== undefined;
}
