'use client';

/**
 * The game shell.
 *
 * Every upgrade button runs the same path the slice proved: optimistic local
 * applyCommand, POST, authoritative re-run, persistence. Adding the six that
 * followed the first cost a loop, which is what having a real command boundary
 * buys you.
 */

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  bulkUpgradeCost,
  killsPerSecond,
  maxAffordableUpgrades,
  remainingLevels,
  UPGRADE_TRACKS,
  type UpgradeKey,
  type UpgradeView,
} from '@/sim';
import { HUD_TICK_MS, useGameStore } from './store';

/** Bulk purchase sizes. 'max' spends everything the track can absorb. */
const BUY_AMOUNTS = [1, 5, 10, 20, 'max'] as const;
type BuyAmount = (typeof BUY_AMOUNTS)[number];

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
  const [buyAmount, setBuyAmount] = useState<BuyAmount>(1);

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

  const rate = killsPerSecond(state, Math.max(1, state.bestStage || 1));

  return (
    <main className="relative min-h-screen bg-neutral-950 text-neutral-100">
      <div className="absolute inset-0">
        <GameCanvas
          killsPerSecond={rate}
          hitSize={hud.stats.damage}
          attacksPerSecond={hud.stats.attackSpeed}
          stage={Math.max(1, hud.bestStage || 1)}
        />
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

          <div className="flex items-center gap-2 text-xs">
            <label htmlFor="buy-amount" className="text-neutral-400">
              Buy
            </label>
            <select
              id="buy-amount"
              value={String(buyAmount)}
              onChange={(e) =>
                setBuyAmount(e.target.value === 'max' ? 'max' : (Number(e.target.value) as BuyAmount))
              }
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-neutral-100"
            >
              {BUY_AMOUNTS.map((amount) => (
                <option key={String(amount)} value={String(amount)}>
                  {amount === 'max' ? 'Max' : `${amount}x`}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {hud.upgrades.map((upgrade) => (
              <UpgradeButton
                key={upgrade.key}
                upgrade={upgrade}
                amount={buyAmount}
                gold={hud.gold}
                disabled={pending}
                onBuy={(count) => void send({ type: 'buyUpgrade', key: upgrade.key, count })}
              />
            ))}
          </div>

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

/**
 * Nouns only. The magnitudes are read from UPGRADE_TRACKS so retuning a curve
 * cannot leave the UI advertising a number the sim no longer applies.
 */
const EFFECT_NOUNS: Record<string, { noun: string; percent: boolean }> = {
  damage: { noun: 'damage', percent: true },
  attackSpeed: { noun: 'attack speed', percent: true },
  health: { noun: 'max HP', percent: true },
  toughness: { noun: 'effective HP', percent: true },
  greed: { noun: 'gold found', percent: true },
  area: { noun: 'targets hit', percent: false },
  crit: { noun: 'crit chance', percent: true },
};

function effectText(key: string): string {
  const track = UPGRADE_TRACKS[key as keyof typeof UPGRADE_TRACKS];
  const { noun, percent } = EFFECT_NOUNS[key];
  if (track.valueGrowth !== null) {
    return `+${((track.valueGrowth - 1) * 100).toFixed(0)}% ${noun}`;
  }
  const add = track.valueAdd ?? 0;
  return percent ? `+${(add * 100).toFixed(1)}% ${noun}` : `+${add} ${noun}`;
}

/**
 * Levels this button would buy, and what they cost.
 *
 * Mirrors applyCommand's rules so the label matches what the server will
 * actually do: a fixed multiplier is all-or-nothing, 'max' takes what fits.
 * Both call the same sim functions the server calls, so they cannot disagree.
 */
function plannedPurchase(upgrade: UpgradeView, amount: BuyAmount, gold: number) {
  const key = upgrade.key as UpgradeKey;
  if (upgrade.maxed) return { count: 0, cost: Infinity, affordable: false };

  if (amount === 'max') {
    const count = maxAffordableUpgrades(key, upgrade.level, gold);
    return {
      count,
      cost: count > 0 ? bulkUpgradeCost(key, upgrade.level, count) : upgrade.cost,
      affordable: count > 0,
    };
  }

  const count = Math.min(amount, remainingLevels(key, upgrade.level));
  if (count <= 0) return { count: 0, cost: Infinity, affordable: false };
  const cost = bulkUpgradeCost(key, upgrade.level, count);
  return { count, cost, affordable: gold >= cost };
}

function UpgradeButton({
  upgrade,
  amount,
  gold,
  disabled,
  onBuy,
}: {
  upgrade: UpgradeView;
  amount: BuyAmount;
  gold: number;
  disabled: boolean;
  onBuy: (count: number | 'max') => void;
}) {
  const plan = plannedPurchase(upgrade, amount, gold);
  const blocked = disabled || upgrade.maxed || !plan.affordable;

  return (
    <button
      type="button"
      disabled={blocked}
      // 'max' is forwarded as-is rather than as the count computed here. The
      // client's gold is a cache; the server recomputes against its own.
      onClick={() => onBuy(amount === 'max' ? 'max' : plan.count)}
      // No title attribute: it duplicates the effect line already rendered
      // below, and it shadows the label in the accessible name.
      className={[
        'flex flex-col items-start gap-0.5 rounded border px-3 py-2 text-left transition',
        upgrade.maxed
          ? 'border-neutral-800 bg-neutral-900/80 text-neutral-500'
          : plan.affordable
            ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25'
            : 'border-neutral-800 bg-neutral-900/80 text-neutral-400',
        blocked ? 'cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
    >
      <span className="text-sm font-medium">{upgrade.label}</span>
      <span className="text-[11px] text-neutral-400">{effectText(upgrade.key)}</span>
      <span className="font-mono text-[11px]">
        {upgrade.maxed
          ? 'MAX'
          : `Lv ${upgrade.level}${plan.count > 1 ? ` +${plan.count}` : ''} · ${compact(plan.cost)}g`}
      </span>
    </button>
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
      return Number(event.count) > 1
        ? `${event.key} +${event.count} → ${event.level}`
        : `${event.key} → ${event.level}`;
    case 'offlineClaimed':
      return `claimed ${Math.round(Number(event.gold))} idle gold`;
    default:
      return event.type;
  }
}
