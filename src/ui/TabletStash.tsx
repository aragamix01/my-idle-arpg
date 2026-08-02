'use client';

/**
 * The run picker.
 *
 * One job now: choose which tablet to spend. Holding, reading and crafting them happens
 * in the Tablets tab of the character panel, where they are ordinary items in an
 * ordinary grid - that is the payoff of a tablet BEING an item.
 *
 * What stays here is everything the panel cannot show, because it is not a property of
 * the item but of the run the Abyss will build from it: the depth the tier fights at,
 * how many waves, and what the run resists. All three come from the account seed and the
 * tier curve, and all three have to be readable BEFORE the tablet is spent - it is
 * consumed on entry and consumed on a loss.
 */

import { itemName, type HudSnapshot, type ItemInstance, type TabletView } from '@/sim';
import { ItemMods } from './ItemMods';
import { ELEMENT_STYLE, elementName, RARITY_STYLE } from './format';

interface Props {
  tablets: ItemInstance[];
  /** What each one means as a run, keyed by uid. */
  runs: HudSnapshot['tabletRuns'];
  /** False below the unlock floor. The list still renders; the runs do not. */
  unlocked: boolean;
  unlockStage: number;
  cap: number;
  busy: boolean;
  onDescend: (uid: string) => void;
}

export function TabletStash({ tablets, runs, unlocked, unlockStage, cap, busy, onDescend }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-neutral-500">
        {tablets.length}/{cap} tablets · spent on entry, and spent on a loss.
      </p>

      {!unlocked && (
        // Stated, not implied by a missing button. A player holding a tablet they cannot
        // use needs to know it is the floor stopping them, not the tablet.
        <p className="rounded border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          The Abyss opens at floor {unlockStage}.
        </p>
      )}

      {tablets.length === 0 ? (
        <p className="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-4 text-center text-[11px] text-neutral-500">
          No tablets. They drop from monsters past floor {unlockStage}, and clearing the Abyss
          pays them back.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Tablets">
          {tablets.map((tablet) => {
            const run = runs[tablet.uid];
            // A tablet with no run description is a tablet the server did not describe.
            // Skipping it beats rendering a card full of undefined.
            if (!run) return null;
            return (
              <li key={tablet.uid}>
                <TabletCard
                  tablet={tablet}
                  run={run}
                  busy={busy || !unlocked}
                  onDescend={() => onDescend(tablet.uid)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TabletCard({
  tablet,
  run,
  busy,
  onDescend,
}: {
  tablet: ItemInstance;
  run: TabletView;
  busy: boolean;
  onDescend: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-violet-500/50 bg-violet-500/5 p-3">
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-violet-200">
          T{run.tier}
        </span>
        <span className={`min-w-0 flex-1 truncate text-sm ${RARITY_STYLE[tablet.rarity].text}`}>
          {itemName(tablet)}
        </span>
        {/* The depth is the fight; the tier is the label. Both, because a T7 says
            nothing about how deep it actually is until you have run one. */}
        <span className="shrink-0 font-mono text-[10px] text-neutral-500">
          {run.waves}w · depth {run.depth}
        </span>
      </div>

      {/*
        The affinity, before the tablet is spent.

        At the Abyssal affinity the resisted element is the single biggest number in the
        run - it multiplies effective health far harder than the tier does - so this is
        the line that decides which weapon to bring. Behind a tooltip it would make the
        tablet a coin flip.
      */}
      <p className="text-[11px]">
        <span className="text-neutral-500">weak to </span>
        <span className={ELEMENT_STYLE[run.weakTo]}>{elementName(run.weakTo)}</span>
        <span className="text-neutral-700"> · </span>
        <span className="text-neutral-500">resists </span>
        <span className={ELEMENT_STYLE[run.resists]}>{elementName(run.resists)}</span>
      </p>

      {/* The same component the inventory detail pane uses. A tablet is an item, so its
          implicit sits above the rule and its explicits below it, exactly like gear. */}
      <ItemMods item={tablet} />

      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] text-rose-300">
          +{Math.round(run.danger * 100)}% danger
        </span>
        {/* One reward line, not four. The implicit decides the axis and the explicits
            decide the size - that coupling is what makes crafting a tablet a decision
            about how much risk to buy. */}
        <span className="font-mono text-[11px] text-emerald-300">
          {run.reward ? `+${Math.round(run.reward.amount * 100)}% ${run.reward.pays}` : 'no reward'}
        </span>

        <button
          type="button"
          disabled={busy}
          onClick={onDescend}
          className="ml-auto min-h-9 rounded-lg border border-violet-400/60 bg-violet-500/20 px-3 text-xs font-semibold text-violet-100 active:bg-violet-500/40 disabled:opacity-40"
        >
          Descend
        </button>
      </div>
    </div>
  );
}
