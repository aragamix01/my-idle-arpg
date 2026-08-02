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
import { big, formatBig, fromSave, toSave, type Big, type BigInput } from './big';
import { resolveAbyssal, resolveDungeon, resolveStage } from './combat';
import {
  BULK_PURCHASE_LIMIT,
  bulkUpgradeCost,
  isUpgradeMaxed,
  maxAffordableUpgrades,
  remainingLevels,
  rerollCost,
  abyssalDepth,
  ABYSSAL_ITEMS_PER_CLEAR,
  ABYSSAL_CURRENCY_PER_CLEAR,
} from './curves';
import {
  CONTENT_VERSION,
  CurrencyIdSchema,
  DISSEMBLE_YIELD,
  getCurrency,
  getBase,
  isWeaponBase,
  tabletReward,
  WAVE_RARITY_WEIGHTS,
  type CurrencyId,
  type CurrencyPurse,
  type ItemInstance,
  type TabletPays,
} from './content';
import { computeOffline } from './offline';
import {
  applyCurrencyToItem,
  currencyLegality,
  itemName,
  rerollAffixes,
  rollDropCount,
  rollDungeonCurrency,
  rollDungeonItem,
  rollItem,
  rollStageBossDrops,
  rollWaveDropCount,
  rollTablet,
  rollWaveTablets,
  rollAbyssalTablets,
} from './items';
import { equipSlots, findItem, keyDropMultiplier } from './stats';
import {
  MAX_ITEM_SLOTS,
  ACCESSORY_SLOTS,
  ACCESSORY_SLOT_KINDS,
  ABYSS_UNLOCK_STAGE,
  TABLET_CAP,
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
      // Bounded by the ARRAY, not by the live slot count - the schema cannot see a
      // save. applyCommand refuses a slot past the live count, so the server decides
      // whether the seventh position is real for this character.
      slot: z.number().int().min(0).max(MAX_ITEM_SLOTS - 1),
      /** Item uid, or null to clear the slot. */
      itemId: z.string().nullable(),
    })
    .strict(),
  /**
   * The weapon has its own command because it has its own slot, and because only a
   * weapon base may go in it - a check `equipItem` has no reason to carry.
   */
  z
    .object({
      type: z.literal('equipWeapon'),
      /** Item uid, or null to fight unarmed. */
      itemId: z.string().nullable(),
    })
    .strict(),
  /**
   * Its own command for the same reason `equipWeapon` is: only a ring fits a ring slot,
   * and that is a check `equipItem` has no cause to carry.
   */
  z
    .object({
      type: z.literal('equipAccessory'),
      /** 0 and 1 are rings, 2 is the amulet - see ACCESSORY_SLOT_KINDS. */
      slot: z.number().int().min(0).max(ACCESSORY_SLOTS - 1),
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
  /**
   * Dissembling, one item or two hundred.
   *
   * One command rather than a single and a bulk variant: a single dissemble is a
   * list of one, and two commands would be two copies of the same ownership and
   * equipped checks. Bounded by the inventory cap so an untrusted list cannot
   * ask the server for unbounded work.
   */
  z
    .object({
      type: z.literal('dissembleItems'),
      uids: z.array(z.string().min(1)).min(1).max(INVENTORY_CAP),
    })
    .strict(),
  /** Takes no stage: a dungeon always runs at bestStage, never at a chosen one. */
  z.object({ type: z.literal('attemptDungeon') }).strict(),
  z.object({ type: z.literal('claimOffline') }).strict(),
  /** Which tablet to spend. A tier is a thing you hold, so the run names one. */
  z.object({ type: z.literal('attemptAbyssal'), uid: z.string().min(1) }).strict(),
]);

export type Command = z.infer<typeof CommandSchema>;

/**
 * Every gold figure on an event is a decimal STRING, for the same reason the save
 * holds one: these cross the wire as JSON, and a JSON number is a double at the far
 * end. A toast reading `Infinity gold` would be the cheapest possible way to lose the
 * whole point of this type.
 */
export type SimEvent =
  | { type: 'stageCleared'; stage: number; seconds: number; gold: string }
  | { type: 'stageFailed'; stage: number; reason: 'died' | 'timeout'; gold: string }
  | { type: 'dungeonCleared'; stage: number; seconds: number; gold: string }
  | { type: 'dungeonFailed'; stage: number; reason: 'died' | 'timeout' }
  | { type: 'abyssalCleared'; tier: number; seconds: number; gold: string }
  | { type: 'abyssalFailed'; tier: number; reason: 'died' | 'timeout' }
  | { type: 'tabletFound'; tier: number; name: string }
  | { type: 'itemDropped'; itemId: string; name: string; rarity: string }
  /** Carries how many drops were lost, so the message can say what it cost. */
  | { type: 'inventoryFull'; lost: number }
  | { type: 'itemRerolled'; uid: string; cost: string }
  | { type: 'currencyDropped'; currencyId: string; name: string; count: number }
  | { type: 'currencyUsed'; currencyId: string; name: string; uid: string }
  | { type: 'itemTransmuted'; uid: string; name: string }
  | { type: 'itemDestroyed'; uid: string }
  | { type: 'fragmentsCombined'; currencyId: string; name: string }
  | { type: 'itemsDissembled'; count: number; yields: Record<string, number> }
  | { type: 'upgradeBought'; key: string; level: number; cost: string; count: number }
  | { type: 'offlineClaimed'; gold: string; seconds: number; capped: boolean };

export interface CommandOutcome {
  state: SaveState;
  events: SimEvent[];
}

function emptyUpgrades(): UpgradeLevels {
  return Object.fromEntries(UPGRADE_KEYS.map((k) => [k, 0])) as UpgradeLevels;
}

/**
 * Credit gold, and record it against the lifetime total in the same breath.
 *
 * One function rather than two lines at five call sites, because the two totals
 * diverging is a silent bug: nothing checks them against each other, and prestige
 * would quietly be priced off whichever earnings happened to be counted.
 */
function earn(state: SaveState, amount: BigInput): Big {
  const gained = big(amount);
  state.gold = toSave(fromSave(state.gold).add(gained));
  state.lifetimeGold = toSave(fromSave(state.lifetimeGold).add(gained));
  return gained;
}

/** Debit gold. Lifetime earnings are untouched - they are earnings, not a balance. */
function spend(state: SaveState, amount: Big): void {
  state.gold = toSave(fromSave(state.gold).sub(amount));
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
    gold: '0',
    lifetimeGold: '0',
    bestStage: 0,
    currentStage: 1,
    upgrades: emptyUpgrades(),
    items: [],
    tablets: [],
    currency: {},
    loadout: Array<string | null>(MAX_ITEM_SLOTS).fill(null),
    // A new character starts unarmed, and Unarmed's bases are the old global
    // BASE_STATS - so stage 1 plays exactly as it did before weapons existed.
    weapon: null,
    accessories: Array<string | null>(ACCESSORY_SLOTS).fill(null),
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
      const earned = earn(next, outcome.goldEarned);

      if (outcome.cleared) {
        next.bestStage = Math.max(next.bestStage, stage);
        next.currentStage = stage + 1;
        events.push({
          type: 'stageCleared',
          stage,
          seconds: outcome.seconds,
          gold: toSave(earned),
        });

        // Two sources now, and they mean different things. The WAVE pays for the
        // kills - common material to dissemble - and the CLEAR pays for finishing,
        // which is where the rarity table and therefore the chase still lives.
        const firstUid = next.nextItemId;
        const waveDrops = rollWaveDropCount(next.seed, firstUid, stage);
        const drops = rollDropCount(next.seed, firstUid);
        let lost = 0;

        // Boss drops are rolled off the same clear-seeded stream, before the
        // item loop advances the uid counter past it.
        const bossDrops = rollStageBossDrops(
          next.seed,
          firstUid,
          stage,
          // Evaluated against the boss, since that is what drops the key - a
          // conditional key effect gated on `isBoss` has to see the fight it names.
          keyDropMultiplier(next, { stage, isBoss: true, enemyHpFraction: 1 }),
        );
        next.currency = credit(next.currency, bossDrops);
        for (const [id, count] of Object.entries(bossDrops) as [CurrencyId, number][]) {
          events.push({
            type: 'currencyDropped',
            currencyId: id,
            name: getCurrency(id)?.name ?? id,
            count,
          });
        }

        // Wave drops take the first uids, so the sequence is the order they fell in -
        // which is what lets the renderer show them during the trash phase.
        for (let i = 0; i < waveDrops + drops; i++) {
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

          const item = rollItem(
            next.seed,
            uid,
            stage,
            i < waveDrops ? WAVE_RARITY_WEIGHTS : undefined,
          );
          next.items.push(item);
          events.push({
            type: 'itemDropped',
            itemId: item.uid,
            name: itemName(item),
            rarity: item.rarity,
          });
        }

        if (lost > 0) events.push({ type: 'inventoryFull', lost });

        // The wave is the Abyss's faucet. Rolled off its own stream and granted last, so
        // moving it here could not shift a single item or fragment that was already
        // going to fall.
        for (const tier of rollWaveTablets(next.seed, firstUid, stage)) {
          const tabletUid = next.nextItemId;
          next.nextItemId = tabletUid + 1;
          // The uid still advances past a tablet the shelf has no room for, exactly like
          // an item lost to a full inventory: reusing the uid later would make the
          // replacement roll identically to the one that was dropped.
          if (next.tablets.length >= TABLET_CAP) continue;
          const tablet = rollTablet(next.seed, tabletUid, tier);
          next.tablets = [...next.tablets, tablet];
          events.push({ type: 'tabletFound', tier: tablet.itemLevel, name: itemName(tablet) });
        }
      } else {
        events.push({
          type: 'stageFailed',
          stage,
          reason: outcome.failure === 'timeout' ? 'timeout' : 'died',
          gold: toSave(earned),
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
          ? maxAffordableUpgrades(command.key, level, fromSave(next.gold))
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
      if (fromSave(next.gold).lt(cost)) {
        return err(`need ${formatBig(cost)} gold for ${count}x, have ${formatBig(fromSave(next.gold))}`);
      }

      spend(next, cost);
      next.upgrades[command.key] = level + count;
      events.push({
        type: 'upgradeBought',
        key: command.key,
        level: level + count,
        cost: toSave(cost),
        count,
      });
      break;
    }

    case 'equipItem': {
      const { slot, itemId } = command;
      // The live count, decided here rather than by the client. A slot only exists
      // while whatever granted it is still worn, so this has to be re-checked on the
      // server for every equip - the client's copy could be a swap out of date.
      const live = equipSlots(next, { stage: next.currentStage, isBoss: false, enemyHpFraction: 1 });
      if (slot >= live) return err(`slot ${slot + 1} is locked: you have ${live} slots`);
      if (itemId !== null) {
        if (!findItem(next, itemId)) return err(`not owned: ${itemId}`);
        const existing = next.loadout.indexOf(itemId);
        if (existing !== -1 && existing !== slot) next.loadout[existing] = null;
      }
      next.loadout[slot] = itemId;
      break;
    }

    case 'equipWeapon': {
      const { itemId } = command;
      if (itemId !== null) {
        const item = findItem(next, itemId);
        if (!item) return err(`not owned: ${itemId}`);
        // Refused rather than silently ignored: equipping a Charm as a weapon would
        // otherwise leave the player unarmed with no indication why.
        if (!isWeaponBase(item.baseId)) return err('that is not a weapon');
        // A weapon in a gear slot is the same item in two places, and the two would
        // both contribute its effects.
        const inLoadout = next.loadout.indexOf(itemId);
        if (inLoadout !== -1) next.loadout[inLoadout] = null;
      }
      next.weapon = itemId;
      break;
    }

    case 'equipAccessory': {
      const { slot, itemId } = command;
      if (slot >= ACCESSORY_SLOTS) return err(`no accessory slot ${slot}`);

      if (itemId !== null) {
        const item = findItem(next, itemId);
        if (!item) return err(`not owned: ${itemId}`);
        const wear = getBase(item.baseId)?.wear;
        // Refused with the reason rather than silently ignored, the same way a Charm in
        // the weapon slot is. "Nothing happened" is the worst possible answer.
        if (!wear) return err('that is not an accessory');
        if (wear !== ACCESSORY_SLOT_KINDS[slot]) {
          return err(`that is a ${wear}, not a ${ACCESSORY_SLOT_KINDS[slot]}`);
        }
        // The same accessory in two slots would be one item contributing twice - the
        // rule the weapon slot enforces against the loadout, applied within this array.
        const already = next.accessories.indexOf(itemId);
        if (already !== -1) next.accessories[already] = null;
      }

      next.accessories = next.accessories.map((held, i) => (i === slot ? itemId : held));
      break;
    }

    case 'rerollItem': {
      const index = next.items.findIndex((item) => item.uid === command.uid);
      if (index === -1) return err(`not owned: ${command.uid}`);

      const item = next.items[index];
      if (item.rarity === 'unique') return err('uniques cannot be rerolled');

      const cost = rerollCost(item.rarity, item.itemLevel, item.rerolls);
      if (fromSave(next.gold).lt(cost)) {
        return err(`need ${formatBig(cost)} gold to reroll, have ${formatBig(fromSave(next.gold))}`);
      }

      spend(next, cost);
      // Replaces every rolled affix, and leaves the base implicit alone. There
      // is deliberately no way to keep one and reroll the rest - that choice is
      // what gives each roll weight.
      next.items = next.items.map((current, i) =>
        i === index ? rerollAffixes(next.seed, current) : current,
      );
      events.push({ type: 'itemRerolled', uid: command.uid, cost: toSave(cost) });
      break;
    }

    case 'applyCurrency': {
      const currency = getCurrency(command.currencyId);
      if (!currency) return err(`unknown currency: ${command.currencyId}`);

      const held = next.currency[command.currencyId] ?? 0;
      if (held < 1) return err(`you have no ${currency.name}`);

      // Both shelves. A tablet IS an item and takes the same currency; it just lives in
      // its own array so it never competes with gear for INVENTORY_CAP or shows up in
      // an equip slot. Searching one array was what made "most crafting currency works
      // on a tablet" unbuilt rather than unwritten.
      const onTablet = !next.items.some((item) => item.uid === command.uid);
      const shelf = onTablet ? next.tablets : next.items;
      const index = shelf.findIndex((item) => item.uid === command.uid);
      if (index === -1) return err(`not owned: ${command.uid}`);

      const item = shelf[index];
      // The exact string the craft modal greys the option out with. One rule
      // set, so the UI cannot promise something the server then refuses.
      const illegal = currencyLegality(
        item,
        currency,
        next.loadout.includes(item.uid) || next.accessories.includes(item.uid),
      );
      if (illegal) return err(illegal);

      const result = applyCurrencyToItem(next.seed, item, currency);
      next.currency = { ...next.currency, [command.currencyId]: held - 1 };
      events.push({
        type: 'currencyUsed',
        currencyId: currency.id,
        name: currency.name,
        uid: item.uid,
      });

      const write = (shelved: ItemInstance[]) => {
        if (onTablet) next.tablets = shelved;
        else next.items = shelved;
      };

      if (result.item === null) {
        // A gamble that failed. Nothing to unequip - legality already refused
        // this on an equipped item.
        write(shelf.filter((_, i) => i !== index));
        events.push({ type: 'itemDestroyed', uid: item.uid });
        break;
      }

      const crafted = result.item;
      write(shelf.map((current, i) => (i === index ? crafted : current)));
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

    case 'dissembleItems': {
      // Deduplicated first: a list naming the same item twice would otherwise
      // pay out twice for one item.
      const uids = [...new Set(command.uids)];

      // Validated in full before anything is destroyed. A partial dissemble
      // that melted eleven items and then failed on the twelfth would leave the
      // player unable to tell what they still owned.
      const targets = uids.map((uid) => findItem(next, uid));
      const missing = uids.find((uid, i) => !targets[i]);
      if (missing) return err(`not owned: ${missing}`);

      // Refuse rather than silently unequipping. Destroying the item you are
      // currently wearing is the single most expensive misclick available, and
      // an unequip step is a cheap confirmation that costs nothing to undo.
      // Bulk callers filter equipped items out before sending, so this stays a
      // single rule rather than one rule for one item and another for many.
      //
      // The weapon counts as equipped. It is the most expensive item a player owns -
      // it carries their skill and their skill level - so the one thing this guard
      // must not miss is the thing they are holding. Accessories count for the same
      // reason: they drop only from the Abyss, one tablet at a time.
      const equipped = [...next.loadout, next.weapon, ...next.accessories];
      if (uids.some((uid) => equipped.includes(uid))) return err('unequip it first');

      // Dissembling replaced discarding outright. An item you do not want is
      // now raw material for one you do, which makes a full inventory a pile of
      // material rather than a chore.
      const yields: Record<string, number> = {};
      for (const item of targets) {
        const yielded = DISSEMBLE_YIELD[item!.rarity];
        yields[yielded] = (yields[yielded] ?? 0) + 1;
      }

      const doomed = new Set(uids);
      next.items = next.items.filter((current) => !doomed.has(current.uid));
      next.currency = credit(next.currency, yields as CurrencyPurse);
      events.push({ type: 'itemsDissembled', count: uids.length, yields });
      break;
    }

    case 'attemptDungeon': {
      const stage = next.bestStage;
      if (stage < 1) return err('clear a stage first');

      const keys = next.currency['dungeon-key'] ?? 0;
      if (keys < 1) return err('you have no dungeon keys');

      // Spent up front, and spent on a loss too. That is what "need a key to
      // attempt" means, and it is the pressure that makes running one at the
      // edge of your power a decision rather than a formality.
      next.currency = { ...next.currency, 'dungeon-key': keys - 1 };

      const outcome = resolveDungeon(next, stage);
      if (!outcome.cleared) {
        events.push({
          type: 'dungeonFailed',
          stage,
          reason: outcome.failure === 'timeout' ? 'timeout' : 'died',
        });
        break;
      }

      events.push({
        type: 'dungeonCleared',
        stage,
        seconds: outcome.seconds,
        gold: toSave(earn(next, outcome.goldEarned)),
      });

      const uid = next.nextItemId;
      next.nextItemId = uid + 1;

      if (next.items.length >= INVENTORY_CAP) {
        events.push({ type: 'inventoryFull', lost: 1 });
      } else {
        const item = rollDungeonItem(next.seed, uid, stage);
        next.items.push(item);
        events.push({
          type: 'itemDropped',
          itemId: item.uid,
          name: itemName(item),
          rarity: item.rarity,
        });
      }

      // Currency is unaffected by the inventory cap - it is a counter, not an
      // object, so there is nothing to run out of room for.
      const reward = rollDungeonCurrency(next.seed, uid);
      next.currency = credit(next.currency, reward);
      for (const [id, count] of Object.entries(reward) as [CurrencyId, number][]) {
        events.push({
          type: 'currencyDropped',
          currencyId: id,
          name: getCurrency(id)?.name ?? id,
          count,
        });
      }
      break;
    }

    case 'attemptAbyssal': {
      if (next.bestStage < ABYSS_UNLOCK_STAGE) {
        return err(`reach floor ${ABYSS_UNLOCK_STAGE} first`);
      }

      const tablet = next.tablets.find((t) => t.uid === command.uid);
      if (!tablet) return err('you do not have that tablet');

      // Consumed up front, and consumed on a loss. Same pressure a dungeon key
      // carries: running one at the edge of your power is a decision, not a formality.
      next.tablets = next.tablets.filter((t) => t.uid !== command.uid);

      const tier = Math.max(1, Math.round(tablet.itemLevel));
      const outcome = resolveAbyssal(next, tablet);
      if (!outcome.cleared) {
        events.push({
          type: 'abyssalFailed',
          tier,
          reason: outcome.failure === 'timeout' ? 'timeout' : 'died',
        });
        break;
      }

      /*
        What this tablet pays, and how much.

        ONE axis, from the base, amplified by every explicit on it. That coupling is the
        mechanic: an explicit is pure downside on its own, so the only reason to apply
        one is that the implicit pays for it. The previous cut gave each modifier its own
        reward, which made them interchangeable - every mod was "some danger, some
        reward" and there was no reason to prefer any of them.
      */
      const reward = tabletReward(tablet);
      const paid = (axis: TabletPays) => (reward?.pays === axis ? reward.amount : 0);
      const depth = abyssalDepth(tier);

      events.push({
        type: 'abyssalCleared',
        tier,
        seconds: outcome.seconds,
        gold: toSave(earn(next, outcome.goldEarned.mul(1 + paid('gold')))),
      });

      // Items, at the DEPTH the tier fights at rather than at the player's own stage -
      // the whole point of indexing on the tablet is that a T7 pays a T7's item level.
      const items = Math.max(1, Math.round(ABYSSAL_ITEMS_PER_CLEAR * (1 + paid('quantity'))));
      let lost = 0;
      for (let i = 0; i < items; i++) {
        const uid = next.nextItemId;
        next.nextItemId = uid + 1;
        if (next.items.length >= INVENTORY_CAP) {
          lost++;
          continue;
        }
        // Rarity raises the item LEVEL rather than reweighting the rarity table. A deeper
        // roll is a better item on every axis at once - better tiers, more of them - and
        // it cannot quietly multiply the unique rate the way a reweighting would, which
        // is the same trap WAVE_RARITY_WEIGHTS exists to avoid.
        const item = rollDungeonItem(next.seed, uid, Math.round(depth * (1 + paid('rarity'))));
        next.items.push(item);
        events.push({
          type: 'itemDropped',
          itemId: item.uid,
          name: itemName(item),
          rarity: item.rarity,
        });
      }
      if (lost > 0) events.push({ type: 'inventoryFull', lost });

      const currencyUid = next.nextItemId;
      next.nextItemId = currencyUid + 1;
      const units = Math.max(1, Math.round(ABYSSAL_CURRENCY_PER_CLEAR * (1 + paid('quantity'))));
      for (let i = 0; i < units; i++) {
        const purse = rollDungeonCurrency(next.seed, currencyUid + i);
        next.currency = credit(next.currency, purse);
        for (const [id, count] of Object.entries(purse) as [CurrencyId, number][]) {
          events.push({
            type: 'currencyDropped',
            currencyId: id,
            name: getCurrency(id)?.name ?? id,
            count,
          });
        }
      }

      // Tablets last, and expected BELOW one - see rollAbyssalTablets. A tablet that
      // paid for its own replacement would not be a consumable at all.
      const tabletUid = next.nextItemId;
      for (const found of rollAbyssalTablets(next.seed, tabletUid, tier)) {
        next.nextItemId += 1;
        if (next.tablets.length >= TABLET_CAP) continue;
        next.tablets = [...next.tablets, found];
        events.push({ type: 'tabletFound', tier: found.itemLevel, name: itemName(found) });
      }
      break;
    }

    case 'claimOffline': {
      const report = computeOffline(next, nowMs);
      earn(next, report.goldEarned);
      // Advancing lastSeenAt is what makes this idempotent: an immediate second
      // claim finds ~0 elapsed seconds. Double-claim is the classic idle exploit.
      next.lastSeenAt = nowMs;
      events.push({
        type: 'offlineClaimed',
        gold: toSave(report.goldEarned),
        seconds: report.creditedSeconds,
        capped: report.capped,
      });
      break;
    }
  }

  next.contentVersion = CONTENT_VERSION;
  return ok({ state: next, events });
}
