/**
 * The narrow bridge between the sim and React.
 *
 * React must never see entity arrays. The renderer reads sim entities directly
 * inside the RAF loop at 60Hz; React gets this snapshot — about fifteen scalars
 * — pushed into Zustand at ~10Hz. That split is why a screen full of enemies
 * costs nothing in re-renders.
 */

import { fromSave, toSave } from './big';
import { farmRate } from './combat';
import { OFFLINE_CAP_SECONDS, upgradeCost, isUpgradeMaxed, UPGRADE_TRACKS } from './curves';
import { computeOffline } from './offline';
import { deriveStats } from './stats';
import { INVENTORY_CAP, UPGRADE_KEYS, type SaveState, type Stats, type UpgradeKey } from './types';
import type { CurrencyPurse, ItemInstance } from './content';

export interface UpgradeView {
  key: UpgradeKey;
  label: string;
  level: number;
  /** Decimal string. A maxed track has no cost at all rather than an infinite one. */
  cost: string | null;
  affordable: boolean;
  maxed: boolean;
}

export interface HudSnapshot {
  /** Decimal string - see the note on SaveState.gold. */
  gold: string;
  bestStage: number;
  currentStage: number;
  stats: Stats;
  goldPerSecond: number;
  upgrades: UpgradeView[];
  /** Decimal string. */
  pendingOfflineGold: string;
  offlineCapReached: boolean;
  loadout: (string | null)[];
  /** Equipped weapon uid, or null for unarmed. */
  weapon: string | null;
  items: ItemInstance[];
  currency: CurrencyPurse;
  /** Cap included so the panel can show capacity without importing curves. */
  inventoryCap: number;
}

export function getHudSnapshot(save: SaveState, nowMs: number): HudSnapshot {
  const offline = computeOffline(save, nowMs);
  const gold = fromSave(save.gold);

  return {
    gold: toSave(gold),
    bestStage: save.bestStage,
    currentStage: save.currentStage,
    stats: deriveStats(save, {
      stage: save.currentStage,
      isBoss: false,
      enemyHpFraction: 1,
    }),
    goldPerSecond: farmRate(save, save.bestStage),
    upgrades: UPGRADE_KEYS.map((key) => {
      const level = save.upgrades[key];
      const maxed = isUpgradeMaxed(key, level);
      const cost = maxed ? null : upgradeCost(key, level);
      return {
        key,
        label: UPGRADE_TRACKS[key].label,
        level,
        cost: cost && toSave(cost),
        affordable: cost !== null && gold.gte(cost),
        maxed,
      };
    }),
    pendingOfflineGold: toSave(offline.goldEarned),
    offlineCapReached: offline.elapsedSeconds > OFFLINE_CAP_SECONDS,
    loadout: save.loadout,
    weapon: save.weapon,
    items: save.items,
    currency: save.currency,
    inventoryCap: INVENTORY_CAP,
  };
}
