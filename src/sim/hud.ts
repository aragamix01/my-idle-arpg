/**
 * The narrow bridge between the sim and React.
 *
 * React must never see entity arrays. The renderer reads sim entities directly
 * inside the RAF loop at 60Hz; React gets this snapshot — about fifteen scalars
 * — pushed into Zustand at ~10Hz. That split is why a screen full of enemies
 * costs nothing in re-renders.
 */

import { farmRate } from './combat';
import { OFFLINE_CAP_SECONDS, upgradeCost, isUpgradeMaxed, UPGRADE_TRACKS } from './curves';
import { computeOffline } from './offline';
import { deriveStats } from './stats';
import { UPGRADE_KEYS, type SaveState, type Stats, type UpgradeKey } from './types';

export interface UpgradeView {
  key: UpgradeKey;
  label: string;
  level: number;
  cost: number;
  affordable: boolean;
  maxed: boolean;
}

export interface HudSnapshot {
  gold: number;
  bestStage: number;
  currentStage: number;
  stats: Stats;
  goldPerSecond: number;
  upgrades: UpgradeView[];
  pendingOfflineGold: number;
  offlineCapReached: boolean;
  loadout: (string | null)[];
  artifactsOwned: string[];
}

export function getHudSnapshot(save: SaveState, nowMs: number): HudSnapshot {
  const offline = computeOffline(save, nowMs);
  const gold = Math.floor(save.gold);

  return {
    gold,
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
      const cost = maxed ? Infinity : upgradeCost(key, level);
      return {
        key,
        label: UPGRADE_TRACKS[key].label,
        level,
        cost,
        affordable: !maxed && gold >= cost,
        maxed,
      };
    }),
    pendingOfflineGold: offline.goldEarned,
    offlineCapReached: offline.elapsedSeconds > OFFLINE_CAP_SECONDS,
    loadout: save.loadout,
    artifactsOwned: save.artifactsOwned,
  };
}
