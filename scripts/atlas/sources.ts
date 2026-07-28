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
 * tiles, matching Tiles/tile_0000..0131 in row-major order. The other sheet,
 * tilemap.png, carries 1px spacing; the packed one is used because zero spacing
 * means frame rects are pure arithmetic.
 *
 * Indices were read off the sheet by eye. There is a test asserting every ID
 * here resolves to a frame with a non-empty alpha channel, which catches an
 * index that points at blank space.
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
