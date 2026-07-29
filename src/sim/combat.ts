/**
 * Abstract combat layer — the authoritative one.
 *
 * This decides outcomes. The 60Hz Pixi layer visualises what this already
 * concluded; a bullet visually missing a bat changes nothing. That is what
 * makes offline and online the same game rather than two implementations that
 * drift apart.
 */

import {
  bossDps,
  bossGold,
  bossHp,
  contactCount,
  enemyCount,
  enemyDps,
  enemyHp,
  goldPerKill,
  stageOverride,
  STAGE_TIME_LIMIT_SECONDS,
} from './curves';
import { critFactor, deriveStats, effectiveHp, goldOnKillBonus, hpBands } from './stats';
import type { EffectContext, SaveState } from './types';

export interface StageOutcome {
  cleared: boolean;
  /** Why it failed, when it failed. */
  failure: 'none' | 'died' | 'timeout';
  /** Seconds of the attempt — up to the point of death/timeout. */
  seconds: number;
  goldEarned: number;
  trashPhaseSeconds: number;
  bossPhaseSeconds: number;
  /** Fraction of effective HP consumed. >1 means death. */
  damageTakenFraction: number;
  /**
   * The same figure split by phase, so a replay can drain a health bar at the
   * rate each phase actually inflicted rather than averaging across both. The
   * boss hits far harder per second, and a bar that ignores that lies about
   * where the run was lost.
   */
  trashDamageFraction: number;
  bossDamageFraction: number;
}

function ctxFor(stage: number, isBoss: boolean, hpFraction: number): EffectContext {
  return { stage, isBoss, enemyHpFraction: hpFraction };
}

/** Single-target damage per second in a given context. */
function singleTargetDps(save: SaveState, ctx: EffectContext): number {
  const s = deriveStats(save, ctx);
  return s.damage * s.attackSpeed * critFactor(s);
}

/**
 * Time to chew through a pool of HP, integrating across the loadout's
 * `enemyHpBelow` bands. An execute effect only applies to the bottom slice of
 * each enemy's health, and this is where that gets accounted for honestly.
 */
function timeToKill(
  save: SaveState,
  totalHp: number,
  stage: number,
  isBoss: boolean,
  aoeTargets: number,
): number {
  const bands = hpBands(save);
  let seconds = 0;
  for (let i = 0; i < bands.length - 1; i++) {
    const hi = bands[i];
    const lo = bands[i + 1];
    const slice = totalHp * (hi - lo);
    const dps = singleTargetDps(save, ctxFor(stage, isBoss, hi)) * aoeTargets;
    if (dps <= 0) return Infinity;
    seconds += slice / dps;
  }
  return seconds;
}

/** Gold from one trash kill, including artifact goldOnKill bonuses. */
function goldPerTrashKill(save: SaveState, stage: number): number {
  const ctx = ctxFor(stage, false, 1);
  const stats = deriveStats(save, ctx);
  const base = goldPerKill(stage) * (stageOverride(stage).goldMult ?? 1);
  return base * stats.goldFind * (1 + goldOnKillBonus(save, ctx));
}

/**
 * Resolve a full stage attempt: trash wave, then boss.
 *
 * Pure and closed-form — no per-tick loop — so the server can call it for many
 * stages inside a single invocation, and the balance harness can sweep 300
 * stages in milliseconds.
 */
export function resolveStage(save: SaveState, stage: number): StageOutcome {
  const hpMult = stageOverride(stage).hpMult ?? 1;
  const count = enemyCount(stage);
  const trashCtx = ctxFor(stage, false, 1);
  const stats = deriveStats(save, trashCtx);

  // Deliberately NOT floored. The abstract layer works in expected values, and
  // flooring makes a single +0.25 area level round to zero effect - which makes
  // the entire Area track unbuyable. The renderer floors for display only.
  const aoeTargets = Math.min(stats.area, count);
  const trashPoolHp = count * enemyHp(stage) * hpMult;
  const trashPhaseSeconds = timeToKill(save, trashPoolHp, stage, false, aoeTargets);

  const bossStats = deriveStats(save, ctxFor(stage, true, 1));
  const bossPhaseSeconds = timeToKill(save, bossHp(stage) * hpMult, stage, true, 1);

  const ehp = effectiveHp(stats);
  // A loadout can carry toughness conditional on boss fights, so the boss phase
  // is measured against its own effective HP, expressed as a scale on the pool.
  const bossIncomingScale = ehp / effectiveHp(bossStats);

  const trashIncoming = enemyDps(stage) * contactCount(stage);
  const bossIncoming = bossDps(stage) * bossIncomingScale;

  const damageDuringTrash = trashPhaseSeconds * trashIncoming;
  const damageDuringBoss = bossPhaseSeconds * bossIncoming;
  const totalDamage = damageDuringTrash + damageDuringBoss;
  const totalSeconds = trashPhaseSeconds + bossPhaseSeconds;

  const diedInTrash = damageDuringTrash >= ehp;
  const died = totalDamage >= ehp;
  const timedOut = totalSeconds > STAGE_TIME_LIMIT_SECONDS;

  if (died || timedOut) {
    // Partial credit: gold for whatever was killed before the run ended.
    const survivedSeconds = diedInTrash
      ? Math.min(trashPhaseSeconds, ehp / Math.max(trashIncoming, 1e-9))
      : trashPhaseSeconds;
    const cappedSeconds = Math.min(survivedSeconds, STAGE_TIME_LIMIT_SECONDS);
    const fractionOfTrash =
      trashPhaseSeconds > 0 ? Math.min(1, cappedSeconds / trashPhaseSeconds) : 0;
    return {
      cleared: false,
      failure: died && !diedInTrash && timedOut ? 'timeout' : died ? 'died' : 'timeout',
      seconds: cappedSeconds,
      goldEarned: count * fractionOfTrash * goldPerTrashKill(save, stage),
      trashPhaseSeconds,
      bossPhaseSeconds,
      damageTakenFraction: totalDamage / ehp,
      trashDamageFraction: damageDuringTrash / ehp,
      bossDamageFraction: damageDuringBoss / ehp,
    };
  }

  const bossCtx = ctxFor(stage, true, 1);
  const bossReward =
    bossGold(stage) *
    (stageOverride(stage).goldMult ?? 1) *
    bossStats.goldFind *
    (1 + goldOnKillBonus(save, bossCtx));

  return {
    cleared: true,
    failure: 'none',
    seconds: totalSeconds,
    goldEarned: count * goldPerTrashKill(save, stage) + bossReward,
    trashPhaseSeconds,
    bossPhaseSeconds,
    damageTakenFraction: totalDamage / ehp,
    trashDamageFraction: damageDuringTrash / ehp,
    bossDamageFraction: damageDuringBoss / ehp,
  };
}

/**
 * Steady-state farming income at a cleared stage, in gold per second.
 *
 * Farming skips the boss and never fails — the stage is already beaten. This is
 * the function the server uses for offline progress, which is why it takes no
 * elapsed time and no randomness.
 */
export function farmRate(save: SaveState, stage: number): number {
  if (stage < 1) return 0;
  return killsPerSecond(save, stage) * goldPerTrashKill(save, stage);
}

/**
 * Steady-state kills per second while farming.
 *
 * Exported because the renderer needs it: the cosmetic layer kills circles at
 * exactly this rate, which is what makes the spectacle honest rather than
 * decorative theatre running at its own invented speed.
 */
export function killsPerSecond(save: SaveState, stage: number): number {
  if (stage < 1) return 0;
  const ctx = ctxFor(stage, false, 1);
  const stats = deriveStats(save, ctx);
  const aoeTargets = Math.min(stats.area, enemyCount(stage));
  const hpMult = stageOverride(stage).hpMult ?? 1;

  const perEnemyHp = enemyHp(stage) * hpMult;
  const secondsPerWave = timeToKill(save, perEnemyHp * aoeTargets, stage, false, aoeTargets);
  if (!Number.isFinite(secondsPerWave) || secondsPerWave <= 0) return 0;

  return aoeTargets / secondsPerWave;
}
