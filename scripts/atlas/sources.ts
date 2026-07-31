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
  /**
   * Ids deliberately pointing at a tile something else already uses.
   *
   * Kept apart from `tiles` rather than mixed in, because a shared tile is normally a
   * copy-paste slip and there is a test that says so. Listing one here is a signed
   * statement that the art is not ready yet - the test skips these and prints them, so
   * a placeholder stays visible instead of quietly becoming permanent.
   *
   * Retiring one is a move from this map to `tiles` plus the new art. No game code
   * moves, because nothing outside this file knows a sprite id is borrowed.
   */
  placeholders?: Partial<Record<SpriteId, number>>;
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

    // The four Phase 2 uniques, and these were the last readable item tiles the
    // pack has. 94 of 132 tiles are unbound but nearly all are floor, wall, door or
    // fence; the free ones that read as an OBJECT at 16px are down to furniture and
    // townsfolk. A fifth unique needs a second GridSource, which is what this
    // indirection exists for - no game code moves when one is added.
    'item.berserkers_anvil': 74,
    'item.duelists_visor': 124,
    'item.wardens_coffer': 91,
    'item.bulwark_of_the_deep': 82,

    // Weapon bases. Picked by rendering the sheet at 6x and reading it, not by
    // guessing indices - 117 is the double axe and 131 the staff, and both were the
    // only free tiles that read unmistakably as a weapon at 16px. There is no free
    // sword: 104 is the player's swing animation and 105-107 are bound to
    // giant_slayer and two shards.
    'item.axe': 117,
    'item.wand': 131,
    'item.maul': 118,
    'item.staff': 128,

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

  /**
   * The two Phase 2 slot uniques. Tiny Dungeon has nothing left that reads as an
   * object at 16px - what remains unbound is floor, wall, door, fence and townsfolk -
   * so these borrow tiles until purpose-made art arrives.
   *
   * Borrowed on meaning, not at random: the harness takes the pack (a thing you wear
   * to carry more), the seal takes the amulet-ish gem.
   */
  placeholders: {
    'item.travellers_harness': 82,
    'item.monomaniacs_seal': 115,
  },
};

export const SOURCES: GridSource[] = [KENNEY_TINY_DUNGEON];
