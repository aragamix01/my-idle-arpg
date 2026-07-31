/**
 * Save migration.
 *
 * This is what `contentVersion` was stamped into every save for. The server
 * recomputes progress from saves that may be weeks old, and a content change
 * that alters the *shape* of a save needs a step here or the new code reads
 * fields that are not there.
 *
 * Gold, stage and upgrades are never touched by any step.
 */

import { fromSave, toSave } from './big';
import { CONTENT_VERSION, getAffix, getUnique, rollUniqueValues, type RolledAffix } from './content';
import { rollStream } from './items';
import { ITEM_SLOTS, MAX_ITEM_SLOTS, type SaveState } from './types';

/** First version whose saves use rolled item instances. */
export const ITEMS_VERSION = 2;

/** First version where the field is `items` and bases carry implicits. */
export const IMPLICITS_VERSION = 3;

/** First version with a currency purse and per-item craft counters. */
export const CURRENCY_VERSION = 4;

/** First version where modifiers carry a layer instead of add/mul. */
export const LAYERS_VERSION = 5;

/** First version with a weapon slot, skills, and uniques that roll their values. */
export const WEAPONS_VERSION = 6;

/** First version where gold is a decimal string rather than a double. */
export const BIG_GOLD_VERSION = 7;

/** First version whose loadout array is MAX_ITEM_SLOTS long and slots are derived. */
export const DERIVED_SLOTS_VERSION = 8;

export interface MigrationResult {
  state: SaveState;
  /** True when anything was reset, so the caller can tell the player. */
  migrated: boolean;
}

/** The pre-v3 field name, which no current type mentions. */
type LegacySave = SaveState & { artifactsOwned?: SaveState['items'] };

export function migrateSave(state: SaveState): MigrationResult {
  let migrated = false;
  const next: LegacySave = { ...state };

  // Steps run oldest-shape-first, and the field rename has to come before the
  // version-gated wipes rather than after. Running it last silently undid the
  // v1 wipe by copying the legacy field back over the emptied one.
  if (next.artifactsOwned !== undefined) {
    // v2 → v3 is a rename plus an added optional field, so it is lossless.
    // Deliberately non-destructive: v2 shipped a wipe, and wiping again one
    // release later would teach players that progress here is disposable.
    //
    // Items carried across keep their affixes and simply have no baseAffix.
    // That makes them marginally weaker than a fresh drop, which is the honest
    // outcome for an item that predates the mechanic - and every read path
    // already tolerates the field being absent.
    next.items = next.artifactsOwned;
    delete next.artifactsOwned;
    migrated = true;
  }

  if ((state.contentVersion ?? 0) < ITEMS_VERSION) {
    // v1 stored artifacts as bare string ids - a shape the item code cannot
    // read at all, so there is nothing to preserve.
    next.items = [];
    next.loadout = Array<string | null>(ITEM_SLOTS).fill(null);
    next.nextItemId = 1;
    migrated = true;
  }

  if (!Array.isArray(next.items)) {
    next.items = [];
    migrated = true;
  }

  if (next.currency === undefined || next.currency === null) {
    // v3 → v4 adds the purse and a per-item craft counter. Additive only;
    // nothing an existing save holds becomes unreadable.
    next.currency = {};
    migrated = true;
  }

  if (next.items.some((item) => typeof item.crafts !== 'number')) {
    // Seeding crafts from rerolls keeps each item's roll stream continuous:
    // starting everyone at zero would make the next gold reroll reproduce a
    // result the player has already seen.
    next.items = next.items.map((item) =>
      typeof item.crafts === 'number' ? item : { ...item, crafts: item.rerolls ?? 0 },
    );
    migrated = true;
  }

  if ((state.contentVersion ?? 0) < LAYERS_VERSION && next.items.length > 0) {
    // The one migration that is *allowed* to restat existing items.
    //
    // RolledAffix stores its magnitude rather than looking it up, precisely so a
    // retuned tier table cannot silently change an item someone already owns.
    // A change of formula is the exception that rule was written against: an old
    // Brutal stored 1.04 under `op: 'mul'`, and reading 1.04 as `increased` means
    // +104% damage. Leaving the numbers alone would be far more destructive than
    // re-resolving them.
    //
    // Identity survives - same affix id, same tier index, same item - so a player
    // keeps the item they earned and only its numbers move onto the new scale.
    // Affixes whose id no longer exists resolve to nothing, which itemEffects
    // already tolerates.
    const restat = (rolled: RolledAffix): RolledAffix => {
      const affix = getAffix(rolled.affixId);
      const tier = affix?.tiers[rolled.tier];
      return tier ? { ...rolled, value: tier.value } : rolled;
    };
    next.items = next.items.map((item) => ({
      ...item,
      affixes: item.affixes.map(restat),
      baseAffix: item.baseAffix ? restat(item.baseAffix) : undefined,
    }));
    migrated = true;
  }

  if (next.weapon === undefined) {
    // v5 -> v6 adds the weapon slot, and this step is deliberately POWER-NEUTRAL.
    //
    // Unarmed's bases are the exact BASE_STATS values every save derived before
    // skills existed, so a migrated character's stats do not move by a single point
    // on load. Nothing is rerolled, nothing is granted, and no gear is disturbed.
    //
    // What does change is what happens next: the gold upgrade tracks were retuned on
    // the assumption that a weapon carries two thirds of the ladder, so a migrated
    // player needs a weapon drop before they can push further. They can still farm
    // the stage they are on, and weapons take a healthy share of drops, so this
    // resolves itself within a few clears rather than becoming a wall.
    next.weapon = null;
    migrated = true;
  }

  if (next.items.some((item) => item.uniqueId && item.uniqueRolls === undefined)) {
    // v5 -> v6 gives every owned unique a roll inside its authored range.
    //
    // Rolled rather than pinned to the midpoint, even though itemEffects already
    // falls back to the midpoint. A stored roll is what Angel Flame rerolls and what
    // the panel reports quality against - leaving the field absent would give
    // existing owners a unique that reads as having no roll at all, and a currency
    // whose effect on it is invisible.
    //
    // Seeded from the item's own uid and craft count like every other roll, so the
    // client's optimistic migration and the server's authoritative one agree.
    next.items = next.items.map((item) => {
      if (!item.uniqueId || item.uniqueRolls !== undefined) return item;
      const unique = getUnique(item.uniqueId);
      if (!unique) return item;
      const rng = rollStream(state.seed, Number(item.uid), item.crafts);
      return { ...item, uniqueRolls: rollUniqueValues(unique, rng) };
    });
    migrated = true;
  }

  if (typeof (next.gold as unknown) === 'number' || next.lifetimeGold === undefined) {
    // v6 -> v7 moves gold from a double to a decimal string.
    //
    // Lossless in the direction that matters: whatever the double held is exactly what
    // the string holds, and from here the value can keep growing past 1.8e308 instead
    // of becoming Infinity somewhere around stage 6,100.
    //
    // lifetimeGold is seeded from the CURRENT balance rather than from zero. It is
    // wrong either way for an existing player - gold already spent is not recoverable -
    // but seeding it at zero would tell prestige that a player at stage 300 has never
    // earned anything, and understating a long-running account is the worse error.
    next.gold = toSave(fromSave(next.gold as unknown as string | number));
    if (next.lifetimeGold === undefined) next.lifetimeGold = next.gold;
    migrated = true;
  }

  if (Array.isArray(next.loadout) && next.loadout.length !== MAX_ITEM_SLOTS) {
    // v7 -> v8 widens the loadout array to its ceiling, padding with nulls.
    //
    // Power-neutral and position-preserving: the first four entries keep their
    // meaning, and the extra positions are inert until something grants the slots.
    // Truncating rather than growing is equally safe - a longer array can only come
    // from a save written by a newer build, and the items are still in `items`.
    const padded = Array<string | null>(MAX_ITEM_SLOTS).fill(null);
    for (let i = 0; i < Math.min(MAX_ITEM_SLOTS, next.loadout.length); i++) {
      padded[i] = next.loadout[i] ?? null;
    }
    next.loadout = padded;
    migrated = true;
  }

  // Defensive: a save written before nextItemId existed would otherwise produce
  // NaN uids, and every item would collide on the same roll seed.
  if (typeof next.nextItemId !== 'number' || !Number.isFinite(next.nextItemId)) {
    next.nextItemId = 1;
    migrated = true;
  }

  if (migrated) next.contentVersion = CONTENT_VERSION;
  return { state: next as SaveState, migrated };
}
