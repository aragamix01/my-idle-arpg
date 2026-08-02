'use client';

/**
 * The game shell.
 *
 * Every upgrade button runs the same path the slice proved: optimistic local
 * applyCommand, POST, authoritative re-run, persistence. Adding the six that
 * followed the first cost a loop, which is what having a real command boundary
 * buys you.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  abyssalDepth,
  bulkUpgradeCost,
  formatBig,
  fromSave,
  itemSprite,
  killsPerSecond,
  maxAffordableUpgrades,
  remainingLevels,
  resolveAbyssal,
  resolveDungeon,
  resolveStage,
  rollItem,
  rollTablet,
  rollWaveTablets,
  rollWaveDropCount,
  WAVE_RARITY_WEIGHTS,
  STAGE_TIME_LIMIT_SECONDS,
  statsFromWire,
  UPGRADE_TRACKS,
  type Big,
  type HudSnapshot,
  type SaveState,
  type UpgradeKey,
  type SimEvent,
  type UpgradeView,
} from '@/sim';
import type { AttemptRequest } from '@/render/GameCanvas';
import type { SpriteId } from '@/render/sprites';
import { AtlasSprite } from './atlasSprite';
import { CharacterPanel } from './CharacterPanel';
import { compact, ELEMENT_STYLE, elementName } from './format';
import { HUD_TICK_MS, useGameStore } from './store';
import { TabletStash } from './TabletStash';

/**
 * A replay in flight, plus which tablet paid for it.
 *
 * The uid rides on the request for the same reason the kind does: which command to send
 * when the replay ends is decided by what was being replayed, and tracking it separately
 * means two pieces of state that can disagree about what the player just watched.
 */
type Attempt = AttemptRequest & { tabletUid?: string };

/** Bulk purchase sizes. 'max' spends everything the track can absorb. */
const BUY_AMOUNTS = [1, 5, 10, 20, 'max'] as const;
type BuyAmount = (typeof BUY_AMOUNTS)[number];

// Pixi touches the DOM on import, so it must never run during SSR.
const GameCanvas = dynamic(() => import('@/render/GameCanvas').then((m) => m.GameCanvas), {
  ssr: false,
});

export function Game() {
  const { state, hud, events, pending, error, desynced, bootstrap, send, refreshHud } =
    useGameStore();
  const [buyAmount, setBuyAmount] = useState<BuyAmount>(1);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [abyssOpen, setAbyssOpen] = useState(false);
  const attemptSeq = useRef(0);
  const [receipt, setReceipt] = useState<OfflineReceipt | null>(null);
  /**
   * Whether this mount has already settled the offline question.
   *
   * A ref rather than state: the HUD ticks ten times a second and every tick would
   * otherwise re-enter the effect, fire a second claim, and replace the receipt with a
   * report of the milliseconds since the first one.
   */
  const settledOffline = useRef(false);

  /**
   * Resolve the stage now, play the replay, and only then send the command.
   *
   * resolveStage is deterministic and pure, so the outcome shown is the outcome
   * the server will independently reach - the replay is a preview, not a
   * prediction that could be wrong. Sending on completion is what stops gold
   * and stage from jumping before the fight is over.
   *
   * Closing the tab mid-replay costs the attempt. That is the honest reading:
   * the run did not finish.
   */
  const startAttempt = useCallback(() => {
    const current = useGameStore.getState().state;
    if (!current || attempt) return;
    const stage = current.currentStage;
    attemptSeq.current += 1;
    setAttempt({
      id: attemptSeq.current,
      stage,
      outcome: resolveStage(current, stage),
      waveDrops: waveDropSprites(current, stage),
    });
  }, [attempt]);

  /**
   * Same shape as a stage attempt: resolve now, play the replay, commit when
   * it finishes. resolveDungeon is pure and deterministic, so what the replay
   * shows is what the server will independently reach.
   */
  const startDungeon = useCallback(() => {
    const current = useGameStore.getState().state;
    if (!current || attempt) return;
    attemptSeq.current += 1;
    setAttempt({
      id: attemptSeq.current,
      stage: current.bestStage,
      outcome: resolveDungeon(current, current.bestStage),
      kind: 'dungeon',
    });
  }, [attempt]);

  /**
   * Descend, on the tablet the player picked.
   *
   * Same shape again, with one difference worth naming: the stage passed to the replay
   * is the tier's DEPTH, not the tier. The Abyss indexes on the tablet, so a T7 is a
   * fight at floor 152 no matter where the player's own ladder has reached - which is
   * the whole reason the mode does not scale off `bestStage`.
   */
  const startAbyssal = useCallback(
    (uid: string) => {
      const current = useGameStore.getState().state;
      if (!current || attempt) return;
      const tablet = current.tablets.find((t) => t.uid === uid);
      if (!tablet) return;

      setAbyssOpen(false);
      attemptSeq.current += 1;
      // A tablet's itemLevel IS its tier - see content/tablets.ts. The replay wants the
      // depth for the fight and the tier for the banner, and they are different numbers.
      const tier = Math.max(1, Math.round(tablet.itemLevel));
      setAttempt({
        id: attemptSeq.current,
        stage: abyssalDepth(tier),
        outcome: resolveAbyssal(current, tablet),
        kind: 'abyssal',
        tier,
        tabletUid: uid,
      });
    },
    [attempt],
  );

  const finishAttempt = useCallback(() => {
    // Which command to send is decided by what was being replayed. Reading it
    // off the request rather than tracking a second piece of state means the
    // two can never disagree about what the player just watched.
    const finished = attempt;
    setAttempt(null);
    if (finished?.kind === 'abyssal' && finished.tabletUid) {
      void send({ type: 'attemptAbyssal', uid: finished.tabletUid });
      return;
    }
    void send({ type: finished?.kind === 'dungeon' ? 'attemptDungeon' : 'attemptStage' });
  }, [attempt, send]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /**
   * Credit whatever accrued while you were gone, then say what it was.
   *
   * Claimed rather than offered, which is the whole point of a receipt: there is never
   * a state where gold is owed and uncollected, so closing this can cost nothing. The
   * command is idempotent - it advances `lastSeenAt`, so a second call finds ~0 seconds
   * - but the ref stops it being sent twice regardless.
   */
  useEffect(() => {
    if (!hud || settledOffline.current) return;
    settledOffline.current = true;

    const earned = fromSave(hud.pendingOfflineGold);
    if (earned.lte(0)) return;

    // Captured BEFORE the claim. Claiming resets the pending figures, so reading them
    // afterwards would report a player who had been away for no time at all.
    const captured: OfflineReceipt = {
      gold: earned,
      seconds: hud.pendingOfflineSeconds,
      capped: hud.offlineCapReached,
      stage: hud.bestStage,
    };
    // Shown once the claim lands rather than synchronously, so the balance behind the
    // modal already includes the number on it - and so this is not a setState in an
    // effect body, which cascades a render before the request has even left.
    void send({ type: 'claimOffline' }).then(() => setReceipt(captured));
  }, [hud, send]);

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
  const keys = hud.currency['dungeon-key'] ?? 0;
  // Parsed once per render rather than at each of the five places that read it -
  // the HUD ticks ten times a second and this is a string every time it arrives.
  const gold = fromSave(hud.gold);
  // The snapshot crosses the wire as JSON, so its magnitudes arrive as strings.
  const stats = statsFromWire(hud.stats);

  const upgradeGrid = (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {hud.upgrades.map((upgrade) => (
        <UpgradeButton
          key={upgrade.key}
          upgrade={upgrade}
          amount={buyAmount}
          gold={gold}
          disabled={pending}
          onBuy={(count) => void send({ type: 'buyUpgrade', key: upgrade.key, count })}
        />
      ))}
    </div>
  );

  /*
    Rendered twice - once in the desktop bar, once in the sheet - so the id has to
    be per-instance. With a shared one the DOM held two `#buy-amount` elements, the
    `for` attribute bound to whichever came first, and on a phone that was the
    hidden desktop copy: the label pointed at a control nobody could see.
  */
  const buyPicker = (id: string) => (
    <div className="flex items-center gap-2 text-xs">
      <label htmlFor={id} className="text-neutral-400">
        Buy
      </label>
      <select
        id={id}
        value={String(buyAmount)}
        onChange={(e) =>
          setBuyAmount(e.target.value === 'max' ? 'max' : (Number(e.target.value) as BuyAmount))
        }
        className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono text-neutral-100"
      >
        {BUY_AMOUNTS.map((amount) => (
          <option key={String(amount)} value={String(amount)}>
            {amount === 'max' ? 'Max' : `${amount}x`}
          </option>
        ))}
      </select>
    </div>
  );

  /*
    Three fixed rows: status, arena, controls. Nothing overlaps anything.

    The canvas used to be `absolute inset-0` with the whole UI floating over it,
    which is why the phone screenshot has spiders crawling through the upgrade
    text and the action row hidden behind Safari's chrome. The fight now owns a
    bounded row and every surface below it is opaque.
  */
  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <header
        className="shrink-0 border-b border-neutral-800 bg-neutral-950/95 px-3 pb-2"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-2">
          {/*
            One horizontally scrollable rail rather than a wrapping grid. Six
            chips cannot fit a phone width, and wrapping them pushed the arena
            down by a whole row at exactly the moment a number got longer.
          */}
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Stat label="gold" value={formatBig(gold)} />
            <Stat label="gold/s" value={formatBig(fromSave(hud.goldPerSecond))} />
            <Stat label="stage" value={String(hud.currentStage)} />
            <Stat label="best" value={String(hud.bestStage)} />
            <Stat label="dmg" value={formatBig(stats.damage)} />
            <Stat label="kills/s" value={compact(rate)} />
          </div>

          {/* In the flow, not absolutely positioned - it used to sit on top of
              the stage chip on a narrow screen. */}
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            aria-label="Character"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-500/50 bg-neutral-900 px-2.5 py-2 text-sm font-medium text-amber-100 active:bg-neutral-800 sm:px-3"
          >
            <AtlasSprite id="player.knight" scale={2} />
            <span className="hidden sm:inline">Character</span>
            {hud.items.length > 0 && (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] text-amber-200">
                {hud.items.length}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* The arena. `min-h-0` is what lets it shrink rather than pushing the
          controls off screen - a flex child defaults to its content size. */}
      <div className="relative min-h-0 flex-1">
        <GameCanvas
          killsPerSecond={rate}
          // A formatter rather than a number. Damage is a Big and the cosmetic layer
          // is deliberately kept on bounded values - handing it the raw stat would put
          // `Infinity` in the floating combat text the moment the ladder ran deep.
          // The renderer owns the jitter; the UI owns how a magnitude reads.
          hitLabel={(jitter) => formatBig(stats.damage.mul(jitter))}
          attacksPerSecond={stats.attackSpeed}
          stage={Math.max(1, hud.bestStage || 1)}
          stageTimeLimit={STAGE_TIME_LIMIT_SECONDS}
          attempt={attempt}
          onAttemptComplete={finishAttempt}
        />

        {/* Toasts float INSIDE the arena, bottom-anchored, so they never
            displace a control. They are the one thing allowed to overlap the
            canvas, because they are about what just happened on it. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 p-2">
          {error && (
            <p className="rounded bg-neutral-950/90 px-2 py-1 text-xs text-amber-400">
              {error}
              {desynced && ' — resynced'}
            </p>
          )}
          {summarise(events)
            .slice(-2)
            .map((line, i) => (
              <p key={i} className="rounded bg-neutral-950/90 px-2 py-1 text-xs text-neutral-300">
                {line}
              </p>
            ))}
        </div>
      </div>

      {/* Desktop has the vertical room to keep the tracks on screen; a phone
          does not, and the same grid renders in the sheet below. */}
      <div className="hidden shrink-0 flex-col gap-2 border-t border-neutral-800 px-3 py-2 lg:flex">
        {buyPicker('buy-amount-inline')}
        {upgradeGrid}
      </div>

      <footer
        className="shrink-0 border-t border-neutral-800 bg-neutral-950 px-3 pt-2"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex gap-2">
          {/* The primary action takes the width it deserves: it is the thing a
              player taps hundreds of times, and it belongs under the thumb. */}
          <button
            type="button"
            disabled={pending || attempt !== null}
            onClick={startAttempt}
            className="min-h-12 flex-1 rounded-lg bg-neutral-100 px-4 text-sm font-semibold text-neutral-900 active:bg-neutral-300 disabled:opacity-40"
          >
            {/* A dungeon replay disables this button too, so it must not
                claim a stage fight is under way while a duel is on screen. */}
            {attempt ? replayLabel(attempt) : `Attempt stage ${hud.currentStage}`}
          </button>

          <button
            type="button"
            disabled={pending || attempt !== null || keys < 1 || hud.bestStage < 1}
            onClick={startDungeon}
            aria-label={dungeonLabel(keys, hud.dungeon)}
            title={dungeonLabel(keys, hud.dungeon)}
            className="flex min-h-12 items-center gap-1.5 rounded-lg border border-amber-500/60 bg-amber-500/10 px-3 text-sm text-amber-100 disabled:opacity-40"
          >
            <AtlasSprite id="currency.dungeon_key" scale={1.5} />
            <span className="font-mono text-xs">{keys}</span>
            {/* The affinity is on the BUTTON, not behind a tooltip, because a key is
                spent whether the run is won or lost. Two coloured letters is the most
                this row can carry, and it is enough to say "bring cold, not fire". */}
            {hud.dungeon && (
              <span className="font-mono text-[10px] leading-none">
                <span className={ELEMENT_STYLE[hud.dungeon.weakTo]}>
                  {hud.dungeon.weakTo[0].toUpperCase()}
                </span>
                <span className="text-neutral-600">/</span>
                <span className={ELEMENT_STYLE[hud.dungeon.resists]}>
                  {hud.dungeon.resists[0].toUpperCase()}
                </span>
              </span>
            )}
          </button>

          {/*
            The Abyss opens the shelf rather than starting a run, because which tablet
            to spend IS the decision - tier, modifiers and affinity all differ per
            tablet, and there is no sensible default to pick on the player's behalf.

            Enabled even when locked and even at zero tablets: the surface behind it is
            where both of those are explained, and a disabled button explains nothing.
          */}
          <button
            type="button"
            disabled={pending || attempt !== null}
            onClick={() => setAbyssOpen(true)}
            aria-label={abyssLabel(hud)}
            title={abyssLabel(hud)}
            className="flex min-h-12 items-center gap-1.5 rounded-lg border border-violet-500/60 bg-violet-500/10 px-3 text-sm text-violet-100 disabled:opacity-40"
          >
            <span aria-hidden>▼</span>
            <span className="font-mono text-xs">{hud.tablets.length}</span>
          </button>

          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex min-h-12 items-center rounded-lg border border-neutral-700 px-3 text-sm lg:hidden"
          >
            Upgrades
          </button>
        </div>

        {/* The Claim button used to live here. Offline gold is credited on arrival
            now, so there is nothing left to claim - see the receipt effect above. */}
      </footer>

      {receipt && <OfflineReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />}

      {sheetOpen && (
        <BottomSheet title="Upgrades" trailing={buyPicker('buy-amount-sheet')} onClose={() => setSheetOpen(false)}>
          {upgradeGrid}
        </BottomSheet>
      )}

      {abyssOpen && (
        <BottomSheet title="The Abyss" onClose={() => setAbyssOpen(false)}>
          <TabletStash
            tablets={hud.tablets}
            runs={hud.tabletRuns}
            unlocked={hud.abyss.unlocked}
            unlockStage={hud.abyss.unlockStage}
            cap={hud.abyss.cap}
            busy={pending || attempt !== null}
            onDescend={startAbyssal}
          />
        </BottomSheet>
      )}

      {panelOpen && (
        <CharacterPanel
          state={state}
          hud={hud}
          busy={pending}
          onEquip={(slot, itemId) => void send({ type: 'equipItem', slot, itemId })}
          onEquipWeapon={(itemId) => void send({ type: 'equipWeapon', itemId })}
          onEquipAccessory={(slot, itemId) =>
            void send({ type: 'equipAccessory', slot, itemId })
          }
          onReroll={(uid) => void send({ type: 'rerollItem', uid })}
          onDissemble={(uids) => void send({ type: 'dissembleItems', uids })}
          onApplyCurrency={(currencyId, uid) => void send({ type: 'applyCurrency', currencyId, uid })}
          onCombine={(currencyId) => void send({ type: 'combineFragments', currencyId })}
          onClose={() => setPanelOpen(false)}
        />
      )}
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
  resource: { noun: 'stamina and mana regen', percent: false },
};

function effectText(key: string): string {
  const track = UPGRADE_TRACKS[key as keyof typeof UPGRADE_TRACKS];
  const { noun, percent } = EFFECT_NOUNS[key];
  // Uncapped tracks are the `more` layer, so they compound and must say so - a
  // bare "+7% damage" reads like an affix that sums with its peers, and these do
  // not. See trackLayer() in src/sim/curves.ts.
  if (track.valueGrowth !== null) {
    return `${((track.valueGrowth - 1) * 100).toFixed(0)}% more ${noun}`;
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
function plannedPurchase(upgrade: UpgradeView, amount: BuyAmount, gold: Big) {
  const key = upgrade.key as UpgradeKey;
  const none = { count: 0, cost: null, affordable: false };
  if (upgrade.maxed) return none;

  if (amount === 'max') {
    const count = maxAffordableUpgrades(key, upgrade.level, gold);
    return {
      count,
      cost: count > 0 ? bulkUpgradeCost(key, upgrade.level, count) : fromSave(upgrade.cost),
      affordable: count > 0,
    };
  }

  const count = Math.min(amount, remainingLevels(key, upgrade.level));
  if (count <= 0) return none;
  const cost = bulkUpgradeCost(key, upgrade.level, count);
  return { count, cost, affordable: gold.gte(cost) };
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
  gold: Big;
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
        // min-h-14 is a thumb target, not a decoration: these were 3-line cards
        // whose tap area happened to be large. Now they are two lines and the
        // height is stated rather than inherited from the text.
        'flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-2 text-left transition',
        upgrade.maxed
          ? 'border-neutral-800 bg-neutral-900 text-neutral-500'
          : plan.affordable
            ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-100 active:bg-emerald-500/30'
            : 'border-neutral-800 bg-neutral-900 text-neutral-400',
        blocked ? 'cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
    >
      <span className="flex w-full items-baseline gap-1.5">
        <span className="truncate text-sm font-medium">{upgrade.label}</span>
        {/* The effect line is what a player reads once and never again, so it
            drops off the narrow layout rather than wrapping the card taller. */}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-neutral-500">
          Lv {upgrade.level}
          {plan.count > 1 ? ` +${plan.count}` : ''}
        </span>
      </span>
      <span className="hidden text-[11px] text-neutral-400 sm:block">
        {effectText(upgrade.key)}
      </span>
      <span className="font-mono text-[11px]">
        {upgrade.maxed ? 'MAX' : `${plan.cost ? formatBig(plan.cost) : '—'}g`}
      </span>
    </button>
  );
}

/**
 * A pull-up sheet for controls that do not fit a phone screen.
 *
 * A sheet rather than a modal: it is anchored to the bottom edge, so the
 * controls inside land under a thumb rather than in the middle of the screen
 * where the upgrade grid used to sit. The backdrop closes it, and so does
 * Escape, because a sheet that can only be dismissed by an X is a trap on a
 * device with no visible cursor.
 */
function BottomSheet({
  title,
  trailing,
  onClose,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col justify-end bg-black/60"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-neutral-700 bg-neutral-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        {/* Sticky, so the buy multiplier stays reachable while the list scrolls -
            picking 'Max' and then hunting back up for the track is the exact
            trip this avoids. */}
        <div className="sticky top-0 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950 px-3 py-3">
          <span className="h-1 w-10 shrink-0 rounded-full bg-neutral-700" aria-hidden />
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="ml-auto flex items-center gap-3">
            {trailing}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded px-2 py-1 text-neutral-400 active:bg-neutral-800"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="p-3">{children}</div>
      </div>
    </div>
  );
}

/**
 * One figure in the status rail.
 *
 * Stacked rather than inline: `gold 302.67k` on one line is wide, and six wide
 * chips are what forced the header to wrap into two ragged rows on a phone.
 * Label above value halves the width and reads faster at a glance.
 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="shrink-0 rounded bg-neutral-900 px-2 py-1">
      <div className="text-[10px] uppercase leading-tight tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="font-mono text-sm leading-tight">{value}</div>
    </div>
  );
}

/**
 * Collapse a command's events into a few readable lines.
 *
 * A single clear can now emit a stageCleared, three itemDropped and several
 * currencyDropped. Rendering the last N verbatim pushed the clear message -
 * the one thing the player was waiting for - off the end, buried by its own
 * loot. Widening the window only moved the point at which that happens.
 *
 * So loot is summarised rather than enumerated: counts are what a player reads
 * anyway, and the detail is in the inventory.
 */
/**
 * What the dungeon button says it will do, in one sentence.
 *
 * The affinity is in the label as well as on the face of the button, because the
 * two-letter badge is a reminder for someone who already knows what it means and this
 * is where they find out. Shared between `title` and `aria-label` so a screen reader
 * gets the same sentence rather than a truncated one.
 */
/** What the primary button says while a replay is on screen. */
function replayLabel(attempt: Attempt): string {
  switch (attempt.kind) {
    case 'abyssal':
      return `In the Abyss, T${attempt.tier}…`;
    case 'dungeon':
      return 'In a dungeon…';
    default:
      return `Fighting stage ${attempt.stage}…`;
  }
}

/**
 * What the Abyss button says it will do.
 *
 * Three states and all three are worth distinguishing: locked, unlocked but empty, and
 * ready. "0 tablets" alone would leave a player at floor 40 hunting for a drop that
 * cannot happen yet.
 */
function abyssLabel(hud: HudSnapshot): string {
  const held = `${hud.tablets.length} tablet${hud.tablets.length === 1 ? '' : 's'}`;
  if (!hud.abyss.unlocked) return `The Abyss, ${held} — opens at floor ${hud.abyss.unlockStage}`;
  if (hud.tablets.length === 0) {
    return `The Abyss, no tablets — they drop from monsters past floor ${hud.abyss.unlockStage}`;
  }
  // `tablets` is sorted deepest first, so the head is the hardest thing on the shelf -
  // which is the one a player is deciding about.
  const deepest = hud.tabletRuns[hud.tablets[0].uid];
  if (!deepest) return `The Abyss, ${held}`;
  return `The Abyss, ${held} — deepest is tier ${deepest.tier}, resists ${elementName(deepest.resists)}`;
}

function dungeonLabel(keys: number, dungeon: HudSnapshot['dungeon']): string {
  // Every branch starts with "Dungeon" and states the key count. It is the button's
  // accessible name as well as its tooltip, so it has to identify the control before
  // it explains it - and the count is the thing a player is looking for.
  const head = `Dungeon, ${keys} key${keys === 1 ? '' : 's'}`;
  if (keys < 1) return `${head} — they drop from stage bosses`;
  if (!dungeon) return `${head} — clear a stage first`;
  return (
    `${head} — stage ${dungeon.stage}, weak to ${elementName(dungeon.weakTo)}, ` +
    `resists ${elementName(dungeon.resists)}`
  );
}

interface OfflineReceipt {
  gold: Big;
  seconds: number;
  capped: boolean;
  stage: number;
}

/** "6h 14m", "3m", "48s". Whole units only - nobody reads a decimal here. */
function describeDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * What happened while you were away.
 *
 * A receipt, not a prompt - the gold is already in the balance behind it. Dismissing
 * costs nothing, which is why it closes on the backdrop, on Escape and on its one
 * button rather than trapping you until you accept something.
 */
function OfflineReceiptModal({
  receipt,
  onClose,
}: {
  receipt: OfflineReceipt;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-xs rounded-lg border border-neutral-700 bg-neutral-950 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Welcome back"
      >
        <p className="text-xs uppercase tracking-wide text-neutral-500">Welcome back</p>
        <p className="mt-1 text-sm text-neutral-300">
          You were away {describeDuration(receipt.seconds)}
        </p>

        <p className="mt-4 font-mono text-2xl text-emerald-300">+{formatBig(receipt.gold)}</p>
        <p className="text-[11px] text-neutral-500">
          gold, farmed at stage {receipt.stage}
        </p>

        {receipt.capped && (
          // Worth saying plainly. Idle income stops accruing at the cap, and a player
          // who does not know that reads a short day and a long weekend as the same.
          <p className="mt-3 rounded border border-amber-600/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
            Idle earnings stop after 8 hours — you were away longer than that.
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="mt-4 min-h-11 w-full rounded-lg bg-neutral-100 text-sm font-semibold text-neutral-900 active:bg-neutral-300"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

/**
 * The sprites the trash wave is about to drop.
 *
 * Rolled here, on the client, from the same pure seeded functions applyCommand will
 * use on the server - `rollWaveDropCount` and `rollItem` take the account seed and the
 * uid the counter is sitting on, so both sides reach the same items. That is the same
 * property the replay already relies on for the outcome itself: what you watch is a
 * preview of what the server will independently conclude, not a guess at it.
 *
 * Display only. Nothing here is sent, and the server rolls its own.
 */
function waveDropSprites(save: SaveState, stage: number): SpriteId[] {
  const count = rollWaveDropCount(save.seed, save.nextItemId, stage);
  const items = Array.from({ length: count }, (_, i) =>
    itemSprite(rollItem(save.seed, save.nextItemId + i, stage, WAVE_RARITY_WEIGHTS)),
  ) as SpriteId[];

  /*
    Tablets fall out of the wave too, and they have to be on screen.

    They are the rarest thing the ladder pays and they arrive in the middle of a wave
    rather than at the end of it - a tablet that appeared only as a toast would be the
    one drop a player never actually sees drop. Rolled from the same pure function the
    server will use, so what falls is what lands on the shelf.

    Appended rather than interleaved: the layer spawns them in order across the trash
    phase, and the exact position in the sequence is not something either side agrees
    about anyway.
  */
  const tablets = rollWaveTablets(save.seed, save.nextItemId, stage);
  return [
    ...items,
    ...tablets.map((tier) =>
      itemSprite(rollTablet(save.seed, save.nextItemId + count, tier)),
    ),
  ] as SpriteId[];
}

function summarise(events: SimEvent[]): string[] {
  const rest: string[] = [];
  let items = 0;
  let currency = 0;

  for (const event of events) {
    if (event.type === 'itemDropped') items++;
    else if (event.type === 'currencyDropped') currency += event.count;
    else rest.push(describe(event as { type: string } & Record<string, unknown>));
  }

  const loot: string[] = [];
  if (items > 0) loot.push(`${items} item${items === 1 ? '' : 's'}`);
  if (currency > 0) loot.push(`${currency} currency`);

  // The outcome line first, so it survives whatever else happened.
  return [...rest.slice(-3), ...(loot.length > 0 ? [`found ${loot.join(', ')}`] : [])];
}

function describe(event: { type: string } & Record<string, unknown>): string {
  switch (event.type) {
    case 'stageCleared':
      return `cleared stage ${event.stage} in ${Number(event.seconds).toFixed(1)}s`;
    case 'stageFailed':
      return `stage ${event.stage} failed (${event.reason})`;
    case 'dungeonCleared':
      return `cleared dungeon ${event.stage} in ${Number(event.seconds).toFixed(1)}s`;
    case 'dungeonFailed':
      return `dungeon failed (${event.reason}) — key spent`;
    case 'abyssalCleared':
      return `cleared the Abyss T${event.tier} in ${Number(event.seconds).toFixed(1)}s`;
    case 'abyssalFailed':
      return `Abyss T${event.tier} failed (${event.reason}) — tablet spent`;
    case 'tabletFound':
      return `found ${event.name} (T${event.tier})`;
    case 'itemDropped':
      return `found ${event.name} (${event.rarity})`;
    case 'inventoryFull':
      return `inventory full — lost ${event.lost} drop${Number(event.lost) === 1 ? '' : 's'}`;
    case 'itemRerolled':
      return `rerolled for ${Math.round(Number(event.cost))}g`;
    case 'currencyDropped':
      return `found ${event.name}${Number(event.count) > 1 ? ` x${event.count}` : ''}`;
    case 'currencyUsed':
      return `used ${event.name}`;
    case 'itemTransmuted':
      return `transmuted into ${event.name}`;
    case 'itemDestroyed':
      return 'the item was destroyed';
    case 'fragmentsCombined':
      return `combined into ${event.name}`;
    case 'itemsDissembled':
      return `dissembled ${event.count} item${Number(event.count) === 1 ? '' : 's'}`;
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
