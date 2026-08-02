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

/**
 * The five damage types.
 *
 * `physical` is one of them rather than "the absence of an element", so there is one
 * mitigation path instead of two and a physical-resistant target is expressible. The
 * cost of the extra member is one entry in a resistance table; the cost of the special
 * case would be a branch in every place that reads a share.
 *
 * Deliberately NOT the same axis as SkillKind. Kind is physical-or-magical and decides
 * which resource the skill spends and which skill-level affixes apply to it; element
 * decides what the damage is mitigated by. Fireball is `kind: magical, element: fire`,
 * and a future physical spell would be `kind: magical, element: physical` without
 * either field lying about the other.
 *
 * `lightning` and `darkness` have no skill on day one and are live regardless, because
 * an "extra element" modifier can name any of them. No dead enum members, no art.
 */
export const ElementSchema = z.enum(['physical', 'fire', 'cold', 'lightning', 'darkness']);
export type Element = z.infer<typeof ElementSchema>;
export const ELEMENTS = ElementSchema.options;

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
  /**
   * Scales what every OTHER equipped item contributes.
   *
   * Applies to `flat` and `increased` only. `more` is already the compounding layer,
   * and multiplying a multiplier turns a bounded effect into an unbounded one - the
   * same reason a rollable affix may not use `more` at all.
   *
   * Never applies to itself, or it would compound against its own downside and two
   * copies would compound against each other.
   */
  z
    .object({
      kind: z.literal('amplifyOthers'),
      multiplier: z.number(),
      when: ConditionSchema.optional(),
    })
    .strict(),
  /**
   * Gain a fraction of your damage as extra damage of another element.
   *
   * A hit is not a number, it is SHARES of one number by element: the skill's own
   * element at 1, plus a fraction for every one of these. The dps a target actually
   * takes is `damage x speed x critFactor x Σ share x mitigation(element)`.
   *
   * So against a target with no resistance `gain 20% as extra cold` is a flat 1.2x,
   * and against a cold-immune one it is nothing at all. That is the whole mechanic,
   * and it costs one map plus one stat rather than four damage pools with four sets
   * of layers.
   *
   * An effect rather than four stat keys for the same reason keyDrop is one: it is not
   * a number the character sheet has a row for, and four of them would be four rows
   * that are almost always zero.
   *
   * NOT amplified by amplifyOthers. It is neither `flat` nor `increased`; it is closer
   * to a `more` multiplier on part of the hit, and amplifying it would compound.
   */
  z
    .object({
      kind: z.literal('extraElement'),
      element: ElementSchema,
      /** Share of base damage added, so 0.03 is "gain 3% as extra". */
      fraction: z.number(),
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

/**
 * What a trash kill drops, as opposed to what a CLEAR drops.
 *
 * Wave loot is material and clear loot is the chase. A wave drop is something to
 * dissemble on the way past; the item you are hunting still comes from finishing the
 * stage or killing the boss.
 *
 * **Unique is zero, and that is structural rather than flavour.** Uniques are 2% of
 * drops and an ancient is roughly one item in a thousand. Wave loot multiplies drop
 * volume several times over, so leaving this table equal to RARITY_WEIGHTS would
 * multiply the unique rate with it and quietly undo the tier weights - the rarity of a
 * given unique would become a function of how many trash enemies a stage happens to
 * have. Volume changes what you have to dissemble, never what you are hunting.
 */
export const WAVE_RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 80,
  magic: 17,
  rare: 3,
  unique: 0,
};

/**
 * How a dropped tablet's rarity rolls.
 *
 * **Unique is zero and cannot be anything else.** A tablet's rarity is a row count, and
 * a unique rolls no rows at all - drawing one would hand back a tablet with no base, no
 * modifiers and no implicit. There is no authored tablet to be unique.
 *
 * Weighted toward common far more than gear is, because rarity here is a difficulty
 * dial as much as a reward one: a rare tablet carries six modifiers, every one of which
 * is pure danger. A player who mostly finds commons can choose to make them rarer with
 * currency, which is the whole point of a craftable consumable.
 */
export const TABLET_RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 62,
  magic: 30,
  rare: 8,
  unique: 0,
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
  | { kind: 'goldOnKill' }
  /** The element is part of the affix's identity; only the fraction comes from a tier. */
  | { kind: 'extraElement'; element: Element }
  /**
   * Buff the RUN, not the character. Tablets only.
   *
   * The one template that deliberately produces no `Effect` at all - `affixEffect`
   * returns null for it, so a tablet's modifiers are structurally incapable of reaching
   * `deriveStats`. That is a stronger guarantee than keeping tablets in a separate type
   * gave: it holds even if a tablet somehow ends up in the loadout, because there is no
   * code path from this template to a stat.
   *
   * The magnitude is a fraction added to the run's danger, so 0.35 is "+35% harder".
   * Which axis it lands on is the affix's identity; only the size comes from a tier.
   */
  | { kind: 'monsterBuff'; axis: MonsterAxis }
  /**
   * A tablet's implicit: what the run pays out in.
   *
   * The other half of the same idea, and it produces no `Effect` either. Which axis it
   * pays is the BASE's identity rather than the affix's, so this template carries no
   * field at all - `tabletReward` reads `pays` off the base and the magnitude off the
   * roll. That keeps "a Gilded Tablet pays gold" in one place instead of two that could
   * disagree.
   */
  | { kind: 'tabletReward' };

/**
 * What a tablet modifier makes worse.
 *
 * Four axes rather than one number, because they are not interchangeable inside a run
 * where damage accumulates and never resets:
 *
 *   hp      lengthens every fight, and pushes at the time limit
 *   damage  shortens how long you survive one
 *   count   more enemies per wave - raises clear time AND incoming together
 *   waves   more fights against the same pool of health, so pure exposure
 *
 * `waves` is the one that only exists because HP carries across. In a run that healed
 * between fights it would be a time cost and nothing more.
 */
export const MONSTER_AXES = ['hp', 'damage', 'count', 'waves'] as const;
export type MonsterAxis = (typeof MONSTER_AXES)[number];

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
   * Where this affix may roll. Absent means anywhere a CHARACTER can wear it.
   *
   * More than two values, because "gear only" is as load-bearing as "weapons only".
   * Without it a weapon rolls everything gear does plus its own exclusives, so gear is
   * strictly a weapon with fewer options - and the four gear slots become a place to
   * put leftovers.
   *
   * The division is offence-and-resource against defence-and-economy. A weapon
   * cannot roll max HP or gold find; gear cannot roll skill levels. So the two are
   * different objects rather than the same object with different numbers, and
   * `+2 to Physical Skill Levels` never appears on a wand as a dead row.
   *
   * `'tablet'` is the one value that partitions rather than divides. "Absent means
   * anywhere" would otherwise let every gear affix roll on a tablet, so `eligibleAffixes`
   * treats it as a closed set in both directions: a tablet rolls only tablet affixes, and
   * nothing else ever rolls one. `validateRegistry` asserts both halves - the partition
   * is what makes a tablet safe to store as an ItemInstance.
   */
  rollsOn?: 'gear' | 'tablet' | SkillKind;
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
  /**
   * Which reward this base pays, for tablets. Absent on everything else.
   *
   * Presence of this field is what makes a base a TABLET, following the same rule
   * `skillId` set for weapons: one field, so there is no second flag that could
   * disagree about what kind of thing this is.
   *
   * It names the axis the implicit multiplies. Which axis is the base's identity -
   * choosing a Gilded Tablet over a Hoarding one is the same decision as choosing a
   * Whetstone over a Purse, and for the same reason: the implicit is the guaranteed
   * half, and the explicits are the lottery.
   */
  pays?: TabletPays;
  /**
   * Which accessory slot this base goes in. Absent on everything else.
   *
   * The third field in the same family as `skillId` and `pays`: presence makes a base an
   * accessory, and the value says which of the two slot kinds it fits. One field, so
   * there is no separate flag to keep in agreement with it.
   */
  wear?: AccessorySlot;
}

/**
 * The two accessory slot kinds.
 *
 * Rings and amulets differ ONLY in how many you can wear - two against one - and in
 * which bases fit. Every base of either kind can build offence or defence, deliberately:
 * if rings were the offensive slot and amulets the defensive one, a defensive character
 * could not use two of its three accessory slots at all, which is the offence/defence
 * asymmetry arriving structurally on the day the feature ships.
 */
export const ACCESSORY_WEARS = ['ring', 'amulet'] as const;
export type AccessorySlot = (typeof ACCESSORY_WEARS)[number];

/**
 * What a tablet's implicit pays out in.
 *
 * One axis per base, never several. A tablet that raised every reward at once would
 * make the bases interchangeable, and picking one up would stop being a decision about
 * what you are short of.
 */
export const TABLET_PAYS = ['quantity', 'rarity', 'gold'] as const;
export type TabletPays = (typeof TABLET_PAYS)[number];

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
    /**
     * What this skill's damage is, for mitigation purposes.
     *
     * The skill carrying the element is what keeps damage a single number. Weapons
     * already grant skills, so which weapon you bring IS the elemental decision, made
     * in a slot that already exists - and "gain X% as extra" modifiers are what stop
     * it being a fixed property of that weapon.
     *
     * Separate from `kind`, which is physical-or-magical and drives the resource label
     * and which skill-level affixes apply. See ElementSchema.
     */
    element: ElementSchema,
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
  z
    .object({
      kind: z.literal('amplifyOthers'),
      roll: RollRangeSchema,
      when: ConditionSchema.optional(),
    })
    .strict(),
  /**
   * The element is authored and only the fraction rolls.
   *
   * Which element an item converts to is its identity, not its quality - a lucky drop
   * should be a bigger version of the same item, not a different one.
   */
  z
    .object({
      kind: z.literal('extraElement'),
      element: ElementSchema,
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
