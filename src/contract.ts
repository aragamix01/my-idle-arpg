/**
 * The wire contract between client and server.
 *
 * Types only, no runtime code, so both halves can import it without dragging
 * server modules into the browser bundle.
 */

import type { HudSnapshot, SaveState, SimEvent } from '@/sim';

/** Every endpoint returns the full authoritative state. The client's copy is a cache. */
export interface GameStateResponse {
  state: SaveState;
  hud: HudSnapshot;
  events: SimEvent[];
  /** Server time, so the client never trusts its own clock for offline accrual. */
  serverNowMs: number;
}

export interface ApiError {
  error: string;
}
