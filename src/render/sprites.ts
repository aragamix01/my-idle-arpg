/**
 * Logical sprite IDs.
 *
 * Game code and content data reference these names and never a filename, a tile
 * index, or an atlas offset. Swapping art packs is then a change to
 * scripts/atlas/sources.ts plus new files - no game code moves.
 *
 * The indirection also lets a partial migration run: an ID with no frame in the
 * atlas falls back to a coloured placeholder rather than crashing, so art can
 * arrive twenty sprites at a time.
 */

export const SPRITE_IDS = [
  // Enemies - the swarm.
  'enemy.slime',
  'enemy.crab',
  'enemy.ghost',
  'enemy.spider',
  'enemy.bat',
  'enemy.snake',
  'enemy.rat',
  'enemy.ogre',

  // Bosses.
  'boss.brute',
  'boss.warlock',

  // Player.
  'player.knight',

  // Artifacts - must stay in step with src/sim/content/artifacts.ts.
  'artifact.whetstone',
  'artifact.quickdraw_glove',
  'artifact.coin_purse',
  'artifact.executioners_mark',
  'artifact.giant_slayer',
  'artifact.swarm_lens',
  'artifact.bloodstone',
  'artifact.deep_delvers_idol',
] as const;

export type SpriteId = (typeof SPRITE_IDS)[number];

/** Enemies drawn in the swarm, in rough order of appearance as stages climb. */
export const ENEMY_SPRITES: SpriteId[] = [
  'enemy.slime',
  'enemy.rat',
  'enemy.bat',
  'enemy.spider',
  'enemy.crab',
  'enemy.snake',
  'enemy.ghost',
  'enemy.ogre',
];

export interface AtlasFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasManifest {
  image: string;
  /** Source cell size, before any display scaling. */
  cell: number;
  frames: Record<string, AtlasFrame>;
}

export const ATLAS_URL = '/atlas/atlas.json';

/**
 * Which enemy sprites a stage draws.
 *
 * Purely cosmetic - the abstract layer has no notion of enemy type, so this
 * only decides what the swarm looks like as the player descends.
 */
export function enemySpritesForStage(stage: number): SpriteId[] {
  const unlocked = Math.min(ENEMY_SPRITES.length, 2 + Math.floor(stage / 6));
  return ENEMY_SPRITES.slice(0, unlocked);
}
