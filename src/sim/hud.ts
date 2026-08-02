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
import {
  abyssalDepth,
  dungeonAffinity,
  OFFLINE_CAP_SECONDS,
  upgradeCost,
  isUpgradeMaxed,
  UPGRADE_TRACKS,
} from './curves';
import { computeOffline } from './offline';
import { deriveStats, equipSlots } from './stats';
import {
  ABYSS_UNLOCK_STAGE,
  INVENTORY_CAP,
  TABLET_CAP,
  UPGRADE_KEYS,
  type MagnitudeStatKey,
  type SaveState,
  type StatKey,
  type Stats,
  type UpgradeKey,
} from './types';
import { tabletDanger, tabletReward, totalDanger, wavesForTier } from './content/tablets';
import type { TabletPays } from './content/schema';
import type { CurrencyPurse, Element, ItemInstance } from './content';

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

/**
 * What a tablet's RUN looks like, before it is spent.
 *
 * A companion to the tablet rather than a replacement for it. The tablet itself now
 * crosses the wire in `tablets` as an ordinary `ItemInstance`, so the panel renders its
 * name and modifiers with the same components every other item uses. What cannot be
 * derived client-side is here: the depth the tier fights at, how many waves, what the
 * run resists, and what the implicit adds up to once the explicits amplify it.
 *
 * The affinity is the load-bearing one. It comes from the ACCOUNT SEED, which is
 * server-side, and a tablet is consumed on entry AND on a loss - so a run whose element
 * you only learn by entering it is a coin flip rather than a decision.
 */
export interface TabletView {
  uid: string;
  /** Also the tablet's itemLevel. Repeated here because this is the run, not the item. */
  tier: number;
  /** Ladder floor this tier actually fights at - the tier alone does not say. */
  depth: number;
  /** Waves before the boss, after the `waves` modifiers have had their say. */
  waves: number;
  /** Summed danger across every axis. 0.65 is "+65% harder than a bare tier". */
  danger: number;
  /** Which reward the implicit pays, and how much once the explicits amplify it. */
  reward: { pays: TabletPays; amount: number } | null;
  resists: Element;
  weakTo: Element;
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
  /**
   * Seconds that gold represents, after the cap.
   *
   * Sent so the welcome-back receipt can say how long you were away without a second
   * round trip. The gold alone cannot answer it: the same amount is eight minutes at
   * stage 300 and eight hours at stage 3.
   */
  pendingOfflineSeconds: number;
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
  /**
   * What the next dungeon resists and what it is weak to, or null before one is
   * possible.
   *
   * Sent rather than derived in the UI, because the affinity is a function of the
   * ACCOUNT SEED and the seed is server-side. It is also the reason this is worth
   * sending at all: a key is spent, not refunded, so what the run is going to resist
   * has to be readable before the decision rather than after it.
   */
  dungeon: { stage: number; resists: Element; weakTo: Element } | null;
  items: ItemInstance[];
  currency: CurrencyPurse;
  /** Cap included so the panel can show capacity without importing curves. */
  inventoryCap: number;
  /**
   * The tablets on the shelf, deepest first.
   *
   * Ordinary items - the panel renders them with the same grid, the same ItemMods and
   * the same craft modal gear uses. Sorted here rather than in the surface, so the order
   * does not depend on which one is rendering them; deepest first because the decision a
   * player is making is "what is the hardest thing I can still beat".
   */
  tablets: ItemInstance[];
  /**
   * What each of those tablets means as a RUN, keyed by uid.
   *
   * Parallel to `tablets` rather than folded into it, because these are not properties
   * of the item - they are what the Abyss will do with it, and they need the account
   * seed to derive.
   */
  tabletRuns: Record<string, TabletView>;
  /**
   * The Abyss gate, stated rather than implied by an absent button.
   *
   * `unlocked` is false until floor 80 and the command refuses regardless - this is the
   * copy for a control that has to explain why it is disabled.
   */
  abyss: { unlocked: boolean; unlockStage: number; cap: number };
}

/**
 * What the Abyss will do with this tablet.
 *
 * Mirrors `resolveAbyssal`'s reading of it - same tier clamp, same wave count, same
 * rounding - so the card and the fight cannot disagree about what the player is about
 * to spend a consumable on.
 */
function describeRun(seed: number, tablet: ItemInstance): TabletView {
  const tier = Math.max(1, Math.round(tablet.itemLevel));
  const depth = abyssalDepth(tier);
  const danger = tabletDanger(tablet);
  return {
    uid: tablet.uid,
    tier,
    depth,
    waves: Math.ceil(wavesForTier(tier) * (1 + danger.waves)),
    danger: totalDanger(tablet),
    reward: tabletReward(tablet),
    ...dungeonAffinity(seed, depth),
  };
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
    pendingOfflineSeconds: offline.creditedSeconds,
    offlineCapReached: offline.elapsedSeconds > OFFLINE_CAP_SECONDS,
    loadout: save.loadout,
    equipSlots: equipSlots(save, ctx),
    weapon: save.weapon,
    dungeon:
      save.bestStage >= 1
        ? { stage: save.bestStage, ...dungeonAffinity(save.seed, save.bestStage) }
        : null,
    items: save.items,
    currency: save.currency,
    inventoryCap: INVENTORY_CAP,
    tablets: [...save.tablets].sort((a, b) => b.itemLevel - a.itemLevel),
    tabletRuns: Object.fromEntries(
      save.tablets.map((tablet) => [tablet.uid, describeRun(save.seed, tablet)]),
    ),
    abyss: {
      unlocked: save.bestStage >= ABYSS_UNLOCK_STAGE,
      unlockStage: ABYSS_UNLOCK_STAGE,
      cap: TABLET_CAP,
    },
  };
}
