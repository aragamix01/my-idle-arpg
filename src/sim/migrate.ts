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

import { CONTENT_VERSION } from './content';
import { ITEM_SLOTS, type SaveState } from './types';

/** First version whose saves use rolled item instances. */
export const ITEMS_VERSION = 2;

/** First version where the field is `items` and bases carry implicits. */
export const IMPLICITS_VERSION = 3;

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

  // Defensive: a save written before nextItemId existed would otherwise produce
  // NaN uids, and every item would collide on the same roll seed.
  if (typeof next.nextItemId !== 'number' || !Number.isFinite(next.nextItemId)) {
    next.nextItemId = 1;
    migrated = true;
  }

  if (migrated) next.contentVersion = CONTENT_VERSION;
  return { state: next as SaveState, migrated };
}
