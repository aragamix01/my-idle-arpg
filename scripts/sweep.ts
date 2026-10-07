/**
 * Ladder pacing across several account seeds.
 *
 *   pnpm exec tsx scripts/sweep.ts [seed ...]
 *
 * One seed cannot tell a pacing change from drop luck - total ladder time spans days
 * between seeds on identical code (see "Verification" in currency-item.txt). This runs
 * the same agent the golden uses on each seed and prints what a balance change has to
 * be read against: total time, and the clear-time spread either side of the Abyss
 * unlock, where the band deliberately splits.
 */

import { ABYSS_UNLOCK_STAGE } from '../src/sim';
import { runLadder } from './balance';

const seeds = process.argv.slice(2).map(Number).filter(Number.isFinite);
const SEEDS = seeds.length > 0 ? seeds : [1, 2, 3, 4];

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

for (const seed of SEEDS) {
  const started = Date.now();
  const { rows, wall } = runLadder(seed);
  const last = rows[rows.length - 1];
  const before = rows.filter((r) => r.stage < ABYSS_UNLOCK_STAGE).map((r) => r.clearSeconds);
  const after = rows.filter((r) => r.stage >= ABYSS_UNLOCK_STAGE).map((r) => r.clearSeconds);
  const days = last ? last.cumulativeSeconds / 86400 : NaN;
  console.log(
    [
      `seed ${seed}`,
      wall === null ? `reached ${last?.stage}` : `WALL at ${wall}`,
      `${days.toFixed(1)}d`,
      `pre-${ABYSS_UNLOCK_STAGE} p10 ${percentile(before, 0.1).toFixed(1)}s`,
      `post p10 ${percentile(after, 0.1).toFixed(1)}s`,
      `(${((Date.now() - started) / 1000).toFixed(0)}s to run)`,
    ].join('  '),
  );
}
