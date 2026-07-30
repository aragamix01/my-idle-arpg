/**
 * Progression curves.
 *
 * The game IS these numbers. Everything else is a delivery mechanism.
 * Tune here, then run `pnpm balance` and read the diff on the golden file
 * (tests/__snapshots__/balance.golden.txt) before committing.
 */

import type { Rarity } from './content/schema';
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
 *
 * `min` is a *typical* floor, checked against the 5th percentile rather than
 * the single worst stage. That changed when items arrived: upgrades raise power
 * smoothly, but equipping a good drop is a step change that overshoots for a
 * few stages until enemy scaling catches up. One stage at 9.7s among 300 is the
 * system working; a hundred stages at 9.7s is not, and a worst-case assertion
 * cannot tell those apart.
 *
 * `absoluteFloor` is the collapse guard. Offence outrunning defence once drove
 * clear times to 0.04s, and no amount of lumpiness explains that.
 */
export const CLEAR_TIME_BAND_SECONDS = {
  min: 12,
  absoluteFloor: 3,
  max: STAGE_TIME_LIMIT_SECONDS,
} as const;

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

/** Levels still available on a track, or Infinity when uncapped. */
export function remainingLevels(key: UpgradeKey, level: number): number {
  const max = UPGRADE_TRACKS[key].maxLevel;
  return max === null ? Infinity : Math.max(0, max - level);
}

/**
 * Most levels a single bulk purchase may buy.
 *
 * Bounds the work an untrusted `count: 'max'` can ask the server to do. Late
 * game gold outruns cost growth badly enough that an unbounded max could ask
 * for tens of thousands of iterations per request.
 */
export const BULK_PURCHASE_LIMIT = 1000;

/**
 * Total cost of `count` consecutive levels starting from `level`.
 *
 * Summed level by level rather than by the geometric closed form, because
 * upgradeCost rounds each level up. Buying ten at once must cost exactly what
 * buying one ten times costs, or the bulk button becomes a discount.
 */
export function bulkUpgradeCost(key: UpgradeKey, level: number, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += upgradeCost(key, level + i);
  return total;
}

/** How many levels `gold` can buy, respecting the track cap and the bulk limit. */
export function maxAffordableUpgrades(key: UpgradeKey, level: number, gold: number): number {
  const ceiling = Math.min(remainingLevels(key, level), BULK_PURCHASE_LIMIT);
  let count = 0;
  let spent = 0;

  while (count < ceiling) {
    const next = spent + upgradeCost(key, level + count);
    if (next > gold) break;
    spent = next;
    count++;
  }
  return count;
}

// --- Items ----------------------------------------------------------------

/**
 * Items per stage clear, inclusive.
 *
 * Three times the old rate. The point is not raw power - the ceiling is set by
 * affix tiers, not by how many items you see - but throughput: a player needs
 * enough bases passing through their hands that picking one to craft is a
 * choice rather than a matter of using whatever dropped.
 */
export const DROPS_PER_CLEAR = { min: 1, max: 3 } as const;

/**
 * Fragments a stage boss drops, inclusive of zero.
 *
 * Ten fragments make one currency, so this averages 1.5 per clear - roughly a
 * currency every seven stages early on, before dungeons exist. Fragments are
 * the slow, guaranteed trickle; dungeons are the fast, gated source.
 */
export const FRAGMENTS_PER_CLEAR = { min: 0, max: 3 } as const;

/**
 * Chance a stage boss drops a dungeon key.
 *
 * One key per five clears. A dungeon is a single boss fight, so this is the
 * dial that decides how much of the loot economy runs through dungeons rather
 * than through the ladder itself.
 */
export const KEY_DROP_CHANCE = 0.2;

/**
 * Dungeon boss, as a multiple of the stage boss at the same stage.
 *
 * A dungeon has no trash phase, so the whole timer is spent on one target. HP
 * is therefore set against what a player kills a stage boss in, not against a
 * whole stage: at 2.5x the duel runs roughly two to three times a stage boss
 * fight and still lands inside STAGE_TIME_LIMIT_SECONDS.
 *
 * Incoming damage is the harder number. The stage boss phase is short and
 * follows a trash phase that has already worn the player down; a dungeon starts
 * at full health and lasts longer, so an unchanged DPS multiple would make
 * dungeons trivially safe. 1.5x keeps a dungeon a real risk without making it a
 * wall the moment a key drops.
 */
export const DUNGEON_BOSS_HP_MULT = 2.5;
export const DUNGEON_BOSS_DPS_MULT = 1.5;

/** Gold from a dungeon clear, as a multiple of the stage boss's lump sum. */
export const DUNGEON_GOLD_MULT = 3;

/** Currency a dungeon clear awards, inclusive. */
export const DUNGEON_CURRENCY_PER_CLEAR = { min: 1, max: 2 } as const;

/**
 * Gold to reroll an item's modifiers.
 *
 * Priced off `goldPerKill` at the item's own level, so a stage-80 item costs
 * what a stage-80 player earns rather than what a stage-1 player does. Rarity
 * multiplies because a rare has four affixes to reroll and is worth far more
 * when it lands well.
 *
 * The per-reroll escalation is the important term. Flat pricing would let a
 * player park on one item and grind it to perfect tiers for pocket change,
 * which turns a loot system into a slot machine with no cost.
 */
export function rerollCost(rarity: Rarity, itemLevel: number, rerolls: number): number {
  const rarityMultiplier: Record<Rarity, number> = {
    common: 1,
    magic: 2.5,
    rare: 6,
    // Uniques have no affixes to reroll; commands.ts refuses before reaching here.
    unique: Infinity,
  };
  const base = goldPerKill(Math.max(1, itemLevel)) * 30 * rarityMultiplier[rarity];
  return Math.ceil(base * Math.pow(1.35, rerolls));
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
