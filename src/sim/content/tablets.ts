/**
 * Abyssal tablets.
 *
 * A tablet is one run: spent on entry, spent on a loss. It carries a TIER, which decides
 * how deep the Abyss is, and MODIFIERS, which decide what that depth is worth.
 *
 * ## Why tablet modifiers are not Effects
 *
 * Every `Effect` in this codebase flows into `deriveStats` and changes the CHARACTER.
 * None of these do - they change the run. A tablet does not make you stronger, it makes
 * the fight harder and the payout larger, and putting that through the stat machinery
 * would mean a modifier that raises "monster damage" landing in the same bucket as one
 * that raises your own.
 *
 * So this is its own small vocabulary, and it stays small on purpose.
 *
 * ## Every modifier is a trade
 *
 * A tablet mod raises DANGER and REWARD together. That is the entire design: a heavily
 * modified tablet is a bigger gamble, not a bigger prize, and crafting one is a decision
 * about how much risk to buy rather than a strict upgrade.
 *
 *     difficulty = tier baseline x (1 + Σ danger)
 *     payout     = tier baseline x (1 + Σ reward)
 *
 * A mod with danger and no reward would be a punishment nobody would ever apply; one
 * with reward and no danger would make crafting mandatory rather than interesting.
 * validateRegistry enforces that both are present.
 */

import type { Rng } from '../rng';

/**
 * What a tablet modifier does to a run.
 *
 * `danger` and `reward` are fractions added to their respective sums, so 0.4 is +40%.
 * Both are always positive - the trade is expressed by every mod carrying both, not by
 * one of them being allowed to go negative.
 */
export interface TabletModDefinition {
  id: string;
  /** Composes the tablet's name, like an affix fragment. */
  nameFragment: string;
  /** One sentence, shown on the tablet. */
  description: string;
  danger: number;
  reward: number;
  /**
   * Which reward this one actually pays out in.
   *
   * A tablet that raised every reward at once would make the mods interchangeable. One
   * axis each means a player picks the tablet that pays what they are short of.
   */
  pays: 'currency' | 'items' | 'rarity' | 'gold';
  /**
   * Lowest tablet tier this may roll on.
   *
   * The tablet equivalent of an affix tier gate, and it needs its own scale: the affix
   * GATES are stage numbers (1, 15, 40, 80) and a tablet tier only ever reaches 15.
   */
  minTier: number;
}

/**
 * The pool.
 *
 * Deliberately short. Tablets are a difficulty dial with flavour, not a second affix
 * system - and every entry here multiplies against every other one, so a wide pool is a
 * combinatorial balance problem rather than more content.
 */
export const TABLET_MODS: TabletModDefinition[] = [
  {
    id: 'teeming',
    nameFragment: 'Teeming',
    description: 'The boss hits harder, and the Abyss gives up more currency.',
    danger: 0.35,
    reward: 0.5,
    pays: 'currency',
    minTier: 1,
  },
  {
    id: 'hoarding',
    nameFragment: 'Hoarding',
    description: 'A tougher fight, paid for in items.',
    danger: 0.3,
    reward: 0.45,
    pays: 'items',
    minTier: 1,
  },
  {
    id: 'gilded',
    nameFragment: 'Gilded',
    description: 'More dangerous, and far richer.',
    danger: 0.25,
    reward: 0.8,
    pays: 'gold',
    minTier: 1,
  },
  {
    /**
     * The rarity mod is gated deeper than the rest.
     *
     * Rarity is the one reward that reaches the power ceiling rather than the economy -
     * it changes what drops, not how much - so it is not something a first tablet should
     * be able to carry.
     */
    id: 'auspicious',
    nameFragment: 'Auspicious',
    description: 'What the Abyss drops is rarer, and what guards it is deadlier.',
    danger: 0.5,
    reward: 0.6,
    pays: 'rarity',
    minTier: 4,
  },
  {
    id: 'ravenous',
    nameFragment: 'Ravenous',
    description: 'Much deadlier, and the currency to justify it.',
    danger: 0.75,
    reward: 0.9,
    pays: 'currency',
    minTier: 7,
  },
  {
    id: 'abyssal',
    nameFragment: 'Abyssal',
    description: 'The deep notices you. Everything is worse, and everything pays.',
    danger: 1.1,
    reward: 1.2,
    pays: 'items',
    minTier: 11,
  },
];

const byId = new Map(TABLET_MODS.map((mod) => [mod.id, mod]));

export function getTabletMod(id: string): TabletModDefinition | undefined {
  return byId.get(id);
}

/** Mods a tablet of this tier may roll. Always at least one, or a tablet could roll none. */
export function availableTabletMods(tier: number): TabletModDefinition[] {
  const eligible = TABLET_MODS.filter((mod) => tier >= mod.minTier);
  return eligible.length > 0 ? eligible : [TABLET_MODS[0]];
}

/**
 * How many modifiers a tablet of this tier carries.
 *
 * Rises with tier, so a deep tablet is not merely a harder version of a shallow one -
 * it has more room to be shaped. Capped at three: the danger sum is multiplicative
 * against a tier curve that is already exponential, and four mods on a T15 is a fight
 * nothing can win.
 */
export function tabletModSlots(tier: number): number {
  if (tier >= 11) return 3;
  if (tier >= 5) return 2;
  return 1;
}

/**
 * One tablet.
 *
 * Its OWN shape, not an ItemInstance. The plan assumed a tablet could borrow that type
 * and inherit the craft engine with it, and that was wrong for a reason worth recording:
 * an ItemInstance's `affixes` are ids into the AFFIX registry, so `rerollAffixes` would
 * hand a tablet three points of increased crit chance and `describeRolledAffix` would
 * render every modifier as "unknown". The shapes look alike and the pools are disjoint,
 * which is the expensive kind of similarity.
 *
 * Four fields, and none of them are optional. A tablet is a tier, some mods, and enough
 * identity to reroll deterministically.
 */
export interface TabletInstance {
  /** Stable identity, from the same monotonic counter items use. */
  uid: string;
  /** 1..MAX_TABLET_TIER. What the Abyss is worth and how hard it hits. */
  tier: number;
  /** Ids into TABLET_MODS, in roll order. */
  mods: string[];
  /** Every reroll ever applied. Part of the roll seed, like an item's. */
  crafts: number;
}

/**
 * Roll a tablet's modifiers.
 *
 * Distinct within a tablet, for the same reason an item never rolls the same affix
 * twice: two Teemings would turn a trade into a stacking problem, and the danger sum
 * multiplies against a curve that is already exponential.
 */
export function rollTabletMods(tier: number, rng: Rng): string[] {
  const candidates = [...availableTabletMods(tier)];
  const slots = Math.min(tabletModSlots(tier), candidates.length);

  const rolled: string[] = [];
  for (let i = 0; i < slots; i++) {
    rolled.push(candidates.splice(rng.int(candidates.length), 1)[0].id);
  }
  return rolled;
}

/** What a tablet's modifiers add up to. Danger and reward are always both present. */
export function tabletTotals(tablet: TabletInstance): { danger: number; reward: number } {
  return tablet.mods.reduce(
    (totals, id) => {
      const mod = getTabletMod(id);
      // A mod id that no longer exists resolves to nothing rather than breaking the
      // tablet, the same tolerance itemEffects gives a retired affix.
      if (!mod) return totals;
      return { danger: totals.danger + mod.danger, reward: totals.reward + mod.reward };
    },
    { danger: 0, reward: 0 },
  );
}

/** Display name: "Teeming Gilded Tablet". */
export function tabletName(tablet: TabletInstance): string {
  const fragments = tablet.mods
    .map((id) => getTabletMod(id)?.nameFragment)
    .filter((fragment): fragment is string => Boolean(fragment));
  return [...fragments, 'Tablet'].join(' ');
}
