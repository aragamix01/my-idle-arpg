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
 * The values below are set from the power budget, not from feel. Four items,
 * top tier, must multiply to about 1.16 per side:
 *
 *   offence   affixes 2.06x  x  implicit 1.038^4 = 1.16x  ~= 2.39x
 *   defence   affixes 2.04x  x  implicit 1.040^4 = 1.17x  ~= 2.39x
 *   -----------------------------------------------------------------
 *   combined                                              ~= 5.7x
 *
 * That leaves headroom under the 8x ceiling for the extra affix row spirits
 * grant. A first pass at these numbers used ~1.075 per item and landed the
 * combined ceiling at 8.8x on its own, which would have spent the entire budget
 * before the currency system existed.
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
    effect: { kind: 'statMod', stat: 'damage', op: 'mul' },
    tiers: tiers([1.015, 1.022, 1.03, 1.038]),
  },
  glove: {
    id: 'implicit-attack-speed',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'attackSpeed', op: 'mul' },
    // 1.025 would collide with of-Haste's weakest tier and render as the same
    // line on an item carrying both.
    tiers: tiers([1.01, 1.015, 1.019, 1.023]),
  },
  purse: {
    id: 'implicit-gold-find',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'goldFind', op: 'mul' },
    tiers: tiers([1.02, 1.03, 1.04, 1.05]),
  },
  sigil: {
    id: 'implicit-crit-chance',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'critChance', op: 'add' },
    tiers: tiers([0.004, 0.007, 0.009, 0.011]),
  },
  blade: {
    id: 'implicit-crit-mult',
    kind: 'suffix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'critMult', op: 'add' },
    tiers: tiers([0.03, 0.05, 0.07, 0.085]),
  },
  lens: {
    id: 'implicit-area',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'area', op: 'add' },
    // Likewise 0.3 would collide with Sweeping's weakest tier.
    tiers: tiers([0.1, 0.16, 0.22, 0.28]),
  },
  charm: {
    id: 'implicit-max-hp',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'maxHp', op: 'mul' },
    tiers: tiers([1.015, 1.024, 1.032, 1.04]),
  },
  idol: {
    id: 'implicit-toughness',
    kind: 'prefix',
    nameFragment: '',
    effect: { kind: 'statMod', stat: 'toughness', op: 'mul' },
    tiers: tiers([1.006, 1.008, 1.01, 1.012]),
  },
};

export const BASES: ItemBase[] = [
  { id: 'whetstone', name: 'Whetstone', sprite: 'item.whetstone' },
  { id: 'glove', name: 'Glove', sprite: 'item.quickdraw_glove' },
  { id: 'purse', name: 'Purse', sprite: 'item.coin_purse' },
  { id: 'sigil', name: 'Sigil', sprite: 'item.executioners_mark' },
  { id: 'blade', name: 'Blade', sprite: 'item.giant_slayer' },
  { id: 'lens', name: 'Lens', sprite: 'item.swarm_lens' },
  { id: 'charm', name: 'Charm', sprite: 'item.bloodstone' },
  { id: 'idol', name: 'Idol', sprite: 'item.deep_delvers_idol' },
];

const byId = new Map(BASES.map((b) => [b.id, b]));

export function getBase(id: string): ItemBase | undefined {
  return byId.get(id);
}

/** The implicit affix definition for a base, or undefined for uniques. */
export function getBaseAffix(baseId: string): AffixDefinition | undefined {
  return BASE_AFFIXES[baseId];
}
