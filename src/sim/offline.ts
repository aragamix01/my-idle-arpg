/**
 * Offline progress.
 *
 * Closed-form: `rate(bestStage) × elapsed`. The server already knows bestStage
 * and lastSeenAt, so the client never reports farm income and cannot inflate
 * it. Vercel Hobby caps cron at once per day, so this is computed lazily on the
 * player's next request rather than by a background ticker.
 */

import { big, type Big } from './big';
import { farmRate } from './combat';
import { OFFLINE_CAP_SECONDS, OFFLINE_EFFICIENCY } from './curves';
import type { SaveState } from './types';

export interface OfflineReport {
  /** Wall-clock seconds since lastSeenAt. */
  elapsedSeconds: number;
  /** Seconds actually paid out, after the cap. */
  creditedSeconds: number;
  goldEarned: Big;
  /** True when the player left progress on the table by staying away too long. */
  capped: boolean;
}

export function computeOffline(save: SaveState, nowMs: number): OfflineReport {
  const elapsedSeconds = Math.max(0, (nowMs - save.lastSeenAt) / 1000);
  const creditedSeconds = Math.min(elapsedSeconds, OFFLINE_CAP_SECONDS);
  // No flooring. Gold has not been an integer since it passed 2^53, and rounding a
  // value whose precision step is already larger than 1 only makes the code look
  // exact - see src/sim/big.ts.
  const gold = big(farmRate(save, save.bestStage)).mul(creditedSeconds).mul(OFFLINE_EFFICIENCY);

  return {
    elapsedSeconds,
    creditedSeconds,
    goldEarned: gold,
    capped: elapsedSeconds > OFFLINE_CAP_SECONDS,
  };
}
