# Source assets

Currently wired: **Kenney Tiny Dungeon** (CC0) — 132 tiles of 16x16 in a packed
12x11 grid. Tile indices are bound to logical sprite IDs in
`scripts/atlas/sources.ts`.

Drop new packs' **spritesheet PNGs** here — not the preview/contact sheets.

A preview sheet has section titles, grid borders and often a UI mockup baked
into the pixels. Slicing one puts the word "Goblins" into the game. The files
wanted here are the raw sheets: transparent background, uniform cell grid,
nothing but frames.

Nothing in this folder is loaded at runtime. `pnpm atlas` packs it into
`public/atlas/`, and the game only ever references logical sprite IDs
(`enemy.skeleton`, `item.bloodstone`) which resolve through the sprite map.
That indirection is what lets the art source change without touching game code.

## Layout

```
assets/source/
  enemies/     skeleton.png, zombie.png, goblin.png, gargoyle.png, bat.png, ...
  bosses/      vampire-lord.png, lich-lord.png, beholder.png
  player/      knight.png, mage.png, rogue.png
  items/       gems.png, potions.png, chests.png, weapons.png
  LICENSE.txt  the pack's license, kept alongside what it covers
```

Folder names are a convention, not a constraint — the packer walks the tree.

## What the build needs to know

Per sheet, either a matching `<name>.json` from the pack, or the numbers written
into `assets/source/manifest.json`:

- **cell size** in pixels (e.g. 32x32) — sheets in one category should agree
- **frames per row** and total frame count, if there is padding or empty cells
- **animation ranges**, if a sheet holds several states (idle 0-3, walk 4-9)

Without these the packer has to guess the grid, and guessing wrong shears every
frame by a few pixels in a way that is easy to miss and annoying to trace.

## Sizing

Logical sizes are pinned in the sim; the renderer scales to fit. A pack at a
different pixel density therefore changes how things *look* and never what a
hitbox *is*. Keep one cell size per category so scaling stays uniform.
