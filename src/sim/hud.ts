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
import { deriveStats, equipSlots } from './stats';
import {
  INVENTORY_CAP,
  UPGRADE_KEYS,
  type MagnitudeStatKey,
  type SaveState,
  type StatKey,
  type Stats,
  type UpgradeKey,
} from './types';
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

/**
 * Stats as they cross the wire.
 *
 * A Decimal is an object with a prototype, and JSON keeps the fields while losing the
 * prototype - so a snapshot that travelled through `NextResponse.json` arrives as
 * `{mantissa, exponent}` with no `.mul`, and the first thing the panel does with it
 * throws. Strings survive; the UI revives them with `statsFromWire`.
 */
export type WireStats = { [K in StatKey]: K extends MagnitudeStatKey ? string : number };

export function statsToWire(stats: Stats): WireStats {
  return { ...stats, damage: toSave(stats.damage), maxHp: toSave(stats.maxHp) };
}

export function statsFromWire(stats: WireStats): Stats {
  return { ...stats, damage: fromSave(stats.damage), maxHp: fromSave(stats.maxHp) };
}

export interface HudSnapshot {
  /** Decimal string - see the note on SaveState.gold. */
  gold: string;
  bestStage: number;
  currentStage: number;
  stats: WireStats;
  /** Decimal string, like every other magnitude that crosses the wire. */
  goldPerSecond: string;
  upgrades: UpgradeView[];
  /** Decimal string. */
  pendingOfflineGold: string;
  offlineCapReached: boolean;
  loadout: (string | null)[];
  /**
   * How many of those positions are live.
   *
   * Derived rather than constant now that a unique can grant or remove slots, and
   * sent rather than recomputed in the panel so the two cannot disagree about which
   * slots exist.
   */
  equipSlots: number;
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
  // One context for everything derived here, so the sheet, the slot count and the
  // DPS figure are all describing the same moment.
  const ctx = { stage: save.currentStage, isBoss: false, enemyHpFraction: 1 };

  return {
    gold: toSave(gold),
    bestStage: save.bestStage,
    currentStage: save.currentStage,
    stats: statsToWire(deriveStats(save, ctx)),
    goldPerSecond: toSave(farmRate(save, save.bestStage)),
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
    equipSlots: equipSlots(save, ctx),
    weapon: save.weapon,
    items: save.items,
    currency: save.currency,
    inventoryCap: INVENTORY_CAP,
  };
}
