/**
 * Effect interpreter + derived stats.
 *
 * One interpreter, N items — rather than N bespoke closures. Every item is data
 * that flows through here, so the balance harness can reason about the whole
 * item pool without executing arbitrary code.
 */

import type { Effect, ItemInstance } from './content';
import { UPGRADE_TRACKS } from './curves';
import { itemEffects } from './items';
import {
  BASE_STATS,
  STAT_KEYS,
  type EffectContext,
  type SaveState,
  type StatKey,
  type Stats,
  type UpgradeLevels,
} from './types';

export { BASE_STATS };

/** Which stat each upgrade track drives. */
const TRACK_STAT: Record<keyof UpgradeLevels, StatKey> = {
  damage: 'damage',
  attackSpeed: 'attackSpeed',
  health: 'maxHp',
  greed: 'goldFind',
  area: 'area',
  crit: 'critChance',
  toughness: 'toughness',
};

/** The three layers, accumulated per stat before anything is resolved. */
interface Layers {
  flat: number;
  increased: number;
  more: number;
}

type Buckets = Record<StatKey, Layers>;

function emptyBuckets(): Buckets {
  return Object.fromEntries(
    STAT_KEYS.map((key) => [key, { flat: 0, increased: 0, more: 1 }]),
  ) as Buckets;
}

/**
 * Growth rates live in UPGRADE_TRACKS, not here — the feedback exponent that
 * governs the whole economy is computed from those same numbers, and two copies
 * would drift.
 *
 * Upgrades fill the same buckets item effects do. That is the point of bucketing
 * rather than pre-multiplying a Stats: upgrades and items become commensurable,
 * so the power budget can compare an affix against a purchase instead of against
 * an already-collapsed number.
 */
function collectUpgrades(buckets: Buckets, levels: UpgradeLevels): void {
  for (const [key, track] of Object.entries(UPGRADE_TRACKS)) {
    const level = levels[key as keyof UpgradeLevels];
    if (level <= 0) continue;
    const layers = buckets[TRACK_STAT[key as keyof UpgradeLevels]];
    if (track.valueGrowth !== null) layers.more *= Math.pow(track.valueGrowth, level);
    else if (track.valueAdd !== null) layers.flat += track.valueAdd * level;
  }
}

function collectEffects(buckets: Buckets, effects: Effect[]): void {
  for (const e of effects) {
    if (e.kind !== 'statMod') continue;
    const layers = buckets[e.stat as StatKey];
    if (e.op === 'flat') layers.flat += e.value;
    else if (e.op === 'increased') layers.increased += e.value;
    else layers.more *= e.value;
  }
}

/**
 * Collapse the layers of one stat.
 *
 * `(base + flat) × (1 + increased) × more`. The sum in the middle is why the
 * common layers have diminishing returns and why a sixth affix row is now
 * affordable - see ModLayer in src/sim/content/schema.ts.
 */
function resolve(base: number, layers: Layers): number {
  return (base + layers.flat) * (1 + layers.increased) * layers.more;
}

function conditionHolds(effect: Effect, ctx: EffectContext): boolean {
  const when = effect.when;
  if (!when) return true;
  if (when.enemyHpBelow !== undefined && ctx.enemyHpFraction > when.enemyHpBelow) return false;
  if (when.isBoss !== undefined && ctx.isBoss !== when.isBoss) return false;
  if (when.stageAtLeast !== undefined && ctx.stage < when.stageAtLeast) return false;
  return true;
}

/** Find an owned item by uid. */
export function findItem(save: SaveState, uid: string): ItemInstance | undefined {
  return save.items.find((item) => item.uid === uid);
}

/** Effects from currently equipped items only — owned-but-unequipped do nothing. */
export function equippedEffects(save: SaveState): Effect[] {
  const out: Effect[] = [];
  for (const uid of save.loadout) {
    if (!uid) continue;
    const item = findItem(save, uid);
    if (!item) continue; // loadout referencing a discarded or migrated-away item
    out.push(...itemEffects(item));
  }
  return out;
}

/**
 * Derive final stats for a given combat context.
 *
 * Every contribution is bucketed by layer first and the layers resolve in a
 * fixed order, so ordering within the loadout never changes the result. That
 * property is what makes loadouts comparable, and it survived the move from
 * two passes to three.
 */
export function deriveStats(save: SaveState, ctx: EffectContext): Stats {
  const buckets = emptyBuckets();
  collectUpgrades(buckets, save.upgrades);
  collectEffects(
    buckets,
    equippedEffects(save).filter((e) => conditionHolds(e, ctx)),
  );

  const stats = { ...BASE_STATS };
  for (const key of STAT_KEYS) stats[key] = resolve(BASE_STATS[key], buckets[key]);

  stats.area = Math.max(1, stats.area);
  stats.critChance = Math.min(1, Math.max(0, stats.critChance));
  stats.maxHp = Math.max(1, stats.maxHp);
  stats.toughness = Math.max(0.1, stats.toughness);
  return stats;
}

/** Effective HP: what the incoming damage pool is actually measured against. */
export function effectiveHp(stats: Stats): number {
  return stats.maxHp * stats.toughness;
}

/** Extra gold per kill, as a fraction of the stage's base gold value. */
export function goldOnKillBonus(save: SaveState, ctx: EffectContext): number {
  return equippedEffects(save)
    .filter((e) => e.kind === 'goldOnKill' && conditionHolds(e, ctx))
    .reduce((sum, e) => sum + (e.kind === 'goldOnKill' ? e.multiplier : 0), 0);
}

/** Every distinct `enemyHpBelow` threshold in the loadout, plus the band edges. */
export function hpBands(save: SaveState): number[] {
  const thresholds = new Set<number>([1, 0]);
  for (const e of equippedEffects(save)) {
    if (e.when?.enemyHpBelow !== undefined) thresholds.add(e.when.enemyHpBelow);
  }
  return [...thresholds].sort((a, b) => b - a);
}

export function critFactor(stats: Stats): number {
  return 1 + stats.critChance * (stats.critMult - 1);
}

/**
 * Single-target damage per second implied by a stat block.
 *
 * The combat layer calls this too, so the character sheet cannot quote a DPS
 * the fight does not actually use.
 */
export function statsDps(stats: Stats): number {
  return stats.damage * stats.attackSpeed * critFactor(stats);
}
