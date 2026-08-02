'use client';

/**
 * The tablet shelf, inside the character panel.
 *
 * A list rather than the inventory's icon grid, and deliberately: there are at most a
 * couple of hundred of these, every one of them is read for its modifiers rather than
 * recognised by its icon, and the decision a player makes here - which one to craft, and
 * how far to push it - is made out of the text.
 *
 * Everything about it is the item machinery. `ItemMods` renders the modifiers, the craft
 * modal applies currency, `currencyLegality` says what is refused and why. That is the
 * payoff of a tablet being an `ItemInstance` rather than a type of its own.
 */

import { useState } from 'react';
import {
  fromSave,
  itemName,
  type CurrencyId,
  type HudSnapshot,
  type ItemInstance,
} from '@/sim';
import { CraftModal } from './CraftModal';
import { ELEMENT_STYLE, RARITY_STYLE } from './format';
import { ItemMods } from './ItemMods';

interface Props {
  hud: HudSnapshot;
  busy: boolean;
  /** Set when the currency stash armed one. Clicking a tablet then crafts rather than opens. */
  armed: CurrencyId | null;
  onApplyCurrency: (currencyId: CurrencyId, uid: string) => void;
}

export function TabletTab({ hud, busy, armed, onApplyCurrency }: Props) {
  const [crafting, setCrafting] = useState<string | null>(null);
  // Read from the live snapshot every render rather than held in state: the craft modal
  // stays open across applications, and a copy would show the tablet as it was before
  // the last currency landed.
  const open = crafting ? hud.tablets.find((t) => t.uid === crafting) : undefined;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-neutral-500">
        {hud.tablets.length}/{hud.abyss.cap} tablets · rarity buys rows, and every row is
        danger the implicit pays you for. Descend from the Abyss button.
      </p>

      {armed && (
        <p className="rounded border border-emerald-500/60 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
          Click a tablet to use it.
        </p>
      )}

      {hud.tablets.length === 0 ? (
        <p className="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-6 text-center text-[11px] text-neutral-500">
          No tablets. They drop from monsters past floor {hud.abyss.unlockStage}.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Tablet list">
          {hud.tablets.map((tablet) => (
            <li key={tablet.uid}>
              <TabletRow
                tablet={tablet}
                run={hud.tabletRuns[tablet.uid]}
                busy={busy}
                armed={armed !== null}
                onClick={() => {
                  if (armed) onApplyCurrency(armed, tablet.uid);
                  else setCrafting(tablet.uid);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {open && (
        <CraftModal
          item={open}
          purse={hud.currency}
          gold={fromSave(hud.gold)}
          // Never equipped and never worth gold-rerolling: rerollCost scales on item
          // level, and a tablet's is its tier of 1-15, so a T15 would cost about what a
          // stage-15 item costs - free, at the point anyone is running the Abyss.
          equipped={false}
          rerollable={false}
          busy={busy}
          onApply={(currencyId) => onApplyCurrency(currencyId, open.uid)}
          onReroll={() => {}}
          onClose={() => setCrafting(null)}
        />
      )}
    </div>
  );
}

function TabletRow({
  tablet,
  run,
  busy,
  armed,
  onClick,
}: {
  tablet: ItemInstance;
  run: HudSnapshot['tabletRuns'][string] | undefined;
  busy: boolean;
  armed: boolean;
  onClick: () => void;
}) {
  const style = RARITY_STYLE[tablet.rarity];

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`flex w-full flex-col gap-2 rounded border ${style.border} bg-neutral-900/60 p-3 text-left disabled:opacity-40 ${
        armed ? 'ring-1 ring-emerald-400' : 'hover:bg-neutral-900'
      }`}
    >
      <span className="flex items-baseline gap-2">
        <span className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-violet-200">
          T{tablet.itemLevel}
        </span>
        <span className={`min-w-0 flex-1 truncate text-sm ${style.text}`}>{itemName(tablet)}</span>
        {run && (
          // The affinity belongs here as well as on the run picker: this is where a
          // player decides whether a tablet is worth crafting, and a run that resists
          // the only element they can deal is not.
          <span className="shrink-0 font-mono text-[10px]">
            <span className={ELEMENT_STYLE[run.weakTo]}>{run.weakTo[0].toUpperCase()}</span>
            <span className="text-neutral-600">/</span>
            <span className={ELEMENT_STYLE[run.resists]}>{run.resists[0].toUpperCase()}</span>
            <span className="text-neutral-700"> · </span>
            <span className="text-neutral-500">
              {run.waves}w · depth {run.depth}
            </span>
          </span>
        )}
      </span>

      <ItemMods item={tablet} />

      {run && (
        /*
          What the tablet actually adds up to.

          Not decoration on top of the modifier list - a correction to it. The implicit
          line above prints the value that ROLLED, and the run pays that value amplified
          by every explicit, so a tablet whose implicit reads 50% can pay 105%. Reading
          the list alone would understate a heavily crafted tablet by more than half,
          which is the exact opposite of the impression crafting one should leave.
        */
        <span className="flex items-center gap-3 border-t border-neutral-800 pt-2 font-mono text-[11px]">
          <span className="text-rose-300">+{Math.round(run.danger * 100)}% danger</span>
          <span className="text-emerald-300">
            {run.reward
              ? `+${Math.round(run.reward.amount * 100)}% ${run.reward.pays}`
              : 'no reward'}
          </span>
        </span>
      )}
    </button>
  );
}
