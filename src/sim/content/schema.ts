/**
 * Content is DATA, not closures.
 *
 * Effects are a discriminated union the sim interprets. This costs expressive
 * power — a novel effect needs a new `kind` plus interpreter support — and buys
 * serialisability, diffability, schema validation, and the option to move the
 * registry into the database later without rewriting anything.
 *
 * Affixes follow the same rule: a definition carries an effect *template* plus
 * a tier table of numbers, never a function. That is what lets a rolled affix
 * be stored in a save, displayed in the panel, and validated by a test.
 */

import { z } from 'zod';
import { STAT_KEYS, type StatKey } from '../types';

export const StatKeySchema = z.enum(STAT_KEYS);

/** Conditions are evaluated against EffectContext at stat-derivation time. */
export const ConditionSchema = z
  .object({
    /** Applies only when the target is at or below this HP fraction. */
    enemyHpBelow: z.number().min(0).max(1).optional(),
    /** Applies only against bosses (true) or only against trash (false). */
    isBoss: z.boolean().optional(),
    /** Applies only from this stage onward. */
    stageAtLeast: z.number().int().min(1).optional(),
  })
  .strict();

/**
 * Which of the three layers a modifier contributes to.
 *
 * The layer is the whole pricing model, not a formatting detail:
 *
 *   final = (base + Σ flat) × (1 + Σ increased) × Π more
 *
 * `flat` and `increased` both have **diminishing** marginal value - the tenth
 * `+20% increased` is worth far less than the first, because it lands in a sum
 * that is already large. Only `more` compounds.
 *
 * That is the fix for the problem this replaced. Every item modifier used to be
 * a multiplier, so N modifiers multiplied into a product and modifier N+1 was
 * worth *more* than modifier N. The budget could only be held by making every
 * value tiny - base implicits were squeezed down to 1.038 - and every new row of
 * content arrived into that squeeze. Now only the rare layer compounds, so the
 * common layers can carry readable numbers and adding a row is affordable.
 *
 * A consequence worth stating: for stats whose base is already a multiplier
 * (toughness, goldFind), `flat` and `increased` are the same operation. Those
 * stats only ever carry `increased` and `more`.
 */
export const ModLayerSchema = z.enum(['flat', 'increased', 'more']);
export type ModLayer = z.infer<typeof ModLayerSchema>;

export const EffectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('statMod'),
      stat: StatKeySchema,
      /**
       * Which layer this lands in. Layers resolve in a fixed order, so ordering
       * within a layer never changes the result - the property that makes two
       * loadouts comparable.
       */
      op: ModLayerSchema,
      value: z.number(),
      when: ConditionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goldOnKill'),
      /** Flat gold added per kill, scaled by stage gold value. */
      multiplier: z.number(),
      when: ConditionSchema.optional(),
    })
    .strict(),
  /**
   * Multiplies the chance a stage boss drops a dungeon key.
   *
   * A third kind rather than a stat, because a key is not part of any stat block -
   * it is a drop roll, made once per clear, outside the loadout's stat maths
   * entirely. Modelling it as a stat would mean a number on the character sheet that
   * nothing on the character sheet uses.
   *
   * The chance is clamped at certainty, so stacking these has a real ceiling.
   */
  z
    .object({
      kind: z.literal('keyDrop'),
      multiplier: z.number(),
      when: ConditionSchema.optional(),
    })
    .strict(),
  /**
   * Changes how many gear slots the character has.
   *
   * A fourth kind rather than a stat, for the same reason keyDrop is one: a slot count
   * is an integer the layer machinery has nothing to say about. Running it through
   * `(base + flat) x (1 + increased) x more` would mean a loadout of 4.7 slots.
   *
   * Only items in the first ITEM_SLOTS positions are consulted - see equipSlots().
   */
  z
    .object({
      kind: z.literal('equipSlots'),
      delta: z.number().int(),
      when: ConditionSchema.optional(),
    })
    .strict(),
]);

export type Effect = z.infer<typeof EffectSchema>;
export type Condition = z.infer<typeof ConditionSchema>;

// --- Rarity ---------------------------------------------------------------

export const RaritySchema = z.enum(['common', 'magic', 'rare', 'unique']);
export type Rarity = z.infer<typeof RaritySchema>;

/**
 * How many affixes each rarity carries.
 *
 * A clean one-two-three per side. This is what the layer system bought: under the
 * old all-multiplier model a fifth and sixth row compounded onto everything
 * already there, so widening the rows meant either blowing the power budget or
 * shrinking every value again. Rows that land in a *sum* have falling marginal
 * value, so the extra ones are affordable.
 *
 * Note what widened and what did not. The overall power ceiling is deliberately
 * held near where it was - the ladder is tuned against it - so per-affix values
 * came down to pay for the new rows. What the player gains is not raw power but
 * surface: more modifiers to read, more crafting decisions, and a much wider gap
 * between a common and a rare. A common at 1/1 against a rare at 3/3 is a far
 * bigger step than 1/0 against 2/2 ever was, so rarity means more than it did.
 *
 * Uniques roll nothing - their effects are authored and fixed, which is the
 * whole point of a unique.
 */
export const AFFIX_LIMITS: Record<Rarity, { prefix: number; suffix: number }> = {
  common: { prefix: 1, suffix: 1 },
  magic: { prefix: 2, suffix: 2 },
  rare: { prefix: 3, suffix: 3 },
  unique: { prefix: 0, suffix: 0 },
};

/** Relative drop weights. Rolled once per drop; every clear yields an item. */
export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 55,
  magic: 30,
  rare: 13,
  unique: 2,
};

// --- Affixes --------------------------------------------------------------

export type AffixKind = 'prefix' | 'suffix';

/**
 * What an affix does, minus its magnitude.
 *
 * Deliberately not a function taking a value. A template plus a number is data
 * that can be validated and diffed; a factory closure is neither.
 */
export type AffixEffectTemplate =
  | { kind: 'statMod'; stat: StatKey; op: ModLayer }
  | { kind: 'goldOnKill' };

export interface AffixTier {
  /** Lowest item level that may roll this tier. */
  minStage: number;
  /**
   * The magnitude, read according to the template's layer.
   *
   * `flat` - added to the stat's base, in the stat's own units.
   * `increased` - a fraction, so 0.08 means +8%.
   * `more` - the multiplier itself, so 1.2 means 20% more.
   */
  value: number;
}

export interface AffixDefinition {
  id: string;
  kind: AffixKind;
  /** Composes item names: 'Brutal' + base, or base + 'of Haste'. */
  nameFragment: string;
  effect: AffixEffectTemplate;
  /**
   * Where this affix may roll. Absent means anywhere.
   *
   * Three values rather than two, because "gear only" is as load-bearing as
   * "weapons only". Without it a weapon rolls everything gear does plus its own
   * exclusives, so gear is strictly a weapon with fewer options - and the four gear
   * slots become a place to put leftovers.
   *
   * The division is offence-and-resource against defence-and-economy. A weapon
   * cannot roll max HP or gold find; gear cannot roll skill levels. So the two are
   * different objects rather than the same object with different numbers, and
   * `+2 to Physical Skill Levels` never appears on a wand as a dead row.
   */
  rollsOn?: 'gear' | SkillKind;
  /** Ascending by strength. Index 0 is the weakest and always available. */
  tiers: AffixTier[];
}

/** A rolled affix as stored on an item. */
export const RolledAffixSchema = z
  .object({
    affixId: z.string().min(1),
    /** Index into the definition's tier table. */
    tier: z.number().int().min(0),
    /**
     * The rolled magnitude, stored rather than looked up.
     *
     * Retuning a tier table must not silently restat items already sitting in
     * someone's inventory, and the panel must show exactly what the sim applies.
     */
    value: z.number(),
  })
  .strict();

export type RolledAffix = z.infer<typeof RolledAffixSchema>;

// --- Items ----------------------------------------------------------------

export const ItemInstanceSchema = z
  .object({
    /** Stable identity. The loadout stores these, not indices. */
    uid: z.string().min(1),
    baseId: z.string().min(1),
    rarity: RaritySchema,
    /** Stage it dropped at. Caps which affix tiers it may ever roll. */
    itemLevel: z.number().int().min(1),
    affixes: z.array(RolledAffixSchema),
    /**
     * The base type's implicit, rolled once at drop and never rerollable.
     *
     * Optional for two reasons: uniques have none, and items that dropped
     * before implicits existed keep working without one rather than being
     * wiped. Everything reading it must tolerate absence.
     */
    baseAffix: RolledAffixSchema.optional(),
    /**
     * Prior *gold* rerolls. Feeds the gold cost curve only.
     *
     * Separate from `crafts` on purpose: spending currency must not silently
     * inflate the price of a gold reroll, or the two systems tax each other.
     */
    rerolls: z.number().int().min(0),
    /**
     * Every modifying operation ever applied, gold or currency. Part of the
     * roll seed, so two different crafts never draw the same numbers.
     */
    crafts: z.number().int().min(0),
    /**
     * The one spirit applied to this item, if any. Permanent and exclusive.
     */
    spirit: z.string().optional(),
    /**
     * The affix rows that spirit traded, stored rather than recomputed.
     *
     * Dune's trade is random, so recomputing it from the spirit id alone would
     * give a different answer every call - and the panel and the sim would
     * disagree about how many modifiers the item has.
     */
    spiritDelta: z.object({ prefix: z.number().int(), suffix: z.number().int() }).strict().optional(),
    /** Set only on uniques, naming the authored entry in the unique registry. */
    uniqueId: z.string().optional(),
    /**
     * One rolled magnitude per authored effect, in the registry's order.
     *
     * Stored rather than derived for the same reason a RolledAffix stores its value:
     * the roll IS the item. Recomputing it from the id would make every copy of a
     * unique identical again, and retuning a range would restat one already owned.
     *
     * Optional because uniques predating ranges have none. Everything reading it
     * falls back to the range's midpoint, so an old item is neither bricked nor
     * silently promoted to a perfect roll.
     */
    uniqueRolls: z.array(z.number()).optional(),
  })
  .strict();

export type ItemInstance = z.infer<typeof ItemInstanceSchema>;

/** A base type: the name and icon an item is built on. */
export interface ItemBase {
  id: string;
  name: string;
  /** Logical sprite ID — never a filename. Resolved via the atlas sprite map. */
  sprite: string;
  /**
   * The skill this base grants, for weapons. Absent on gear.
   *
   * Presence of this field is what makes a base a weapon - there is no separate
   * `slot` flag to keep in agreement with it.
   */
  skillId?: string;
}

// --- Skills ---------------------------------------------------------------

export const SkillKindSchema = z.enum(['physical', 'magical']);
export type SkillKind = z.infer<typeof SkillKindSchema>;

/**
 * A skill, granted by the equipped weapon.
 *
 * Skills supply the `base` the three layers build on, which is why introducing them
 * is a small change rather than another formula rework: `base` was only ever a
 * constant sitting in BASE_STATS, and a skill replacing that constant leaves the
 * layers, the affix pool and the currency untouched.
 *
 * The four bases below are exactly the four stats a skill owns. Everything else -
 * max HP, toughness, gold find, crit damage - stays global, because none of them
 * describe how you attack.
 */
export const SkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: SkillKindSchema,
    /** Damage per hit before any modifier. */
    baseDamage: z.number().positive(),
    /** Hits or casts per second before any modifier. */
    baseSpeed: z.number().positive(),
    /**
     * Chance to crit before any modifier.
     *
     * This is where the two playstyles diverge without a mechanic being removed.
     * Physical skills carry a real base; spells carry near-zero. Both can still use
     * every crit affix in the pool - four of the nine suffixes are crit affixes, and
     * making those dead for casters would halve a caster's suffix pool.
     */
    baseCritChance: z.number().min(0).max(1),
    /**
     * Enemies struck at once.
     *
     * The axis the whole design turns on. resolveStage multiplies damage by
     * min(area, enemyCount) through the trash phase and ignores area entirely on the
     * boss, so a wide skill clears waves and duels badly, and a narrow one does the
     * reverse. The 75s limit applies to the total, so each is a real failure mode.
     */
    baseArea: z.number().positive(),
    /**
     * Resource spent per use - stamina on a physical skill, mana on a magical one.
     *
     * One system with two labels. The maths is identical and only the name the UI
     * prints differs, because two implementations of one idea would double the stat
     * surface and buy nothing. What actually differs is the NUMBER: a cheap cost
     * against fast regen binds late, an expensive one binds immediately.
     */
    resourceCost: z.number().positive(),
  })
  .strict();

export type Skill = z.infer<typeof SkillSchema>;

// --- Uniques --------------------------------------------------------------

/**
 * How hard a unique is to obtain, and nothing else.
 *
 * Separate from `dropStage`, which says WHEN one becomes possible. A tier says how
 * often, so the two dials are independent: a shallow-gated unique can still be the
 * rarest thing in the game, and a deep gate is not forced to also be rare.
 *
 * Three tiers rather than a per-unique weight. A weight per entry drifts - every
 * addition silently rebalances every other one, because what matters is the share of
 * a total nobody is looking at. Tiers make the roster's shape reviewable: count the
 * ancients.
 */
export const UniqueTierSchema = z.enum(['lesser', 'greater', 'ancient']);
export type UniqueTier = z.infer<typeof UniqueTierSchema>;

/** Relative weights, rolled among the tiers that have an eligible unique. */
export const UNIQUE_TIER_WEIGHTS: Record<UniqueTier, number> = {
  lesser: 68,
  greater: 27,
  ancient: 5,
};

/**
 * The range a unique's value rolls in.
 *
 * This is what makes a unique a chase rather than a checkbox. Under fixed values the
 * second copy of an item was worthless the moment the first dropped; with a range,
 * the item is the start of the hunt and the roll is the hunt itself.
 *
 * Rolled once at drop and stored on the instance, exactly like an affix magnitude -
 * an authored range that is retuned later must not restat what someone already owns.
 */
export const RollRangeSchema = z
  .object({ min: z.number(), max: z.number() })
  .strict()
  .refine((r) => r.max >= r.min, { message: 'max must not be below min' });

export type RollRange = z.infer<typeof RollRangeSchema>;

/**
 * An authored effect with a range in place of its magnitude.
 *
 * Mirrors EffectSchema variant for variant on purpose: resolving one is substituting
 * a number, so the interpreter never learns that uniques exist.
 */
export const UniqueEffectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('statMod'),
      stat: StatKeySchema,
      op: ModLayerSchema,
      roll: RollRangeSchema,
      when: ConditionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goldOnKill'),
      roll: RollRangeSchema,
      when: ConditionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('keyDrop'),
      roll: RollRangeSchema,
      when: ConditionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('equipSlots'),
      roll: RollRangeSchema,
      when: ConditionSchema.optional(),
    })
    .strict(),
]);

export type UniqueEffect = z.infer<typeof UniqueEffectSchema>;

/** An authored unique. Which effects it has is fixed; how big they are is rolled. */
export const UniqueSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    sprite: z.string().min(1),
    /** Earliest stage this can drop from. */
    dropStage: z.number().int().min(1),
    /** Drop weight, independent of the stage gate. */
    tier: UniqueTierSchema,
    effects: z.array(UniqueEffectSchema).min(1),
  })
  .strict();

export type Unique = z.infer<typeof UniqueSchema>;
