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
import { GEAR_BASES, WEAPON_BASES, getBase, getBaseAffix } from './content/bases';
import { getSkill } from './content/skills';
import {
  CURRENCY_DROP_WEIGHTS,
  FRAGMENT_GATES,
  type AffixSide,
  type CurrencyId,
  type CurrencyAction,
  type CurrencyDefinition,
  type CurrencyPurse,
  type SpiritDelta,
} from './content/currency';
import { getUnique, uniquesFor } from './content/uniques';
import {
  DROPS_PER_CLEAR,
  DUNGEON_CURRENCY_PER_CLEAR,
  FRAGMENTS_PER_CLEAR,
  KEY_DROP_CHANCE,
  WEAPON_DROP_SHARE,
} from './curves';
import { createRng, type Rng } from './rng';
import { BASE_STATS } from './types';

/** Arbitrary large odd multiplier, so reroll streams never collide with drops. */
const REROLL_STREAM = 0x9e3779b1;

/** Likewise for the per-clear drop-count stream. */
const DROP_COUNT_STREAM = 0x85eb_ca6b;

/** And for the boss's fragment and key rolls. */
const BOSS_DROP_STREAM = 0xc2b2_ae35;

/** And for dungeon rewards, which must not collide with the stage-clear rolls. */
const DUNGEON_STREAM = 0x27d4_eb2f;

/**
 * The RNG stream for an item's current roll.
 *
 * Keyed on `crafts` rather than `rerolls`, so a currency application and a gold
 * reroll draw different numbers - two operations sharing a stream would make
 * "reroll, then flame, then reroll" reproduce the first reroll's result.
 */
function rollStream(accountSeed: number, uid: number, crafts: number): Rng {
  return createRng(accountSeed).fork(uid * 7919 + crafts * REROLL_STREAM);
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
 * The affixes a given base may roll.
 *
 * An affix with a `weapons` kind rolls only on weapons of that kind - so a wand never
 * rolls `+ to Physical Skill Levels`, and no gear rolls either. An affix without the
 * tag rolls anywhere, which is every affix that existed before weapons did.
 *
 * `baseId` is optional so the reroll and spirit paths that already know they are
 * working on a real item can pass it, and the handful of callers that do not have it
 * fall back to the unrestricted pool rather than silently rolling nothing.
 */
export function eligibleAffixes(pool: AffixDefinition[], baseId?: string): AffixDefinition[] {
  const kind = baseId ? getBase(baseId)?.skillId : undefined;
  const skill = kind ? getSkill(kind) : undefined;
  // Untagged rolls anywhere. 'gear' rolls only where there is no skill; a kind
  // rolls only on a weapon granting a skill of that kind.
  return pool.filter((affix) => {
    if (!affix.rollsOn) return true;
    return affix.rollsOn === 'gear' ? skill === undefined : affix.rollsOn === skill?.kind;
  });
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
  baseId?: string,
): RolledAffix[] {
  const candidates = eligibleAffixes(pool, baseId);
  const rolled: RolledAffix[] = [];

  for (let i = 0; i < count && candidates.length > 0; i++) {
    const affix = candidates.splice(rng.int(candidates.length), 1)[0];
    const tiers = availableTiers(affix, itemLevel);
    const tier = tiers[rng.int(tiers.length)];
    rolled.push({ affixId: affix.id, tier, value: affix.tiers[tier].value });
  }

  return rolled;
}

/**
 * How many prefix and suffix rows an item has.
 *
 * The single source of truth. Rarity sets the base counts and a spirit's stored
 * delta adjusts them, so rolling, displaying and testing all agree - and dune's
 * fifth row is not a special case anyone has to remember.
 */
export function affixRows(item: ItemInstance): { prefix: number; suffix: number } {
  const limits = AFFIX_LIMITS[item.rarity];
  const delta = item.spiritDelta ?? { prefix: 0, suffix: 0 };
  return {
    // Clamped at zero and at the pool size: a row count larger than the pool
    // would silently roll fewer affixes than it claims.
    prefix: Math.max(0, Math.min(PREFIXES.length, limits.prefix + delta.prefix)),
    suffix: Math.max(0, Math.min(SUFFIXES.length, limits.suffix + delta.suffix)),
  };
}

function rollAffixesForRows(
  rows: { prefix: number; suffix: number },
  itemLevel: number,
  rng: Rng,
  baseId: string,
): RolledAffix[] {
  return [
    ...rollAffixes(PREFIXES, rows.prefix, itemLevel, rng, baseId),
    ...rollAffixes(SUFFIXES, rows.suffix, itemLevel, rng, baseId),
  ];
}

function rollAffixesForRarity(
  rarity: Rarity,
  itemLevel: number,
  rng: Rng,
  baseId: string,
): RolledAffix[] {
  return rollAffixesForRows(AFFIX_LIMITS[rarity], itemLevel, rng, baseId);
}

/** Which side of the pool an affix id belongs to. */
function sideOf(affixId: string): AffixSide | null {
  const affix = getAffix(affixId);
  return affix ? affix.kind : null;
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
        crafts: 0,
        uniqueId: unique.id,
      };
    }
  }

  // Weapon-or-gear is decided before the base, and by its own roll rather than by
  // weapons simply being two entries in one list. A weapon carries most of the
  // ladder now, so how often one drops is a tuning dial that has to be settable
  // without adding or removing weapon types to move it.
  const pool = rng.next() < WEAPON_DROP_SHARE ? WEAPON_BASES : GEAR_BASES;
  const base = pool[rng.int(pool.length)];
  return {
    uid: String(uid),
    baseId: base.id,
    rarity,
    itemLevel,
    affixes: rollAffixesForRarity(rarity, itemLevel, rng, base.id),
    baseAffix: rollBaseAffix(base.id, itemLevel, rng),
    rerolls: 0,
    crafts: 0,
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
 * What a stage boss drops besides items: fragments, and sometimes a key.
 *
 * Fragments come from stage bosses and currency comes from dungeons, so
 * neither activity is strictly dominated by the other. Rolled from the same
 * clear-seeded stream as the drop count.
 */
export function rollStageBossDrops(
  accountSeed: number,
  firstUid: number,
  stage: number,
): CurrencyPurse {
  const rng = createRng(accountSeed).fork(firstUid * BOSS_DROP_STREAM);
  const purse: CurrencyPurse = {};

  const eligible = FRAGMENT_GATES.filter((gate) => stage >= gate.minStage);
  const fragments = rng.int(FRAGMENTS_PER_CLEAR.max - FRAGMENTS_PER_CLEAR.min + 1) +
    FRAGMENTS_PER_CLEAR.min;

  for (let i = 0; i < fragments && eligible.length > 0; i++) {
    const total = eligible.reduce((sum, gate) => sum + gate.weight, 0);
    let roll = rng.next() * total;
    for (const gate of eligible) {
      roll -= gate.weight;
      if (roll <= 0) {
        purse[gate.id] = (purse[gate.id] ?? 0) + 1;
        break;
      }
    }
  }

  if (rng.next() < KEY_DROP_CHANCE) purse['dungeon-key'] = 1;
  return purse;
}

/**
 * What a dungeon clear awards, besides the item.
 *
 * The only source of finished currency in the game, and the only source of
 * spirits at all - stage bosses drop fragments, which take ten to become
 * anything. That split is what stops either activity dominating: the ladder is
 * the steady trickle, dungeons are the gated burst.
 */
export function rollDungeonCurrency(accountSeed: number, uid: number): CurrencyPurse {
  const rng = createRng(accountSeed).fork(uid * DUNGEON_STREAM);
  const purse: CurrencyPurse = {};

  const span = DUNGEON_CURRENCY_PER_CLEAR.max - DUNGEON_CURRENCY_PER_CLEAR.min + 1;
  const count = DUNGEON_CURRENCY_PER_CLEAR.min + rng.int(span);

  const entries = Object.entries(CURRENCY_DROP_WEIGHTS) as [CurrencyId, number][];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);

  for (let i = 0; i < count; i++) {
    let roll = rng.next() * total;
    for (const [id, weight] of entries) {
      roll -= weight;
      if (roll <= 0) {
        purse[id] = (purse[id] ?? 0) + 1;
        break;
      }
    }
  }

  return purse;
}

/**
 * The item a dungeon clear drops.
 *
 * Same roll as a stage drop but on weights that skew rare - a key is a limited
 * resource, and handing back the common a free clear would have given makes
 * spending one pointless.
 */
export function rollDungeonItem(accountSeed: number, uid: number, itemLevel: number): ItemInstance {
  const item = rollItem(accountSeed, uid, itemLevel);
  if (item.rarity !== 'common') return item;

  // Re-roll a common once against magic-or-better. Cheaper than a second weight
  // table, and it keeps every dungeon drop meaningfully above the floor without
  // guaranteeing a rare.
  const rng = createRng(accountSeed).fork(uid * DUNGEON_STREAM + 1);
  const upgraded = rng.next() < 0.5 ? 'magic' : 'rare';
  return {
    ...item,
    rarity: upgraded,
    affixes: rollAffixesForRarity(upgraded, itemLevel, rng, item.baseId),
  };
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
  const crafts = item.crafts + 1;
  const rng = rollStream(accountSeed, Number(item.uid), crafts);
  return {
    ...item,
    // affixRows, not the rarity limits: a spirited item must keep the rows its
    // spirit gave it. Rerolling one back to 2/2 would make gold a way to undo
    // a permanent, one-shot change.
    affixes: rollAffixesForRows(affixRows(item), item.itemLevel, rng, item.baseId),
    rerolls: item.rerolls + 1,
    crafts,
  };
}

// --- Currency -------------------------------------------------------------

/**
 * Why this currency cannot be used on this item, or null when it can.
 *
 * One function, two callers: applyCommand refuses with this string, and the
 * craft modal greys the option out and shows it. That is deliberate - a player
 * learns the rules from the same sentence the server enforces, and the two
 * cannot drift into disagreeing about what is allowed.
 */
export function currencyLegality(
  item: ItemInstance,
  currency: CurrencyDefinition,
  equipped: boolean,
): string | null {
  const action = currency.action;

  if (action.kind === 'combine') return 'combine this in the stash, not on an item';
  if (action.kind === 'inert') return `${currency.name} is not used on items`;

  // Uniques are authored, not rolled. Nothing here has anything to act on.
  if (item.rarity === 'unique') return 'uniques cannot be modified';

  switch (action.kind) {
    case 'rerollAffixes': {
      const rows = affixRows(item);
      if (rows[action.only] === 0) return `this item has no ${action.only}es`;
      return null;
    }

    case 'rerollTiers':
      if (item.affixes.length === 0) return 'this item has no modifiers';
      return null;

    case 'upgradeRarity':
      if (item.rarity !== action.from) return `${action.from} items only`;
      return null;

    case 'gamble':
      if (item.rarity !== action.from) return `${action.from} items only`;
      // The only operation that can destroy the item you are wearing.
      if (equipped) return 'unequip it first';
      return null;

    case 'spirit':
      if (item.rarity !== 'rare') return 'rare items only';
      if (item.spirit) return 'this item already has a spirit';
      return null;
  }
}

/** The row trade a spirit performs, rolled once and then stored. */
function rollSpiritDelta(
  action: Extract<CurrencyAction, { kind: 'spirit' }>,
  item: ItemInstance,
  rng: Rng,
): SpiritDelta {
  const pick = (side: AffixSide | 'either'): AffixSide =>
    side === 'either' ? (rng.next() < 0.5 ? 'prefix' : 'suffix') : side;

  const delta: SpiritDelta = { prefix: 0, suffix: 0 };

  // Dune may take nothing, which is the only route to a fifth row.
  const removes = action.mayRemoveNone ? rng.next() < 0.5 : true;
  if (removes) {
    const rows = affixRows(item);
    let from = pick(action.remove);
    // Never remove from an empty side - it would spend the spirit for a pure
    // gain, which is not what "trades a row" means.
    if (rows[from] === 0) from = from === 'prefix' ? 'suffix' : 'prefix';
    if (rows[from] > 0) delta[from] -= 1;
  }

  delta[pick(action.add)] += 1;
  return delta;
}

export interface CraftResult {
  /** The item after crafting, or null when the item was destroyed. */
  item: ItemInstance | null;
  /** True only for a gamble that succeeded. */
  transmuted: boolean;
}

/**
 * Apply a currency to an item.
 *
 * Pure, and seeded from (account seed, uid, crafts) like every other roll, so
 * the client's optimistic prediction and the server's authoritative re-run
 * reach the same item. Callers must check `currencyLegality` first; this
 * assumes the operation is already known to be legal.
 */
export function applyCurrencyToItem(
  accountSeed: number,
  item: ItemInstance,
  currency: CurrencyDefinition,
): CraftResult {
  const crafts = item.crafts + 1;
  const rng = rollStream(accountSeed, Number(item.uid), crafts);
  const action = currency.action;
  const next: ItemInstance = { ...item, crafts };

  switch (action.kind) {
    case 'rerollAffixes': {
      // Keep the other side byte-identical. This is the whole point of the
      // idols: a targeted reroll a player can repeat without losing the half
      // that already landed well.
      const kept = item.affixes.filter((a) => sideOf(a.affixId) !== action.only);
      const pool = action.only === 'prefix' ? PREFIXES : SUFFIXES;
      const count = affixRows(item)[action.only];
      next.affixes = [...kept, ...rollAffixes(pool, count, item.itemLevel, rng, item.baseId)];
      return { item: next, transmuted: false };
    }

    case 'rerollTiers': {
      // Same modifiers, new magnitudes. An item whose affixes are right but
      // whose numbers are not is exactly what this exists for.
      next.affixes = item.affixes.map((rolled) => {
        const affix = getAffix(rolled.affixId);
        if (!affix) return rolled;
        const tiers = availableTiers(affix, item.itemLevel);
        const tier = tiers[rng.int(tiers.length)];
        return { affixId: rolled.affixId, tier, value: affix.tiers[tier].value };
      });
      return { item: next, transmuted: false };
    }

    case 'upgradeRarity': {
      // Existing modifiers survive; only the newly granted rows are rolled.
      // Losing what you had would make the ore a reroll with extra steps.
      const before = affixRows(item);
      next.rarity = action.to;
      const after = affixRows(next);
      const added = [
        ...rollAffixes(
          PREFIXES.filter((a) => !item.affixes.some((r) => r.affixId === a.id)),
          Math.max(0, after.prefix - before.prefix),
          item.itemLevel,
          rng,
        ),
        ...rollAffixes(
          SUFFIXES.filter((a) => !item.affixes.some((r) => r.affixId === a.id)),
          Math.max(0, after.suffix - before.suffix),
          item.itemLevel,
          rng,
        ),
      ];
      next.affixes = [...item.affixes, ...added];
      return { item: next, transmuted: false };
    }

    case 'gamble': {
      if (rng.next() >= action.successChance) return { item: null, transmuted: false };
      const eligible = uniquesFor(item.itemLevel);
      // No unique exists this early. Refunding the item rather than eating it
      // keeps the failure honest: the droplet did not fail, it had nothing to
      // turn the item into.
      if (eligible.length === 0) return { item: next, transmuted: false };
      const unique = eligible[rng.int(eligible.length)];
      return {
        item: {
          ...next,
          baseId: unique.id,
          rarity: 'unique',
          uniqueId: unique.id,
          affixes: [],
          baseAffix: undefined,
          spirit: undefined,
          spiritDelta: undefined,
        },
        transmuted: true,
      };
    }

    case 'spirit': {
      const delta = rollSpiritDelta(action, item, rng);
      next.spirit = currency.id;
      next.spiritDelta = delta;

      const rows = affixRows(next);
      // Trim the removed side down, then roll the added side up. Trimming from
      // the end drops the most recently rolled affix, which is arbitrary but
      // consistent - and the player chose a permanent trade, not which mod.
      const trim = (side: AffixSide) => {
        const own = next.affixes.filter((a) => sideOf(a.affixId) === side);
        return own.slice(0, rows[side]);
      };
      const prefixes = trim('prefix');
      const suffixes = trim('suffix');

      const grow = (side: AffixSide, current: RolledAffix[]) => {
        const pool = (side === 'prefix' ? PREFIXES : SUFFIXES).filter(
          (a) => !current.some((r) => r.affixId === a.id),
        );
        return rollAffixes(pool, rows[side] - current.length, item.itemLevel, rng, item.baseId);
      };

      next.affixes = [
        ...prefixes,
        ...grow('prefix', prefixes),
        ...suffixes,
        ...grow('suffix', suffixes),
      ];
      return { item: next, transmuted: false };
    }

    default:
      return { item: next, transmuted: false };
  }
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
 *
 * Every layer is normalised to "fraction of the stat's base", which is the only
 * way the three become comparable: `+4.8 flat damage` and `+8% increased damage`
 * are both worth about 0.08 of a base-60 damage pool, and a naive sum of raw
 * values would rate the flat roll sixty times higher.
 */
export function itemPower(item: ItemInstance): number {
  return itemEffects(item).reduce((power, effect) => {
    if (effect.kind === 'goldOnKill') return power + effect.multiplier;
    if (effect.op === 'more') return power + Math.abs(effect.value - 1);
    if (effect.op === 'increased') return power + Math.abs(effect.value);
    return power + Math.abs(effect.value) / Math.max(BASE_STATS[effect.stat], 1e-9);
  }, 0);
}
