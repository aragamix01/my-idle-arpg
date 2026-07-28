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
import { isUpgradeMaxed, upgradeCost } from './curves';
import { ARTIFACTS, CONTENT_VERSION, artifactExists } from './content';
import { computeOffline } from './offline';
import { createRng } from './rng';
import {
  ARTIFACT_SLOTS,
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
  z.object({ type: z.literal('buyUpgrade'), key: z.enum(UPGRADE_KEYS) }).strict(),
  z
    .object({
      type: z.literal('equipArtifact'),
      slot: z.number().int().min(0).max(ARTIFACT_SLOTS - 1),
      artifactId: z.string().nullable(),
    })
    .strict(),
  z.object({ type: z.literal('claimOffline') }).strict(),
]);

export type Command = z.infer<typeof CommandSchema>;

export type SimEvent =
  | { type: 'stageCleared'; stage: number; seconds: number; gold: number }
  | { type: 'stageFailed'; stage: number; reason: 'died' | 'timeout'; gold: number }
  | { type: 'artifactDropped'; artifactId: string }
  | { type: 'upgradeBought'; key: string; level: number; cost: number }
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
    lastSeenAt: nowMs,
  };
}

/**
 * Roll a boss drop. Seeded by (account seed, stage) so the same clear always
 * produces the same drop — the client's optimistic prediction matches the
 * server's answer, and neither can reroll for a better item.
 */
function rollDrop(save: SaveState, stage: number): string | null {
  const rng = createRng(save.seed).fork(stage * 2654435761);
  const eligible = ARTIFACTS.filter(
    (a) => a.dropStage <= stage && !save.artifactsOwned.includes(a.id),
  );
  if (eligible.length === 0) return null;
  if (!rng.chance(0.35)) return null;
  return eligible[rng.int(eligible.length)].id;
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

        const drop = rollDrop(state, stage);
        if (drop) {
          next.artifactsOwned.push(drop);
          events.push({ type: 'artifactDropped', artifactId: drop });
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
      const cost = upgradeCost(command.key, level);
      if (next.gold < cost) return err(`need ${cost} gold, have ${Math.floor(next.gold)}`);
      next.gold -= cost;
      next.upgrades[command.key] = level + 1;
      events.push({ type: 'upgradeBought', key: command.key, level: level + 1, cost });
      break;
    }

    case 'equipArtifact': {
      const { slot, artifactId } = command;
      if (artifactId !== null) {
        if (!artifactExists(artifactId)) return err(`unknown artifact: ${artifactId}`);
        if (!next.artifactsOwned.includes(artifactId)) return err(`not owned: ${artifactId}`);
        const existing = next.loadout.indexOf(artifactId);
        if (existing !== -1 && existing !== slot) next.loadout[existing] = null;
      }
      next.loadout[slot] = artifactId;
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
