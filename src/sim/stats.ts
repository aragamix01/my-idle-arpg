/**
 * Effect interpreter + derived stats.
 *
 * One interpreter, N items — rather than N bespoke closures. Every item is data
 * that flows through here, so the balance harness can reason about the whole
 * item pool without executing arbitrary code.
 */

import {
  baseSkillId,
  ELEMENTS,
  getBase,
  getSkill,
  resourceLabel,
  UNARMED,
  type Effect,
  type Element,
  type ItemInstance,
  type Skill,
} from './content';
import {
  MAX_RESISTANCE,
  MAX_VULNERABILITY,
  SKILL_LEVEL_GAIN,
  UPGRADE_TRACKS,
  type Resistances,
} from './curves';
import { armourSlotOf, itemEffects } from './items';
import { big, bigMax, BIG_ONE, type Big } from './big';
import {
  ACCESSORY_SLOTS,
  ACCESSORY_SLOT_KINDS,
  ARMOUR_CAP,
  ARMOUR_K,
  BASE_STATS,
  BOSS_HIT_SCALE,
  EVASION_CAP,
  EVASION_K,
  ARMOUR_SLOT_KINDS,
  BASE_ACCESSORY_SLOTS,
  BOSS_MITIGATION_CAP,
  MAGNITUDE_STAT_KEYS,
  STAT_KEYS,
  WAVE_RECOVERY_CAP,
  type ArmourSlot,
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

/**
 * @param amplify Scale applied to this source's flat and increased contributions.
 *
 * `more` is deliberately not amplified. It is already the compounding layer, and
 * multiplying a multiplier is how a bounded effect becomes an unbounded one - the
 * same reasoning that keeps `more` off rollable affixes entirely.
 */
function collectEffects(buckets: Buckets, effects: Effect[], amplify = 1): void {
  for (const e of effects) {
    if (e.kind !== 'statMod') continue;
    const layers = buckets[e.stat as StatKey];
    if (e.op === 'flat') layers.flat += e.value * amplify;
    else if (e.op === 'increased') layers.increased += e.value * amplify;
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
 * Accessories currently worn, in slot order. Empty positions are simply absent.
 *
 * `live` is how many positions count - the base three unless armour grants more. See
 * accessorySlots.
 */
export function equippedAccessories(save: SaveState, live = BASE_ACCESSORY_SLOTS): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (let i = 0; i < Math.min(live, ACCESSORY_SLOTS); i++) {
    const uid = save.accessories?.[i];
    // Optional-chained because a save written before accessories existed has no array at
    // all, and deriveStats runs before migrate on the optimistic client path.
    if (!uid) continue;
    const item = findItem(save, uid);
    if (item) out.push(item);
  }
  return out;
}

/** What one armour position contributes. Empty, or pointing at a discarded item, is []. */
function slotEffects(save: SaveState, index: number): Effect[] {
  const uid = save.loadout[index];
  if (!uid) return [];
  const item = findItem(save, uid);
  return item ? itemEffects(item) : [];
}

/**
 * The armour slots switched off by what is worn - Monomaniac's Shroud. Phase 8.
 *
 * Read from the positions' own effects, and a position can never seal itself: the one
 * item that seals is a body piece and seals gloves and boots. So there is no fixed point
 * to resolve - unlike the derived slot count this replaced, one pass is the answer.
 */
function sealedFrom(armour: Effect[][], ctx: EffectContext): Set<ArmourSlot> {
  const sealed = new Set<ArmourSlot>();
  armour.forEach((effects, i) => {
    for (const e of effects) {
      if (e.kind !== 'sealSlots' || !conditionHolds(e, ctx)) continue;
      for (const slot of e.slots) if (slot !== ARMOUR_SLOT_KINDS[i]) sealed.add(slot);
    }
  });
  return sealed;
}

/** The armour slots currently sealed. Empty for every character without the Shroud. */
export function sealedSlots(save: SaveState, ctx: EffectContext): Set<ArmourSlot> {
  return sealedFrom(ARMOUR_SLOT_KINDS.map((_, i) => slotEffects(save, i)), ctx);
}

/**
 * How many accessory positions are live: the base three, plus what armour grants.
 *
 * Only ARMOUR can grant one - no accessory carries `ringSlots` - so the count is read off
 * the armour once and cannot feed back into itself. A sealed slot grants nothing.
 */
function accessorySlotsFrom(armour: Effect[][], sealed: Set<ArmourSlot>, ctx: EffectContext): number {
  let slots = BASE_ACCESSORY_SLOTS;
  armour.forEach((effects, i) => {
    if (sealed.has(ARMOUR_SLOT_KINDS[i])) return;
    for (const e of effects) if (e.kind === 'ringSlots' && conditionHolds(e, ctx)) slots += e.delta;
  });
  return Math.max(BASE_ACCESSORY_SLOTS, Math.min(ACCESSORY_SLOTS, slots));
}

export function accessorySlots(save: SaveState, ctx: EffectContext): number {
  const armour = ARMOUR_SLOT_KINDS.map((_, i) => slotEffects(save, i));
  return accessorySlotsFrom(armour, sealedFrom(armour, ctx), ctx);
}

/**
 * Effects from currently equipped items only — owned-but-unequipped do nothing.
 *
 * "Equipped" means worn in a live position. A piece in a sealed slot is still worn in
 * the sense that dissembling refuses it, but it contributes nothing - which is what
 * makes the Shroud's seal a real cost rather than a free swap. Likewise a ring in the
 * fourth position only counts while something grants that position.
 *
 * The armour is walked ONCE and every answer comes out of that walk. Asking the sealed
 * set and the ring count separately would resolve every item's effects three times on
 * the hottest path in the sim.
 *
 * The weapon counts. It is an ordinary item that happens to also grant a skill, so
 * its affixes and implicit contribute exactly like any other equipped item's.
 */
export function equippedGroups(save: SaveState, ctx: EffectContext): Effect[][] {
  const armour = ARMOUR_SLOT_KINDS.map((_, i) => slotEffects(save, i));
  const sealed = sealedFrom(armour, ctx);

  const out: Effect[][] = armour.filter((_, i) => !sealed.has(ARMOUR_SLOT_KINDS[i]));

  const weapon = equippedWeapon(save);
  if (weapon) out.push(itemEffects(weapon));
  // Accessories are ordinary equipped items in every way that matters here - their own
  // group each, so `amplifyOthers` counts them the way it counts armour.
  for (const accessory of equippedAccessories(save, accessorySlotsFrom(armour, sealed, ctx))) {
    out.push(itemEffects(accessory));
  }
  return out;
}

export function equippedEffects(save: SaveState, ctx: EffectContext): Effect[] {
  return equippedGroups(save, ctx).flat();
}

/**
 * How much each equipped item's contributions are scaled by the OTHER items.
 *
 * One number per group, in the same order. An amplifier multiplies everything worn
 * except itself: `total / own` is the product of every other source's multiplier,
 * which is the cheap way to say "all of them but this one".
 *
 * Excluding itself is not a nicety. An amplifier that scaled its own effects would
 * compound against its own downside, and two of them would compound against each
 * other - the same shape as a rollable `more` affix, which the registry forbids for
 * exactly this reason.
 */
function amplifiers(groups: Effect[][], ctx: EffectContext): number[] {
  const own = groups.map((effects) =>
    effects.reduce(
      (mult, e) =>
        e.kind === 'amplifyOthers' && conditionHolds(e, ctx) ? mult * e.multiplier : mult,
      1,
    ),
  );

  // Nothing amplifies anything, which is every loadout without that one unique.
  if (own.every((m) => m === 1)) return own.map(() => 1);

  const total = own.reduce((a, b) => a * b, 1);
  return own.map((m) => (m === 0 ? total : total / m));
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
export function skillLevel(
  save: SaveState,
  ctx: EffectContext,
  /** Pre-walked equipped effects. Passed by deriveStats so the gear is walked once. */
  effects: Effect[] = equippedEffects(save, ctx),
): number {
  const weapon = equippedWeapon(save);
  if (!weapon) return 0;
  const skill = equippedSkill(save);
  const stat = skill.kind === 'physical' ? 'physicalSkillLevel' : 'magicalSkillLevel';

  let bonus = 0;
  for (const e of effects) {
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
function baseStats(save: SaveState, ctx: EffectContext, effects: Effect[]): Stats {
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
    damage: big(skill.baseDamage).mul(big(SKILL_LEVEL_GAIN).pow(skillLevel(save, ctx, effects))),
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
export function deriveStats(
  save: SaveState,
  ctx: EffectContext,
  /**
   * Pre-walked gear, grouped by source item.
   *
   * Passed by callers that need the same walk for something else - the combat layer
   * needs it for damage shares. Walking gear is the hottest path in the sim, and the
   * skill-level lookup below used to force a second walk on every single call.
   */
  groups: Effect[][] = equippedGroups(save, ctx),
): Stats {
  const buckets = emptyBuckets();
  collectUpgrades(buckets, save.upgrades);

  // Grouped by source item rather than flattened, because an amplifier scales what
  // the OTHER items contribute - a flat list has no way to say which is which.
  const scale = amplifiers(groups, ctx);
  groups.forEach((effects, i) => {
    collectEffects(
      buckets,
      effects.filter((e) => conditionHolds(e, ctx)),
      scale[i],
    );
  });

  const base = baseStats(save, ctx, groups.flat());
  const stats = resolveAll(base, buckets);
  applyLimits(stats, save);
  return stats;
}

/**
 * Collapse every stat's layers. Extracted so deriveStats and explainStats resolve
 * through the same arithmetic rather than through two copies of it.
 *
 * @param out Optionally receives the pre-clamp value per stat. Omitted by deriveStats,
 * which is the hot path and has no use for them.
 */
function resolveAll(base: Stats, buckets: Buckets, out?: Record<StatKey, Big>): Stats {
  const stats = { ...base };
  for (const key of STAT_KEYS) {
    // Resolved as a Big in every case, then collapsed back to a double for the stats
    // that are rates, probabilities or counts. Doing the arithmetic uniformly is what
    // keeps the three layers one code path; only the storage type differs.
    const resolved = resolve(big(base[key]), buckets[key]);
    if (out) out[key] = resolved;
    if (isMagnitude(key)) stats[key] = resolved;
    else (stats as unknown as Record<string, number>)[key] = resolved.toNumber();
  }
  return stats;
}

/**
 * Floors, ceilings and the resource cap, applied in place.
 *
 * ONE copy, called by deriveStats and by explainStats. That is the whole reason this is
 * a function: a character sheet that listed a stat's layers and stopped would disagree
 * with the number printed above them exactly when a limit was biting - and the resource
 * cap bites for every caster who ever buys attack speed, which is the moment the panel
 * most needs to be believed.
 *
 * @param capped Optionally receives a reason per stat a limit actually moved. Omitted
 * by deriveStats, so the hot path allocates nothing and compares nothing.
 */
function applyLimits(
  stats: Stats,
  save: SaveState,
  capped?: Partial<Record<StatKey, string>>,
): void {
  if (stats.area < 1) {
    stats.area = 1;
    if (capped) capped.area = 'a skill always hits at least one target';
  }
  if (stats.critChance > 1) {
    stats.critChance = 1;
    if (capped) capped.critChance = 'crit chance cannot exceed certainty';
  } else if (stats.critChance < 0) {
    stats.critChance = 0;
    if (capped) capped.critChance = 'crit chance cannot go below zero';
  }
  if (stats.maxHp.lt(1)) {
    stats.maxHp = bigMax(1, stats.maxHp);
    if (capped) capped.maxHp = 'max HP cannot fall below one';
  }
  if (stats.toughness < 0.1) {
    stats.toughness = 0.1;
    if (capped) capped.toughness = 'toughness cannot fall below x0.10';
  }
  if (stats.resourceRegen < 0) {
    stats.resourceRegen = 0;
    if (capped) capped.resourceRegen = 'regen cannot be negative';
  }
  // Gold find had no floor until an item existed that reduces it. Two Warden's
  // Coffers take it negative, and a negative multiplier does not mean "earns less" -
  // it means the clear pays out negative gold.
  if (stats.goldFind < 0) {
    stats.goldFind = 0;
    if (capped) capped.goldFind = 'gold find cannot be negative';
  }
  // Negative penetration would mean granting the target resistance, which nothing in
  // the game is supposed to do. No ceiling here - mitigatedResistance bounds what it
  // can accomplish, so a huge value is wasted rather than unbounded.
  if (stats.penetration < 0) {
    stats.penetration = 0;
    if (capped) capped.penetration = 'penetration cannot be negative';
  }
  // The defence layers floor at zero for the same reason. The ceilings are not here:
  // they are on what each one ACHIEVES (EVASION_CAP, ARMOUR_CAP in effectiveHp), so a
  // huge rating is wasted rather than wrong.
  for (const key of ['energyShield', 'armour', 'evasion', 'moveSpeed'] as const) {
    if (stats[key] < 0) {
      stats[key] = 0;
      if (capped) capped[key] = 'cannot be negative';
    }
  }

  // The two slot-only fractions are capped where they are stored: what they achieve IS
  // the stored number, so there is no later formula to cap it in.
  const fractionCaps = { bossMitigation: BOSS_MITIGATION_CAP, waveRecovery: WAVE_RECOVERY_CAP } as const;
  for (const [key, cap] of Object.entries(fractionCaps) as [keyof typeof fractionCaps, number][]) {
    if (stats[key] < 0) {
      stats[key] = 0;
      if (capped) capped[key] = 'cannot be negative';
    } else if (stats[key] > cap) {
      stats[key] = cap;
      if (capped) capped[key] = `capped at ${Math.round(cap * 100)}%`;
    }
  }

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
  const skill = equippedSkill(save);
  const sustained = sustainedRate(stats, skill);
  if (sustained < stats.attackSpeed) {
    stats.attackSpeed = sustained;
    if (capped) capped.attackSpeed = `${resourceLabel(skill)} sustains only this many uses`;
  }
}

/**
 * What produced one stat's final number.
 *
 * The character sheet quotes finals; this is the answer to "from what?". Every field is
 * the value the sim actually used, not a re-derivation - see explainStats.
 */
export interface StatBreakdown {
  /** What the skill or BASE_STATS supplied, before any modifier. */
  base: Big;
  /** Σ of the flat layer, in the stat's own units. */
  flat: number;
  /** Σ of the increased layer, as a fraction: 0.38 is +38%. */
  increased: number;
  /** Π of the more layer. 1 means nothing compounds this stat. */
  more: Big;
  /** After the layers, before any floor, ceiling or cap. */
  resolved: Big;
  /** What the fight actually uses. */
  final: Big;
  /** Why `final` differs from `resolved`, or null when nothing intervened. */
  cappedBy: string | null;
}

/**
 * Every stat's components, for the character sheet.
 *
 * Deliberately NOT folded into deriveStats. Building twelve objects per call would land
 * on the hottest path in the sim - the balance harness calls deriveStats thousands of
 * times per stage - to serve a panel that is open a fraction of the time. This runs the
 * same helpers in the same order instead, so there is no second copy of the formula:
 * the only thing the two could disagree about is the limits, and those are one function
 * both of them call.
 *
 * Client-side by design. The panel already holds the whole SaveState, so no part of
 * this crosses the wire.
 */
export function explainStats(save: SaveState, ctx: EffectContext): Record<StatKey, StatBreakdown> {
  const groups = equippedGroups(save, ctx);
  const buckets = emptyBuckets();
  collectUpgrades(buckets, save.upgrades);

  const scale = amplifiers(groups, ctx);
  groups.forEach((effects, i) => {
    collectEffects(
      buckets,
      effects.filter((e) => conditionHolds(e, ctx)),
      scale[i],
    );
  });

  const base = baseStats(save, ctx, groups.flat());
  const resolved = {} as Record<StatKey, Big>;
  const stats = resolveAll(base, buckets, resolved);

  const capped: Partial<Record<StatKey, string>> = {};
  applyLimits(stats, save, capped);

  return Object.fromEntries(
    STAT_KEYS.map((key) => [
      key,
      {
        base: big(base[key]),
        flat: buckets[key].flat,
        increased: buckets[key].increased,
        more: buckets[key].more,
        resolved: resolved[key],
        final: big(stats[key]),
        cappedBy: capped[key] ?? null,
      },
    ]),
  ) as Record<StatKey, StatBreakdown>;
}

/**
 * The save you would have if you equipped this item, without equipping it.
 *
 * Exists so the inventory can answer "what is this worth?" with the number the FIGHT
 * uses rather than with a score. itemPower is the obvious shortcut and the wrong one:
 * its own doc says it is a heuristic not shown to players, and it once rated a `crit
 * chance more 0` penalty as the largest bonus any modifier could carry. Re-deriving
 * through the real formula cannot invert an item, because it is the same code that
 * decides the fight.
 *
 * Mirrors the placement rules the equip command applies, so the preview is what would
 * actually happen: a weapon swaps into the weapon slot; gear takes its own slot if it
 * is already worn, then the first empty one; with every slot full it replaces the
 * WEAKEST live slot, because that is the swap a player would make.
 *
 * Pure - the save handed in is never touched.
 */
export function previewEquip(
  save: SaveState,
  item: ItemInstance,
  ctx: EffectContext,
): SaveState {
  const owned = save.items.some((i) => i.uid === item.uid) ? save.items : [...save.items, item];

  if (baseSkillId(item.baseId) !== undefined) {
    return { ...save, items: owned, weapon: item.uid };
  }

  /*
    An accessory goes in an accessory slot, of its own kind.

    Without this it was simulated into a GEAR slot - which the equip command refuses, so
    the panel priced a swap the player could not make, and did it by displacing a piece
    of gear that was never going anywhere.
  */
  const wear = getBase(item.baseId)?.wear;
  if (wear) {
    const accessories = [...save.accessories];
    const worn = accessories.indexOf(item.uid);
    if (worn !== -1) return { ...save, items: owned, accessories };

    const matching = ACCESSORY_SLOT_KINDS.map((kind, i) => ({ kind, i })).filter(
      (s) => s.kind === wear,
    );
    // Prefer an empty slot; otherwise displace the first of its kind, which is what
    // "if you equipped it" has to mean once the slots are full.
    const target = matching.find((s) => accessories[s.i] === null) ?? matching[0];
    if (target) accessories[target.i] = item.uid;
    return { ...save, items: owned, accessories };
  }

  // Armour has exactly one place to go, so "if you equipped it" is a plain swap into
  // its slot. The context is unused now that no slot is derived; kept so callers that
  // price a drop at a given stage do not change shape.
  void ctx;
  const slot = armourSlotOf(item);
  const index = slot ? ARMOUR_SLOT_KINDS.indexOf(slot) : -1;
  if (index === -1) return save;
  const loadout = [...save.loadout];
  loadout[index] = item.uid;
  return { ...save, items: owned, loadout };
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

/*
  The defence layers, Phase 7d.

  Every one of them reduces to a factor on effective HP, which is what keeps combat
  closed-form: incoming damage is an expected value over a whole phase, so "avoid 20% of
  hits" and "take 20% less from each" are both a scale on the pool. They differ in SHAPE,
  not in that.

  Ratings are measured against constants, NOT against the stage. Flat rolls in this game
  do not grow with depth - a roll sits inside the multiplicative envelope of the upgrade
  tracks, which is what keeps it relevant - so a rating measured against an exponential
  enemy hit would be worth nothing by floor 100 and be dead content from then on.
*/


/** Fraction of hits avoided. */
export function evadeChance(stats: Stats): number {
  if (stats.evasion <= 0) return 0;
  return Math.min(EVASION_CAP, stats.evasion / (stats.evasion + EVASION_K));
}

/** Fraction of each hit armour removes, against trash or against a boss. */
export function armourCut(stats: Stats, against: 'trash' | 'boss' = 'trash'): number {
  if (stats.armour <= 0) return 0;
  const hit = against === 'boss' ? BOSS_HIT_SCALE : 1;
  return Math.min(ARMOUR_CAP, stats.armour / (stats.armour + ARMOUR_K * hit));
}

/**
 * The share of the pool that is energy shield rather than life.
 *
 * Energy shield is a fraction of Max HP stacked on top of it, so a character with 0.25
 * holds a pool 1.25 times their life, of which one fifth is shield. On the ladder that is
 * all it is - more pool. In a delve it is the part that refills between waves.
 */
export function shieldShare(stats: Stats): number {
  return stats.energyShield / (1 + stats.energyShield);
}

/**
 * Effective HP: what the incoming damage pool is actually measured against.
 *
 *   (life + shield) x toughness / ((1 - evade) x (1 - armourCut))
 *
 * `against` changes armour - see BOSS_HIT_SCALE - and applies body armour's boss cut. Everything that reads one number
 * for "how tanky am I" reads the trash figure, which is what a run spends most of its
 * time taking.
 */
export function effectiveHp(stats: Stats, against: 'trash' | 'boss' = 'trash'): Big {
  // Body armour's boss cut is one more factor of the same shape - a scale on what lands.
  const mitigated = against === 'boss' ? 1 - stats.bossMitigation : 1;
  const avoided = (1 - evadeChance(stats)) * (1 - armourCut(stats, against)) * mitigated;
  return stats.maxHp
    .mul(1 + stats.energyShield)
    .mul(stats.toughness)
    .div(avoided);
}

/**
 * Multiplier on the stage boss's key chance, from equipped items.
 *
 * A PRODUCT, unlike goldOnKill's sum. Two copies of a doubling effect should double
 * twice - and the chance is clamped at certainty where it is applied, so compounding
 * has a hard ceiling rather than an unbounded one.
 */
export function keyDropMultiplier(save: SaveState, ctx: EffectContext): number {
  return equippedEffects(save, ctx)
    .filter((e) => e.kind === 'keyDrop' && conditionHolds(e, ctx))
    .reduce((mult, e) => mult * (e.kind === 'keyDrop' ? e.multiplier : 1), 1);
}

/** Extra gold per kill, as a fraction of the stage's base gold value. */
export function goldOnKillBonus(save: SaveState, ctx: EffectContext): number {
  return equippedEffects(save, ctx)
    .filter((e) => e.kind === 'goldOnKill' && conditionHolds(e, ctx))
    .reduce((sum, e) => sum + (e.kind === 'goldOnKill' ? e.multiplier : 0), 0);
}

/**
 * Every distinct `enemyHpBelow` threshold in the loadout, plus the band edges.
 *
 * Reads the worn items directly rather than through equippedEffects, and takes no
 * context, because the question is structural: which thresholds could EVER matter for
 * this loadout. Asking it through a context would be circular - the bands are what the
 * contexts are built from.
 */
export function hpBands(save: SaveState): number[] {
  const thresholds = new Set<number>([1, 0]);
  for (const uid of [...save.loadout, save.weapon]) {
    if (!uid) continue;
    const item = findItem(save, uid);
    if (!item) continue;
    for (const e of itemEffects(item)) {
      if (e.when?.enemyHpBelow !== undefined) thresholds.add(e.when.enemyHpBelow);
    }
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

// --- Elements -------------------------------------------------------------

/**
 * How a hit divides by element. The skill's own element is 1; extras add on top.
 *
 * NOT normalised, and that is the mechanic. `gain 20% as extra cold` makes the shares
 * sum to 1.2, so against a target with no resistance it is a straight 1.2x - the extra
 * damage is genuinely extra rather than a slice taken out of the physical half. What
 * makes it a decision instead of free damage is that the new share is mitigated by a
 * DIFFERENT resistance, so it is worth more or less than 20% depending on the target.
 */
export type DamageShares = Record<Element, number>;

export function damageShares(
  save: SaveState,
  ctx: EffectContext,
  effects: Effect[] = equippedEffects(save, ctx),
): DamageShares {
  const shares = Object.fromEntries(ELEMENTS.map((e) => [e, 0])) as DamageShares;
  shares[equippedSkill(save).element] = 1;

  for (const e of effects) {
    if (e.kind === 'extraElement' && conditionHolds(e, ctx)) shares[e.element] += e.fraction;
  }
  return shares;
}

/**
 * A target's resistance to one element, after penetration and bounds.
 *
 * Penetration moves resistance TOWARD zero and never past it, so over-penetrating a
 * soft target is wasted rather than a bonus - `Math.min(resistance, 0)` is the floor
 * it may reach. A resistance that was already negative is a dungeon's vulnerability
 * and is left alone: penetration is for getting through armour, not for deepening a
 * weakness that is already yours.
 */
export function mitigatedResistance(resistance: number, penetration: number): number {
  const pierced = Math.max(Math.min(resistance, 0), resistance - Math.max(0, penetration));
  return Math.max(-MAX_VULNERABILITY, Math.min(MAX_RESISTANCE, pierced));
}

/**
 * What fraction of the loadout's raw DPS a given target actually takes.
 *
 * Exactly 1 when the shares are `{ own element: 1 }` and the target resists nothing,
 * which is the property that made this change safe to land: every existing loadout
 * against a zero-resistance target reproduces the previous numbers to the bit.
 */
export function elementalScale(
  shares: DamageShares,
  penetration: number,
  resist: Resistances,
): number {
  let total = 0;
  for (const element of ELEMENTS) {
    const share = shares[element];
    if (share === 0) continue;
    total += share * (1 - mitigatedResistance(resist[element], penetration));
  }
  // A negative share is not authored anywhere, but a floor here is cheaper than a
  // division by a negative dps somewhere downstream reporting a negative clear time.
  return Math.max(0, total);
}
