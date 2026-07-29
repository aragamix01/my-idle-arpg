/**
 * Item rolling.
 *
 * Every roll here is a pure function of (account seed, item uid, reroll count).
 * That is not a stylistic preference: the client applies commands optimistically
 * and the server re-runs the same code, so a drop the two disagree about would
 * show the player an item they do not own. Nothing in this file may reach for
 * Math.random - the ESLint boundary enforces it.
 */

import {
  AFFIX_LIMITS,
  RARITY_WEIGHTS,
  type AffixDefinition,
  type Effect,
  type ItemInstance,
  type Rarity,
  type RolledAffix,
} from './content/schema';
import { availableTiers, getAffix, PREFIXES, SUFFIXES } from './content/affixes';
import { BASES, getBase, getBaseAffix } from './content/bases';
import { getUnique, uniquesFor } from './content/uniques';
import { DROPS_PER_CLEAR } from './curves';
import { createRng, type Rng } from './rng';

/** Arbitrary large odd multiplier, so reroll streams never collide with drops. */
const REROLL_STREAM = 0x9e3779b1;

/** Likewise for the per-clear drop-count stream. */
const DROP_COUNT_STREAM = 0x85eb_ca6b;

/** The RNG stream for an item's current roll. */
function rollStream(accountSeed: number, uid: number, rerolls: number): Rng {
  return createRng(accountSeed).fork(uid * 7919 + rerolls * REROLL_STREAM);
}

function weightedRarity(rng: Rng): Rarity {
  const entries = Object.entries(RARITY_WEIGHTS) as [Rarity, number][];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.next() * total;
  for (const [rarity, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return rarity;
  }
  return 'common';
}

/**
 * Pick `count` distinct affixes from a pool and roll a tier for each.
 *
 * Distinct within an item, deliberately. Allowing duplicates would let a rare
 * carry two Brutals and turn the power budget into a stacking problem.
 */
function rollAffixes(
  pool: AffixDefinition[],
  count: number,
  itemLevel: number,
  rng: Rng,
): RolledAffix[] {
  const candidates = [...pool];
  const rolled: RolledAffix[] = [];

  for (let i = 0; i < count && candidates.length > 0; i++) {
    const affix = candidates.splice(rng.int(candidates.length), 1)[0];
    const tiers = availableTiers(affix, itemLevel);
    const tier = tiers[rng.int(tiers.length)];
    rolled.push({ affixId: affix.id, tier, value: affix.tiers[tier].value });
  }

  return rolled;
}

function rollAffixesForRarity(rarity: Rarity, itemLevel: number, rng: Rng): RolledAffix[] {
  const limits = AFFIX_LIMITS[rarity];
  return [
    ...rollAffixes(PREFIXES, limits.prefix, itemLevel, rng),
    ...rollAffixes(SUFFIXES, limits.suffix, itemLevel, rng),
  ];
}

/**
 * Roll a base's implicit.
 *
 * Which affix it is was decided by the base type; only the tier is random.
 * That is the whole point - the implicit is the part of an item you can choose
 * by picking a base, while the rest is a lottery.
 */
function rollBaseAffix(baseId: string, itemLevel: number, rng: Rng): RolledAffix | undefined {
  const affix = getBaseAffix(baseId);
  if (!affix) return undefined;
  const tiers = availableTiers(affix, itemLevel);
  const tier = tiers[rng.int(tiers.length)];
  return { affixId: affix.id, tier, value: affix.tiers[tier].value };
}

/**
 * Roll a fresh drop.
 *
 * `uid` is taken from the save's monotonic counter, so the same account
 * clearing the same stages always produces the same items in the same order.
 */
export function rollItem(accountSeed: number, uid: number, itemLevel: number): ItemInstance {
  const rng = rollStream(accountSeed, uid, 0);
  let rarity = weightedRarity(rng);

  if (rarity === 'unique') {
    const eligible = uniquesFor(itemLevel);
    // Early stages have no eligible uniques. Falling back keeps every clear a
    // drop rather than silently swallowing one.
    if (eligible.length === 0) rarity = 'rare';
    else {
      const unique = eligible[rng.int(eligible.length)];
      return {
        uid: String(uid),
        baseId: unique.id,
        rarity: 'unique',
        itemLevel,
        affixes: [],
        rerolls: 0,
        uniqueId: unique.id,
      };
    }
  }

  const base = BASES[rng.int(BASES.length)];
  return {
    uid: String(uid),
    baseId: base.id,
    rarity,
    itemLevel,
    affixes: rollAffixesForRarity(rarity, itemLevel, rng),
    baseAffix: rollBaseAffix(base.id, itemLevel, rng),
    rerolls: 0,
  };
}

/**
 * How many items a clear drops.
 *
 * Seeded off the uid the first of them will take, so the count and the items
 * themselves come from the same reproducible sequence - the server must reach
 * the same number the client optimistically showed, or one side hands out an
 * item the other never rolled.
 */
export function rollDropCount(accountSeed: number, firstUid: number): number {
  const rng = createRng(accountSeed).fork(firstUid * DROP_COUNT_STREAM);
  const span = DROPS_PER_CLEAR.max - DROPS_PER_CLEAR.min + 1;
  return DROPS_PER_CLEAR.min + rng.int(span);
}

/**
 * Reroll an item's affixes in place.
 *
 * Rarity, base, item level and the base implicit survive - only the rolled
 * modifiers change. There is no way to keep one affix and reroll the rest: a
 * bad outcome means rerolling again or finding a better item, which is what
 * makes each roll a decision.
 *
 * The implicit surviving is not an oversight. It is the guaranteed half of an
 * item, and a reroll that could improve it would collapse base choice back into
 * "reroll until the implicit is good", which is exactly what it exists to avoid.
 */
export function rerollAffixes(accountSeed: number, item: ItemInstance): ItemInstance {
  if (item.rarity === 'unique') return item;
  const rerolls = item.rerolls + 1;
  const rng = rollStream(accountSeed, Number(item.uid), rerolls);
  return {
    ...item,
    affixes: rollAffixesForRarity(item.rarity, item.itemLevel, rng),
    rerolls,
  };
}

/** The concrete Effect a rolled affix contributes. */
export function affixEffect(rolled: RolledAffix): Effect | null {
  const affix = getAffix(rolled.affixId);
  if (!affix) return null; // save referencing an affix that no longer exists
  const template = affix.effect;
  return template.kind === 'goldOnKill'
    ? { kind: 'goldOnKill', multiplier: rolled.value }
    : { kind: 'statMod', stat: template.stat, op: template.op, value: rolled.value };
}

/** Everything an item contributes: implicit, rolled affixes, or authored effects. */
export function itemEffects(item: ItemInstance): Effect[] {
  if (item.uniqueId) return [...(getUnique(item.uniqueId)?.effects ?? [])];
  const rolled = [...(item.baseAffix ? [item.baseAffix] : []), ...item.affixes];
  return rolled.map(affixEffect).filter((e): e is Effect => e !== null);
}

/** Display name: "Brutal Whetstone of Haste". Uniques use their authored name. */
export function itemName(item: ItemInstance): string {
  if (item.uniqueId) return getUnique(item.uniqueId)?.name ?? 'Unknown Relic';

  const base = getBase(item.baseId);
  const prefix = item.affixes
    .map((a) => getAffix(a.affixId))
    .find((a) => a?.kind === 'prefix')?.nameFragment;
  const suffix = item.affixes
    .map((a) => getAffix(a.affixId))
    .find((a) => a?.kind === 'suffix')?.nameFragment;

  return [prefix, base?.name ?? 'Relic', suffix].filter(Boolean).join(' ');
}

export function itemSprite(item: ItemInstance): string {
  if (item.uniqueId) return getUnique(item.uniqueId)?.sprite ?? 'item.whetstone';
  return getBase(item.baseId)?.sprite ?? 'item.whetstone';
}

/**
 * A rough scalar for comparing items.
 *
 * Only used by the balance harness and by "discard the worst" logic - the real
 * comparison is what deriveStats produces, which depends on the rest of the
 * build. This is a heuristic and is not shown to players.
 */
export function itemPower(item: ItemInstance): number {
  return itemEffects(item).reduce((power, effect) => {
    if (effect.kind === 'goldOnKill') return power + effect.multiplier;
    return power + (effect.op === 'mul' ? Math.abs(effect.value - 1) : Math.abs(effect.value) * 0.1);
  }, 0);
}
