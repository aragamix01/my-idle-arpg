'use client';

/**
 * The tablet shelf, and the run picker in the same surface.
 *
 * One list rather than a stash plus a separate "choose a run" dialog, because there is
 * exactly one thing to do with a tablet and hiding it behind a second step would only
 * add a click. Picking a tablet IS entering the Abyss - it is consumed on the way in.
 *
 * ## Why this does not reuse ItemMods
 *
 * They render the same-looking list and cannot share a component. `ItemMods` resolves
 * `RolledAffix` ids against the AFFIX registry; a tablet's ids are into TABLET_MODS and
 * the pools are disjoint, so passing one to the other renders every line as "unknown".
 * The same reason `TabletInstance` is not an `ItemInstance`: the shapes look alike, and
 * that is the expensive kind of similarity.
 *
 * What a tablet mod shows is different anyway. An affix line is a magnitude on a stat.
 * A tablet line is a TRADE - danger against one axis of reward - and the whole decision
 * a player is making here is how much risk to buy.
 */

import { getTabletMod, type TabletView } from '@/sim';
import { ELEMENT_STYLE, elementName } from './format';

interface Props {
  tablets: TabletView[];
  /** False below the unlock floor. The list still renders; the runs do not. */
  unlocked: boolean;
  unlockStage: number;
  cap: number;
  busy: boolean;
  onDescend: (uid: string) => void;
}

export function TabletStash({ tablets, unlocked, unlockStage, cap, busy, onDescend }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-neutral-500">
        {tablets.length}/{cap} tablets · a tablet is spent on entry, and spent on a loss.
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
          No tablets. Stage bosses past floor {unlockStage} hand them over, and clearing the
          Abyss pays them back.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Tablets">
          {tablets.map((tablet) => (
            <li key={tablet.uid}>
              <TabletCard
                tablet={tablet}
                busy={busy || !unlocked}
                onDescend={() => onDescend(tablet.uid)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TabletCard({
  tablet,
  busy,
  onDescend,
}: {
  tablet: TabletView;
  busy: boolean;
  onDescend: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-violet-500/50 bg-violet-500/5 p-3">
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-violet-200">
          T{tablet.tier}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-violet-100">{tablet.name}</span>
        {/* The depth is the fight; the tier is the label. Both, because a T7 says
            nothing about how deep it actually is until you have run one. */}
        <span className="shrink-0 font-mono text-[10px] text-neutral-500">
          depth {tablet.depth}
        </span>
      </div>

      {/*
        The affinity, before the tablet is spent.

        At the Abyssal affinity the resisted element is the single biggest number in the
        run - it multiplies effective HP far harder than the tier does - so this is the
        line that decides which weapon to bring. Putting it behind a tooltip would make
        the tablet a coin flip.
      */}
      <p className="text-[11px]">
        <span className="text-neutral-500">weak to </span>
        <span className={ELEMENT_STYLE[tablet.weakTo]}>{elementName(tablet.weakTo)}</span>
        <span className="text-neutral-700"> · </span>
        <span className="text-neutral-500">resists </span>
        <span className={ELEMENT_STYLE[tablet.resists]}>{elementName(tablet.resists)}</span>
      </p>

      <ul className="flex flex-col gap-1 text-[11px]">
        {tablet.mods.map((id) => {
          const mod = getTabletMod(id);
          // A retired id renders as nothing rather than breaking the tablet - the same
          // tolerance tabletTotals gives it.
          if (!mod) return null;
          return (
            <li key={id} className="flex gap-2">
              <span className="w-24 shrink-0 truncate font-medium text-violet-300">
                {mod.nameFragment}
              </span>
              <span className="min-w-0 flex-1 text-neutral-400">{mod.description}</span>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-3">
        {/* Danger and reward as one summary each, because that is the trade the mods
            add up to and reading four lines to work it out is the player doing the
            sum the sim already did. */}
        <span className="font-mono text-[11px] text-rose-300">
          +{Math.round(tablet.danger * 100)}% danger
        </span>
        <span className="font-mono text-[11px] text-emerald-300">{rewardSummary(tablet)}</span>

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

/**
 * What this tablet pays, by axis.
 *
 * Split rather than summed, because the axes are the point: a Gilded tablet pays gold
 * and a Hoarding one items, and a single "+125% reward" would make every mod read the
 * same. A bare tier pays its baseline and shows nothing here.
 */
function rewardSummary(tablet: TabletView): string {
  const parts = Object.entries(tablet.reward)
    .filter(([, value]) => value > 0)
    .map(([axis, value]) => `+${Math.round(value * 100)}% ${axis}`);
  return parts.length > 0 ? parts.join(' · ') : 'baseline reward';
}
