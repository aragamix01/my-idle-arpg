/**
 * Progression curves.
 *
 * The game IS these numbers. Everything else is a delivery mechanism.
 * Tune here, then run `pnpm balance` and read the diff on the golden file
 * (tests/__snapshots__/balance.golden.txt) before committing.
 */

import type { UpgradeKey } from './types';

/** The tuned constants. Keep this list short — if it grows past ~12, the model is too loose. */
export const TUNING = {
  /** Trash HP at stage 1. */
  enemyHpBase: 12,
  /**
   * Per-stage multiplicative HP growth. The single most sensitive number here.
   * Must stay below the achievable damage growth per stage or the game walls
   * permanently — the harness is the only honest way to check that.
   */
  enemyHpGrowth: 1.12,
  /**
   * Trash contact DPS at stage 1.
   *
   * enemyDpsGrowth must equal enemyHpGrowth. Below it, the survival gate
   * loosens every stage while damage keeps compounding, so the player ends up
   * over-killing by orders of magnitude and stages resolve instantly - measured
   * at 1.10: 49s at stage 1 collapsing to 0.04s by stage 300. Equal growth
   * keeps relative difficulty constant, so both offence and defence stay
   * live purchases for the whole ladder.
   */
  enemyDpsBase: 0.45,
  enemyDpsGrowth: 1.12,
  /**
   * Gold per trash kill at stage 1.
   *
   * goldGrowth must track enemyHpGrowth closely. Above it, income per second
   * rises even at constant DPS and the whole curve runs away (measured: stage
   * 300 in 23 minutes at 1.16). Below it, income cannot fund the upgrades that
   * beat the HP curve and the game walls. Equal is the neutral choice, and
   * pacing is then governed by the upgrade cost curve alone.
   */
  goldBase: 1.0,
  goldGrowth: 1.12,
  /** Boss HP as a multiple of a trash enemy at the same stage. */
  bossHpMult: 18,
  /** Boss contact DPS as a multiple of trash. */
  bossDpsMult: 3.2,
} as const;

/**
 * A stage attempt that runs past this is a failure, even if the player survives.
 *
 * This is what pins clear time to a watchable band. A player pushes a stage the
 * moment they can beat it, so first-clear time sits just under the limit by
 * construction - provided the timer is tight enough to be the binding gate
 * rather than a formality. At 300s it was never binding and clear times decayed
 * toward zero.
 */
export const STAGE_TIME_LIMIT_SECONDS = 75;

/**
 * First-clear time should land in this band. Enforced by a test over sampled
 * stages, because "the fight is long enough to watch" is the entire reason the
 * cosmetic layer exists and it degrades silently.
 */
export const CLEAR_TIME_BAND_SECONDS = { min: 20, max: STAGE_TIME_LIMIT_SECONDS } as const;

/** Trash enemies that must die before the boss spawns. */
export function enemyCount(stage: number): number {
  return Math.min(40 + Math.floor(stage * 1.6), 220);
}

/** How many enemies are in contact range at once — caps incoming damage. */
export function contactCount(stage: number): number {
  return Math.min(3 + Math.floor(stage / 8), 12);
}

export function enemyHp(stage: number): number {
  return TUNING.enemyHpBase * Math.pow(TUNING.enemyHpGrowth, stage - 1);
}

export function bossHp(stage: number): number {
  return enemyHp(stage) * TUNING.bossHpMult;
}

export function enemyDps(stage: number): number {
  return TUNING.enemyDpsBase * Math.pow(TUNING.enemyDpsGrowth, stage - 1);
}

export function bossDps(stage: number): number {
  return enemyDps(stage) * TUNING.bossDpsMult;
}

export function goldPerKill(stage: number): number {
  return TUNING.goldBase * Math.pow(TUNING.goldGrowth, stage - 1);
}

/** Boss kill pays a lump sum on top of trash gold. */
export function bossGold(stage: number): number {
  return goldPerKill(stage) * 25;
}

/** Sparse hand overrides for stages that should feel like walls. */
const STAGE_OVERRIDES: Record<number, { hpMult?: number; goldMult?: number }> = {
  10: { hpMult: 1.25, goldMult: 1.4 },
  25: { hpMult: 1.35, goldMult: 1.5 },
  50: { hpMult: 1.45, goldMult: 1.6 },
  100: { hpMult: 1.6, goldMult: 2.0 },
};

export function stageOverride(stage: number) {
  return STAGE_OVERRIDES[stage] ?? {};
}

// --- Upgrades -------------------------------------------------------------

export interface UpgradeTrack {
  key: UpgradeKey;
  label: string;
  /** Cost of level 1. */
  baseCost: number;
  /** Multiplicative cost growth per level. */
  costGrowth: number;
  /**
   * Per-level stat multiplier, or null for additive tracks.
   *
   * The ratio ln(valueGrowth)/ln(costGrowth) is this track's exponent - see
   * feedbackExponent() and sideExponents() below. Those two numbers decide
   * whether the economy converges and whether fights stay watchable.
   */
  valueGrowth: number | null;
  /** Per-level flat increase, for additive tracks. */
  valueAdd: number | null;
  /** Hard cap, or null for uncapped. */
  maxLevel: number | null;
  /**
   * Whether this track raises gold income. Offensive and gold-find tracks do;
   * defensive tracks do not. Only income tracks close the feedback loop.
   */
  affectsIncome: boolean;
}

/**
 * Multiplicative tracks compound: power grows as gold^Σα, and gold accrues at a
 * rate proportional to power. That makes dG/dt ∝ G^Σα.
 *
 *   Σα > 1  → finite-time blowup. Measured: stage 300 reached in 37 minutes.
 *   Σα < 1  → gold grows polynomially, power logarithmically, stages pace out.
 *
 * Stage reached after time t is roughly
 *   s ≈ (Σα / (1 - Σα)) · ln(t) / ln(enemyHpGrowth)
 * so Σα is the master pacing dial. ~0.67 puts stage 300 near a year of play.
 *
 * The four uncapped multiplicative tracks pair off: damage/attackSpeed on
 * offence, health/toughness on defence, with matching exponents so neither side
 * outruns the other. Additive tracks (area, crit) are capped and fall out of the
 * loop entirely, which is exactly why they are the ones allowed to be capped.
 */
export const UPGRADE_TRACKS: Record<UpgradeKey, UpgradeTrack> = {
  damage: {
    key: 'damage', label: 'Damage',
    baseCost: 10, costGrowth: 1.213, valueGrowth: 1.07, valueAdd: null, maxLevel: null, affectsIncome: true,
  },
  attackSpeed: {
    key: 'attackSpeed', label: 'Attack Speed',
    baseCost: 25, costGrowth: 1.14, valueGrowth: 1.04, valueAdd: null, maxLevel: null, affectsIncome: true,
  },
  health: {
    key: 'health', label: 'Health',
    baseCost: 15, costGrowth: 1.181, valueGrowth: 1.06, valueAdd: null, maxLevel: null, affectsIncome: false,
  },
  greed: {
    key: 'greed', label: 'Greed',
    baseCost: 60, costGrowth: 1.20, valueGrowth: 1.04, valueAdd: null, maxLevel: 200, affectsIncome: true,
  },
  area: {
    key: 'area', label: 'Area',
    baseCost: 40, costGrowth: 1.55, valueGrowth: null, valueAdd: 0.25, maxLevel: 60, affectsIncome: true,
  },
  crit: {
    key: 'crit', label: 'Critical',
    baseCost: 30, costGrowth: 1.35, valueGrowth: null, valueAdd: 0.005, maxLevel: 100, affectsIncome: true,
  },
  toughness: {
    key: 'toughness', label: 'Toughness',
    baseCost: 35, costGrowth: 1.14, valueGrowth: 1.04, valueAdd: null, maxLevel: null, affectsIncome: false,
  },
};

/**
 * Σα over the uncapped tracks that feed the income loop.
 *
 * Only income-producing tracks close the loop: more damage means faster kills
 * means more gold means more damage. Defensive tracks consume gold without
 * raising income, so they do not contribute to runaway - which is why offence
 * and defence can each carry two multiplicative tracks while this stays below 1.
 */
export function feedbackExponent(): number {
  return Object.values(UPGRADE_TRACKS)
    .filter((t) => t.valueGrowth !== null && t.maxLevel === null && t.affectsIncome)
    .reduce((sum, t) => sum + Math.log(t.valueGrowth!) / Math.log(t.costGrowth), 0);
}

/**
 * Growth exponents of the offensive and defensive sides.
 *
 * These must stay close. Whichever side grows faster runs away from the other:
 * offence ahead means stages resolve instantly, defence ahead means the player
 * is unkillable and bored. Asserted in tests.
 */
export function sideExponents(): { offence: number; defence: number } {
  const alpha = (t: UpgradeTrack) => Math.log(t.valueGrowth!) / Math.log(t.costGrowth);
  const uncappedMultiplicative = Object.values(UPGRADE_TRACKS).filter(
    (t) => t.valueGrowth !== null && t.maxLevel === null,
  );
  return {
    offence: uncappedMultiplicative.filter((t) => t.affectsIncome).reduce((s, t) => s + alpha(t), 0),
    defence: uncappedMultiplicative
      .filter((t) => !t.affectsIncome)
      .reduce((s, t) => s + alpha(t), 0),
  };
}

/** Cost to go from `level` to `level + 1`. */
export function upgradeCost(key: UpgradeKey, level: number): number {
  const t = UPGRADE_TRACKS[key];
  return Math.ceil(t.baseCost * Math.pow(t.costGrowth, level));
}

export function isUpgradeMaxed(key: UpgradeKey, level: number): boolean {
  const max = UPGRADE_TRACKS[key].maxLevel;
  return max !== null && level >= max;
}

// --- Offline --------------------------------------------------------------

/** Offline farming pays this fraction of the online farm rate. */
export const OFFLINE_EFFICIENCY = 0.7;

/** Offline accrual stops after this long. Bring the player back. */
export const OFFLINE_CAP_SECONDS = 8 * 3600;

/**
 * Active play beats the default offline pick policy by this much.
 * This single number is the entire "why be present" reward. See Q17.
 */
export const ACTIVE_PLAY_BONUS = 1.2;
