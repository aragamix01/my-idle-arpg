/**
 * The command layer — the entire trust boundary.
 *
 * Every permanent change to an account goes through applyCommand. The client
 * calls it optimistically for instant UI; the route handler calls it
 * authoritatively and its answer wins. Same code, both sides, so they cannot
 * disagree about the rules.
 *
 * Note what is NOT a command: farming income. The server derives that from
 * (bestStage, elapsed), so there is nothing for a client to claim.
 */

import { z } from 'zod';
import { resolveStage } from './combat';
import {
  BULK_PURCHASE_LIMIT,
  bulkUpgradeCost,
  isUpgradeMaxed,
  maxAffordableUpgrades,
  remainingLevels,
  rerollCost,
} from './curves';
import {
  CONTENT_VERSION,
  CurrencyIdSchema,
  DISSEMBLE_YIELD,
  getCurrency,
  type CurrencyId,
  type CurrencyPurse,
} from './content';
import { computeOffline } from './offline';
import {
  applyCurrencyToItem,
  currencyLegality,
  itemName,
  rerollAffixes,
  rollDropCount,
  rollItem,
  rollStageBossDrops,
} from './items';
import { findItem } from './stats';
import {
  ITEM_SLOTS,
  INVENTORY_CAP,
  UPGRADE_KEYS,
  err,
  ok,
  type Result,
  type SaveState,
  type UpgradeLevels,
} from './types';

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attemptStage') }).strict(),
  z.object({ type: z.literal('setStage'), stage: z.number().int().min(1) }).strict(),
  z
    .object({
      type: z.literal('buyUpgrade'),
      key: z.enum(UPGRADE_KEYS),
      /**
       * Levels to buy. Omitted means one, so clients predating bulk purchase
       * keep working unchanged.
       *
       * 'max' is resolved server-side against the server's own gold - the
       * client's balance is a cache and has no say in how much it can afford.
       */
      count: z
        .union([z.number().int().min(1).max(BULK_PURCHASE_LIMIT), z.literal('max')])
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('equipItem'),
      slot: z.number().int().min(0).max(ITEM_SLOTS - 1),
      /** Item uid, or null to clear the slot. */
      itemId: z.string().nullable(),
    })
    .strict(),
  z.object({ type: z.literal('rerollItem'), uid: z.string().min(1) }).strict(),
  /**
   * Every currency goes through one command.
   *
   * The action union already discriminates, so eleven commands would be eleven
   * copies of the same ownership and legality checks.
   */
  z
    .object({
      type: z.literal('applyCurrency'),
      currencyId: CurrencyIdSchema,
      uid: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal('combineFragments'), currencyId: CurrencyIdSchema }).strict(),
  z.object({ type: z.literal('dissembleItem'), uid: z.string().min(1) }).strict(),
  z.object({ type: z.literal('claimOffline') }).strict(),
]);

export type Command = z.infer<typeof CommandSchema>;

export type SimEvent =
  | { type: 'stageCleared'; stage: number; seconds: number; gold: number }
  | { type: 'stageFailed'; stage: number; reason: 'died' | 'timeout'; gold: number }
  | { type: 'itemDropped'; itemId: string; name: string; rarity: string }
  /** Carries how many drops were lost, so the message can say what it cost. */
  | { type: 'inventoryFull'; lost: number }
  | { type: 'itemRerolled'; uid: string; cost: number }
  | { type: 'currencyDropped'; currencyId: string; name: string; count: number }
  | { type: 'currencyUsed'; currencyId: string; name: string; uid: string }
  | { type: 'itemTransmuted'; uid: string; name: string }
  | { type: 'itemDestroyed'; uid: string }
  | { type: 'fragmentsCombined'; currencyId: string; name: string }
  | { type: 'itemDissembled'; uid: string; yielded: string }
  | { type: 'upgradeBought'; key: string; level: number; cost: number; count: number }
  | { type: 'offlineClaimed'; gold: number; seconds: number; capped: boolean };

export interface CommandOutcome {
  state: SaveState;
  events: SimEvent[];
}

function emptyUpgrades(): UpgradeLevels {
  return Object.fromEntries(UPGRADE_KEYS.map((k) => [k, 0])) as UpgradeLevels;
}

/** Add counts into a purse, returning a new one. Never mutates the argument. */
function credit(purse: CurrencyPurse, gains: CurrencyPurse): CurrencyPurse {
  const next = { ...purse };
  for (const [id, count] of Object.entries(gains) as [CurrencyId, number][]) {
    next[id] = (next[id] ?? 0) + count;
  }
  return next;
}

export function newSave(seed: number, nowMs: number): SaveState {
  return {
    contentVersion: CONTENT_VERSION,
    seed,
    gold: 0,
    bestStage: 0,
    currentStage: 1,
    upgrades: emptyUpgrades(),
    items: [],
    currency: {},
    loadout: Array<string | null>(ITEM_SLOTS).fill(null),
    nextItemId: 1,
    lastSeenAt: nowMs,
  };
}

export function applyCommand(
  state: SaveState,
  command: Command,
  nowMs: number,
): Result<CommandOutcome> {
  const events: SimEvent[] = [];
  const next: SaveState = {
    ...state,
    upgrades: { ...state.upgrades },
    items: [...state.items],
    currency: { ...state.currency },
    loadout: [...state.loadout],
  };

  switch (command.type) {
    case 'attemptStage': {
      const stage = next.currentStage;
      if (stage > next.bestStage + 1) {
        return err(`cannot attempt stage ${stage}: best cleared is ${next.bestStage}`);
      }
      const outcome = resolveStage(next, stage);
      next.gold += Math.floor(outcome.goldEarned);

      if (outcome.cleared) {
        next.bestStage = Math.max(next.bestStage, stage);
        next.currentStage = stage + 1;
        events.push({
          type: 'stageCleared',
          stage,
          seconds: outcome.seconds,
          gold: Math.floor(outcome.goldEarned),
        });

        // Every clear drops one to three. Rarity and count are what vary, not
        // whether anything falls.
        const firstUid = next.nextItemId;
        const drops = rollDropCount(next.seed, firstUid);
        let lost = 0;

        // Boss drops are rolled off the same clear-seeded stream, before the
        // item loop advances the uid counter past it.
        const bossDrops = rollStageBossDrops(next.seed, firstUid, stage);
        next.currency = credit(next.currency, bossDrops);
        for (const [id, count] of Object.entries(bossDrops) as [CurrencyId, number][]) {
          events.push({
            type: 'currencyDropped',
            currencyId: id,
            name: getCurrency(id)?.name ?? id,
            count,
          });
        }

        for (let i = 0; i < drops; i++) {
          // A full inventory swallows the rest of the wave rather than
          // discarding silently. The uid counter still advances for the ones
          // that fell on the floor: reusing a uid later would make the
          // replacement item roll identically to the one that was lost.
          const uid = next.nextItemId;
          next.nextItemId = uid + 1;

          if (next.items.length >= INVENTORY_CAP) {
            lost++;
            continue;
          }

          const item = rollItem(next.seed, uid, stage);
          next.items.push(item);
          events.push({
            type: 'itemDropped',
            itemId: item.uid,
            name: itemName(item),
            rarity: item.rarity,
          });
        }

        if (lost > 0) events.push({ type: 'inventoryFull', lost });
      } else {
        events.push({
          type: 'stageFailed',
          stage,
          reason: outcome.failure === 'timeout' ? 'timeout' : 'died',
          gold: Math.floor(outcome.goldEarned),
        });
      }
      break;
    }

    case 'setStage': {
      if (command.stage > next.bestStage + 1) {
        return err(`stage ${command.stage} is not unlocked`);
      }
      next.currentStage = command.stage;
      break;
    }

    case 'buyUpgrade': {
      const level = next.upgrades[command.key];
      if (isUpgradeMaxed(command.key, level)) return err(`${command.key} is at max level`);

      const requested = command.count ?? 1;
      const count =
        requested === 'max'
          ? maxAffordableUpgrades(command.key, level, next.gold)
          : Math.min(requested, remainingLevels(command.key, level));

      if (count <= 0) {
        return err(
          requested === 'max'
            ? `cannot afford any ${command.key} levels`
            : `${command.key} has no levels remaining`,
        );
      }

      // A fixed multiplier is all-or-nothing. Silently buying seven when the
      // player asked for ten would spend their gold on something they did not
      // choose; 'max' is the button that means "as many as fit".
      const cost = bulkUpgradeCost(command.key, level, count);
      if (next.gold < cost) {
        return err(`need ${Math.ceil(cost)} gold for ${count}x, have ${Math.floor(next.gold)}`);
      }

      next.gold -= cost;
      next.upgrades[command.key] = level + count;
      events.push({ type: 'upgradeBought', key: command.key, level: level + count, cost, count });
      break;
    }

    case 'equipItem': {
      const { slot, itemId } = command;
      if (itemId !== null) {
        if (!findItem(next, itemId)) return err(`not owned: ${itemId}`);
        const existing = next.loadout.indexOf(itemId);
        if (existing !== -1 && existing !== slot) next.loadout[existing] = null;
      }
      next.loadout[slot] = itemId;
      break;
    }

    case 'rerollItem': {
      const index = next.items.findIndex((item) => item.uid === command.uid);
      if (index === -1) return err(`not owned: ${command.uid}`);

      const item = next.items[index];
      if (item.rarity === 'unique') return err('uniques cannot be rerolled');

      const cost = rerollCost(item.rarity, item.itemLevel, item.rerolls);
      if (next.gold < cost) {
        return err(`need ${cost} gold to reroll, have ${Math.floor(next.gold)}`);
      }

      next.gold -= cost;
      // Replaces every rolled affix, and leaves the base implicit alone. There
      // is deliberately no way to keep one and reroll the rest - that choice is
      // what gives each roll weight.
      next.items = next.items.map((current, i) =>
        i === index ? rerollAffixes(next.seed, current) : current,
      );
      events.push({ type: 'itemRerolled', uid: command.uid, cost });
      break;
    }

    case 'applyCurrency': {
      const currency = getCurrency(command.currencyId);
      if (!currency) return err(`unknown currency: ${command.currencyId}`);

      const held = next.currency[command.currencyId] ?? 0;
      if (held < 1) return err(`you have no ${currency.name}`);

      const index = next.items.findIndex((item) => item.uid === command.uid);
      if (index === -1) return err(`not owned: ${command.uid}`);

      const item = next.items[index];
      // The exact string the craft modal greys the option out with. One rule
      // set, so the UI cannot promise something the server then refuses.
      const illegal = currencyLegality(item, currency, next.loadout.includes(item.uid));
      if (illegal) return err(illegal);

      const result = applyCurrencyToItem(next.seed, item, currency);
      next.currency = { ...next.currency, [command.currencyId]: held - 1 };
      events.push({
        type: 'currencyUsed',
        currencyId: currency.id,
        name: currency.name,
        uid: item.uid,
      });

      if (result.item === null) {
        // A gamble that failed. Nothing to unequip - legality already refused
        // this on an equipped item.
        next.items = next.items.filter((_, i) => i !== index);
        events.push({ type: 'itemDestroyed', uid: item.uid });
        break;
      }

      const crafted = result.item;
      next.items = next.items.map((current, i) => (i === index ? crafted : current));
      if (result.transmuted) {
        events.push({ type: 'itemTransmuted', uid: crafted.uid, name: itemName(crafted) });
      }
      break;
    }

    case 'combineFragments': {
      const currency = getCurrency(command.currencyId);
      if (!currency) return err(`unknown currency: ${command.currencyId}`);
      if (currency.action.kind !== 'combine') return err(`${currency.name} does not combine`);

      const { into, count } = currency.action;
      const held = next.currency[command.currencyId] ?? 0;
      if (held < count) return err(`need ${count} ${currency.name}, have ${held}`);

      next.currency = {
        ...next.currency,
        [command.currencyId]: held - count,
        [into]: (next.currency[into] ?? 0) + 1,
      };
      events.push({
        type: 'fragmentsCombined',
        currencyId: into,
        name: getCurrency(into)?.name ?? into,
      });
      break;
    }

    case 'dissembleItem': {
      const item = findItem(next, command.uid);
      if (!item) return err(`not owned: ${command.uid}`);
      // Refuse rather than silently unequipping. Destroying the item you are
      // currently wearing is the single most expensive misclick available, and
      // an unequip step is a cheap confirmation that costs nothing to undo.
      if (next.loadout.includes(command.uid)) return err('unequip it first');

      // Dissembling replaced discarding outright. An item you do not want is
      // now raw material for one you do, which makes a full inventory a
      // decision about what to melt down rather than what to throw away.
      const yielded = DISSEMBLE_YIELD[item.rarity];
      next.items = next.items.filter((current) => current.uid !== command.uid);
      next.currency = credit(next.currency, { [yielded]: 1 });
      events.push({ type: 'itemDissembled', uid: command.uid, yielded });
      break;
    }

    case 'claimOffline': {
      const report = computeOffline(next, nowMs);
      next.gold += report.goldEarned;
      // Advancing lastSeenAt is what makes this idempotent: an immediate second
      // claim finds ~0 elapsed seconds. Double-claim is the classic idle exploit.
      next.lastSeenAt = nowMs;
      events.push({
        type: 'offlineClaimed',
        gold: report.goldEarned,
        seconds: report.creditedSeconds,
        capped: report.capped,
      });
      break;
    }
  }

  next.contentVersion = CONTENT_VERSION;
  return ok({ state: next, events });
}
