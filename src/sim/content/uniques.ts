/**
 * Uniques.
 *
 * The eight originally hand-authored artifacts, now the only items with fixed
 * effects. They never roll and never reroll - a unique that could be rerolled
 * would just be a rare with a fancier name.
 *
 * These are also where conditional effects live. Rolled affixes are
 * unconditional by design (a condition on a random mod is very hard to price),
 * so uniques carry the interesting shapes: execute thresholds, boss-only
 * damage, stage gates.
 */

import type { Unique } from './schema';

export const UNIQUES = [
  {
    id: 'whetstone',
    name: 'The Whetstone',
    sprite: 'artifact.whetstone',
    dropStage: 1,
    effects: [{ kind: 'statMod', stat: 'damage', op: 'mul', value: 1.35 }],
  },
  {
    id: 'quickdraw-glove',
    name: 'Quickdraw Glove',
    sprite: 'artifact.quickdraw_glove',
    dropStage: 1,
    effects: [{ kind: 'statMod', stat: 'attackSpeed', op: 'mul', value: 1.3 }],
  },
  {
    id: 'coin-purse',
    name: 'Bottomless Purse',
    sprite: 'artifact.coin_purse',
    dropStage: 3,
    effects: [{ kind: 'goldOnKill', multiplier: 0.6 }],
  },
  {
    id: 'executioners-mark',
    name: "Executioner's Mark",
    sprite: 'artifact.executioners_mark',
    dropStage: 8,
    effects: [
      { kind: 'statMod', stat: 'damage', op: 'mul', value: 1.9, when: { enemyHpBelow: 0.3 } },
    ],
  },
  {
    id: 'giant-slayer',
    name: 'Giant Slayer',
    sprite: 'artifact.giant_slayer',
    dropStage: 12,
    effects: [
      { kind: 'statMod', stat: 'damage', op: 'mul', value: 1.7, when: { isBoss: true } },
      { kind: 'statMod', stat: 'area', op: 'add', value: -1 },
    ],
  },
  {
    id: 'swarm-lens',
    name: 'Swarm Lens',
    sprite: 'artifact.swarm_lens',
    dropStage: 20,
    effects: [
      { kind: 'statMod', stat: 'area', op: 'add', value: 4 },
      { kind: 'statMod', stat: 'damage', op: 'mul', value: 0.8 },
    ],
  },
  {
    id: 'bloodstone',
    name: 'Bloodstone',
    sprite: 'artifact.bloodstone',
    dropStage: 25,
    effects: [
      { kind: 'statMod', stat: 'critChance', op: 'add', value: 0.18 },
      { kind: 'statMod', stat: 'critMult', op: 'add', value: 0.6 },
      { kind: 'statMod', stat: 'maxHp', op: 'mul', value: 0.75 },
    ],
  },
  {
    id: 'deep-delvers-idol',
    name: "Deep Delver's Idol",
    sprite: 'artifact.deep_delvers_idol',
    dropStage: 40,
    effects: [
      { kind: 'statMod', stat: 'goldFind', op: 'mul', value: 2, when: { stageAtLeast: 40 } },
      { kind: 'goldOnKill', multiplier: 0.5, when: { isBoss: true } },
    ],
  },
] as const satisfies readonly Unique[];

export type UniqueId = (typeof UNIQUES)[number]['id'];

const byId = new Map<string, Unique>(UNIQUES.map((u) => [u.id, u]));

export function getUnique(id: string): Unique | undefined {
  return byId.get(id);
}

/** Uniques whose drop stage this item level satisfies. */
export function uniquesFor(stage: number): Unique[] {
  return UNIQUES.filter((u) => u.dropStage <= stage);
}
