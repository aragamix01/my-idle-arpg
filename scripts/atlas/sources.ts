/**
 * Art source bindings.
 *
 * The only file that knows where a logical sprite ID physically comes from.
 * A new pack means a new entry here; nothing in src/ changes.
 */

import type { SpriteId } from '../../src/render/sprites';

export interface GridSource {
  kind: 'grid';
  name: string;
  /** Sheet path, relative to assets/source/. */
  sheet: string;
  /** Square cell size in pixels. */
  cell: number;
  /** Columns in the sheet. Rows are inferred from the file size. */
  columns: number;
  /** Gap between cells, if the sheet is spaced rather than packed. */
  spacing: number;
  license: string;
  /** Logical ID to tile index, read row-major from the top left. */
  tiles: Partial<Record<SpriteId, number>>;
}

/**
 * Kenney "Tiny Dungeon" 1.0, CC0.
 *
 * tilemap_packed.png is 192x176 = 12 columns x 11 rows of 16px cells = 132
 * tiles, read row-major from the top left. The pack also ships a 1px-spaced
 * sheet and 132 individual tile PNGs; both were dropped, since zero spacing
 * makes frame rects pure arithmetic and the other two carry identical pixels.
 *
 * Indices were read off the sheet by eye - Preview.png is kept alongside the
 * art for exactly that job. A test asserts every ID resolves to a frame with a
 * non-empty alpha channel, which catches an index pointing at blank space. It
 * cannot catch an index pointing at the wrong creature.
 */
export const KENNEY_TINY_DUNGEON: GridSource = {
  kind: 'grid',
  name: 'kenney_tiny-dungeon',
  sheet: 'kenney_tiny-dungeon/Tilemap/tilemap_packed.png',
  cell: 16,
  columns: 12,
  spacing: 0,
  license: 'CC0 1.0 - Kenney (kenney.nl)',
  tiles: {
    'enemy.slime': 108,
    'enemy.ogre': 109,
    'enemy.crab': 110,
    'enemy.rat': 111,
    'enemy.bat': 120,
    'enemy.ghost': 121,
    'enemy.spider': 122,
    'enemy.snake': 123,

    'boss.brute': 87,
    'boss.warlock': 84,

    'player.knight': 96,
    // 106 is a sword too, but it is already bound to giant_slayer and the
    // duplicate-tile test would reject sharing it.
    'weapon.sword': 104,

    'item.whetstone': 102,
    'item.quickdraw_glove': 103,
    'item.coin_purse': 89,
    'item.executioners_mark': 119,
    'item.giant_slayer': 106,
    'item.swarm_lens': 130,
    'item.bloodstone': 115,
    'item.deep_delvers_idol': 129,

    // Currency. Tiny Dungeon has no purpose-drawn crafting icons, so these are
    // the closest readable stand-ins from what the pack ships: potions for the
    // ores, torches for the flames, chests and tomes for the rest. The colour
    // pairings are deliberate - magic ore is the blue potion because magic
    // items are blue, rare ore the orange gem because rares are yellow.
    'currency.sacred_idol': 64,
    'currency.dark_idol': 56,
    'currency.magic_ore': 116,
    'currency.rare_ore': 101,
    'currency.angel_flame': 127,
    'currency.angel_droplet': 113,
    'currency.bishop_spirit': 65,
    'currency.devil_spirit': 92,
    'currency.dune_spirit': 125,
    'currency.magic_ore_shard': 105,
    'currency.rare_ore_shard': 107,
    'currency.angel_flame_shard': 126,
    'currency.angel_droplet_shard': 114,
    'currency.dungeon_key': 90,
  },
};

export const SOURCES: GridSource[] = [KENNEY_TINY_DUNGEON];
