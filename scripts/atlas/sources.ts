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

    'artifact.whetstone': 102,
    'artifact.quickdraw_glove': 103,
    'artifact.coin_purse': 89,
    'artifact.executioners_mark': 119,
    'artifact.giant_slayer': 106,
    'artifact.swarm_lens': 130,
    'artifact.bloodstone': 115,
    'artifact.deep_delvers_idol': 129,
  },
};

export const SOURCES: GridSource[] = [KENNEY_TINY_DUNGEON];
