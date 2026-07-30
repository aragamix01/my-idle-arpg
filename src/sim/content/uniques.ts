/**
 * Uniques.
 *
 * The one class of item whose EFFECTS are authored rather than drawn from a pool.
 * Which modifiers a unique carries never changes; how big they are is rolled inside
 * an authored range, once, at drop.
 *
 * That split is the whole design. A fixed unique is a checkbox - the second copy is
 * worthless the moment the first drops, and the item stops being content the day you
 * find it. A rolled one is a chase: the item starts the hunt and the roll is the
 * hunt. It also gives Angel Flame something to do on a unique, which is the only
 * currency that touches one.
 *
 * These are also where conditional effects live. Rolled affixes are unconditional by
 * design (a condition on a random mod is very hard to price), so uniques carry the
 * interesting shapes: execute thresholds, boss-only damage, stage gates.
 *
 * They are also the only content that uses the `more` layer. Nothing in the rollable
 * affix pool compounds; a unique does, and that is what makes one feel like a
 * different class of item rather than a rare with a name. It is safe here for the
 * same reason it is safe on the gold upgrade tracks and unsafe on a rollable affix -
 * the list is authored and finite, so the ceiling is known. A RANGE does not change
 * that: the ceiling is the top of the range, which is still authored.
 *
 * ## Ranges are centred on what the fixed value used to be
 *
 * Every range below brackets the number this unique carried before ranges existed.
 * So the average roll is the old item, a good roll beats it, and a bad one does not
 * make the roster weaker on average - the ladder is tuned against these and a
 * wholesale power shift would have to be re-measured rather than assumed.
 */

import type { Rng } from '../rng';
import { UNIQUE_TIER_WEIGHTS, type Effect, type Unique, type UniqueTier } from './schema';

export const UNIQUES = [
  {
    id: 'whetstone',
    name: 'The Whetstone',
    sprite: 'item.whetstone',
    dropStage: 1,
    tier: 'lesser',
    effects: [{ kind: 'statMod', stat: 'damage', op: 'more', roll: { min: 1.2, max: 1.5 } }],
  },
  {
    id: 'quickdraw-glove',
    name: 'Quickdraw Glove',
    sprite: 'item.quickdraw_glove',
    dropStage: 1,
    tier: 'lesser',
    effects: [{ kind: 'statMod', stat: 'attackSpeed', op: 'more', roll: { min: 1.18, max: 1.42 } }],
  },
  {
    id: 'coin-purse',
    name: 'Bottomless Purse',
    sprite: 'item.coin_purse',
    dropStage: 3,
    tier: 'lesser',
    effects: [{ kind: 'goldOnKill', roll: { min: 0.4, max: 0.8 } }],
  },
  {
    id: 'executioners-mark',
    name: "Executioner's Mark",
    sprite: 'item.executioners_mark',
    dropStage: 8,
    tier: 'greater',
    effects: [
      {
        kind: 'statMod',
        stat: 'damage',
        op: 'more',
        roll: { min: 1.6, max: 2.2 },
        when: { enemyHpBelow: 0.3 },
      },
    ],
  },
  {
    id: 'giant-slayer',
    name: 'Giant Slayer',
    sprite: 'item.giant_slayer',
    dropStage: 12,
    tier: 'greater',
    effects: [
      {
        kind: 'statMod',
        stat: 'damage',
        op: 'more',
        roll: { min: 1.45, max: 1.95 },
        when: { isBoss: true },
      },
      // The downside does NOT roll. A range on the cost would let a lucky drop be
      // strictly better than an unlucky one on both halves, and the trade is the
      // item's identity - it should be the same trade for everyone who owns it.
      { kind: 'statMod', stat: 'area', op: 'flat', roll: { min: -1, max: -1 } },
    ],
  },
  {
    id: 'swarm-lens',
    name: 'Swarm Lens',
    sprite: 'item.swarm_lens',
    dropStage: 20,
    tier: 'greater',
    effects: [
      { kind: 'statMod', stat: 'area', op: 'flat', roll: { min: 3, max: 5 } },
      { kind: 'statMod', stat: 'damage', op: 'more', roll: { min: 0.8, max: 0.8 } },
    ],
  },
  {
    id: 'bloodstone',
    name: 'Bloodstone',
    sprite: 'item.bloodstone',
    dropStage: 25,
    tier: 'ancient',
    effects: [
      { kind: 'statMod', stat: 'critChance', op: 'flat', roll: { min: 0.12, max: 0.24 } },
      { kind: 'statMod', stat: 'critMult', op: 'flat', roll: { min: 0.4, max: 0.8 } },
      { kind: 'statMod', stat: 'maxHp', op: 'more', roll: { min: 0.75, max: 0.75 } },
    ],
  },
  {
    id: 'deep-delvers-idol',
    name: "Deep Delver's Idol",
    sprite: 'item.deep_delvers_idol',
    dropStage: 40,
    tier: 'ancient',
    effects: [
      {
        kind: 'statMod',
        stat: 'goldFind',
        op: 'more',
        roll: { min: 1.6, max: 2.4 },
        when: { stageAtLeast: 40 },
      },
      { kind: 'goldOnKill', roll: { min: 0.35, max: 0.65 }, when: { isBoss: true } },
    ],
  },
  {
    /**
     * Crit, traded away entirely, for the largest raw multiplier in the game.
     *
     * `more 0` on crit chance rather than a large negative: a subtraction leaves a
     * build free to buy the loss back, and then this is simply a damage unique with
     * a tax. Zero is zero - the crit track, every crit affix and the skill's own base
     * crit all stop mattering the moment it is equipped, and that is a real decision
     * about what the rest of the loadout is for.
     *
     * The payoff is `increased`, and the first cut had it as `more 1.7-2.6`. Four
     * copies of that is 45x damage from an uncrafted loadout, which the stacked-
     * uniques test caught immediately - `more` compounds, so any large one is a
     * stacking problem rather than an item. `increased` lands in the sum every
     * damage affix lands in, so a second copy is worth less than the first and the
     * ceiling is the same one the affix pool already lives under.
     */
    id: 'berserkers-anvil',
    name: "Berserker's Anvil",
    sprite: 'item.berserkers_anvil',
    dropStage: 15,
    tier: 'greater',
    effects: [
      { kind: 'statMod', stat: 'critChance', op: 'more', roll: { min: 0, max: 0 } },
      { kind: 'statMod', stat: 'damage', op: 'increased', roll: { min: 0.7, max: 1.2 } },
    ],
  },
  {
    /**
     * The other side of the same question: crit as the whole build.
     *
     * `increased` on both halves, not `more`. Crit multiplier already multiplies into
     * DPS through critFactor, so a `more` on it compounds twice over - the rule the
     * registry enforces on rollable affixes and holds authored content to as well.
     */
    id: 'duelists-visor',
    name: "Duelist's Visor",
    sprite: 'item.duelists_visor',
    dropStage: 18,
    tier: 'greater',
    effects: [
      { kind: 'statMod', stat: 'critMult', op: 'increased', roll: { min: 0.6, max: 1.4 } },
      { kind: 'statMod', stat: 'critChance', op: 'increased', roll: { min: -0.5, max: -0.3 } },
    ],
  },
  {
    /**
     * Gold traded for keys - the first unique that pays in something other than
     * numbers on the character sheet.
     *
     * Keys gate dungeons, dungeons are the only source of finished currency, and
     * currency is the only route to a crafted item. So this buys crafting throughput
     * with farm rate, which is a different axis from every other unique in the list.
     */
    id: 'wardens-coffer',
    name: "Warden's Coffer",
    sprite: 'item.wardens_coffer',
    dropStage: 22,
    tier: 'greater',
    effects: [
      { kind: 'keyDrop', roll: { min: 1.6, max: 2.4 } },
      // The roadmap asked for -30% to -60% gold. That is priced against a game where
      // gold is one currency among several; here it is the engine every upgrade
      // track runs on, so halving it costs more than doubled keys can pay back and
      // the item would be a trap rather than a trade.
      { kind: 'statMod', stat: 'goldFind', op: 'increased', roll: { min: -0.4, max: -0.2 } },
    ],
  },
  {
    /**
     * The defensive chase item, and the roster fails structurally without one.
     *
     * Every other unique is offence or economy. A tier whose best items are all
     * offensive breaks the offence/defence symmetry invariant the same way the affix
     * pool broke it twice - the ceiling on one side rises and the other cannot
     * follow, and the ladder resolves that by killing the player.
     *
     * The downside is a constant: this is the item you equip when you are dying, and
     * a roll that made it better on both halves would remove the decision.
     */
    id: 'bulwark-of-the-deep',
    name: 'Bulwark of the Deep',
    sprite: 'item.bulwark_of_the_deep',
    dropStage: 30,
    tier: 'ancient',
    effects: [
      { kind: 'statMod', stat: 'toughness', op: 'more', roll: { min: 1.4, max: 1.9 } },
      { kind: 'statMod', stat: 'damage', op: 'more', roll: { min: 0.75, max: 0.75 } },
    ],
  },
] as const satisfies readonly Unique[];

export type UniqueId = (typeof UNIQUES)[number]['id'];

const byId = new Map<string, Unique>(UNIQUES.map((u) => [u.id, u]));

export function getUnique(id: string): Unique | undefined {
  return byId.get(id);
}

/** Uniques whose drop stage this item level satisfies. */
export function uniquesFor(stage: number): Unique[] {
  return UNIQUES.filter((u) => u.dropStage <= stage);
}

/**
 * Which unique drops: tier first, then uniformly inside that tier.
 *
 * Two rolls rather than one weighted pick over the roster, because the weight has to
 * survive the stage gate. Weighting the flat list means an ancient gated at stage 40
 * silently doubles every early unique's share until stage 40 and then halves it
 * again - the rarity of a given item would depend on which OTHER items happen to be
 * unlocked. Renormalising among the tiers that have something eligible keeps each
 * tier's share the same at every depth.
 *
 * Returns null only when nothing is eligible at all, which callers already handle.
 */
export function pickUnique(stage: number, rng: Rng): Unique | null {
  const eligible = uniquesFor(stage);
  if (eligible.length === 0) return null;

  const tiers = (Object.keys(UNIQUE_TIER_WEIGHTS) as UniqueTier[]).filter((tier) =>
    eligible.some((u) => u.tier === tier),
  );
  const total = tiers.reduce((sum, tier) => sum + UNIQUE_TIER_WEIGHTS[tier], 0);

  let roll = rng.next() * total;
  let chosen = tiers[tiers.length - 1];
  for (const tier of tiers) {
    roll -= UNIQUE_TIER_WEIGHTS[tier];
    if (roll <= 0) {
      chosen = tier;
      break;
    }
  }

  const pool = eligible.filter((u) => u.tier === chosen);
  return pool[rng.int(pool.length)];
}

/**
 * Two decimals, because a roll is read before it is felt.
 *
 * `1.3874262` and `1.39` are the same item to the sim and a very different item to
 * read, and the panel showing a number the save does not hold is how a display and a
 * simulation start disagreeing.
 */
const QUANTUM = 100;

/** Roll one magnitude per authored effect, in registry order. */
export function rollUniqueValues(unique: Unique, rng: Rng): number[] {
  return unique.effects.map(({ roll }) => {
    const value = Math.round((roll.min + rng.next() * (roll.max - roll.min)) * QUANTUM) / QUANTUM;
    // Clamped after rounding, not before. A bound that is not itself a multiple of
    // the quantum can round outward, and an item a hundredth above its authored
    // maximum is exactly the kind of thing nobody notices until a range is retuned.
    return Math.min(roll.max, Math.max(roll.min, value));
  });
}

/**
 * The concrete effects a unique instance contributes.
 *
 * Falls back to the midpoint per effect when the instance carries no rolls, which is
 * every unique that dropped before ranges existed. Midpoint rather than minimum:
 * these items were authored at what is now the centre of their range, so the average
 * roll IS what their owner has been playing with.
 */
export function uniqueEffects(unique: Unique, rolls: number[] | undefined): Effect[] {
  return unique.effects.map((effect, i) => {
    const value = rolls?.[i] ?? (effect.roll.min + effect.roll.max) / 2;
    const when = effect.when ? { when: effect.when } : {};
    if (effect.kind === 'goldOnKill') return { kind: 'goldOnKill', multiplier: value, ...when };
    if (effect.kind === 'keyDrop') return { kind: 'keyDrop', multiplier: value, ...when };
    return { kind: 'statMod', stat: effect.stat, op: effect.op, value, ...when };
  });
}

/**
 * Where a roll sits in its range, 0..1 - or null when the range is a single value.
 *
 * Null rather than 1: an authored constant has no quality to report, and rendering
 * Swarm Lens's fixed downside as a perfect roll would read as luck a player can
 * chase. Only the halves that actually vary get a percentage.
 */
export function rollQuality(unique: Unique, rolls: number[] | undefined, i: number): number | null {
  const range = unique.effects[i]?.roll;
  if (!range || range.max === range.min) return null;
  const value = rolls?.[i] ?? (range.min + range.max) / 2;
  return Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
}
