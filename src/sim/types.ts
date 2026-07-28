/**
 * Core sim types.
 *
 * Everything in src/sim/ is pure TypeScript: no DOM, no Pixi, no React, no
 * Next. The same code runs in the browser (optimistic prediction) and in a
 * route handler (authoritative). The ESLint boundary rule enforces this.
 */

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

/** Number of artifact slots the player can equip at once. */
export const ARTIFACT_SLOTS = 4;

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
  artifactsOwned: string[];
  /** Fixed-length; null = empty slot. */
  loadout: (string | null)[];
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
