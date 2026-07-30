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
  /**
   * Levels added to the equipped skill, by kind.
   *
   * Two stats rather than one, because a level only means something to a skill of
   * the matching kind - `+2 to Physical Skill Levels` does nothing for a Fireball,
   * and one shared stat would make every weapon want every skill-level roll.
   *
   * These raise the skill's BASE, which is a different position from any of the
   * three layers: base is what flat adds to and what increased and more multiply. So
   * a skill level competes with flat damage and compounds with everything else.
   */
  'physicalSkillLevel',
  'magicalSkillLevel',
] as const;

export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Record<StatKey, number>;

/**
 * Stats with zero upgrades and no items.
 *
 * Lives here rather than in stats.ts because items.ts needs it to normalise flat
 * modifiers against, and stats.ts already imports items.ts. Plain data with no
 * dependencies, so this is its natural home anyway.
 *
 * **Four of these are now overridden by the equipped skill** - damage, attackSpeed,
 * critChance and area. The values kept here are the Unarmed skill's, so they are
 * still what a save with an empty weapon slot derives, and they are still what a
 * flat modifier is normalised against.
 *
 * `damage` is 60 rather than 6 purely so flat damage rolls read as `+4.8` instead
 * of `+0.48`. It is a pure rescale: `TUNING.enemyHpBase` moved by the same factor,
 * so every clear time, every gold figure and the whole ladder are unchanged.
 */
export const BASE_STATS: Stats = {
  damage: 60,
  attackSpeed: 1.5,
  area: 2,
  critChance: 0.05,
  critMult: 2.0,
  maxHp: 100,
  /** A multiplier on effective HP, so its base is 1 and it has no flat layer. */
  toughness: 1.0,
  goldFind: 1.0,
  physicalSkillLevel: 0,
  magicalSkillLevel: 0,
};

/** The stats an equipped skill supplies the base for, instead of BASE_STATS. */
export const SKILL_BASE_STATS = ['damage', 'attackSpeed', 'critChance', 'area'] as const;

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
 * without bound - and it is read and written on every single command. At 200
 * items the blob is roughly 40KB, which is the real cost of this number and the
 * reason it is not simply unbounded.
 *
 * 200 rather than 100 because dissembling arrived: a full inventory is now a
 * pile of crafting material rather than a chore, and clearing it is one action
 * instead of a hundred. The cap exists to bound the save, not to force
 * housekeeping.
 *
 * A full inventory still refuses new drops rather than discarding silently.
 */
export const INVENTORY_CAP = 200;

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
   * The equipped weapon's uid, or null for unarmed.
   *
   * Its own field rather than a fifth `loadout` index. A fifth index would
   * reinterpret what every position in every existing save means, where a new field
   * is purely additive - `weapon` absent reads as null and the save still works.
   */
  weapon: string | null;
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
