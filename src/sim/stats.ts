/**
 * Effect interpreter + derived stats.
 *
 * One interpreter, N items — rather than N bespoke closures. Every item is data
 * that flows through here, so the balance harness can reason about the whole
 * item pool without executing arbitrary code.
 */

import {
  baseSkillId,
  getSkill,
  UNARMED,
  type Effect,
  type ItemInstance,
  type Skill,
} from './content';
import { SKILL_LEVEL_GAIN, UPGRADE_TRACKS } from './curves';
import { itemEffects } from './items';
import { big, bigMax, BIG_ONE, type Big } from './big';
import {
  BASE_STATS,
  MAGNITUDE_STAT_KEYS,
  STAT_KEYS,
  type MagnitudeStatKey,
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
  resource: 'resourceRegen',
};

/**
 * The three layers, accumulated per stat before anything is resolved.
 *
 * `more` is a Big and the other two are not, which is not an inconsistency: flat and
 * increased land in SUMS bounded by how many modifiers an item can carry, while more
 * is a PRODUCT over upgrade levels and compounds without bound. At 1.07 per level the
 * damage track passes 1.8e308 near level 10,000 - a stage the ladder is meant to
 * reach.
 */
interface Layers {
  flat: number;
  increased: number;
  more: Big;
}

type Buckets = Record<StatKey, Layers>;

/** Whether a stat is stored as a Big. See MAGNITUDE_STAT_KEYS in types.ts. */
function isMagnitude(key: StatKey): key is MagnitudeStatKey {
  return (MAGNITUDE_STAT_KEYS as readonly string[]).includes(key);
}

function emptyBuckets(): Buckets {
  return Object.fromEntries(
    STAT_KEYS.map((key) => [key, { flat: 0, increased: 0, more: BIG_ONE }]),
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
    if (track.valueGrowth !== null) layers.more = layers.more.mul(big(track.valueGrowth).pow(level));
    else if (track.valueAdd !== null) layers.flat += track.valueAdd * level;
  }
}

function collectEffects(buckets: Buckets, effects: Effect[]): void {
  for (const e of effects) {
    if (e.kind !== 'statMod') continue;
    const layers = buckets[e.stat as StatKey];
    if (e.op === 'flat') layers.flat += e.value;
    else if (e.op === 'increased') layers.increased += e.value;
    else layers.more = layers.more.mul(e.value);
  }
}

/**
 * Collapse the layers of one stat.
 *
 * `(base + flat) × (1 + increased) × more`. The sum in the middle is why the
 * common layers have diminishing returns and why a sixth affix row is now
 * affordable - see ModLayer in src/sim/content/schema.ts.
 */
function resolve(base: Big, layers: Layers): Big {
  return base.add(layers.flat).mul(1 + layers.increased).mul(layers.more);
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

/** The equipped weapon, or undefined when unarmed. */
export function equippedWeapon(save: SaveState): ItemInstance | undefined {
  return save.weapon ? findItem(save, save.weapon) : undefined;
}

/**
 * Effects from currently equipped items only — owned-but-unequipped do nothing.
 *
 * The weapon counts. It is an ordinary item that happens to also grant a skill, so
 * its affixes and implicit contribute exactly like any other equipped item's.
 */
export function equippedEffects(save: SaveState): Effect[] {
  const out: Effect[] = [];
  for (const uid of [...save.loadout, save.weapon]) {
    if (!uid) continue;
    const item = findItem(save, uid);
    if (!item) continue; // loadout referencing a discarded or migrated-away item
    out.push(...itemEffects(item));
  }
  return out;
}

/**
 * The skill the equipped weapon grants, or Unarmed.
 *
 * Unarmed's bases are the pre-weapon BASE_STATS values, so a save with an empty
 * weapon slot derives exactly what it derived before skills existed.
 */
export function equippedSkill(save: SaveState): Skill {
  const weapon = equippedWeapon(save);
  const id = weapon ? baseSkillId(weapon.baseId) : undefined;
  return (id ? getSkill(id) : undefined) ?? UNARMED;
}

/**
 * The equipped skill's level.
 *
 * Item level is the source, which is what makes depth matter again: the tier gates
 * stop at stage 80, so before this an item level 226 drop rolled from the same table
 * as an item level 80 one and pushing deeper bought nothing but gold.
 *
 * Modifiers add to it, and only ones matching the skill's kind - a wand gains
 * nothing from `+2 to Physical Skill Levels`. Unarmed is level zero and never
 * scales; it is a fallback, not a build.
 */
export function skillLevel(save: SaveState, ctx: EffectContext): number {
  const weapon = equippedWeapon(save);
  if (!weapon) return 0;
  const skill = equippedSkill(save);
  const stat = skill.kind === 'physical' ? 'physicalSkillLevel' : 'magicalSkillLevel';

  let bonus = 0;
  for (const e of equippedEffects(save)) {
    if (e.kind === 'statMod' && e.stat === stat && conditionHolds(e, ctx)) bonus += e.value;
  }
  return Math.max(0, weapon.itemLevel + bonus);
}

/**
 * The base each stat resolves from.
 *
 * Four stats come from the skill and scale with its level; the rest are global. The
 * skill-level term multiplies the BASE, which is a distinct position from the three
 * layers - see the note on physicalSkillLevel in types.ts.
 */
function baseStats(save: SaveState, ctx: EffectContext): Stats {
  const skill = equippedSkill(save);
  return {
    ...BASE_STATS,
    // Skill level scales DAMAGE ONLY. Speed, crit and area are the skill's identity
    // and stay fixed: scaling speed as well would make a weapon deliver its growth
    // rate squared per stage, which is double what the rate was sized to carry, and
    // the player would outrun the ladder on weapons alone. Crit and area are bounded
    // by their own meaning anyway - a probability and a target count.
    // A Big because this term alone outgrows a double: 1.05 per skill level, and
    // skill level is the weapon's item level, so a stage-6,000 weapon is already past
    // 1.8e308 before a single upgrade or affix is applied.
    damage: big(skill.baseDamage).mul(big(SKILL_LEVEL_GAIN).pow(skillLevel(save, ctx))),
    attackSpeed: skill.baseSpeed,
    critChance: skill.baseCritChance,
    area: skill.baseArea,
  };
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

  const base = baseStats(save, ctx);
  const stats = { ...base };
  for (const key of STAT_KEYS) {
    // Resolved as a Big in every case, then collapsed back to a double for the stats
    // that are rates, probabilities or counts. Doing the arithmetic uniformly is what
    // keeps the three layers one code path; only the storage type differs.
    const resolved = resolve(big(base[key]), buckets[key]);
    if (isMagnitude(key)) stats[key] = resolved;
    else (stats as unknown as Record<string, number>)[key] = resolved.toNumber();
  }

  stats.area = Math.max(1, stats.area);
  stats.critChance = Math.min(1, Math.max(0, stats.critChance));
  stats.maxHp = bigMax(1, stats.maxHp);
  stats.toughness = Math.max(0.1, stats.toughness);
  stats.resourceRegen = Math.max(0, stats.resourceRegen);
  // Gold find had no floor until an item existed that reduces it. Two Warden's
  // Coffers take it negative, and a negative multiplier does not mean "earns less" -
  // it means the clear pays out negative gold.
  stats.goldFind = Math.max(0, stats.goldFind);

  // Attack speed is capped by what the resource can sustain, and the CAP IS WRITTEN
  // INTO THE STAT rather than applied later in the damage formula.
  //
  // That is deliberate. `attackSpeed` now means "swings you actually get", so every
  // caller - the combat layer, the character sheet, the balance harness - is talking
  // about the same number without being told about resources. A panel quoting 3.0/s
  // to a player who can only sustain 2.0/s would be the exact failure statsDps was
  // written to prevent.
  //
  // Closed-form, which is non-negotiable: resolveStage has no per-tick loop, and
  // that is what lets the server resolve offline progress and the harness sweep 300
  // stages in milliseconds.
  stats.attackSpeed = Math.min(stats.attackSpeed, sustainedRate(stats, equippedSkill(save)));
  return stats;
}

/**
 * Uses per second the resource can pay for.
 *
 * A cheap cost against fast regen sits above your attack speed and never binds; an
 * expensive one sits below it and binds from the first swing. That difference in
 * WHEN it binds is the whole distinction between stamina and mana - the formula is
 * identical and only the numbers differ.
 */
export function sustainedRate(stats: Stats, skill: Skill): number {
  if (skill.resourceCost <= 0) return Infinity;
  return stats.resourceRegen / skill.resourceCost;
}

/**
 * Whether the resource, not the weapon, is what limits your attacks.
 *
 * Since deriveStats already capped attackSpeed to the smaller of the two, the
 * resource is binding exactly when the two are equal - no need to carry the
 * uncapped figure around to find out.
 *
 * Exported for the panel. A stat silently lower than the modifiers on your gear
 * imply is a number a player cannot act on without being told why.
 */
export function isResourceBound(stats: Stats, skill: Skill): boolean {
  return sustainedRate(stats, skill) <= stats.attackSpeed * (1 + 1e-9);
}

/** Effective HP: what the incoming damage pool is actually measured against. */
export function effectiveHp(stats: Stats): Big {
  return stats.maxHp.mul(stats.toughness);
}

/**
 * Multiplier on the stage boss's key chance, from equipped items.
 *
 * A PRODUCT, unlike goldOnKill's sum. Two copies of a doubling effect should double
 * twice - and the chance is clamped at certainty where it is applied, so compounding
 * has a hard ceiling rather than an unbounded one.
 */
export function keyDropMultiplier(save: SaveState, ctx: EffectContext): number {
  return equippedEffects(save)
    .filter((e) => e.kind === 'keyDrop' && conditionHolds(e, ctx))
    .reduce((mult, e) => mult * (e.kind === 'keyDrop' ? e.multiplier : 1), 1);
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
export function statsDps(stats: Stats): Big {
  return stats.damage.mul(stats.attackSpeed).mul(critFactor(stats));
}
