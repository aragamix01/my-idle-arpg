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
 *
 * This pack now carries CREATURES ONLY. Every item and currency icon moved to the
 * Raven pack below, which is drawn for inventories rather than for floors - Tiny
 * Dungeon is a tileset, and its "items" were furniture and potions doing a job they
 * were not drawn for. What remains here is what a tileset is actually good at.
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
  },
};

/**
 * Clockwork Raven "Free Fantasy Icons", 2192 icons at 16 columns.
 *
 * Purpose-drawn inventory icons, which is exactly what Tiny Dungeon does not have -
 * that pack is a TILESET, so its items were furniture and potions pressed into service
 * and the roster had run out of tiles that read as an object at 16px.
 *
 * The two packs split by what each is for: creatures, the player and the world stay
 * Kenney; everything that lives in an inventory comes from here. Neither is a partial
 * replacement of the other, which is why the atlas holds both rather than migrating.
 *
 * ## Reading the indices
 *
 * Row-major over 16 columns, so index = row x 16 + column, same convention as above.
 * They were read off contact sheets rendered at 4x rather than guessed - the pack
 * groups by category (gems around 160, keys at 176, weapons from 1440, armour and
 * accessories from 2048), which is what makes picking by meaning possible at all.
 *
 * The 16px sheet, not the 32px or 64px ones it also ships. Kenney's cells are 16, and
 * matching them keeps every existing `scale` in the UI meaning the same thing. Moving
 * to 32px art is a real improvement and a separate change: the frames already carry
 * their own size, so it is a swap here plus reading the sizes the callers ask for.
 */
export const RAVEN_FANTASY_ICONS: GridSource = {
  kind: 'grid',
  name: 'raven-fantasy-icons',
  sheet: 'Free - Raven Fantasy Icons/Full Spritesheet/16x16.png',
  cell: 16,
  columns: 16,
  spacing: 0,
  license: 'Clockwork Raven Studios - Free Fantasy Icons (see CREDITS.md)',
  tiles: {
    // Weapons. The pack draws each in several metal tints; these are the steel ones,
    // so a weapon's colour never implies a rarity the item does not have.
    'item.axe': 1457,
    'item.maul': 1471,
    // The wand is short and the staff is long, which is the only thing separating
    // them at 16px - the pack draws both as a rod with a red gem, and the first pick
    // had them near-identical on the proof sheet.
    'item.wand': 1488,
    'item.staff': 1497,
    // The player's swing. A plain arming sword rather than anything ornate - it is
    // drawn every frame of every fight and should not compete with the loot.
    'weapon.sword': 1440,

    // Gear bases. Each shares its icon with the unique of the same name, which is a
    // property of the content rather than a shortcut: The Whetstone IS a whetstone.
    'item.whetstone': 208,
    'item.quickdraw_glove': 1487,
    'item.coin_purse': 157,
    'item.executioners_mark': 316,
    'item.giant_slayer': 1455,
    'item.swarm_lens': 292,
    'item.bloodstone': 162,
    'item.deep_delvers_idol': 134,

    // The remaining uniques, picked on meaning: an anvil for the Anvil, a visored helm
    // for the Visor, a round shield for the Bulwark, a signet for the Seal.
    'item.berserkers_anvil': 124,
    'item.duelists_visor': 2051,
    'item.wardens_coffer': 304,
    'item.bulwark_of_the_deep': 2114,
    'item.travellers_harness': 2092,
    'item.monomaniacs_seal': 2060,

    /*
      Accessories.

      The pack draws jewellery across two bands - a grey/silver run at the end of row
      128 and a blue-and-gold run in the last row - and these are picked from both so no
      two accessories share a palette. At 16px a ring is four or five pixels of metal
      and one of stone, so COLOUR is most of what separates them; three silver bands
      would be one icon shown three times.

      2060 is a plain silver band and is deliberately NOT here: Monomaniac's Seal already
      claims it, and the builder refuses an id claimed twice rather than letting one
      silently win.
    */
    'item.signet': 2061,
    'item.band': 2185,
    'item.seal': 2186,
    'item.pendant': 2064,
    'item.locket': 2176,
    'item.talisman': 2181,

    // Currency. Tiny Dungeon had no crafting icons at all and these were the weakest
    // art in the game - potions and torches standing in for ores and flames.
    //
    // Every fragment is the ORE VEIN of its finished currency's colour, so "ten of
    // these make one of those" reads without a legend: blue gem and blue vein, gold
    // gem and gold vein. The first cut claimed that pairing in a comment and did not
    // deliver it - the proof sheet had a silver shard under a gold ore - which is
    // exactly the kind of thing no test can see.
    //
    // The colours carry the rarity they always did: magic is blue, rare is gold. The
    // Droplet is purple because it is the one currency that makes a unique, and the
    // Flame is white because it changes magnitudes rather than identity.
    'currency.magic_ore': 160,
    'currency.magic_ore_shard': 186,
    'currency.rare_ore': 163,
    'currency.rare_ore_shard': 189,
    'currency.angel_flame': 173,
    'currency.angel_flame_shard': 188,
    'currency.angel_droplet': 121,
    'currency.angel_droplet_shard': 191,

    // The idols are ritual masks, gold for the Sacred and red for the Dark. The
    // spirits are what a spirit is bound in: a rosary, a skull, a desert stone.
    'currency.sacred_idol': 135,
    'currency.dark_idol': 133,
    'currency.bishop_spirit': 2066,
    'currency.devil_spirit': 226,
    'currency.dune_spirit': 197,

    'currency.dungeon_key': 178,
  },
};

/**
 * Order matters only for reading the build log - ids may not be claimed twice, and the
 * builder refuses rather than letting the later pack silently win.
 */
export const SOURCES: GridSource[] = [KENNEY_TINY_DUNGEON, RAVEN_FANTASY_ICONS];
