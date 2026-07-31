# Credits

## Art

The atlas is built from two packs, split by what each is drawn for. Creatures,
the player and the world come from a tileset; everything that lives in an
inventory comes from an icon pack. Neither replaces the other.

### Tiny Dungeon (1.0) — [Kenney](https://kenney.nl)

Licensed CC0 1.0 Universal (public domain dedication).

CC0 requires no attribution. Listed anyway because knowing where art came from
matters when deciding whether it can be replaced, extended, or shipped.

Source files live in `assets/source/kenney_tiny-dungeon/` with the pack's own
`License.txt` alongside them.

Provides: enemies, bosses, the player.

### Free Fantasy Icons — Clockwork Raven Studios

2192 icons at 16×16, 32×32 and 64×64. Source files live in
`assets/source/Free - Raven Fantasy Icons/`.

Provides: every item, weapon and currency icon.

> **License unverified.** The pack ships no license file — only a note from the
> artist thanking the buyer. The folder is named "Free", which suggests the free
> tier of a paid range, but nothing in the download states the terms.
>
> **Confirm on the store page before shipping this publicly**, and record the
> answer here. What matters: commercial use, and whether attribution has to
> appear in-game rather than in a file like this one. Nothing else in the repo
> depends on the answer — the binding is one entry in
> `scripts/atlas/sources.ts`, so swapping packs moves no game code.

## Adding another pack

Check the license before the art. Some otherwise-free packs forbid commercial
use or require attribution in-game rather than in a file like this one — both
are cheaper to discover now than after the art is wired in.

Then add a source entry in `scripts/atlas/sources.ts` and drop the files under
`assets/source/`. Nothing in `src/` changes: game code references logical sprite
IDs (`enemy.slime`, `item.bloodstone`) and never a filename or tile index.

Two packs may not claim the same sprite ID. The build refuses rather than
letting the later one silently win, because a pack whose art quietly vanished is
a bug you find in a screenshot weeks later.

## Adding another pack

Check the license before the art. Some otherwise-free packs forbid commercial
use or require attribution in-game rather than in a file like this one — both
are cheaper to discover now than after the art is wired in.

Then add a source entry in `scripts/atlas/sources.ts` and drop the files under
`assets/source/`. Nothing in `src/` changes: game code references logical sprite
IDs (`enemy.slime`, `item.bloodstone`) and never a filename or tile index.
