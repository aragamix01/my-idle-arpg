/**
 * Uniques.
 *
 * The eight originally hand-authored items, now the only ones with fixed
 * effects. They never roll and never reroll - a unique that could be rerolled
 * would just be a rare with a fancier name. They carry no base implicit
 * either: a unique's whole identity is its authored effect list.
 *
 * These are also where conditional effects live. Rolled affixes are
 * unconditional by design (a condition on a random mod is very hard to price),
 * so uniques carry the interesting shapes: execute thresholds, boss-only
 * damage, stage gates.
 *
 * They are also the only content that uses the `more` layer. Nothing in the
 * rollable affix pool compounds; a unique does, and that is what makes one feel
 * like a different class of item rather than a rare with a name. It is safe here
 * for the same reason it is safe on the gold upgrade tracks and unsafe on a
 * rollable affix - the list is authored and finite, so the ceiling is known.
 */

import type { Unique } from './schema';

export const UNIQUES = [
  {
    id: 'whetstone',
    name: 'The Whetstone',
    sprite: 'item.whetstone',
    dropStage: 1,
    effects: [{ kind: 'statMod', stat: 'damage', op: 'more', value: 1.35 }],
  },
  {
    id: 'quickdraw-glove',
    name: 'Quickdraw Glove',
    sprite: 'item.quickdraw_glove',
    dropStage: 1,
    effects: [{ kind: 'statMod', stat: 'attackSpeed', op: 'more', value: 1.3 }],
  },
  {
    id: 'coin-purse',
    name: 'Bottomless Purse',
    sprite: 'item.coin_purse',
    dropStage: 3,
    effects: [{ kind: 'goldOnKill', multiplier: 0.6 }],
  },
  {
    id: 'executioners-mark',
    name: "Executioner's Mark",
    sprite: 'item.executioners_mark',
    dropStage: 8,
    effects: [
      { kind: 'statMod', stat: 'damage', op: 'more', value: 1.9, when: { enemyHpBelow: 0.3 } },
    ],
  },
  {
    id: 'giant-slayer',
    name: 'Giant Slayer',
    sprite: 'item.giant_slayer',
    dropStage: 12,
    effects: [
      { kind: 'statMod', stat: 'damage', op: 'more', value: 1.7, when: { isBoss: true } },
      { kind: 'statMod', stat: 'area', op: 'flat', value: -1 },
    ],
  },
  {
    id: 'swarm-lens',
    name: 'Swarm Lens',
    sprite: 'item.swarm_lens',
    dropStage: 20,
    effects: [
      { kind: 'statMod', stat: 'area', op: 'flat', value: 4 },
      { kind: 'statMod', stat: 'damage', op: 'more', value: 0.8 },
    ],
  },
  {
    id: 'bloodstone',
    name: 'Bloodstone',
    sprite: 'item.bloodstone',
    dropStage: 25,
    effects: [
      { kind: 'statMod', stat: 'critChance', op: 'flat', value: 0.18 },
      { kind: 'statMod', stat: 'critMult', op: 'flat', value: 0.6 },
      { kind: 'statMod', stat: 'maxHp', op: 'more', value: 0.75 },
    ],
  },
  {
    id: 'deep-delvers-idol',
    name: "Deep Delver's Idol",
    sprite: 'item.deep_delvers_idol',
    dropStage: 40,
    effects: [
      { kind: 'statMod', stat: 'goldFind', op: 'more', value: 2, when: { stageAtLeast: 40 } },
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
