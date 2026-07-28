/**
 * Effect interpreter + derived stats.
 *
 * One interpreter, N items — rather than N bespoke closures. Every artifact is
 * data that flows through here, so the balance harness can reason about the
 * whole item pool without executing arbitrary code.
 */

import { getArtifact, type Effect } from './content';
import { UPGRADE_TRACKS } from './curves';
import type { EffectContext, SaveState, StatKey, Stats, UpgradeLevels } from './types';

/** Stats with zero upgrades and no artifacts. */
export const BASE_STATS: Stats = {
  damage: 6,
  attackSpeed: 1.5,
  area: 2,
  critChance: 0.05,
  critMult: 2.0,
  maxHp: 100,
  toughness: 1.0,
  goldFind: 1.0,
};

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

/**
 * Growth rates live in UPGRADE_TRACKS, not here — the feedback exponent that
 * governs the whole economy is computed from those same numbers, and two copies
 * would drift.
 */
function applyUpgrades(base: Stats, levels: UpgradeLevels): Stats {
  const s: Stats = { ...base };
  for (const [key, track] of Object.entries(UPGRADE_TRACKS)) {
    const level = levels[key as keyof UpgradeLevels];
    if (level <= 0) continue;
    const stat = TRACK_STAT[key as keyof UpgradeLevels];
    if (track.valueGrowth !== null) s[stat] *= Math.pow(track.valueGrowth, level);
    else if (track.valueAdd !== null) s[stat] += track.valueAdd * level;
  }
  return s;
}

function conditionHolds(effect: Effect, ctx: EffectContext): boolean {
  const when = effect.when;
  if (!when) return true;
  if (when.enemyHpBelow !== undefined && ctx.enemyHpFraction > when.enemyHpBelow) return false;
  if (when.isBoss !== undefined && ctx.isBoss !== when.isBoss) return false;
  if (when.stageAtLeast !== undefined && ctx.stage < when.stageAtLeast) return false;
  return true;
}

/** Effects from currently equipped artifacts only — owned-but-unequipped do nothing. */
export function equippedEffects(save: SaveState): Effect[] {
  const out: Effect[] = [];
  for (const id of save.loadout) {
    if (!id) continue;
    const artifact = getArtifact(id);
    if (!artifact) continue; // stale save referencing removed content
    out.push(...artifact.effects);
  }
  return out;
}

/**
 * Derive final stats for a given combat context.
 *
 * All `add` operations apply before all `mul`, so ordering within the loadout
 * never changes the result. That property is what makes loadouts comparable.
 */
export function deriveStats(save: SaveState, ctx: EffectContext): Stats {
  const stats = applyUpgrades(BASE_STATS, save.upgrades);
  const effects = equippedEffects(save).filter((e) => conditionHolds(e, ctx));

  for (const e of effects) {
    if (e.kind === 'statMod' && e.op === 'add') {
      stats[e.stat as StatKey] += e.value;
    }
  }
  for (const e of effects) {
    if (e.kind === 'statMod' && e.op === 'mul') {
      stats[e.stat as StatKey] *= e.value;
    }
  }

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
