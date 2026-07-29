/**
 * Base types.
 *
 * A base contributes a name and an icon and nothing else - no implicit stats.
 * All power on a non-unique comes from its affixes, which keeps the budget in
 * one place instead of split across two tables.
 *
 * Names are deliberately plain nouns so composition reads: "Brutal Whetstone of
 * Haste" works, "Brutal Executioner's Mark of Haste" does not.
 */

import type { ItemBase } from './schema';

export const BASES: ItemBase[] = [
  { id: 'whetstone', name: 'Whetstone', sprite: 'artifact.whetstone' },
  { id: 'glove', name: 'Glove', sprite: 'artifact.quickdraw_glove' },
  { id: 'purse', name: 'Purse', sprite: 'artifact.coin_purse' },
  { id: 'sigil', name: 'Sigil', sprite: 'artifact.executioners_mark' },
  { id: 'blade', name: 'Blade', sprite: 'artifact.giant_slayer' },
  { id: 'lens', name: 'Lens', sprite: 'artifact.swarm_lens' },
  { id: 'charm', name: 'Charm', sprite: 'artifact.bloodstone' },
  { id: 'idol', name: 'Idol', sprite: 'artifact.deep_delvers_idol' },
];

const byId = new Map(BASES.map((b) => [b.id, b]));

export function getBase(id: string): ItemBase | undefined {
  return byId.get(id);
}
