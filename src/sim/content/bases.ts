/**
 * Base types.
 *
 * A base contributes a name, an icon, and **one implicit affix fixed to that
 * base type**. The implicit is rolled once when the item drops and is never
 * rerollable - not by gold, not by any currency. That is what makes choosing a
 * Plate Cuirass over a Silk Robe a decision rather than a cosmetic preference: the
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
 * Names are plain nouns so composition reads: "Brutal Gauntlets of Haste"
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
 * Tier gates for accessories.
 *
 * Their own scale, spanning the ABYSSAL depth range rather than the ladder's. An
 * accessory's item level comes from `abyssalDepth(tier)`, which starts at 80 - so under
 * the gear gates of [1, 15, 40, 80] every accessory that could ever exist would sit on
 * the top tier and the table would be four names for one number.
 *
 * Spread across the tier ladder instead, so a deeper tablet pays a better accessory and
 * the tier is worth climbing for something other than gold.
 */
const ACCESSORY_GATES = [80, 128, 176, 224] as const;

const accessoryTiers = (values: readonly [number, number, number, number]) =>
  values.map((value, i) => ({ minStage: ACCESSORY_GATES[i], value }));

/**
 * The implicit affix of each base, keyed by base id.
 *
 * These are AffixDefinitions like any other - same tier machinery, same effect
 * templates, same display path - so nothing downstream needs to know an
 * implicit is special. Only the roll and reroll paths do.
 */
/*
  Armour implicits, Phase 8.

  **These are the defence, and that inverts the old rule for armour.** A relic's implicit
  was a third of a rolled affix so the rolled half stayed the reason to farm. An armour
  base's implicit is its defence layer - the thing that makes a Plate Cuirass a plate
  cuirass - so it is the BIGGEST defence number on the piece, and the rolled flat defence
  affixes are sized under it. Choosing the base is choosing the layer; the rolls refine it.

  Body carries twice what a helmet, gloves or boots do: the body choice is the defence
  choice, as it is in the games this is modelled on.

  Belts are utility rather than a defence type, and their implicits stay at the old
  third-of-an-affix size on the stats a belt is about.
*/
const DEFENCE_IMPLICIT = {
  armour: { stat: 'armour', small: [0.9, 1.25, 1.6, 2], body: [1.6, 2.4, 3.2, 4] },
  evasion: { stat: 'evasion', small: [0.9, 1.25, 1.6, 2], body: [1.6, 2.4, 3.2, 4] },
  // A hundredth of the ratings: ES is a fraction of life, and a rating of R is worth
  // about R/100 of effective HP while small - so the three layers start out level.
  energyShield: { stat: 'energyShield', small: [0.009, 0.0125, 0.016, 0.02], body: [0.016, 0.024, 0.032, 0.04] },
} as const;

function defenceImplicit(
  baseId: string,
  defence: keyof typeof DEFENCE_IMPLICIT,
  size: 'small' | 'body',
): AffixDefinition {
  const { stat } = DEFENCE_IMPLICIT[defence];
  return {
    id: `implicit-${baseId}`,
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat, op: 'flat' },
    // Implicits are keyed by base, never drawn from a pool - see rollsOn.
    rollsOn: [],
    tiers: tiers(DEFENCE_IMPLICIT[defence][size]),
  };
}

const ARMOUR_IMPLICITS: Record<string, AffixDefinition> = {
  'iron-helm': defenceImplicit('iron-helm', 'armour', 'small'),
  'leather-hood': defenceImplicit('leather-hood', 'evasion', 'small'),
  'silk-circlet': defenceImplicit('silk-circlet', 'energyShield', 'small'),
  'plate-cuirass': defenceImplicit('plate-cuirass', 'armour', 'body'),
  'leather-jerkin': defenceImplicit('leather-jerkin', 'evasion', 'body'),
  'silk-robe': defenceImplicit('silk-robe', 'energyShield', 'body'),
  gauntlets: defenceImplicit('gauntlets', 'armour', 'small'),
  'leather-gloves': defenceImplicit('leather-gloves', 'evasion', 'small'),
  'silk-wraps': defenceImplicit('silk-wraps', 'energyShield', 'small'),
  greaves: defenceImplicit('greaves', 'armour', 'small'),
  'leather-boots': defenceImplicit('leather-boots', 'evasion', 'small'),
  'silk-slippers': defenceImplicit('silk-slippers', 'energyShield', 'small'),
  'heavy-belt': {
    id: 'implicit-heavy-belt',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'toughness', op: 'increased' },
    rollsOn: [],
    tiers: tiers([0.005, 0.008, 0.011, 0.014]),
  },
  'leather-belt': {
    id: 'implicit-leather-belt',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'increased' },
    rollsOn: [],
    tiers: tiers([0.005, 0.008, 0.011, 0.015]),
  },
  sash: {
    id: 'implicit-sash',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'resourceRegen', op: 'increased' },
    rollsOn: [],
    tiers: tiers([0.01, 0.016, 0.022, 0.03]),
  },
};

export const BASE_AFFIXES: Record<string, AffixDefinition> = {
  ...ARMOUR_IMPLICITS,

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
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'critChance', op: 'flat' },
    // Must collide with neither the Sigil's crit implicit nor of-Precision at any
    // tier. 0.007 was of-Precision's weakest roll, and the guard caught it.
    tiers: tiers([0.002, 0.0035, 0.005, 0.0065]),
  },
  wand: {
    id: 'implicit-wand-area',
    kind: 'prefix',
    nameFragment: '',
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'area', op: 'increased' },
    // 0.05 was Titanic's weakest roll, so a Wand carrying both rendered "5.0%
    // increased Area" twice. Caught by the guard, and by a rendering test.
    tiers: tiers([0.018, 0.028, 0.038, 0.048]),
  },
  maul: {
    id: 'implicit-maul-area',
    kind: 'prefix',
    nameFragment: '',
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'area', op: 'flat' },
    tiers: tiers([0.09, 0.14, 0.19, 0.25]),
  },
  staff: {
    // The resource implicit goes on the widest, thirstiest skill, where sustain is
    // the thing a player feels first.
    id: 'implicit-staff-regen',
    kind: 'suffix',
    nameFragment: '',
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'resourceRegen', op: 'increased' },
    // Held to about a third of Of Recovery, the weakest rolled peer on this stat.
    tiers: tiers([0.012, 0.02, 0.028, 0.036]),
  },

  /*
    Accessory implicits.

    **Each SLOT carries both axes**, and that is structural rather than flavour. If rings
    were the offensive slot and amulets the defensive one, a defensive build could not use
    its two ring slots at all - which is the offence/defence asymmetry that has broken
    this game three times, arriving by construction on the day accessories ship. So a
    defensive build wears two Bands and a Locket, an offensive one a Signet, a Seal and a
    Pendant, and both fill every slot.

    **Sized to the same rule every other implicit obeys** - roughly a third of a rolled
    affix on the same stat, and never more than 0.45 of one. That bound is not a gear
    rule that accessories happen to inherit; its reasoning applies here exactly, and
    harder: a guaranteed modifier that was also the strongest modifier would make the
    rolled half decorative, on the one item type whose rolled half is meant to be the
    reason to farm.

    The first cut had these at three to four times a rolled affix, on the theory that
    accessories should be a power spike. They should - but the spike belongs in the
    ROLLED pool, where a player chases it, not in the half handed over with the drop.

    What accessories get instead is the GATE SCALE: these sit near the top of the
    permitted band at every tier, and the tier tracks Abyssal depth rather than the
    ladder, so a deep tablet pays a measurably better implicit.
  */
  signet: {
    id: 'implicit-signet-damage',
    kind: 'prefix',
    nameFragment: '',
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'damage', op: 'increased' },
    tiers: accessoryTiers([0.0088, 0.013, 0.0172, 0.0231]),
  },
  band: {
    id: 'implicit-band-hp',
    kind: 'prefix',
    nameFragment: '',
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'maxHp', op: 'increased' },
    // Sized against of-Vigour rather than Vital: the bound is measured against the
    // WEAKEST rolled peer on the stat, so the peer that matters is whichever that is.
    tiers: accessoryTiers([0.0067, 0.0105, 0.0142, 0.0188]),
  },
  seal: {
    id: 'implicit-seal-crit',
    kind: 'suffix',
    nameFragment: '',
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'critChance', op: 'flat' },
    tiers: accessoryTiers([0.0029, 0.0055, 0.0076, 0.0092]),
  },
  pendant: {
    id: 'implicit-pendant-speed',
    kind: 'suffix',
    nameFragment: '',
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'attackSpeed', op: 'increased' },
    tiers: accessoryTiers([0.0063, 0.0097, 0.013, 0.0176]),
  },
  locket: {
    id: 'implicit-locket-toughness',
    kind: 'suffix',
    nameFragment: '',
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'toughness', op: 'increased' },
    tiers: accessoryTiers([0.0063, 0.0101, 0.0139, 0.0181]),
  },
  talisman: {
    id: 'implicit-talisman-gold',
    kind: 'suffix',
    nameFragment: '',
    rollsOn: [],
    effect: { kind: 'statMod', stat: 'goldFind', op: 'increased' },
    tiers: accessoryTiers([0.026, 0.039, 0.051, 0.064]),
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
    rollsOn: [],
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
    rollsOn: [],
    effect: { kind: 'tabletReward' },
    tiers: tabletTiers([0.2, 0.32, 0.44, 0.56]),
  },
  'gilded-tablet': {
    // Gold is the reward with the least reach: it feeds the upgrade tracks, which are
    // already bounded by a cost curve. So it can afford to be the largest number here.
    id: 'implicit-tablet-gold',
    kind: 'prefix',
    nameFragment: '',
    rollsOn: [],
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

/**
 * Armour bases, Phase 8. Three per slot, one per defence layer, plus three belts.
 *
 * Replaced the eight relic bases (Whetstone, Glove, Purse, Sigil, Blade, Lens, Charm,
 * Idol), which all rolled one shared pool and fitted any of four slots - so no piece was
 * anything in particular. Each of these fits exactly one slot and its implicit is the
 * defence layer it is built around. See `armour` and `defence` on ItemBase.
 */
export const ARMOUR_BASES: ItemBase[] = [
  { id: 'iron-helm', name: 'Iron Helm', sprite: 'item.iron_helm', armour: 'helmet', defence: 'armour' },
  { id: 'leather-hood', name: 'Leather Hood', sprite: 'item.leather_hood', armour: 'helmet', defence: 'evasion' },
  { id: 'silk-circlet', name: 'Silk Circlet', sprite: 'item.silk_circlet', armour: 'helmet', defence: 'energyShield' },
  { id: 'plate-cuirass', name: 'Plate Cuirass', sprite: 'item.plate_cuirass', armour: 'body', defence: 'armour' },
  { id: 'leather-jerkin', name: 'Leather Jerkin', sprite: 'item.leather_jerkin', armour: 'body', defence: 'evasion' },
  { id: 'silk-robe', name: 'Silk Robe', sprite: 'item.silk_robe', armour: 'body', defence: 'energyShield' },
  { id: 'gauntlets', name: 'Gauntlets', sprite: 'item.gauntlets', armour: 'gloves', defence: 'armour' },
  { id: 'leather-gloves', name: 'Leather Gloves', sprite: 'item.leather_gloves', armour: 'gloves', defence: 'evasion' },
  { id: 'silk-wraps', name: 'Silk Wraps', sprite: 'item.silk_wraps', armour: 'gloves', defence: 'energyShield' },
  { id: 'greaves', name: 'Greaves', sprite: 'item.greaves', armour: 'boots', defence: 'armour' },
  { id: 'leather-boots', name: 'Leather Boots', sprite: 'item.leather_boots', armour: 'boots', defence: 'evasion' },
  { id: 'silk-slippers', name: 'Silk Slippers', sprite: 'item.silk_slippers', armour: 'boots', defence: 'energyShield' },
  { id: 'heavy-belt', name: 'Heavy Belt', sprite: 'item.heavy_belt', armour: 'belt' },
  { id: 'leather-belt', name: 'Leather Belt', sprite: 'item.leather_belt', armour: 'belt' },
  { id: 'sash', name: 'Sash', sprite: 'item.sash', armour: 'belt' },
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
/**
 * Accessory bases.
 *
 * `wear` is what makes a base an accessory and which slot it goes in, following the rule
 * `skillId` set for weapons and `pays` for tablets: one field, so nothing can disagree
 * about what kind of thing this is.
 *
 * Three of each, because the implicit is the half of an item you CHOOSE - picking a Band
 * over a Signet is the same decision as picking a Plate Cuirass over a Silk Robe, and one base
 * per slot would make that decision disappear.
 *
 * Names are plain nouns so composition reads: "Brutal Signet of Haste" works. The art is
 * picked so no two share a palette - at 16px a ring is five pixels of metal and one of
 * stone, so colour is most of what separates them.
 */
export const RING_BASES: ItemBase[] = [
  { id: 'signet', name: 'Signet', sprite: 'item.signet', wear: 'ring' },
  { id: 'band', name: 'Band', sprite: 'item.band', wear: 'ring' },
  { id: 'seal', name: 'Seal', sprite: 'item.seal', wear: 'ring' },
];

export const AMULET_BASES: ItemBase[] = [
  { id: 'pendant', name: 'Pendant', sprite: 'item.pendant', wear: 'amulet' },
  { id: 'locket', name: 'Locket', sprite: 'item.locket', wear: 'amulet' },
  { id: 'talisman', name: 'Talisman', sprite: 'item.talisman', wear: 'amulet' },
];

export const ACCESSORY_BASES: ItemBase[] = [...RING_BASES, ...AMULET_BASES];

export const TABLET_BASES: ItemBase[] = [
  { id: 'hoarding-tablet', name: 'Hoarding Tablet', sprite: 'item.hoarding_tablet', pays: 'quantity' },
  { id: 'auspicious-tablet', name: 'Auspicious Tablet', sprite: 'item.auspicious_tablet', pays: 'rarity' },
  { id: 'gilded-tablet', name: 'Gilded Tablet', sprite: 'item.gilded_tablet', pays: 'gold' },
];

/**
 * Every base: armour, weapon, accessory and tablet.
 *
 * Kept as the flat list it always was, so validation, sprite checks and the display
 * path do not have to know the split exists. Only the roll path does.
 */
export const BASES: ItemBase[] = [
  ...ARMOUR_BASES,
  ...WEAPON_BASES,
  ...ACCESSORY_BASES,
  ...TABLET_BASES,
];

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
