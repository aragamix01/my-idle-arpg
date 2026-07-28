/**
 * Artifact registry.
 *
 * Seed set only — enough to exercise every effect `kind` and every condition
 * field so the interpreter is covered before the content pass fills this out.
 */

import type { Artifact } from './schema';

export const ARTIFACTS = [
  {
    id: 'whetstone',
    name: 'Whetstone',
    sprite: 'artifact.whetstone',
    rarity: 'common',
    dropStage: 1,
    effects: [{ kind: 'statMod', stat: 'damage', op: 'mul', value: 1.15 }],
  },
  {
    id: 'quickdraw-glove',
    name: 'Quickdraw Glove',
    sprite: 'artifact.quickdraw_glove',
    rarity: 'common',
    dropStage: 1,
    effects: [{ kind: 'statMod', stat: 'attackSpeed', op: 'mul', value: 1.12 }],
  },
  {
    id: 'coin-purse',
    name: 'Coin Purse',
    sprite: 'artifact.coin_purse',
    rarity: 'common',
    dropStage: 3,
    effects: [{ kind: 'goldOnKill', multiplier: 0.25 }],
  },
  {
    id: 'executioners-mark',
    name: "Executioner's Mark",
    sprite: 'artifact.executioners_mark',
    rarity: 'rare',
    dropStage: 8,
    effects: [
      {
        kind: 'statMod',
        stat: 'damage',
        op: 'mul',
        value: 1.45,
        when: { enemyHpBelow: 0.3 },
      },
    ],
  },
  {
    id: 'giant-slayer',
    name: 'Giant Slayer',
    sprite: 'artifact.giant_slayer',
    rarity: 'rare',
    dropStage: 12,
    effects: [
      { kind: 'statMod', stat: 'damage', op: 'mul', value: 1.35, when: { isBoss: true } },
      { kind: 'statMod', stat: 'area', op: 'add', value: -1 },
    ],
  },
  {
    id: 'swarm-lens',
    name: 'Swarm Lens',
    sprite: 'artifact.swarm_lens',
    rarity: 'epic',
    dropStage: 20,
    effects: [
      { kind: 'statMod', stat: 'area', op: 'add', value: 3 },
      { kind: 'statMod', stat: 'damage', op: 'mul', value: 0.85 },
    ],
  },
  {
    id: 'bloodstone',
    name: 'Bloodstone',
    sprite: 'artifact.bloodstone',
    rarity: 'epic',
    dropStage: 25,
    effects: [
      { kind: 'statMod', stat: 'critChance', op: 'add', value: 0.12 },
      { kind: 'statMod', stat: 'critMult', op: 'add', value: 0.5 },
      { kind: 'statMod', stat: 'maxHp', op: 'mul', value: 0.8 },
    ],
  },
  {
    id: 'deep-delvers-idol',
    name: "Deep Delver's Idol",
    sprite: 'artifact.deep_delvers_idol',
    rarity: 'legendary',
    dropStage: 40,
    effects: [
      {
        kind: 'statMod',
        stat: 'goldFind',
        op: 'mul',
        value: 1.6,
        when: { stageAtLeast: 40 },
      },
      { kind: 'goldOnKill', multiplier: 0.5, when: { isBoss: true } },
    ],
  },
] as const satisfies readonly Artifact[];

export type ArtifactId = (typeof ARTIFACTS)[number]['id'];
