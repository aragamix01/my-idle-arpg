/**
 * Abstract combat layer — the authoritative one.
 *
 * This decides outcomes. The 60Hz Pixi layer visualises what this already
 * concluded; a bullet visually missing a bat changes nothing. That is what
 * makes offline and online the same game rather than two implementations that
 * drift apart.
 */

import { bigMax, BIG_ZERO, type Big } from './big';
import {
  bossDps,
  bossGold,
  bossHp,
  contactCount,
  abyssalDepth,
  ABYSSAL_PROFILE,
  DELVE_WAVE_TIME_SHARE,
  DUNGEON_PROFILE,
  enemyCount,
  dungeonResistances,
  enemyDps,
  enemyHp,
  goldPerKill,
  stageOverride,
  stageResistances,
  STAGE_TIME_LIMIT_SECONDS,
  type DepthProfile,
  type Resistances,
} from './curves';
import { tabletDanger, wavesForTier, type DangerByAxis, type ItemInstance } from './content';
import {
  damageShares,
  deriveStats,
  effectiveHp,
  elementalScale,
  equippedGroups,
  goldOnKillBonus,
  hpBands,
  statsDps,
} from './stats';
import type { EffectContext, SaveState } from './types';

export interface StageOutcome {
  cleared: boolean;
  /** Why it failed, when it failed. */
  failure: 'none' | 'died' | 'timeout';
  /** Seconds of the attempt — up to the point of death/timeout. */
  seconds: number;
  /**
   * A Big, unlike every other field here.
   *
   * Seconds and fractions are ratios of astronomical quantities and stay small
   * forever - which is exactly why the magnitudes have to be Bigs: `poolHp / dps` is
   * only a normal number if both sides can be represented in the first place.
   */
  goldEarned: Big;
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

/**
 * Single-target damage per second against a given target, in a given context.
 *
 * Resistance is a property of the TARGET, so it belongs here rather than in
 * `statsDps` - the character sheet quotes what the loadout puts out, and this is what
 * a particular enemy takes. Against a target that resists nothing the two are equal,
 * which is what kept this change from moving any existing number by itself.
 *
 * The gear is walked once and both answers come out of that walk: the stat block and
 * the elemental shares need the same list of equipped effects.
 */
function singleTargetDps(save: SaveState, ctx: EffectContext, resist: Resistances): Big {
  const groups = equippedGroups(save, ctx);
  const stats = deriveStats(save, ctx, groups);
  const scale = elementalScale(damageShares(save, ctx, groups.flat()), stats.penetration, resist);
  return statsDps(stats).mul(scale);
}

/**
 * Time to chew through a pool of HP, integrating across the loadout's
 * `enemyHpBelow` bands. An execute effect only applies to the bottom slice of
 * each enemy's health, and this is where that gets accounted for honestly.
 */
function timeToKill(
  save: SaveState,
  totalHp: Big,
  stage: number,
  isBoss: boolean,
  aoeTargets: number,
  resist: Resistances,
): number {
  const bands = hpBands(save);
  let seconds = 0;
  for (let i = 0; i < bands.length - 1; i++) {
    const hi = bands[i];
    const lo = bands[i + 1];
    const slice = totalHp.mul(hi - lo);
    const dps = singleTargetDps(save, ctxFor(stage, isBoss, hi), resist).mul(aoeTargets);
    if (dps.lte(0)) return Infinity;
    // The division is where the magnitudes cancel: an HP pool of 1e400 over a DPS of
    // 1e398 is four seconds. Collapsed to a double here and never carried further,
    // because everything downstream of this is time.
    seconds += slice.div(dps).toNumber();
  }
  return seconds;
}

/** Gold from one trash kill, including artifact goldOnKill bonuses. */
function goldPerTrashKill(save: SaveState, stage: number): Big {
  const ctx = ctxFor(stage, false, 1);
  const stats = deriveStats(save, ctx);
  const base = goldPerKill(stage).mul(stageOverride(stage).goldMult ?? 1);
  return base.mul(stats.goldFind).mul(1 + goldOnKillBonus(save, ctx));
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
  // Uniform across elements on the ladder - see stageResistance. Trash and boss share
  // it, so a stage is one elemental problem rather than two.
  const resist = stageResistances(stage);
  const trashPoolHp = enemyHp(stage).mul(count).mul(hpMult);
  const trashPhaseSeconds = timeToKill(save, trashPoolHp, stage, false, aoeTargets, resist);

  const bossStats = deriveStats(save, ctxFor(stage, true, 1));
  const bossPhaseSeconds = timeToKill(save, bossHp(stage).mul(hpMult), stage, true, 1, resist);

  const ehp = effectiveHp(stats);
  // A loadout can carry toughness conditional on boss fights, so the boss phase
  // is measured against its own effective HP, expressed as a scale on the pool.
  const bossIncomingScale = ehp.div(effectiveHp(bossStats));

  const trashIncoming = enemyDps(stage).mul(contactCount(stage));
  const bossIncoming = bossDps(stage).mul(bossIncomingScale);

  const damageDuringTrash = trashIncoming.mul(trashPhaseSeconds);
  const damageDuringBoss = bossIncoming.mul(bossPhaseSeconds);
  const totalDamage = damageDuringTrash.add(damageDuringBoss);
  const totalSeconds = trashPhaseSeconds + bossPhaseSeconds;

  const diedInTrash = damageDuringTrash.gte(ehp);
  const died = totalDamage.gte(ehp);
  const timedOut = totalSeconds > STAGE_TIME_LIMIT_SECONDS;

  if (died || timedOut) {
    // Partial credit: gold for whatever was killed before the run ended.
    const survivedSeconds = diedInTrash
      ? Math.min(trashPhaseSeconds, ehp.div(bigMax(trashIncoming, 1e-9)).toNumber())
      : trashPhaseSeconds;
    const cappedSeconds = Math.min(survivedSeconds, STAGE_TIME_LIMIT_SECONDS);
    const fractionOfTrash =
      trashPhaseSeconds > 0 ? Math.min(1, cappedSeconds / trashPhaseSeconds) : 0;
    return {
      cleared: false,
      failure: died && !diedInTrash && timedOut ? 'timeout' : died ? 'died' : 'timeout',
      seconds: cappedSeconds,
      goldEarned: goldPerTrashKill(save, stage).mul(count).mul(fractionOfTrash),
      trashPhaseSeconds,
      bossPhaseSeconds,
      damageTakenFraction: totalDamage.div(ehp).toNumber(),
      trashDamageFraction: damageDuringTrash.div(ehp).toNumber(),
      bossDamageFraction: damageDuringBoss.div(ehp).toNumber(),
    };
  }

  const bossCtx = ctxFor(stage, true, 1);
  const bossReward = bossGold(stage)
    .mul(stageOverride(stage).goldMult ?? 1)
    .mul(bossStats.goldFind)
    .mul(1 + goldOnKillBonus(save, bossCtx));

  return {
    cleared: true,
    failure: 'none',
    seconds: totalSeconds,
    goldEarned: goldPerTrashKill(save, stage).mul(count).add(bossReward),
    trashPhaseSeconds,
    bossPhaseSeconds,
    damageTakenFraction: totalDamage.div(ehp).toNumber(),
    trashDamageFraction: damageDuringTrash.div(ehp).toNumber(),
    bossDamageFraction: damageDuringBoss.div(ehp).toNumber(),
  };
}

/**
 * Resolve a dungeon: one boss, no wave, no escape.
 *
 * Scaled off `bestStage` rather than a ladder of its own. A second progression
 * axis would be a second curve to balance and a second wall to test for, and
 * the interesting decision here is whether to spend the key - not which depth
 * to spend it at.
 *
 * Returns the same StageOutcome shape as resolveStage with `trashPhaseSeconds`
 * at zero, which is what lets the replay renderer handle both unchanged.
 */
export function resolveDungeon(save: SaveState, stage: number): StageOutcome {
  return resolveDelve(save, stage, DUNGEON_PROFILE, NO_DANGER, 0);
}

/** A run with no tablet shaping it. A dungeon is exactly this. */
const NO_DANGER: DangerByAxis = { hp: 0, damage: 0, count: 0, waves: 0 };

/**
 * An Abyssal run: waves, then the boss.
 *
 * Indexed on the TABLET, never on bestStage - the tier decides the depth, so two players
 * running a T7 fight the same thing. The tablet's modifiers raise the danger on four
 * separate axes, and the same modifiers raise what it pays, which is applied where the
 * rewards are granted rather than here.
 */
export function resolveAbyssal(save: SaveState, tablet: ItemInstance): StageOutcome {
  const danger = tabletDanger(tablet);
  const tier = Math.max(1, Math.round(tablet.itemLevel));
  // Rounded UP, so a tablet advertising more waves always delivers at least one more.
  const waves = Math.ceil(wavesForTier(tier) * (1 + danger.waves));
  return resolveDelve(save, abyssalDepth(tier), ABYSSAL_PROFILE, danger, waves);
}

/**
 * A delve: some number of waves, then one boss, and no escape.
 *
 * Was resolveDungeon's whole body. A dungeon and an Abyssal are the same fight with
 * different numbers - a dungeon simply runs zero waves.
 *
 * ## Health carries across every wave
 *
 * There is one `effectiveHp` for the entire run and nothing refills it. That is what
 * "limited HP inside; at zero you leave with nothing" means, and it is why the `waves`
 * modifier axis is dangerous rather than merely slow: another wave is another slice off
 * a pool that is already down.
 *
 * ## The wave loop is not a tick loop
 *
 * It runs once per WAVE - at most a couple of dozen - not once per frame or per second.
 * The closed-form property that lets the server resolve offline progress and lets the
 * harness sweep 300 stages in milliseconds is about there being no simulation step, and
 * a bounded sum over waves is still a formula. Do not read this as permission to add a
 * per-tick loop anywhere.
 *
 * Returns the same StageOutcome shape as resolveStage, which is what lets the replay
 * renderer handle every kind of run unchanged.
 */
function resolveDelve(
  save: SaveState,
  stage: number,
  profile: DepthProfile,
  /** Extra difficulty from a tablet's modifiers. All zero for a dungeon. */
  danger: DangerByAxis,
  /** Waves before the boss. Zero for a dungeon, which is a duel and nothing else. */
  waves: number,
): StageOutcome {
  const bossCtx = ctxFor(stage, true, 1);
  const bossStats = deriveStats(save, bossCtx);
  const trashCtx = ctxFor(stage, false, 1);
  const stats = deriveStats(save, trashCtx);

  // Where elements actually bite. The affinity is derived from the account seed and the
  // stage, so it is the same every time and can be shown before the tablet is spent.
  const resist = dungeonResistances(save.seed, stage, profile.affinity);
  const ehp = effectiveHp(stats);

  /*
    --- The waves -------------------------------------------------------------

    The profile's multipliers are BOSS multipliers and are deliberately not applied here.
    Measured, because the first cut did apply them: hpMult of 3 turned one wave at depth
    80 into 86 seconds of trash against 18 for the boss, and the incoming damage over
    that stretch killed a character who clears the same floor in 35. A delve boss is
    beefier than a stage boss; a delve's trash is just trash at that depth, and the depth
    is already the difficulty.

    The tablet's own modifiers DO apply, because that is what a player bought.
  */
  const count = enemyCount(stage) * (1 + danger.count);
  const aoeTargets = Math.min(stats.area, count);
  const wavePoolHp = enemyHp(stage).mul(count).mul(1 + danger.hp);
  const perWaveSeconds =
    waves > 0 ? timeToKill(save, wavePoolHp, stage, false, aoeTargets, resist) : 0;
  const waveIncoming = enemyDps(stage)
    .mul(contactCount(stage))
    .mul(1 + danger.damage);

  const trashPhaseSeconds = perWaveSeconds * waves;
  const damageDuringTrash = waveIncoming.mul(trashPhaseSeconds);

  // --- The boss ----------------------------------------------------------
  const hp = bossHp(stage).mul(profile.hpMult).mul(1 + danger.hp);
  const bossPhaseSeconds = timeToKill(save, hp, stage, true, 1, resist);
  // A loadout can carry toughness conditional on boss fights, so the boss phase is
  // measured against its own effective HP, expressed as a scale on the pool.
  const bossIncoming = bossDps(stage)
    .mul(profile.dpsMult)
    .mul(1 + danger.damage)
    .mul(ehp.div(effectiveHp(bossStats)));
  const damageDuringBoss = bossIncoming.mul(bossPhaseSeconds);

  const totalDamage = damageDuringTrash.add(damageDuringBoss);
  const totalSeconds = trashPhaseSeconds + bossPhaseSeconds;
  const limit = delveTimeLimit(waves);

  const outcome = {
    trashPhaseSeconds,
    bossPhaseSeconds,
    damageTakenFraction: totalDamage.div(ehp).toNumber(),
    trashDamageFraction: damageDuringTrash.div(ehp).toNumber(),
    bossDamageFraction: damageDuringBoss.div(ehp).toNumber(),
  };

  const diedInWaves = damageDuringTrash.gte(ehp);
  const died = totalDamage.gte(ehp);

  if (died || totalSeconds > limit) {
    // No partial credit, whether you fell in the third wave or on the boss. A delve pays
    // on the clear or not at all - that is what makes spending the key, or the tablet, a
    // decision rather than a formality.
    const survived = diedInWaves
      ? Math.min(trashPhaseSeconds, ehp.div(bigMax(waveIncoming, 1e-9)).toNumber())
      : died
        ? trashPhaseSeconds +
          Math.min(
            bossPhaseSeconds,
            ehp.sub(damageDuringTrash).div(bigMax(bossIncoming, 1e-9)).toNumber(),
          )
        : totalSeconds;
    const capped = Math.min(survived, limit);
    return {
      ...outcome,
      cleared: false,
      failure: died ? 'died' : 'timeout',
      seconds: capped,
      goldEarned: BIG_ZERO,
      // Truncated to what was actually survived, so the replay stops where the run did.
      trashPhaseSeconds: Math.min(trashPhaseSeconds, capped),
      bossPhaseSeconds: Math.max(0, capped - Math.min(trashPhaseSeconds, capped)),
    };
  }

  return {
    ...outcome,
    cleared: true,
    failure: 'none',
    seconds: totalSeconds,
    goldEarned: bossGold(stage)
      .mul(profile.goldMult)
      .mul(bossStats.goldFind)
      .mul(1 + goldOnKillBonus(save, bossCtx))
      // The waves pay too, at the depth they were fought - otherwise a long run is pure
      // exposure for a boss-sized reward and adding waves is strictly a punishment.
      .add(goldPerTrashKill(save, stage).mul(count).mul(waves).mul(profile.goldMult)),
  };
}

/**
 * How long a delve may run before it fails on the clock.
 *
 * STAGE_TIME_LIMIT_SECONDS is 75 for ONE wave and one boss. A run with eight waves
 * against that limit would fail on arithmetic rather than on difficulty, so the budget
 * grows with the wave count - the boss keeps the full stage allowance and each wave adds
 * its own share.
 *
 * Sub-linear in neither direction on purpose: it is exactly proportional, so the timer
 * stays as binding on a deep tablet as it is on a shallow one. A generous per-wave
 * budget would quietly retire the timeout as a failure mode for exactly the runs where
 * it should bite hardest.
 */
export function delveTimeLimit(waves: number): number {
  return STAGE_TIME_LIMIT_SECONDS * (1 + Math.max(0, waves) * DELVE_WAVE_TIME_SHARE);
}

/**
 * Steady-state farming income at a cleared stage, in gold per second.
 *
 * Farming skips the boss and never fails — the stage is already beaten. This is
 * the function the server uses for offline progress, which is why it takes no
 * elapsed time and no randomness.
 */
export function farmRate(save: SaveState, stage: number): Big {
  if (stage < 1) return BIG_ZERO;
  return goldPerTrashKill(save, stage).mul(killsPerSecond(save, stage));
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

  const perEnemyHp = enemyHp(stage).mul(hpMult);
  const secondsPerWave = timeToKill(
    save,
    perEnemyHp.mul(aoeTargets),
    stage,
    false,
    aoeTargets,
    stageResistances(stage),
  );
  if (!Number.isFinite(secondsPerWave) || secondsPerWave <= 0) return 0;

  return aoeTargets / secondsPerWave;
}
