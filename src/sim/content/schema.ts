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
   * Restricts this affix to weapons of one kind. Absent means "rolls on anything".
   *
   * What makes a physical item and a magical item different objects rather than the
   * same item with different numbers: `+2 to Physical Skill Levels` on a wand would
   * be a dead row, so it never rolls there.
   */
  weapons?: SkillKind;
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
  })
  .strict();

export type Skill = z.infer<typeof SkillSchema>;

/** An authored unique. Fixed effects, never rolled, never rerolled. */
export const UniqueSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    sprite: z.string().min(1),
    /** Earliest stage this can drop from. */
    dropStage: z.number().int().min(1),
    effects: z.array(EffectSchema).min(1),
  })
  .strict();

export type Unique = z.infer<typeof UniqueSchema>;
