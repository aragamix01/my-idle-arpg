/**
 * Core sim types.
 *
 * Everything in src/sim/ is pure TypeScript: no DOM, no Pixi, no React, no
 * Next. The same code runs in the browser (optimistic prediction) and in a
 * route handler (authoritative). The ESLint boundary rule enforces this.
 */

import type { CurrencyPurse } from './content/currency';
import type { ItemInstance } from './content/schema';

export const STAT_KEYS = [
  'damage',
  'attackSpeed',
  'area',
  'critChance',
  'critMult',
  'maxHp',
  /**
   * Multiplier on effective HP, not a subtractive armour value.
   *
   * It is the defensive mirror of attackSpeed. Offence and defence must have
   * matching growth exponents or the faster side runs away - see
   * src/sim/README.md.
   */
  'toughness',
  'goldFind',
] as const;

export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Record<StatKey, number>;

export const UPGRADE_KEYS = [
  'damage',
  'attackSpeed',
  'area',
  'crit',
  'health',
  'toughness',
  'greed',
] as const;

export type UpgradeKey = (typeof UPGRADE_KEYS)[number];
export type UpgradeLevels = Record<UpgradeKey, number>;

/** Number of item slots the player can equip at once. */
export const ITEM_SLOTS = 4;

/**
 * Inventory size.
 *
 * Every clear drops one to three items, so without a cap the save blob grows
 * without bound - and it is read and written on every single command. At 100
 * items the blob is roughly 20KB, which is the reason this is not higher.
 *
 * A full inventory refuses new drops rather than discarding silently, because
 * deciding what to throw away is the interesting part.
 */
export const INVENTORY_CAP = 100;

/**
 * Authoritative player state. The server owns this; the client holds a cache
 * and applies commands optimistically.
 *
 * Ephemeral run state (entity positions, projectiles, current-run level-up
 * picks) is deliberately NOT here — it lives client-side and is never uploaded.
 */
export interface SaveState {
  /** Content registry version this save was last written under. */
  contentVersion: number;
  /** Root seed for all deterministic rolls on this account. */
  seed: number;
  gold: number;
  /** Highest stage index fully cleared. 0 = none. Farm rate is derived from this. */
  bestStage: number;
  /** Stage the player is currently attempting. */
  currentStage: number;
  upgrades: UpgradeLevels;
  /** Rolled item instances. Bounded by INVENTORY_CAP. */
  items: ItemInstance[];
  /**
   * Crafting currency counts.
   *
   * Sparse and unbounded. Unlike items, a currency is a number rather than an
   * object, so a hoarder costs the save blob a handful of integers.
   */
  currency: CurrencyPurse;
  /** Fixed-length; holds item uids. null = empty slot. */
  loadout: (string | null)[];
  /**
   * Monotonic source of item uids, and part of every item's roll seed.
   *
   * Never decremented - reusing a uid after a discard would make a new item
   * roll identically to the one it replaced.
   */
  nextItemId: number;
  /** Epoch ms of last server-acknowledged interaction. Server-owned. */
  lastSeenAt: number;
}

/** Context an effect condition is evaluated against. */
export interface EffectContext {
  stage: number;
  isBoss: boolean;
  /** Target HP as a fraction of its max, 0..1. */
  enemyHpFraction: number;
}

/** Result type for command application. Never throws on invalid input. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: string): Result<T> => ({ ok: false, error });
