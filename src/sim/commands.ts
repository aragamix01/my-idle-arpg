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
import { CONTENT_VERSION } from './content';
import { computeOffline } from './offline';
import { rerollAffixes, rollItem, itemName } from './items';
import { findItem } from './stats';
import {
  ARTIFACT_SLOTS,
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
      type: z.literal('equipArtifact'),
      slot: z.number().int().min(0).max(ARTIFACT_SLOTS - 1),
      /** Item uid, or null to clear the slot. */
      artifactId: z.string().nullable(),
    })
    .strict(),
  z.object({ type: z.literal('rerollItem'), uid: z.string().min(1) }).strict(),
  z.object({ type: z.literal('discardItem'), uid: z.string().min(1) }).strict(),
  z.object({ type: z.literal('claimOffline') }).strict(),
]);

export type Command = z.infer<typeof CommandSchema>;

export type SimEvent =
  | { type: 'stageCleared'; stage: number; seconds: number; gold: number }
  | { type: 'stageFailed'; stage: number; reason: 'died' | 'timeout'; gold: number }
  | { type: 'artifactDropped'; artifactId: string; name: string; rarity: string }
  | { type: 'inventoryFull' }
  | { type: 'itemRerolled'; uid: string; cost: number }
  | { type: 'itemDiscarded'; uid: string }
  | { type: 'upgradeBought'; key: string; level: number; cost: number; count: number }
  | { type: 'offlineClaimed'; gold: number; seconds: number; capped: boolean };

export interface CommandOutcome {
  state: SaveState;
  events: SimEvent[];
}

function emptyUpgrades(): UpgradeLevels {
  return Object.fromEntries(UPGRADE_KEYS.map((k) => [k, 0])) as UpgradeLevels;
}

export function newSave(seed: number, nowMs: number): SaveState {
  return {
    contentVersion: CONTENT_VERSION,
    seed,
    gold: 0,
    bestStage: 0,
    currentStage: 1,
    upgrades: emptyUpgrades(),
    artifactsOwned: [],
    loadout: Array<string | null>(ARTIFACT_SLOTS).fill(null),
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
    artifactsOwned: [...state.artifactsOwned],
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

        // Every clear drops. Rarity is what varies, not whether anything falls.
        if (next.artifactsOwned.length >= INVENTORY_CAP) {
          events.push({ type: 'inventoryFull' });
        } else {
          const uid = next.nextItemId;
          next.nextItemId = uid + 1;
          const item = rollItem(next.seed, uid, stage);
          next.artifactsOwned.push(item);
          events.push({
            type: 'artifactDropped',
            artifactId: item.uid,
            name: itemName(item),
            rarity: item.rarity,
          });
        }
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

    case 'equipArtifact': {
      const { slot, artifactId } = command;
      if (artifactId !== null) {
        if (!findItem(next, artifactId)) return err(`not owned: ${artifactId}`);
        const existing = next.loadout.indexOf(artifactId);
        if (existing !== -1 && existing !== slot) next.loadout[existing] = null;
      }
      next.loadout[slot] = artifactId;
      break;
    }

    case 'rerollItem': {
      const index = next.artifactsOwned.findIndex((item) => item.uid === command.uid);
      if (index === -1) return err(`not owned: ${command.uid}`);

      const item = next.artifactsOwned[index];
      if (item.rarity === 'unique') return err('uniques cannot be rerolled');

      const cost = rerollCost(item.rarity, item.itemLevel, item.rerolls);
      if (next.gold < cost) {
        return err(`need ${cost} gold to reroll, have ${Math.floor(next.gold)}`);
      }

      next.gold -= cost;
      // Replaces every affix. There is deliberately no way to keep one and
      // reroll the rest - that choice is what gives each roll weight.
      next.artifactsOwned = next.artifactsOwned.map((current, i) =>
        i === index ? rerollAffixes(next.seed, current) : current,
      );
      events.push({ type: 'itemRerolled', uid: command.uid, cost });
      break;
    }

    case 'discardItem': {
      if (!findItem(next, command.uid)) return err(`not owned: ${command.uid}`);
      // Unequip first, or the loadout would point at an item that is gone.
      next.loadout = next.loadout.map((uid) => (uid === command.uid ? null : uid));
      next.artifactsOwned = next.artifactsOwned.filter((item) => item.uid !== command.uid);
      events.push({ type: 'itemDiscarded', uid: command.uid });
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
