# Credits

## Art

**Tiny Dungeon** (1.0) — [Kenney](https://kenney.nl)
Licensed CC0 1.0 Universal (public domain dedication).

CC0 requires no attribution. Listed anyway because knowing where art came from
matters when deciding whether it can be replaced, extended, or shipped.

Source files live in `assets/source/kenney_tiny-dungeon/` with the pack's own
`License.txt` alongside them. `pnpm atlas` packs them into `public/atlas/`.

## Adding another pack

Check the license before the art. Some otherwise-free packs forbid commercial
use or require attribution in-game rather than in a file like this one — both
are cheaper to discover now than after the art is wired in.

Then add a source entry in `scripts/atlas/sources.ts` and drop the files under
`assets/source/`. Nothing in `src/` changes: game code references logical sprite
IDs (`enemy.slime`, `item.bloodstone`) and never a filename or tile index.
