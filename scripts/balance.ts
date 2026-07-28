/**
 * Balance harness.
 *
 * Runs a greedy "spend gold optimally" agent through the stage ladder and
 * prints time-to-clear per stage. This is the only honest way to know whether
 * the curves in src/sim/curves.ts intersect the way they should - you cannot
 * feel out 300 stages by playing.
 *
 *   pnpm balance              # print the table
 *   pnpm balance --write      # update the golden snapshot
 *
 * Commit the golden file. When you change a constant, the diff shows you
 * exactly how pacing moved.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  farmRate,
  newSave,
  resolveStage,
  upgradeCost,
  isUpgradeMaxed,
  UPGRADE_KEYS,
  STAGE_TIME_LIMIT_SECONDS,
  type SaveState,
  type UpgradeKey,
} from '../src/sim';

const MAX_STAGE = 300;
const SEED = 0xc0ffee;
/**
 * How long the agent will farm for a single upgrade before declaring the run
 * stalled. This is a statement about player patience, not a technical limit -
 * if the model says the next upgrade is 40 days of farming, that stage is a
 * wall whether or not the arithmetic terminates.
 */
const PATIENCE_SECONDS = 21 * 24 * 3600;
const GOLDEN_PATH = resolve(process.cwd(), 'tests/__snapshots__/balance.golden.txt');

/** How close the agent is to beating a stage. >1 means it clears. */
function clearScore(save: SaveState, stage: number): number {
  const o = resolveStage(save, stage);
  const survival = 1 / Math.max(o.damageTakenFraction, 1e-9);
  const speed = STAGE_TIME_LIMIT_SECONDS / Math.max(o.seconds, 1e-9);
  return Math.min(survival, speed);
}

/** Objective the greedy agent maximises: beat the stage, and farm faster. */
function value(save: SaveState, stage: number): number {
  return Math.log(clearScore(save, stage)) + 0.5 * Math.log(farmRate(save, save.bestStage) + 1);
}

function withUpgrade(save: SaveState, key: UpgradeKey): SaveState {
  return { ...save, upgrades: { ...save.upgrades, [key]: save.upgrades[key] + 1 } };
}

interface Purchase {
  key: UpgradeKey;
  cost: number;
  gain: number;
}

function bestPurchase(save: SaveState, stage: number): Purchase | null {
  const before = value(save, stage);
  let best: Purchase | null = null;

  for (const key of UPGRADE_KEYS) {
    const level = save.upgrades[key];
    if (isUpgradeMaxed(key, level)) continue;
    const cost = upgradeCost(key, level);
    const delta = value(withUpgrade(save, key), stage) - before;
    if (delta <= 0) continue;
    // Compared in log space: late-game costs exceed 1e300, and a raw
    // delta/cost ratio underflows to zero for every candidate, which the
    // harness would otherwise report as a wall that does not exist.
    const gain = Math.log(delta) - Math.log(cost);
    if (best === null || gain > best.gain) best = { key, cost, gain };
  }
  return best;
}

export interface Row {
  stage: number;
  attempts: number;
  cumulativeSeconds: number;
  stageSeconds: number;
  clearSeconds: number;
  goldPerSecond: number;
  totalLevels: number;
}

/** Printed when the agent stalls, so a wall report is actionable rather than mysterious. */
function diagnose(save: SaveState, stage: number): string {
  const o = resolveStage(save, stage);
  const before = value(save, stage);
  const lines = [
    `  outcome: cleared=${o.cleared} failure=${o.failure} seconds=${o.seconds.toFixed(2)} ` +
      `damageTaken=${o.damageTakenFraction.toFixed(3)} trash=${o.trashPhaseSeconds.toFixed(2)}s ` +
      `boss=${o.bossPhaseSeconds.toFixed(2)}s`,
    `  gold=${save.gold.toExponential(2)} value=${before.toFixed(4)} farm=${farmRate(save, save.bestStage).toExponential(2)}`,
  ];
  for (const key of UPGRADE_KEYS) {
    const level = save.upgrades[key];
    const maxed = isUpgradeMaxed(key, level);
    const delta = maxed ? NaN : value(withUpgrade(save, key), stage) - before;
    lines.push(
      `  ${key.padEnd(12)} lvl=${String(level).padStart(4)} ` +
        `${maxed ? 'MAXED' : `cost=${upgradeCost(key, level).toExponential(2)} delta=${delta.toExponential(3)}`}`,
    );
  }
  return lines.join('\n');
}

export function runLadder(): { rows: Row[]; wall: number | null; diagnosis: string; stallReason: string } {
  let save = newSave(SEED, 0);
  let elapsed = 0;
  const rows: Row[] = [];

  for (let stage = 1; stage <= MAX_STAGE; stage++) {
    const stageStart = elapsed;
    let attempts = 0;
    let stalled = false;
    let stallReason = 'no purchase improves the outcome';

    for (;;) {
      const outcome = resolveStage(save, stage);
      attempts++;
      elapsed += Math.min(outcome.seconds, STAGE_TIME_LIMIT_SECONDS);
      save = { ...save, gold: save.gold + outcome.goldEarned };

      if (outcome.cleared) {
        save = { ...save, bestStage: stage, currentStage: stage + 1 };
        break;
      }

      // Buy everything currently affordable that helps.
      let boughtAnything = false;
      for (;;) {
        const buy = bestPurchase(save, stage);
        if (!buy || buy.cost > save.gold) break;
        save = { ...withUpgrade(save, buy.key), gold: save.gold - buy.cost };
        boughtAnything = true;
      }

      if (!boughtAnything) {
        // Farm at the best cleared stage until the next useful upgrade is affordable.
        const buy = bestPurchase(save, stage);
        const rate = farmRate(save, save.bestStage);
        if (!buy) {
          stalled = true;
          break;
        }
        if (rate <= 0) continue; // no farm income yet; keep re-attempting for partial gold
        const deficit = buy.cost - save.gold;
        const seconds = deficit / rate;
        if (!Number.isFinite(seconds) || seconds > PATIENCE_SECONDS) {
          stalled = true;
          stallReason = `next upgrade (${buy.key}) costs ${buy.cost.toExponential(2)} at ${rate.toExponential(2)} gold/s = ${fmtDuration(seconds)} of farming`;
          break;
        }
        elapsed += seconds;
        save = { ...save, gold: save.gold + seconds * rate };
      }

      if (attempts > 5000) {
        stalled = true;
        break;
      }
    }

    if (stalled) return { rows, wall: stage, diagnosis: diagnose(save, stage), stallReason };

    rows.push({
      stage,
      attempts,
      cumulativeSeconds: elapsed,
      stageSeconds: elapsed - stageStart,
      clearSeconds: resolveStage(save, stage).seconds,
      goldPerSecond: farmRate(save, stage),
      totalLevels: UPGRADE_KEYS.reduce((n, k) => n + save.upgrades[k], 0),
    });
  }

  return { rows, wall: null, diagnosis: '', stallReason: '' };
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function report(): string {
  const { rows, wall, diagnosis, stallReason } = runLadder();
  const lines: string[] = [];

  lines.push('stage |  attempts | time in stage | total elapsed | clear time |    gold/s | levels');
  lines.push('------+-----------+---------------+---------------+------------+-----------+-------');

  for (const r of rows) {
    const milestone = r.stage <= 10 || r.stage % 10 === 0;
    if (!milestone) continue;
    lines.push(
      [
        String(r.stage).padStart(5),
        String(r.attempts).padStart(10),
        fmtDuration(r.stageSeconds).padStart(14),
        fmtDuration(r.cumulativeSeconds).padStart(14),
        `${r.clearSeconds.toFixed(1)}s`.padStart(11),
        r.goldPerSecond.toFixed(1).padStart(10),
        String(r.totalLevels).padStart(7),
      ].join(' |'),
    );
  }

  lines.push('');
  if (wall === null) {
    lines.push(`reached stage ${MAX_STAGE} in ${fmtDuration(rows[rows.length - 1].cumulativeSeconds)}`);
  } else {
    lines.push(`WALL at stage ${wall} - ${stallReason}`);
    lines.push(diagnosis);
  }
  return lines.join('\n');
}

const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/balance.ts');
if (invokedDirectly) {
  const out = report();
  console.log(out);
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    writeFileSync(GOLDEN_PATH, `${out}\n`, 'utf8');
    console.log(`\nwrote ${GOLDEN_PATH}`);
  }
}

