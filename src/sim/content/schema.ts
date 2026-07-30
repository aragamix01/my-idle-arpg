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
 * Uniques roll nothing - their effects are authored and fixed, which is the
 * whole point of a unique.
 */
export const AFFIX_LIMITS: Record<Rarity, { prefix: number; suffix: number }> = {
  common: { prefix: 1, suffix: 0 },
  magic: { prefix: 1, suffix: 1 },
  rare: { prefix: 2, suffix: 2 },
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
}

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
