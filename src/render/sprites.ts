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
  'weapon.sword',

  // Items - must stay in step with src/sim/content/bases.ts and uniques.ts.
  'item.whetstone',
  'item.quickdraw_glove',
  'item.coin_purse',
  'item.executioners_mark',
  'item.giant_slayer',
  'item.swarm_lens',
  'item.bloodstone',
  'item.deep_delvers_idol',
  'item.berserkers_anvil',
  'item.duelists_visor',
  'item.wardens_coffer',
  'item.bulwark_of_the_deep',
  'item.travellers_harness',
  'item.monomaniacs_seal',
  'item.axe',
  'item.wand',
  'item.maul',
  'item.staff',

  // Currency - must stay in step with src/sim/content/currency.ts.
  'currency.sacred_idol',
  'currency.dark_idol',
  'currency.magic_ore',
  'currency.rare_ore',
  'currency.angel_flame',
  'currency.angel_droplet',
  'currency.bishop_spirit',
  'currency.devil_spirit',
  'currency.dune_spirit',
  'currency.magic_ore_shard',
  'currency.rare_ore_shard',
  'currency.angel_flame_shard',
  'currency.angel_droplet_shard',
  'currency.dungeon_key',
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

/**
 * One packed sheet.
 *
 * The dimensions are here for the DOM, not for Pixi: Pixi slices frames out of a
 * loaded texture, while rendering one frame as a CSS background means scaling the
 * WHOLE sheet with background-size, which is impossible without knowing how big it is.
 */
export interface AtlasSheet {
  image: string;
  width: number;
  height: number;
}

export interface AtlasFrame {
  /**
   * Index into AtlasManifest.sheets.
   *
   * Per frame rather than per manifest, because one pack rarely covers a whole game -
   * a dungeon tileset has creatures and no inventory icons, an icon pack has the
   * reverse. Without this the second source silently repointed every frame from the
   * first at its own image, which renders as the wrong art rather than as an error.
   */
  sheet: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasManifest {
  sheets: AtlasSheet[];
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
