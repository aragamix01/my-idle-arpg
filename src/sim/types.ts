/**
 * Core sim types.
 *
 * Everything in src/sim/ is pure TypeScript: no DOM, no Pixi, no React, no
 * Next. The same code runs in the browser (optimistic prediction) and in a
 * route handler (authoritative). The ESLint boundary rule enforces this.
 */

import { big, type Big } from './big';
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
  /**
   * Resource restored per second - stamina or mana, named by the equipped weapon.
   *
   * Sustained uses per second is `min(speed, regen / cost)`, so this is what decides
   * whether your attack speed is real. There is deliberately NO pool stat: the
   * combat layer works in expected values over a whole stage, where a pool only
   * governs burst and averages out to nothing. A stat that reads as a bonus and
   * changes no outcome is worse than no stat.
   */
  'resourceRegen',
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

/**
 * Which stats are magnitudes rather than rates, probabilities or counts.
 *
 * These two are the ones that outgrow a double, and for the same reason gold does:
 * every uncapped upgrade track is a `more` multiplier, so their value is a product
 * that compounds without bound. Damage additionally carries the weapon's skill-level
 * term, which is 1.05 per stage on its own.
 *
 * The rest stay doubles ON PURPOSE. Crit chance is clamped to 0..1, area is a target
 * count, toughness and gold find sit behind capped tracks. Attack speed and resource
 * regen are the two that could eventually overflow - 1.04 per level puts them past
 * 1.8e308 near **18,000 levels**, which the cost curve reaches only far beyond stage
 * 1e5. When that matters they move here; the number above is what makes it a data
 * change rather than another investigation.
 */
export const MAGNITUDE_STAT_KEYS = ['damage', 'maxHp'] as const;
export type MagnitudeStatKey = (typeof MAGNITUDE_STAT_KEYS)[number];

export type Stats = { [K in StatKey]: K extends MagnitudeStatKey ? Big : number };

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
  damage: big(60),
  attackSpeed: 1.5,
  area: 2,
  critChance: 0.05,
  critMult: 2.0,
  maxHp: big(100),
  /** A multiplier on effective HP, so its base is 1 and it has no flat layer. */
  toughness: 1.0,
  goldFind: 1.0,
  physicalSkillLevel: 0,
  magicalSkillLevel: 0,
  /**
   * Three per second, against Unarmed's cost of one and speed of 1.5.
   *
   * Sized so NO skill is resource-limited at base: the most expensive costs 3.3 against
   * a base speed of 0.9, and 3/3.3 clears it. The resource is a cap on the speed you
   * BUY, not a tax on standing still - a flat tax at level zero would just be one
   * playstyle being worse.
   * That is what keeps the migration power-neutral - a save that loads unarmed
   * derives exactly what it derived before resources existed.
   */
  resourceRegen: 3,
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
  /** Stamina and mana recovery. The purchasable way past the sustain cap. */
  'resource',
] as const;

export type UpgradeKey = (typeof UPGRADE_KEYS)[number];
export type UpgradeLevels = Record<UpgradeKey, number>;

/**
 * Item slots a character has before anything modifies the count.
 *
 * The BASE, not the total - see equipSlots() in stats.ts. It is also the window
 * within which an item is allowed to change the count at all, which is the rule that
 * keeps that calculation from running away.
 */
export const ITEM_SLOTS = 4;

/**
 * Hard ceiling on the loadout array, and therefore on what any item can grant.
 *
 * The array is this long in every save; positions past the live count hold items that
 * are simply inert. A fixed length is what makes the slot count a derived number
 * instead of a save migration every time a unique changes it.
 */
export const MAX_ITEM_SLOTS = 7;

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
  /**
   * Gold, as a decimal STRING.
   *
   * Not a number, and the reason is range rather than tidiness: a double dies at
   * 1.8e308 and stops being an exact integer at 2^53 (around stage 215), while this
   * ladder is meant to keep going. JSON numbers are doubles on the way back in and
   * Postgres `jsonb` would return 1e5000 as Infinity, so the wire format has to be a
   * string for the value to survive the round trip at all.
   *
   * Read it with `fromSave`, write it with `toSave` - see src/sim/big.ts.
   */
  gold: string;
  /**
   * Every gold ever earned, never spent down.
   *
   * Nothing reads it yet. It is here because prestige will be computed from lifetime
   * earnings rather than current balance, and a field added later starts at zero for
   * every existing player - which would mean everyone's first prestige is priced off
   * an empty history.
   */
  lifetimeGold: string;
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
