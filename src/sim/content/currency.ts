/**
 * Crafting currency.
 *
 * Gold rerolling replaces every modifier at once, which is a slot machine: a
 * player who lands three good mods and one bad one can only destroy all four
 * and try again. Currency is the targeted half - reroll one side, reroll only
 * tiers, raise a rarity, add an affix row.
 *
 * Content is data, not closures, for the same reason affixes are: a
 * CurrencyAction can be validated by a test, rendered as a sentence in the
 * craft modal, and stored in a save. A factory function could only be run.
 *
 * ## One registry, four tiers
 *
 * Basics, spirits, fragments and the dungeon key are all entries in this one
 * table. That buys one schema, one stash tab, one interpreter and one legality
 * function - and it means adding a currency later is a table entry plus an
 * interpreter case rather than a new subsystem.
 */

import { z } from 'zod';
import type { Rarity } from './schema';

export const CURRENCY_IDS = [
  // Basics.
  'sacred-idol',
  'dark-idol',
  'magic-ore',
  'rare-ore',
  'angel-flame',
  'angel-droplet',
  // Spirits. Rare-only, one per item, mutually exclusive.
  'bishop-spirit',
  'devil-spirit',
  'dune-spirit',
  // Fragments. Ten combine into the currency they are named for.
  'magic-ore-shard',
  'rare-ore-shard',
  'angel-flame-shard',
  'angel-droplet-shard',
  // Consumed by attemptDungeon rather than applied to an item.
  'dungeon-key',
] as const;

export const CurrencyIdSchema = z.enum(CURRENCY_IDS);
export type CurrencyId = z.infer<typeof CurrencyIdSchema>;

export type CurrencyTier = 'basic' | 'spirit' | 'fragment' | 'key';

/** Which half of an affix row set an operation touches. */
export type AffixSide = 'prefix' | 'suffix';

/**
 * What a currency does.
 *
 * The discriminant is what lets `applyCurrency` be one command instead of
 * eleven, and what lets the craft modal explain an option it has never seen.
 */
export type CurrencyAction =
  /** Reroll only one side's modifiers, leaving the other side byte-identical. */
  | { kind: 'rerollAffixes'; only: AffixSide }
  /** Keep every modifier, roll new tiers for each. */
  | { kind: 'rerollTiers' }
  /** Raise rarity one step and roll the affix rows the new rarity grants. */
  | { kind: 'upgradeRarity'; from: Rarity; to: Rarity }
  /** Transmute or destroy. The only currency that can lose you an item. */
  | { kind: 'gamble'; from: Rarity; successChance: number }
  /** Trade one affix row for another. See SPIRIT_RULES below. */
  | {
      kind: 'spirit';
      remove: AffixSide | 'either';
      add: AffixSide | 'either';
      /** Dune alone may remove nothing, which is how it reaches five rows. */
      mayRemoveNone: boolean;
    }
  /** Ten fragments become one of something else. Not applied to an item. */
  | { kind: 'combine'; into: CurrencyId; count: number }
  /** Holds no power of its own; another command consumes it. */
  | { kind: 'inert' };

export interface CurrencyDefinition {
  id: CurrencyId;
  name: string;
  tier: CurrencyTier;
  /** Logical sprite ID — never a filename. */
  sprite: string;
  /** One sentence, shown in the stash and the craft modal. */
  description: string;
  action: CurrencyAction;
}

/** Fragments needed to combine one currency. */
export const FRAGMENTS_PER_COMBINE = 10;

export const CURRENCIES: CurrencyDefinition[] = [
  {
    id: 'sacred-idol',
    name: 'Sacred Idol',
    tier: 'basic',
    sprite: 'currency.sacred_idol',
    description: 'Rerolls only the prefixes. Suffixes are untouched.',
    action: { kind: 'rerollAffixes', only: 'prefix' },
  },
  {
    id: 'dark-idol',
    name: 'Dark Idol',
    tier: 'basic',
    sprite: 'currency.dark_idol',
    description: 'Rerolls only the suffixes. Prefixes are untouched.',
    action: { kind: 'rerollAffixes', only: 'suffix' },
  },
  {
    id: 'magic-ore',
    name: 'Magic Ore',
    tier: 'basic',
    sprite: 'currency.magic_ore',
    description: 'Upgrades a common item to magic, adding a prefix and a suffix.',
    action: { kind: 'upgradeRarity', from: 'common', to: 'magic' },
  },
  {
    id: 'rare-ore',
    name: 'Rare Ore',
    tier: 'basic',
    sprite: 'currency.rare_ore',
    description: 'Upgrades a magic item to rare, adding a prefix and a suffix.',
    action: { kind: 'upgradeRarity', from: 'magic', to: 'rare' },
  },
  {
    id: 'angel-flame',
    name: 'Angel Flame',
    tier: 'basic',
    sprite: 'currency.angel_flame',
    description: 'Keeps every modifier and rerolls their tiers.',
    action: { kind: 'rerollTiers' },
  },
  {
    id: 'angel-droplet',
    name: 'Angel Droplet',
    tier: 'basic',
    sprite: 'currency.angel_droplet',
    description: 'A common item becomes unique, or is destroyed. One in ten survive.',
    action: { kind: 'gamble', from: 'common', successChance: 0.1 },
  },

  {
    id: 'bishop-spirit',
    name: 'Bishop Spirit',
    tier: 'spirit',
    sprite: 'currency.bishop_spirit',
    description: 'Rare only. Trades a prefix row for a suffix row. One spirit per item, ever.',
    action: { kind: 'spirit', remove: 'prefix', add: 'suffix', mayRemoveNone: false },
  },
  {
    id: 'devil-spirit',
    name: 'Devil Spirit',
    tier: 'spirit',
    sprite: 'currency.devil_spirit',
    description: 'Rare only. Trades a suffix row for a prefix row. One spirit per item, ever.',
    action: { kind: 'spirit', remove: 'suffix', add: 'prefix', mayRemoveNone: false },
  },
  {
    id: 'dune-spirit',
    name: 'Dune Spirit',
    tier: 'spirit',
    sprite: 'currency.dune_spirit',
    description:
      'Rare only. Removes up to one row and adds one, either side. May leave seven. One spirit per item, ever.',
    action: { kind: 'spirit', remove: 'either', add: 'either', mayRemoveNone: true },
  },

  {
    id: 'magic-ore-shard',
    name: 'Magic Ore Shard',
    tier: 'fragment',
    sprite: 'currency.magic_ore_shard',
    description: 'Ten combine into Magic Ore.',
    action: { kind: 'combine', into: 'magic-ore', count: FRAGMENTS_PER_COMBINE },
  },
  {
    id: 'rare-ore-shard',
    name: 'Rare Ore Shard',
    tier: 'fragment',
    sprite: 'currency.rare_ore_shard',
    description: 'Ten combine into Rare Ore.',
    action: { kind: 'combine', into: 'rare-ore', count: FRAGMENTS_PER_COMBINE },
  },
  {
    id: 'angel-flame-shard',
    name: 'Angel Flame Shard',
    tier: 'fragment',
    sprite: 'currency.angel_flame_shard',
    description: 'Ten combine into Angel Flame.',
    action: { kind: 'combine', into: 'angel-flame', count: FRAGMENTS_PER_COMBINE },
  },
  {
    id: 'angel-droplet-shard',
    name: 'Angel Droplet Shard',
    tier: 'fragment',
    sprite: 'currency.angel_droplet_shard',
    description: 'Ten combine into an Angel Droplet.',
    action: { kind: 'combine', into: 'angel-droplet', count: FRAGMENTS_PER_COMBINE },
  },

  {
    id: 'dungeon-key',
    name: 'Dungeon Key',
    tier: 'key',
    sprite: 'currency.dungeon_key',
    description: 'Opens one dungeon. Spent whether you win or lose.',
    action: { kind: 'inert' },
  },
];

const byId = new Map(CURRENCIES.map((c) => [c.id, c]));

export function getCurrency(id: string): CurrencyDefinition | undefined {
  return byId.get(id as CurrencyId);
}

/** What dissembling an item of each rarity yields. */
export const DISSEMBLE_YIELD: Record<Rarity, CurrencyId> = {
  common: 'magic-ore-shard',
  magic: 'rare-ore-shard',
  rare: 'angel-flame-shard',
  unique: 'angel-droplet-shard',
};

/**
 * How the spirit's row trade is recorded on an item.
 *
 * Stored rather than recomputed, for the same reason rolled affix values are:
 * dune's outcome is random, and the panel and the sim must not disagree about
 * how many rows an item has.
 */
export const SpiritDeltaSchema = z
  .object({
    prefix: z.number().int(),
    suffix: z.number().int(),
  })
  .strict();

export type SpiritDelta = z.infer<typeof SpiritDeltaSchema>;

/** Currency counts held by an account. Sparse - an empty stash costs nothing. */
export const CurrencyPurseSchema = z.record(CurrencyIdSchema, z.number().int().min(0));
export type CurrencyPurse = Partial<Record<CurrencyId, number>>;

/** Currencies that can drop, and their relative weights. */
export const CURRENCY_DROP_WEIGHTS: Partial<Record<CurrencyId, number>> = {
  'sacred-idol': 22,
  'dark-idol': 22,
  'magic-ore': 20,
  'rare-ore': 12,
  'angel-flame': 14,
  'angel-droplet': 6,
  // Spirits are the rarest thing in the game: each is a permanent, one-shot
  // change to an item's shape, and the only route to a fifth affix row.
  'bishop-spirit': 1.5,
  'devil-spirit': 1.5,
  'dune-spirit': 1,
};

/**
 * Fragment drop weights, gated by stage.
 *
 * The same idea as affix tier gates: a stage-3 clear must not hand out the
 * shards that build the best currency, or pushing deeper stops paying.
 */
export const FRAGMENT_GATES: { id: CurrencyId; minStage: number; weight: number }[] = [
  { id: 'magic-ore-shard', minStage: 1, weight: 40 },
  { id: 'rare-ore-shard', minStage: 10, weight: 30 },
  { id: 'angel-flame-shard', minStage: 25, weight: 22 },
  { id: 'angel-droplet-shard', minStage: 50, weight: 8 },
];

/** Rarity ranking, so an upgradeRarity chain can be validated as monotonic. */
export const RARITY_RANK: Record<Rarity, number> = {
  common: 0,
  magic: 1,
  rare: 2,
  unique: 3,
};
