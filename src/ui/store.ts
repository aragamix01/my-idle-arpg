/**
 * UI state.
 *
 * This store holds the ~15 HUD scalars and nothing else. Entity positions never
 * come near it - the Pixi renderer reads those directly inside its own loop at
 * 60Hz. Pushing thousands of entities through a store subscription is how a
 * bullet-hell loses its frame budget before it draws anything.
 */

'use client';

import { create } from 'zustand';
import type { GameStateResponse } from '@/contract';
import { applyCommand, getHudSnapshot, type Command, type HudSnapshot, type SaveState, type SimEvent } from '@/sim';

/** HUD refresh rate. Sixty would be wasted work on numbers nobody can read that fast. */
export const HUD_TICK_MS = 100;

interface GameStore {
  state: SaveState | null;
  hud: HudSnapshot | null;
  events: SimEvent[];
  pending: boolean;
  error: string | null;
  /** True when the server rejected an optimistic prediction and we resynced. */
  desynced: boolean;

  bootstrap: () => Promise<void>;
  send: (command: Command) => Promise<void>;
  refreshHud: () => void;
}

function adopt(response: GameStateResponse) {
  return {
    state: response.state,
    hud: response.hud,
    events: response.events,
    error: null,
  };
}

export const useGameStore = create<GameStore>()((set, get) => ({
  state: null,
  hud: null,
  events: [],
  pending: false,
  error: null,
  desynced: false,

  bootstrap: async () => {
    set({ pending: true });
    try {
      const response = (await fetch('/api/state').then((r) => r.json())) as GameStateResponse;
      set({ ...adopt(response), pending: false });
    } catch (error) {
      set({ pending: false, error: error instanceof Error ? error.message : 'failed to load' });
    }
  },

  send: async (command) => {
    const current = get().state;
    if (!current) return;

    // Optimistic: run the exact same function the server is about to run, so
    // the UI responds now instead of after a round trip. If the prediction was
    // right - which it is unless the client is stale - the server's answer is
    // identical and the swap below is invisible.
    const predicted = applyCommand(current, command, Date.now());
    if (predicted.ok) {
      set({
        state: predicted.value.state,
        hud: getHudSnapshot(predicted.value.state, Date.now()),
        events: predicted.value.events,
      });
    }

    set({ pending: true });
    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      });
      const payload = (await response.json()) as GameStateResponse & { error?: string };

      if (!response.ok) {
        // The server sends its real state back with the rejection, so a
        // divergence self-heals on the next command instead of compounding.
        set({
          ...adopt(payload),
          pending: false,
          error: payload.error ?? 'command rejected',
          desynced: true,
        });
        return;
      }

      set({ ...adopt(payload), pending: false, desynced: false });
    } catch (error) {
      set({ pending: false, error: error instanceof Error ? error.message : 'request failed' });
    }
  },

  refreshHud: () => {
    const state = get().state;
    if (state) set({ hud: getHudSnapshot(state, Date.now()) });
  },
}));
