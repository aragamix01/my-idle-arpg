/**
 * Save migration.
 *
 * This is what `contentVersion` was stamped into every save for. The server
 * recomputes progress from saves that may be weeks old, and the affix rework
 * changed `artifactsOwned` from a list of ids into a list of rolled instances -
 * a shape the new code cannot read.
 *
 * Gold, stage and upgrades are untouched. Only the artifact fields reset, and
 * drops are now guaranteed on every clear so an inventory refills quickly.
 */

import { CONTENT_VERSION } from './content';
import { ARTIFACT_SLOTS, type SaveState } from './types';

/** First version whose saves use rolled item instances. */
export const ITEMS_VERSION = 2;

export interface MigrationResult {
  state: SaveState;
  /** True when anything was reset, so the caller can tell the player. */
  migrated: boolean;
}

export function migrateSave(state: SaveState): MigrationResult {
  let migrated = false;
  const next: SaveState = { ...state };

  if ((state.contentVersion ?? 0) < ITEMS_VERSION) {
    next.artifactsOwned = [];
    next.loadout = Array<string | null>(ARTIFACT_SLOTS).fill(null);
    next.nextItemId = 1;
    migrated = true;
  }

  // Defensive: a save written before nextItemId existed would otherwise produce
  // NaN uids, and every item would collide on the same roll seed.
  if (typeof next.nextItemId !== 'number' || !Number.isFinite(next.nextItemId)) {
    next.nextItemId = 1;
    migrated = true;
  }

  if (migrated) next.contentVersion = CONTENT_VERSION;
  return { state: next, migrated };
}
