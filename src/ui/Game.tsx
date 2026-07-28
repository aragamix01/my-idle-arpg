'use client';

/**
 * The vertical slice.
 *
 * Deliberately one upgrade button, not seven. Clicking it exercises the whole
 * round trip - optimistic local applyCommand, POST, authoritative re-run,
 * persistence - and the remaining six tracks are a loop over UPGRADE_KEYS once
 * that path is proven.
 */

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { killsPerSecond } from '@/sim';
import { HUD_TICK_MS, useGameStore } from './store';

// Pixi touches the DOM on import, so it must never run during SSR.
const GameCanvas = dynamic(() => import('@/render/GameCanvas').then((m) => m.GameCanvas), {
  ssr: false,
});

function compact(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value < 1000) return value.toFixed(value < 10 && value % 1 !== 0 ? 1 : 0);
  const units = ['k', 'M', 'B', 'T', 'q', 'Q'];
  let scaled = value;
  let unit = -1;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit++;
  }
  return `${scaled.toFixed(2)}${units[unit]}`;
}

export function Game() {
  const { state, hud, events, pending, error, desynced, bootstrap, send, refreshHud } =
    useGameStore();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // The throttled HUD channel. Gold accrues continuously; ten updates a second
  // is plenty for numbers a human reads, and costs nothing next to a 60Hz
  // React re-render over the same data.
  useEffect(() => {
    const id = setInterval(refreshHud, HUD_TICK_MS);
    return () => clearInterval(id);
  }, [refreshHud]);

  if (!hud || !state) {
    return <main className="grid min-h-screen place-items-center text-sm text-neutral-400">loading…</main>;
  }

  const damage = hud.upgrades.find((u) => u.key === 'damage')!;
  const rate = killsPerSecond(state, Math.max(1, state.bestStage || 1));

  return (
    <main className="relative min-h-screen bg-neutral-950 text-neutral-100">
      <div className="absolute inset-0">
        <GameCanvas killsPerSecond={rate} hitSize={hud.stats.damage} />
      </div>

      <div className="pointer-events-none relative z-10 flex min-h-screen flex-col justify-between p-6">
        <header className="pointer-events-auto flex flex-wrap gap-6 text-sm">
          <Stat label="gold" value={compact(hud.gold)} />
          <Stat label="gold/s" value={compact(hud.goldPerSecond)} />
          <Stat label="stage" value={String(hud.currentStage)} />
          <Stat label="best" value={String(hud.bestStage)} />
          <Stat label="damage" value={compact(hud.stats.damage)} />
          <Stat label="kills/s" value={compact(rate)} />
        </header>

        <footer className="pointer-events-auto flex flex-col gap-3">
          {error && (
            <p className="text-xs text-amber-400">
              {error}
              {desynced && ' — resynced from server'}
            </p>
          )}

          <ul className="flex flex-wrap gap-2 text-xs text-neutral-400">
            {events.slice(-3).map((event, i) => (
              <li key={i} className="rounded bg-neutral-900/80 px-2 py-1">
                {describe(event)}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => void send({ type: 'attemptStage' })}
              className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
            >
              Attempt stage {hud.currentStage}
            </button>

            <button
              type="button"
              disabled={pending || !damage.affordable}
              onClick={() => void send({ type: 'buyUpgrade', key: 'damage' })}
              className="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-40"
            >
              Damage {damage.level} → {damage.level + 1} · {compact(damage.cost)} gold
            </button>

            <button
              type="button"
              disabled={pending || hud.pendingOfflineGold <= 0}
              onClick={() => void send({ type: 'claimOffline' })}
              className="rounded border border-neutral-700 px-4 py-2 text-sm disabled:opacity-40"
            >
              Claim {compact(hud.pendingOfflineGold)} idle gold
            </button>
          </div>
        </footer>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-neutral-900/80 px-3 py-1.5">
      <span className="text-neutral-500">{label} </span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function describe(event: { type: string } & Record<string, unknown>): string {
  switch (event.type) {
    case 'stageCleared':
      return `cleared stage ${event.stage} in ${Number(event.seconds).toFixed(1)}s`;
    case 'stageFailed':
      return `stage ${event.stage} failed (${event.reason})`;
    case 'artifactDropped':
      return `found ${event.artifactId}`;
    case 'upgradeBought':
      return `${event.key} → ${event.level}`;
    case 'offlineClaimed':
      return `claimed ${Math.round(Number(event.gold))} idle gold`;
    default:
      return event.type;
  }
}
