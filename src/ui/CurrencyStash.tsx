'use client';

/**
 * The currency stash.
 *
 * Fixed slots, one per currency, present whether or not you own any - the same
 * shape as the stash tab in the game this borrows from. An empty slot is
 * information: it tells a player what exists and what they are missing, which a
 * list that only showed holdings could not.
 *
 * Two ways out of here, both dispatching the same commands: combine a stack of
 * ten fragments in place, or arm a currency and click an item in the inventory.
 */

import {
  CURRENCIES,
  FRAGMENTS_PER_COMBINE,
  type CurrencyDefinition,
  type CurrencyId,
  type CurrencyPurse,
} from '@/sim';
import { AtlasSprite } from './atlasSprite';
import { CURRENCY_TIER_STYLE } from './format';

const GROUPS: { tier: CurrencyDefinition['tier']; title: string; blurb: string }[] = [
  { tier: 'basic', title: 'Currency', blurb: 'Click one to arm it, then click an item.' },
  { tier: 'spirit', title: 'Spirits', blurb: 'Rare items only. One per item, permanently.' },
  { tier: 'fragment', title: 'Fragments', blurb: `${FRAGMENTS_PER_COMBINE} combine into one.` },
  { tier: 'key', title: 'Keys', blurb: 'Spent on dungeons, not on items.' },
];

interface Props {
  purse: CurrencyPurse;
  armed: CurrencyId | null;
  busy: boolean;
  onArm: (currencyId: CurrencyId | null) => void;
  onCombine: (currencyId: CurrencyId) => void;
}

export function CurrencyStash({ purse, armed, busy, onArm, onCombine }: Props) {
  return (
    <div className="flex flex-col gap-5">
      {armed && (
        <p className="rounded border border-emerald-500/60 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
          {CURRENCIES.find((c) => c.id === armed)?.name} armed — open Inventory and click an item
          to use it.
        </p>
      )}

      {GROUPS.map((group) => (
        <section key={group.tier}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {group.title}
          </h3>
          <p className="mb-2 text-[11px] text-neutral-600">{group.blurb}</p>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label={group.title}>
            {CURRENCIES.filter((c) => c.tier === group.tier).map((currency) => (
              <li key={currency.id}>
                <Slot
                  currency={currency}
                  count={purse[currency.id] ?? 0}
                  armed={armed === currency.id}
                  busy={busy}
                  onArm={() => onArm(armed === currency.id ? null : currency.id)}
                  onCombine={() => onCombine(currency.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Slot({
  currency,
  count,
  armed,
  busy,
  onArm,
  onCombine,
}: {
  currency: CurrencyDefinition;
  count: number;
  armed: boolean;
  busy: boolean;
  onArm: () => void;
  onCombine: () => void;
}) {
  const style = CURRENCY_TIER_STYLE[currency.tier];
  const combinable = currency.action.kind === 'combine' && count >= currency.action.count;
  // Fragments and keys are never armed: a fragment combines, and a key is spent
  // by the dungeon rather than applied to anything.
  const armable = currency.tier === 'basic' || currency.tier === 'spirit';

  return (
    <div
      className={`flex h-full flex-col gap-1 rounded border ${style.border} bg-neutral-900/70 p-2 ${
        count === 0 ? 'opacity-40' : ''
      } ${armed ? 'ring-2 ring-emerald-400' : ''}`}
    >
      <button
        type="button"
        disabled={busy || !armable || count === 0}
        onClick={onArm}
        title={currency.description}
        aria-pressed={armed}
        className="flex items-center gap-2 text-left disabled:cursor-default"
      >
        <AtlasSprite id={currency.sprite} scale={2} className="shrink-0" />
        <span className="min-w-0">
          <span className={`block truncate text-[11px] font-medium ${style.text}`}>
            {currency.name}
          </span>
          <span className="block font-mono text-[11px] text-neutral-400">x{count}</span>
        </span>
      </button>

      {currency.action.kind === 'combine' && (
        <button
          type="button"
          disabled={busy || !combinable}
          onClick={onCombine}
          className="mt-auto rounded border border-neutral-700 px-2 py-0.5 text-[10px] hover:bg-neutral-800 disabled:opacity-40"
        >
          {/* Progress while short, and how many are ready once there are
              enough. "Combine 20/10" read as a broken fraction. */}
          {combinable
            ? `Combine (${Math.floor(count / currency.action.count)})`
            : `${count}/${currency.action.count}`}
        </button>
      )}
    </div>
  );
}
