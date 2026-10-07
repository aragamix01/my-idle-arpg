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
  // Weapons.
  'item.axe',
  'item.wand',
  'item.maul',
  'item.staff',

  // Armour bases, Phase 8 - three per slot, one per defence layer, and three belts.
  'item.iron_helm',
  'item.leather_hood',
  'item.silk_circlet',
  'item.plate_cuirass',
  'item.leather_jerkin',
  'item.silk_robe',
  'item.gauntlets',
  'item.leather_gloves',
  'item.silk_wraps',
  'item.greaves',
  'item.leather_boots',
  'item.silk_slippers',
  'item.heavy_belt',
  'item.leather_belt',
  'item.sash',

  // Uniques, each drawn as the piece it is worn as.
  'item.whetstone_grips',
  'item.quickdraw_gauntlets',
  'item.berserkers_fists',
  'item.executioners_hood',
  'item.swarm_eye_circlet',
  'item.duelists_visor',
  'item.bloodstone_carapace',
  'item.bulwark_of_the_deep',
  'item.monomaniacs_shroud',
  'item.giantstride_greaves',
  'item.deep_delvers_treads',
  'item.bottomless_pouch',
  'item.wardens_keyring',
  'item.travellers_harness',

  // Tablets. They borrowed relic art until the relics were deleted.
  'item.hoarding_tablet',
  'item.auspicious_tablet',
  'item.gilded_tablet',

  // Accessories. Rings and amulets, from the Abyss only.
  'item.band',
  'item.signet',
  'item.seal',
  'item.pendant',
  'item.locket',
  'item.talisman',

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
