/**
 * Progression curves.
 *
 * The game IS these numbers. Everything else is a delivery mechanism.
 * Tune here, then run `pnpm balance` and read the diff on the golden file
 * (tests/__snapshots__/balance.golden.txt) before committing.
 */

import { big, BIG_ZERO, type Big } from './big';
import { ELEMENTS, type Element, type ModLayer, type Rarity } from './content/schema';
import { createRng } from './rng';
import { ABYSS_UNLOCK_STAGE, type UpgradeKey } from './types';

/** The tuned constants. Keep this list short — if it grows past ~12, the model is too loose. */
export const TUNING = {
  /**
   * Trash HP at stage 1.
   *
   * Moved from 12 to 120 alongside BASE_STATS.damage moving from 6 to 60. Only
   * the ratio of the two matters to any outcome, so this pair is a rescale and
   * nothing else - it exists so flat damage affixes are readable numbers.
   */
  enemyHpBase: 132,
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
 * What each wave of a delve adds to that limit, as a share of it.
 *
 * A delve's waves are the same fight a stage's are, so a wave is worth about what a
 * stage's whole trash phase is worth against the full budget - roughly two thirds - and
 * this is deliberately tighter than that. The timer has to stay a live failure mode on a
 * deep tablet, and a per-wave budget generous enough to be comfortable would retire it
 * for exactly the runs where it should bite hardest.
 */
export const DELVE_WAVE_TIME_SHARE = 0.5;

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

/**
 * The four curves that grow exponentially in stage, and therefore have to be Bigs.
 *
 * `1.12^stage` passes 1.8e308 near **stage 6,100**. As doubles these returned
 * Infinity from there on, and Infinity in enemyHp means NaN clear times, NaN gold and
 * a game that stops working at a stage number nobody chose. Their RATIOS - clear
 * time, damage fractions - stay ordinary numbers, which is what makes this work.
 */
export function enemyHp(stage: number): Big {
  return big(TUNING.enemyHpBase).mul(big(TUNING.enemyHpGrowth).pow(stage - 1));
}

export function bossHp(stage: number): Big {
  return enemyHp(stage).mul(TUNING.bossHpMult);
}

export function enemyDps(stage: number): Big {
  return big(TUNING.enemyDpsBase).mul(big(TUNING.enemyDpsGrowth).pow(stage - 1));
}

export function bossDps(stage: number): Big {
  return enemyDps(stage).mul(TUNING.bossDpsMult);
}

export function goldPerKill(stage: number): Big {
  return big(TUNING.goldBase).mul(big(TUNING.goldGrowth).pow(stage - 1));
}

/** Boss kill pays a lump sum on top of trash gold. */
export function bossGold(stage: number): Big {
  return goldPerKill(stage).mul(25);
}

/**
 * Why flat modifiers need no item-level scaling.
 *
 * A flat roll lands *inside* the multiplicative envelope: `(base + flat) × more`,
 * where `more` carries the exponential upgrade tracks. So a flat modifier is
 * amplified by every damage upgrade the player ever buys and stays worth the same
 * *fraction* of their power forever, with no pegging and no ten-digit numbers on
 * item tooltips.
 *
 * That only holds while the uncapped upgrade tracks stay in the `more` layer -
 * see trackLayer(). If they ever move to `increased`, flat tables go dead within
 * twenty stages and would have to be pegged to a reference curve instead.
 *
 * Flat and increased are still genuinely different purchases, because they
 * multiply each other: a flat roll is worth more to a player carrying a lot of
 * `increased`, and vice versa. That is the tension the two layers exist for.
 */

/**
 * What one skill level multiplies the skill's base damage by.
 *
 * Skill level comes from the weapon's item level, so this number decides how much of
 * the ladder the WEAPON carries rather than the gold upgrade tracks. That is the
 * expensive decision in this release:
 *
 *   enemy HP grows      enemyHpGrowth        per stage  = 1.12
 *   a weapon grows      SKILL_LEVEL_GAIN     per stage  (item level rises 1 per stage)
 *
 * At 1.06 a weapon carries ln(1.06)/ln(1.12) = about **half** the exponent, which
 * makes it the single largest source of a player's power. The offensive gold tracks
 * are slowed to carry the other half - see their costGrowth values, which is why
 * they no longer match the defensive ones.
 *
 * ## Why half and not two thirds
 *
 * Two thirds was the target and it does not fit. Measured, in order:
 *
 *   weapons at 1.0765, gold untouched   -> stage 300 in 16 MINUTES, 0.0s clears
 *   weapons at 1.0765, gold slowed 65%  -> WALL at stage 117
 *   weapons at 1.06,   gold slowed 51%  -> holds: 15-56s clears, no wall, ~21h
 *
 * The squeeze is that the gold tracks are both the power source AND the income
 * driver: dG/dt is proportional to power, so slowing them to make room for the
 * weapon term starves the economy that funds everything, defence included. There is
 * a ceiling on how much of the ladder can move off gold without the loop stalling,
 * and it sits near half. Raising this number again means finding power for defence
 * somewhere other than gold - gear item level scaling effective HP the way weapon
 * item level scales damage would be the symmetric answer.
 *
 * The consequence to keep in mind is that a stale weapon now hurts, and no
 * parametrisation avoids it - falling behind costs SKILL_LEVEL_GAIN per stage
 * whatever units the level is counted in. An earlier draft claimed counting levels
 * as itemLevel/2 would soften it; that is wrong, because the per-stage rate is what
 * matters and halving the units halves nothing. The real mitigation is drop
 * frequency: see WEAPON_DROP_SHARE.
 */
export const SKILL_LEVEL_GAIN = 1.05;

/**
 * Share of item drops that are weapons.
 *
 * This is the mitigation for the paragraph above, and it is the whole of it. Since a
 * weapon carries most of the ladder, a player holding a stale one falls behind at
 * SKILL_LEVEL_GAIN per stage, so the fix has to be that they are rarely holding a
 * stale one. At one in five, and one to three drops per clear, a fresh weapon arrives
 * roughly every other clear - never more than a couple of stages behind.
 *
 * The consequence is deliberate: a weapon's item level stops being the chase and its
 * ROLLS become the chase. Finding a weapon is routine; finding a rare one with three
 * good prefixes is not.
 */
export const WEAPON_DROP_SHARE = 0.2;

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

// --- Resistance -----------------------------------------------------------

/**
 * What resistance approaches at infinite depth, and never reaches.
 *
 * An ASYMPTOTE rather than a cliff, and that is the whole safety argument. Resistance
 * is a multiplier on effective HP, so a bounded one shifts the ladder by a constant and
 * cannot touch the exponent. A resistance that grew without limit would be a second HP
 * curve racing enemyHpGrowth, and one of them would win.
 *
 * ## 0.25, and why not 0.4
 *
 * A constant on effective HP is not a constant on ELAPSED TIME, because the tracks it
 * slows are also the tracks that earn the gold. Measured on the harness seed, against
 * a 7.8d baseline:
 *
 *   cap 0.4   ->  16.0d     clear times fine, no wall, and twice the ladder
 *   cap 0.25  ->   9.2d     the same ladder, 1.2x slower
 *
 * Both are survivable and only one of them is a scaling axis. Doubling the game was
 * not what elements were for, and the difference is the feedback exponent amplifying
 * a 1.4x damage tax into a 2x time tax - Σα < 1 bounds runaway, it does not bound
 * this direction.
 *
 * The remaining 1.2x is deliberate and is what the penetration and extra-element
 * content is priced against: a built character should come out roughly where they
 * were, an unbuilt one slightly behind. That is the point at which the tax becomes
 * a purchase.
 */
export const RESISTANCE_CAP = 0.25;

/** Depth at which ladder resistance reaches half its cap. */
const RESISTANCE_HALF_STAGE = 120;

/**
 * Ladder resistance at a given depth. UNIFORM ACROSS ELEMENTS, on purpose.
 *
 * Elements on the ladder are a scaling axis, not a puzzle. A per-element ladder
 * affinity would mean the correct weapon for stage 140 is a fact you look up, and
 * being wrong about it is a wall - in the one part of the game that has to stay
 * clearable by whatever dropped. Uniform still keeps penetration a live purchase,
 * which a flat zero would not.
 *
 * Where elements are meant to matter is dungeons, and later the Abyssal content:
 * places where spending a key is already a deliberate act. See dungeonResistances.
 */
export function stageResistance(stage: number): number {
  return (RESISTANCE_CAP * Math.max(0, stage)) / (Math.max(0, stage) + RESISTANCE_HALF_STAGE);
}

export type Resistances = Record<Element, number>;

export function uniformResistances(value: number): Resistances {
  return Object.fromEntries(ELEMENTS.map((e) => [e, value])) as Resistances;
}

export function stageResistances(stage: number): Resistances {
  return uniformResistances(stageResistance(stage));
}

/**
 * How far a dungeon's two named elements sit from its baseline.
 *
 * Symmetric, so the average dungeon is exactly as hard as the ladder at that depth and
 * the affinity is a decision rather than a tax. The vulnerable element goes NEGATIVE
 * at shallow depths, which is deliberate: a negative resistance is bonus damage, and
 * "this one is weak to cold" has to be worth acting on or the affinity is just a
 * penalty wearing two labels.
 */
export const DUNGEON_AFFINITY = 0.35;

/** Arbitrary large odd multiplier, so affinity never shares a stream with a drop roll. */
const AFFINITY_STREAM = 0x7feb_352d;

/**
 * Which element a dungeon at this depth resists, and which it is weak to.
 *
 * Derived from the account seed and the stage, so it is deterministic and can be shown
 * BEFORE the key is spent. A dungeon whose affinity is only discovered by entering it
 * would make the key a coin flip rather than a decision.
 */
export function dungeonAffinity(seed: number, stage: number): { resists: Element; weakTo: Element } {
  const rng = createRng(seed).fork(stage * AFFINITY_STREAM);
  const i = rng.int(ELEMENTS.length);
  // Drawn from the remaining members rather than rerolled until distinct, so the two
  // are never the same element and the stream advances a fixed number of times.
  let j = rng.int(ELEMENTS.length - 1);
  if (j >= i) j++;
  return { resists: ELEMENTS[i], weakTo: ELEMENTS[j] };
}

export function dungeonResistances(
  seed: number,
  stage: number,
  /** How far the two named elements sit from the baseline. The Abyss passes its own. */
  affinity = DUNGEON_AFFINITY,
): Resistances {
  const base = stageResistance(stage);
  const { resists, weakTo } = dungeonAffinity(seed, stage);
  const out = uniformResistances(base);
  out[resists] = base + affinity;
  out[weakTo] = base - affinity;
  return out;
}

/**
 * What separates one kind of boss-only run from another.
 *
 * A profile rather than a second resolve function, because a dungeon and an Abyssal are
 * the same fight with different numbers: one boss, no wave, no partial credit. Two
 * near-identical resolvers would be two places for the closed-form property to break.
 *
 * Declared here beside the affinity it carries; the concrete profiles live further down
 * with the dungeon constants they are built from.
 */
export interface DepthProfile {
  hpMult: number;
  dpsMult: number;
  goldMult: number;
  affinity: number;
}

/**
 * The Abyss.
 *
 * ## Why the affinity is 0.55 and not 0.70
 *
 * Resistance multiplies effective HP, and the two sides are NOT symmetric because the
 * clamps are not. At an Abyssal depth with a ladder base near 0.18:
 *
 *   resisted     0.73                 your damage x0.27
 *   vulnerable   clamped at -0.50     your damage x1.50
 *
 * So the penalty for bringing the wrong element far exceeds the reward for bringing the
 * right one - that is MAX_VULNERABILITY doing its job. 0.70 was rejected because it puts
 * the resisted case at x0.12, which against a tier-scaled boss is a timeout, which is
 * "impossible" wearing a different word.
 *
 * The answer to a bad match-up is a different weapon, since the skill carries the
 * element. Conversion is NOT an answer at current magnitudes - extra-element rolls are
 * 1.2-3.3%, nothing against x0.27 - and making it one means growing those values, which
 * is a separate decision.
 */
export const ABYSSAL_PROFILE: DepthProfile = {
  /**
   * Just above a dungeon's 2.5, and MEASURED rather than chosen.
   *
   * The first cut paired 6 with a depth curve that started a tier too high, which put a
   * T1 at 23x a stage-80 boss - nine times a dungeon, for the first tablet a player can
   * possibly hold. It timed out against a character who cleared floor 80 in 34s and the
   * dungeon there in 15s. A mode whose entry fight is unwinnable is not a hard mode.
   */
  hpMult: 3,
  dpsMult: 1.8,
  goldMult: 5,
  affinity: 0.55,
};

/**
 * The ladder depth a tablet tier fights at.
 *
 * The Abyss indexes on TIER and never on bestStage, which is the point: a tier is a
 * difficulty you hold in your hand rather than one your progress hands you. Two players
 * running a T7 fight the same thing.
 *
 * It reuses the ladder's own curves rather than inventing a second exponential - one
 * curve family, one set of growth constants to keep honest. T1 lands just past the
 * unlock floor and T15 well beyond where most players are when they first hold one.
 */
export function abyssalDepth(tier: number): number {
  // T1 sits AT the unlock floor, not a tier past it. The `tier * 12` version put the
  // cheapest tablet twelve stages deep, and twelve stages is 1.12^12 - very nearly four
  // times the boss HP - before the profile multiplier had even been applied.
  return ABYSS_UNLOCK_STAGE + (Math.max(1, tier) - 1) * 12;
}

/**
 * Bounds on effective resistance after penetration.
 *
 * The ceiling stops a target ever being immune - a fight nothing you own can win is
 * not difficulty, it is a locked door. The floor stops a vulnerability compounding
 * into an instant kill: at -0.5 the best possible match-up is 1.5x damage, which is
 * worth building for and is not a different game.
 */
export const MAX_RESISTANCE = 0.9;
export const MAX_VULNERABILITY = 0.5;

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
    baseCost: 10, costGrowth: 1.405, valueGrowth: 1.07, valueAdd: null, maxLevel: null, affectsIncome: true,
  },
  attackSpeed: {
    key: 'attackSpeed', label: 'Attack Speed',
    baseCost: 25, costGrowth: 1.26, valueGrowth: 1.04, valueAdd: null, maxLevel: null, affectsIncome: true,
  },
  /**
   * The defensive tracks are NOT slowed to match the offensive ones, and that is
   * deliberate rather than an oversight.
   *
   * Skill level scales damage and nothing else, so a weapon carries two thirds of the
   * offensive exponent and none of the defensive one. Matching the TOTALS therefore
   * requires unmatched TRACKS: offence needs only the last third from gold, defence
   * needs all of it. Slowing both by the same factor is what the first attempt did,
   * and it produced 0.3s clear times against a player who was dying anyway - offence
   * outrunning defence for a fourth time, by a fourth route.
   *
   * Note this makes sideExponents() measure the wrong thing on its own: it compares
   * track exponents, and the weapon term now sits outside the track system entirely.
   */
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
  /**
   * The release valve on the resource cap, and it has to exist.
   *
   * Stamina and mana cap attack speed at `regen / cost`, which is the point - it is
   * the soft cap attack speed otherwise lacks. But a cap whose only escape is a rare
   * affix is not a cap, it is a wall: the harness hit one at stage 44, buying attack
   * speed that bought nothing while the regen rolls it needed never dropped.
   *
   * Gold buying the sustain that unlocks the speed you already own is the decision
   * this was supposed to create.
   *
   * It MIRRORS ATTACK SPEED exactly - same growth, same cost curve, uncapped - and
   * that is forced rather than tidy. A capped flat track cannot keep pace with an
   * uncapped multiplicative one: regen would rise by a fixed total while speed
   * compounded, so the cap would bite eventually and then permanently, wherever the
   * cap was set. Measured as a wall at stage 128 with a capped version. Matching the
   * shapes makes the ratio something the player manages rather than something that
   * runs out.
   *
   * The practical effect is that attack speed now costs roughly double: you buy the
   * speed, then you buy the sustain that makes it real.
   */
  resource: {
    key: 'resource', label: 'Recovery',
    baseCost: 30, costGrowth: 1.31, valueGrowth: 1.04, valueAdd: null, maxLevel: null, affectsIncome: true,
  },
};

/**
 * Which layer a track's levels land in.
 *
 * Derived rather than declared. A `layer` field beside `valueGrowth`/`valueAdd`
 * would be a second copy of the same fact and would drift the first time a track
 * was retuned from additive to multiplicative.
 *
 * Note what this says: **every uncapped track is `more`.** That is not an
 * oversight, it is the only arrangement that works. Enemy HP grows
 * exponentially in stage, so the player's engine has to be exponential too;
 * `increased` sums linearly in levels bought and levels grow like log(gold), so
 * an economy driven by `increased` purchases walls permanently at any growth
 * rate above 1. Compounding is safe *here* because Σα < 1 bounds it - see
 * feedbackExponent(). It was never safe on item modifiers, which have no such
 * bound and no cost curve, and that is the split this layer system draws.
 */
export function trackLayer(track: UpgradeTrack): ModLayer {
  return track.valueGrowth !== null ? 'more' : 'flat';
}

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

/**
 * Cost to go from `level` to `level + 1`.
 *
 * A Big, because `costGrowth^level` is exactly the shape that outruns a double: at
 * 1.405 per level the damage track passes 1e308 near level 2,100, which the ladder
 * reaches long before it runs out of stages.
 *
 * Still rounded up per level. The rounding is invisible once the exponent is large,
 * but it is what makes buying ten at once cost exactly what buying one ten times
 * costs - see bulkUpgradeCost.
 */
export function upgradeCost(key: UpgradeKey, level: number): Big {
  const t = UPGRADE_TRACKS[key];
  return big(t.baseCost).mul(big(t.costGrowth).pow(level)).ceil();
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
export function bulkUpgradeCost(key: UpgradeKey, level: number, count: number): Big {
  let total = BIG_ZERO;
  for (let i = 0; i < count; i++) total = total.add(upgradeCost(key, level + i));
  return total;
}

/** How many levels `gold` can buy, respecting the track cap and the bulk limit. */
export function maxAffordableUpgrades(key: UpgradeKey, level: number, gold: Big): number {
  const ceiling = Math.min(remainingLevels(key, level), BULK_PURCHASE_LIMIT);
  let count = 0;
  let spent = BIG_ZERO;

  while (count < ceiling) {
    const next = spent.add(upgradeCost(key, level + count));
    if (next.gt(gold)) break;
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
 * Loot from the trash wave, on top of what a clear pays.
 *
 * Rolled once per clear over `enemyCount(stage)` kills rather than per tick, because
 * resolveStage has no tick loop and is not getting one. The chance is per KILL because
 * that is the mental model the animation shows; the maths is a seeded draw at the end.
 *
 * ## The cap is the load-bearing half
 *
 * enemyCount climbs from 41 to a ceiling of 220, so an uncapped 5% would pay about two
 * items at stage 1 and eleven at depth - invisible exactly where a new player first
 * meets the feature, and a flood where the inventory is already under pressure. Capped
 * it is ~2 early and 6 from around stage 120: present immediately, bounded forever.
 *
 * Both numbers are dials for pacing, not for power. Wave loot cannot raise the power
 * ceiling - that is set by affix tiers - it raises THROUGHPUT, which reaches power
 * indirectly through dissembling into crafting currency. That is the loop to watch when
 * these move, and the balance harness models it.
 */
export const WAVE_DROP_CHANCE = 0.05;
export const WAVE_DROP_MAX = 6;

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

export const DUNGEON_PROFILE: DepthProfile = {
  hpMult: DUNGEON_BOSS_HP_MULT,
  dpsMult: DUNGEON_BOSS_DPS_MULT,
  goldMult: DUNGEON_GOLD_MULT,
  affinity: DUNGEON_AFFINITY,
};

/** Currency a dungeon clear awards, inclusive. */
export const DUNGEON_CURRENCY_PER_CLEAR = { min: 1, max: 2 } as const;

// --- The Abyss ------------------------------------------------------------

/**
 * Chance a single trash kill past the unlock floor drops a tablet.
 *
 * A WAVE drop, not a boss reward. The ladder is the faucet and the Abyss is the sink, and
 * "rare but not hard to obtain given the kill rate" is the shape: one in a thousand kills
 * against a couple of hundred enemies a clear is roughly one tablet every four or five
 * floors, arriving in a trickle rather than on a schedule.
 *
 * It was a 12% roll on the stage boss, which is the same rate by a different mechanism -
 * and the wrong one. A boss reward is a thing you are handed for finishing; a wave drop
 * is a thing you find, and it falls on screen out of the enemy that dropped it like every
 * other piece of wave loot.
 */
export const TABLET_DROP_CHANCE = 0.001;

/** Most a single wave may pay, however lucky. Bounded like the wave loot beside it. */
export const TABLETS_PER_WAVE_MAX = 2;

/**
 * Floors per tier the LADDER hands out. T2 at 140, T3 at 200.
 *
 * Deliberately far slower than `abyssalDepth`'s twelve. **The Abyss owns the tier
 * ladder** - "clearing a T5 drops T5s and sometimes a T6" is the progression, and a
 * ladder that matched that rate would make the mode's own tier-up reward pointless.
 * What the ladder owes is an ENTRY tablet, forever, so running dry is never a wall.
 */
export const TABLET_TIER_STAGES = 60;

/**
 * Highest tier the ladder itself will ever drop.
 *
 * Three, and MEASURED rather than chosen. The first cut let it reach eight, which sounds
 * modest and is not: a T8 pays gear at `abyssalDepth(8)` - floor 164 - so the ladder was
 * handing out items from far deeper than the player could reach, on top of an Abyssal
 * gold multiple of five. The harness read it as a clear-time collapse, 10th-percentile
 * clears at 4.4-6.9s against a 12s floor across three seeds.
 *
 * Well under MAX_TABLET_TIER for the design reason too: if climbing alone reached T15,
 * the tier ladder would be a second name for the stage ladder.
 */
export const LADDER_MAX_TABLET_TIER = 3;

/**
 * What an Abyssal clear pays before the tablet's own modifiers.
 *
 * Above a dungeon on every axis, because a tablet is scarcer than a key and the fight
 * is longer. The tablet's `reward` totals multiply these.
 */
export const ABYSSAL_ITEMS_PER_CLEAR = 2;
export const ABYSSAL_CURRENCY_PER_CLEAR = 3;

/**
 * Chance a clear hands back a tablet of the tier just cleared, and of the next one up.
 *
 * The tier-up is the entire progression: no crafting step, no cost, just play. At
 * roughly one in three a player climbs while they can still win, and stalls at the tier
 * that starts beating them - the correct place to stall, because it is a statement
 * about their character rather than their luck.
 *
 * ## They must sum to LESS THAN ONE
 *
 * The first cut guaranteed a same-tier tablet back. That makes a tablet not a
 * consumable: clearing a T1 always pays for the next T1, so a player who can beat one
 * tier can run it forever at no cost, and the scarcity the whole mode is built on
 * evaporates. The balance harness found it immediately - the agent ran fifty Abyssals
 * between every stage clear and the ladder went from 10.1 to 18.2 days, all of it time
 * spent in a mode that never charged for entry.
 *
 * At 0.5 + 0.3 a run returns 0.8 tablets on average, so a stock depletes while it
 * climbs. Running out is not a dead end: the ladder keeps dropping T1s past the unlock
 * floor, which is what TABLET_DROP_CHANCE is for.
 */
export const ABYSSAL_TABLET_RETURN_CHANCE = 0.5;
export const ABYSSAL_TIER_UP_CHANCE = 0.3;

/**
 * Gold to reroll an item's modifiers.
 *
 * Priced off `goldPerKill` at the item's own level, so a stage-80 item costs
 * what a stage-80 player earns rather than what a stage-1 player does. Rarity
 * multiplies because a rare has six affixes to reroll and is worth far more
 * when it lands well.
 *
 * The per-reroll escalation is the important term. Flat pricing would let a
 * player park on one item and grind it to perfect tiers for pocket change,
 * which turns a loot system into a slot machine with no cost.
 */
export function rerollCost(rarity: Rarity, itemLevel: number, rerolls: number): Big {
  const rarityMultiplier: Record<Rarity, number> = {
    common: 1,
    magic: 2.5,
    rare: 6,
    // Uniques have no affixes to reroll; commands.ts refuses before reaching here.
    unique: Infinity,
  };
  const base = goldPerKill(Math.max(1, itemLevel)).mul(30).mul(rarityMultiplier[rarity]);
  return base.mul(big(1.35).pow(rerolls)).ceil();
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
