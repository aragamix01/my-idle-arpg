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
  type CurrencyId,
  type HudSnapshot,
  type SaveState,
  type UpgradeKey,
  type SimEvent,
  type UpgradeView,
} from '@/sim';
import type { AttemptRequest, FightReadout } from '@/render/GameCanvas';
import type { SpriteId } from '@/render/sprites';
import { AtlasSprite } from './atlasSprite';
import { CharacterTab, InventoryTab } from './CharacterScreens';
import { AbyssCard, CharacterSummary, CurrencyMini, EquipmentTiles, LootFeed, Orb } from './CombatPanels';
import { CurrencyStash } from './CurrencyStash';
import { compact, ELEMENT_STYLE, elementName } from './format';
import { HUD_TICK_MS, useGameStore } from './store';
import { TabletStash } from './TabletStash';
import { TabletTab } from './TabletTab';

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
  const { state, hud, events, feed, pending, error, desynced, bootstrap, send, refreshHud } =
    useGameStore();
  const [buyAmount, setBuyAmount] = useState<BuyAmount>(1);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [screen, setScreen] = useState<Screen>('combat');
  /*
    The idle loop, Phase 7c. Both are per-device preferences, so they live in the
    browser rather than the save. Read in the initialiser, which is safe here: the
    first render of this component is the loading screen, so nothing that depends on
    these is ever part of the server-rendered HTML that hydration compares against.
  */
  const [autoAdvance, setAutoAdvance] = useState(() => readPref(AUTO_KEY, 'off') === 'on');
  const [speed, setSpeed] = useState<Speed>(() => {
    const stored = Number(readPref(SPEED_KEY, '1'));
    return SPEEDS.includes(stored as Speed) ? (stored as Speed) : 1;
  });
  const [readout, setReadout] = useState<FightReadout | null>(null);
  /**
   * Coarsened before it reaches state. The canvas reports eight times a second, and a
   * re-render for a health bar that moved by a thousandth is a re-render of the whole
   * shell for nothing.
   */
  const onReadout = useCallback((next: FightReadout) => {
    setReadout((current) =>
      current &&
      current.active === next.active &&
      current.phase === next.phase &&
      Math.round(current.playerHp * 100) === Math.round(next.playerHp * 100) &&
      Math.round(current.remaining) === Math.round(next.remaining)
        ? current
        : next,
    );
  }, []);
  /**
   * The currency the stash armed, if any.
   *
   * Held by the shell because arming is a cross-SCREEN gesture: you pick in Craft and
   * spend in the Bag or on a tablet.
   */
  const [armed, setArmed] = useState<CurrencyId | null>(null);
  /**
   * Which shelf arming a currency sends you back to - two things take currency, and a
   * player crafting a run of tablets should not be kicked to their gear every time.
   *
   * Written where the screen CHANGES rather than derived in an effect: an effect that
   * calls setState cascades a second render for a value already known at the click.
   */
  const [lastShelf, setLastShelf] = useState<'bag' | 'abyss'>('bag');
  const openScreen = useCallback((next: Screen) => {
    setScreen(next);
    if (next === 'bag' || next === 'abyss') setLastShelf(next);
  }, []);
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

  /*
    Auto-advance: when a replay has been committed and nothing else is in flight, the
    next stage attempt starts by itself.

    Stages only. A dungeon spends a key and the Abyss spends a tablet, and spending a
    consumable is never something the game does on the player's behalf. A failed stage
    is retried rather than skipped - the sim leaves currentStage where it was, so the
    next attempt is the same floor again, which is what "keep trying" means.

    The pause is there so the result line is readable before the next wave covers it.
  */
  useEffect(() => {
    if (!autoAdvance || attempt !== null || pending || !state) return;
    const id = setTimeout(startAttempt, AUTO_PAUSE_MS);
    return () => clearTimeout(id);
  }, [autoAdvance, attempt, pending, state, startAttempt]);

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

  // Escape steps back to the fight from any other screen - the one way out that works the
  // same on every screen and does not depend on finding a button.
  useEffect(() => {
    if (screen === 'combat') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) setScreen('combat');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screen]);

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
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
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

  const buyPicker = (id: string) => (
    <div className="flex items-center gap-2 normal-case">
      <label htmlFor={id} className="px-label">
        Buy
      </label>
      <select
        id={id}
        value={String(buyAmount)}
        onChange={(e) =>
          setBuyAmount(e.target.value === 'max' ? 'max' : (Number(e.target.value) as BuyAmount))
        }
        className="px-slot min-h-9 px-2 font-mono text-lg text-neutral-100"
      >
        {BUY_AMOUNTS.map((amount) => (
          <option key={String(amount)} value={String(amount)}>
            {amount === 'max' ? 'Max' : `${amount}x`}
          </option>
        ))}
      </select>
    </div>
  );

  const busy = pending || attempt !== null;
  const applyArmed = (currencyId: CurrencyId, uid: string) => {
    void send({ type: 'applyCurrency', currencyId, uid });
    // Disarm after one use. Leaving it armed turns the next inspecting click into an
    // accidental craft.
    setArmed(null);
  };

  /*
    The fight is ALWAYS mounted, and every other screen is drawn over it.

    Unmounting the canvas on a screen change would kill a replay half way - and the
    command is only sent when the replay ends, so the attempt would simply be lost. Hiding
    it with display:none is no better: Pixi sizes itself to its host, and a host with no
    size hands the cosmetic layer a zero-width arena. Covering it costs one hidden canvas,
    which is what an idle game that keeps fighting while you shop is supposed to do.
  */
  const combat = (
    <div className="flex h-full gap-3 lg:p-3">
      <div className="hidden w-[300px] shrink-0 lg:flex">
        <CharacterSummary
          hud={hud}
          onOpenBag={() => openScreen('bag')}
          onOpenCharacter={() => openScreen('character')}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0 lg:gap-3">
        <section className="px-frame flex items-center gap-4 px-4 py-2.5 max-lg:border-x-0 max-lg:border-t-0">
          <div className="flex shrink-0 flex-col leading-tight">
            <span className="px-label">Next floor</span>
            <span className="font-label text-lg text-neutral-100 px-shadow">Floor {hud.currentStage}</span>
          </div>
          <dl className="ml-auto flex gap-4 text-right">
            <HeaderStat label="Best" value={String(hud.bestStage)} />
            <HeaderStat label="Gold/s" value={formatBig(fromSave(hud.goldPerSecond))} />
            <HeaderStat label="Kills/s" value={compact(rate)} />
          </dl>
        </section>

        {/* `min-h-0` is what lets the fight shrink rather than push the controls off
            screen - a flex child defaults to its content size. */}
        <section className="relative min-h-0 flex-1 border-y-4 border-ink shadow-[inset_0_0_0_2px_#4a3a26] lg:border-4" aria-label="Fight">
          <GameCanvas
            killsPerSecond={rate}
            // A formatter rather than a number. Damage is a Big and the cosmetic layer
            // is deliberately kept on bounded values - handing it the raw stat would put
            // `Infinity` in the floating combat text the moment the ladder ran deep.
            hitLabel={(jitter) => formatBig(stats.damage.mul(jitter))}
            attacksPerSecond={stats.attackSpeed}
            stage={Math.max(1, hud.bestStage || 1)}
            stageTimeLimit={STAGE_TIME_LIMIT_SECONDS}
            attempt={attempt}
            speed={speed}
            onAttemptComplete={finishAttempt}
            onReadout={onReadout}
          />

          {/* The idle controls sit ON the fight, where the thing they change is. */}
          <div className="absolute inset-x-2 top-9 flex items-start justify-between gap-2">
            <button
              type="button"
              aria-pressed={autoAdvance}
              onClick={() => {
                const next = !autoAdvance;
                setAutoAdvance(next);
                writePref(AUTO_KEY, next ? 'on' : 'off');
              }}
              title="Start the next stage automatically when a fight ends"
              className="px-btn min-h-10 text-[10px]"
            >
              <span
                className={`h-3 w-3 border-2 border-ink ${autoAdvance ? 'bg-emerald-400' : 'bg-neutral-800'}`}
                aria-hidden
              />
              Auto
            </button>
            <div className="flex gap-1" role="group" aria-label="Fight speed">
              {SPEEDS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={speed === option}
                  onClick={() => {
                    setSpeed(option);
                    writePref(SPEED_KEY, String(option));
                  }}
                  className="px-btn min-h-10 min-w-10 px-2 font-mono text-lg normal-case"
                >
                  x{option}
                </button>
              ))}
            </div>
          </div>

          {/* Toasts float INSIDE the fight, bottom-anchored, so they never displace a
              control. They are about what just happened on it. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 p-2">
            {error && (
              <p className="bg-ink/90 px-2 py-1 text-xs text-amber-400">
                {error}
                {desynced && ' — resynced'}
              </p>
            )}
            {summarise(events)
              .slice(-2)
              .map((line, i) => (
                <p key={i} className="bg-ink/85 px-2 py-1 text-xs text-neutral-300">
                  {line}
                </p>
              ))}
          </div>
        </section>

        <section className="px-frame flex items-center gap-2 p-2.5 max-lg:border-x-0" aria-label="Actions">
          {/*
            Life, live. The fraction comes from the replay - the same split of damage the
            sim resolved - and the number is that fraction of Max HP. Full while idle,
            because farming costs no health; it only moves when a fight is on.
          */}
          <Orb
            fraction={readout?.playerHp ?? 1}
            label={formatBig(stats.maxHp.mul(readout?.playerHp ?? 1))}
            // The shield rides on top of life, so it is quoted under it rather than given
            // an orb of its own that would sit full for every fight that never reaches it.
            sub={stats.energyShield > 0 ? `+${formatBig(stats.maxHp.mul(stats.energyShield))} ES` : undefined}
            tone="life"
            size={64}
          />
          {/* The primary action takes the width it deserves: it is the thing a player
              taps hundreds of times, and it belongs under the thumb. */}
          <button
            type="button"
            disabled={busy}
            onClick={startAttempt}
            className="px-btn px-btn-gold min-h-12 flex-1 text-xs"
          >
            {/* A dungeon replay disables this button too, so it must not claim a stage
                fight is under way while a duel is on screen. */}
            {attempt ? replayLabel(attempt) : `Attempt stage ${hud.currentStage}`}
          </button>

          <button
            type="button"
            disabled={busy || keys < 1 || hud.bestStage < 1}
            onClick={startDungeon}
            aria-label={dungeonLabel(keys, hud.dungeon)}
            title={dungeonLabel(keys, hud.dungeon)}
            className="px-btn min-h-12"
          >
            <AtlasSprite id="currency.dungeon_key" scale={1.5} />
            <span className="font-mono text-lg normal-case">{keys}</span>
            {/* The affinity is on the BUTTON, not behind a tooltip, because a key is spent
                whether the run is won or lost. Two coloured letters is enough to say
                "bring cold, not fire". */}
            {hud.dungeon && (
              <span className="font-mono text-base leading-none">
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
            The Abyss opens its screen rather than starting a run, because which tablet to
            spend IS the decision. Enabled even when locked and even at zero tablets: the
            screen behind it is where both of those are explained.
          */}
          <button
            type="button"
            disabled={busy}
            onClick={() => openScreen('abyss')}
            aria-label={abyssLabel(hud)}
            title={abyssLabel(hud)}
            className="px-btn px-btn-void min-h-12"
          >
            <TabletGlyph />
            <span className="font-mono text-lg normal-case">{hud.tablets.length}</span>
          </button>
        </section>

        {/* A phone has no right column, so the last few lines of the feed sit here. */}
        <section className="max-h-36 overflow-hidden border-t-2 border-ink bg-neutral-950 px-3 lg:hidden" aria-label="Recent loot">
          <LootFeed feed={feed} limit={3} />
        </section>
      </div>

      <aside className="hidden w-[320px] shrink-0 flex-col gap-3 lg:flex">
        <section className="px-frame flex min-h-0 flex-1 flex-col">
          <div className="px-head">
            <span>Loot</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 scrollbar-none">
            <LootFeed feed={feed} />
          </div>
        </section>
        <CurrencyMini purse={hud.currency} onOpen={() => openScreen('craft')} />
        <AbyssCard hud={hud} busy={busy} onOpen={() => openScreen('abyss')} />
      </aside>
    </div>
  );

  const screenBody = (() => {
    switch (screen) {
      case 'character':
        return (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <Panel title="Equipment">
              <div className="flex flex-col items-center gap-4 p-4">
                <div className="px-slot grid h-28 w-28 place-items-center shadow-[inset_0_0_0_2px_#4a3a26]">
                  <AtlasSprite id="player.knight" scale={6} />
                </div>
                <EquipmentTiles hud={hud} onPick={() => openScreen('bag')} size="lg" />
                <p className="text-center text-sm text-neutral-500">
                  Tap a slot to manage it in the Bag.
                </p>
              </div>
            </Panel>
            <Panel title="Stats">
              <div className="p-4">
                <CharacterTab state={state} hud={hud} />
              </div>
            </Panel>
          </div>
        );
      case 'bag':
        return (
          <Panel title={`Bag · ${hud.items.length}/${hud.inventoryCap}`}>
            <div className="p-3 sm:p-4">
              <InventoryTab
                state={state}
                hud={hud}
                busy={pending}
                armed={armed}
                onEquip={(slot, itemId) => void send({ type: 'equipItem', slot, itemId })}
                onEquipWeapon={(itemId) => void send({ type: 'equipWeapon', itemId })}
                onEquipAccessory={(slot, itemId) => void send({ type: 'equipAccessory', slot, itemId })}
                onReroll={(uid) => void send({ type: 'rerollItem', uid })}
                onDissemble={(uids) => void send({ type: 'dissembleItems', uids })}
                onApplyCurrency={applyArmed}
              />
            </div>
          </Panel>
        );
      case 'craft':
        return (
          <Panel title="Currency stash">
            <div className="p-3 sm:p-4">
              <CurrencyStash
                purse={hud.currency}
                armed={armed}
                busy={pending}
                onArm={(currencyId) => {
                  // Back to whichever shelf the player was last on, so arming a currency
                  // while crafting tablets does not silently move them to gear.
                  setArmed(currencyId);
                  if (currencyId) openScreen(lastShelf);
                }}
                onCombine={(currencyId) => void send({ type: 'combineFragments', currencyId })}
              />
            </div>
          </Panel>
        );
      case 'abyss':
        return (
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Descend" tone="void">
              <div className="p-3 sm:p-4">
                <TabletStash
                  tablets={hud.tablets}
                  runs={hud.tabletRuns}
                  unlocked={hud.abyss.unlocked}
                  unlockStage={hud.abyss.unlockStage}
                  cap={hud.abyss.cap}
                  busy={busy}
                  onDescend={(uid) => {
                    // Back to the fight, which is where the run plays out.
                    openScreen('combat');
                    startAbyssal(uid);
                  }}
                />
              </div>
            </Panel>
            <Panel title="Tablets" tone="void">
              <div className="p-3 sm:p-4">
                <TabletTab hud={hud} busy={pending} armed={armed} onApplyCurrency={applyArmed} />
              </div>
            </Panel>
          </div>
        );
      case 'upgrades':
        return (
          <Panel title="Upgrades" trailing={buyPicker('buy-amount')}>
            <div className="p-3 sm:p-4">{upgradeGrid}</div>
          </Panel>
        );
      default:
        return null;
    }
  })();

  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden bg-abyss text-neutral-200">
      <header
        className="shrink-0 border-b-4 border-ink bg-[#120e0b] shadow-[inset_0_-2px_0_#4a3a26]"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex h-14 items-center gap-3 px-3 lg:h-16 lg:gap-5 lg:px-4">
          <div className="flex items-center gap-2">
            <SigilGlyph />
            <span className="font-label text-base font-bold tracking-widest text-gold px-shadow lg:text-xl">
              Idle ARPG
            </span>
          </div>

          <nav className="ml-3 hidden gap-1.5 lg:flex" aria-label="Screens">
            {SCREENS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => openScreen(entry.id)}
                aria-current={screen === entry.id ? 'page' : undefined}
                className={`px-btn ${entry.id === 'abyss' ? 'px-btn-blood' : ''}`}
              >
                {entry.label}
                {entry.id === 'bag' && (
                  <span className="font-mono text-base normal-case text-neutral-400">
                    {hud.items.length}/{hud.inventoryCap}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 lg:gap-5">
            <span className="flex items-center gap-1.5" title="Gold">
              <CoinGlyph />
              <span className="font-mono text-xl text-gold-bright lg:text-2xl">{formatBig(gold)}</span>
            </span>
            <span className="hidden items-center gap-1.5 sm:flex" title="Dungeon keys">
              <AtlasSprite id="currency.dungeon_key" scale={1} />
              <span className="font-mono text-xl">{keys}</span>
            </span>
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {combat}
        {screen !== 'combat' && (
          <div className="absolute inset-0 z-20 overflow-y-auto bg-abyss p-0 sm:p-3" role="region" aria-label={screenTitle(screen)}>
            {screenBody}
          </div>
        )}
      </div>

      {/* A phone gets one screen at a time and a tab bar under the thumb. */}
      <nav
        className="flex shrink-0 border-t-4 border-ink bg-[#120e0b] shadow-[inset_0_2px_0_#4a3a26] lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Screens"
      >
        {SCREENS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => openScreen(entry.id)}
            aria-current={screen === entry.id ? 'page' : undefined}
            // The full name, so a screen reader and the test suite address the same control
            // on both layouts - the short word is only there to fit a phone's width.
            aria-label={entry.label}
            className={`flex min-h-[60px] flex-1 flex-col items-center justify-center gap-1 font-label text-[9px] uppercase ${
              screen === entry.id ? 'bg-neutral-800 text-gold-bright' : 'text-neutral-500'
            }`}
          >
            <NavGlyph id={entry.id} />
            {entry.short}
          </button>
        ))}
      </nav>

      {receipt && <OfflineReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />}
    </main>
  );
}

type Screen = 'combat' | 'character' | 'bag' | 'craft' | 'abyss' | 'upgrades';

const SPEEDS = [1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];
const AUTO_KEY = 'arpg.auto.v1';
const SPEED_KEY = 'arpg.speed.v1';
/** Real milliseconds between one committed fight and the next auto-started one. */
const AUTO_PAUSE_MS = 700;

/** A per-device preference. Storage can be blocked or absent; the default wins then. */
function readPref(key: string, fallback: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Not remembered on this device. The setting still applies for this visit.
  }
}

const SCREENS: { id: Screen; label: string; short: string }[] = [
  { id: 'combat', label: 'Combat', short: 'Fight' },
  { id: 'character', label: 'Character', short: 'Hero' },
  { id: 'bag', label: 'Bag', short: 'Bag' },
  { id: 'craft', label: 'Craft', short: 'Craft' },
  { id: 'abyss', label: 'Abyss', short: 'Abyss' },
  { id: 'upgrades', label: 'Upgrades', short: 'Upgrade' },
];

function screenTitle(screen: Screen): string {
  return SCREENS.find((entry) => entry.id === screen)?.label ?? 'Combat';
}

function Panel({
  title,
  trailing,
  tone = 'stone',
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  tone?: 'stone' | 'void';
  children: React.ReactNode;
}) {
  return (
    <section className={`${tone === 'void' ? 'px-frame-void' : 'px-frame'} min-w-0`}>
      <div className={`px-head ${tone === 'void' ? 'bg-[#1c1220] text-void-bright' : ''}`}>
        <h2>{title}</h2>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <dt className="px-label">{label}</dt>
      <dd className="font-mono text-xl text-neutral-100">{value}</dd>
    </div>
  );
}

/*
  Glyphs. Inline stroke-free pixel SVGs, `currentColor` where a glyph should follow the
  text it sits beside. Emoji are not used anywhere: they ignore the text colour and are a
  different shape on every platform.
*/
function SigilGlyph() {
  return (
    <svg viewBox="0 0 8 8" className="h-7 w-7" shapeRendering="crispEdges" aria-hidden>
      <rect x="3" y="0" width="2" height="8" fill="#b0221c" />
      <rect x="1" y="2" width="6" height="2" fill="#b0221c" />
      <rect x="3" y="0" width="1" height="8" fill="#e04434" />
      <rect x="3" y="6" width="2" height="2" fill="#5e1a16" />
    </svg>
  );
}

function CoinGlyph() {
  return (
    <svg viewBox="0 0 6 6" className="h-5 w-5" shapeRendering="crispEdges" aria-hidden>
      <rect x="1" y="0" width="4" height="6" fill="#d4a24c" />
      <rect x="0" y="1" width="6" height="4" fill="#d4a24c" />
      <rect x="2" y="1" width="1" height="3" fill="#f6d27a" />
    </svg>
  );
}

function TabletGlyph() {
  return (
    <svg viewBox="0 0 8 8" className="h-5 w-5" shapeRendering="crispEdges" aria-hidden>
      <rect x="1" y="0" width="6" height="8" fill="#3a1a2e" />
      <rect x="2" y="2" width="4" height="4" fill="#9a3aa8" />
      <rect x="3" y="3" width="2" height="2" fill="#e08af0" />
    </svg>
  );
}

function NavGlyph({ id }: { id: Screen }) {
  const rects: Record<Screen, [number, number, number, number][]> = {
    combat: [[6, 0, 2, 1], [5, 1, 2, 1], [4, 2, 2, 1], [3, 3, 2, 1], [1, 3, 1, 2], [2, 4, 2, 1], [0, 6, 2, 2]],
    character: [[1, 1, 6, 2], [1, 4, 6, 2], [1, 3, 1, 1], [6, 3, 1, 1], [1, 6, 2, 1], [5, 6, 2, 1]],
    bag: [[2, 0, 4, 2], [1, 2, 6, 6]],
    craft: [[4, 0, 1, 2], [2, 2, 4, 2], [1, 4, 6, 3]],
    abyss: [[1, 0, 6, 2], [1, 6, 6, 2], [1, 2, 2, 4], [5, 2, 2, 4], [3, 3, 2, 2]],
    upgrades: [[3, 0, 2, 1], [2, 1, 4, 1], [1, 2, 6, 1], [3, 3, 2, 5]],
  };
  return (
    <svg viewBox="0 0 8 8" className="h-5 w-5" shapeRendering="crispEdges" aria-hidden fill="currentColor">
      {rects[id].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} />
      ))}
    </svg>
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
        'flex min-h-16 flex-col items-start justify-center gap-0.5 border-2 border-ink px-3 py-2 text-left shadow-[inset_2px_2px_0_#54422b,inset_-2px_-2px_0_#120e0b]',
        upgrade.maxed
          ? 'bg-neutral-900 text-neutral-500'
          : plan.affordable
            ? 'bg-[#3a2c14] text-gold-bright hover:bg-[#4a3818] active:bg-[#2a2010]'
            : 'bg-neutral-900 text-neutral-400',
        blocked ? 'cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
    >
      <span className="flex w-full items-baseline gap-1.5">
        <span className="truncate font-label text-xs uppercase">{upgrade.label}</span>
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
      <span className="font-mono text-base">
        {upgrade.maxed ? 'MAX' : `${plan.cost ? formatBig(plan.cost) : '—'}g`}
      </span>
    </button>
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
        className="px-frame w-full max-w-xs p-5"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Welcome back"
      >
        <p className="font-label text-sm uppercase tracking-wide text-gold">Welcome back</p>
        <p className="mt-1 text-sm text-neutral-300">
          You were away {describeDuration(receipt.seconds)}
        </p>

        <p className="mt-4 font-mono text-4xl text-gold-bright">+{formatBig(receipt.gold)}</p>
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
          className="px-btn px-btn-gold mt-4 w-full"
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
