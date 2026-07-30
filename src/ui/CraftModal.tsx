'use client';

/**
 * The craft modal.
 *
 * Every option a player owns is listed, valid or not. Invalid ones are greyed
 * out **with the reason** rather than hidden, because the rules - rare only,
 * one spirit per item, commons only - are the interesting part of the system
 * and a hidden option teaches nobody anything.
 *
 * The reason string comes from `currencyLegality`, the same function
 * applyCommand refuses with. A player therefore learns the rule from the exact
 * sentence the server enforces, and the two cannot drift apart.
 *
 * ## It stays open, and it shows the item
 *
 * Crafting is a loop: roll, look, roll again until it lands. An earlier version
 * closed on every application and covered the detail pane while open, so the one
 * screen where modifiers are actively changing was the one screen that did not
 * show them - a player had to shut the modal to find out what they had just
 * done, then reopen it to do it again.
 *
 * `item` comes from the live store, so every line here updates in place as the
 * command round-trips. When an Angel Droplet destroys the item the parent stops
 * finding it and this unmounts, which is the correct exit.
 */

import {
  CURRENCIES,
  currencyLegality,
  itemName,
  itemSprite,
  rerollCost,
  type CurrencyDefinition,
  type CurrencyId,
  type CurrencyPurse,
  type ItemInstance,
} from '@/sim';
import { AtlasSprite } from './atlasSprite';
import { compact, CURRENCY_TIER_STYLE, RARITY_STYLE } from './format';
import { ItemMods } from './ItemMods';

interface Props {
  item: ItemInstance;
  purse: CurrencyPurse;
  gold: number;
  equipped: boolean;
  busy: boolean;
  /** Live character figures, so the effect of an equipped item's roll is visible. */
  dps: number;
  effectiveHp: number;
  onApply: (currencyId: CurrencyId) => void;
  onReroll: () => void;
  onClose: () => void;
}

export function CraftModal({
  item,
  purse,
  gold,
  equipped,
  busy,
  dps,
  effectiveHp,
  onApply,
  onReroll,
  onClose,
}: Props) {
  const style = RARITY_STYLE[item.rarity];
  const isUnique = item.rarity === 'unique';
  const goldCost = isUnique ? Infinity : rerollCost(item.rarity, item.itemLevel, item.rerolls);

  // Only what the player holds, and only what can act on an item. Fragments
  // combine in the stash and keys open dungeons; listing them here just to
  // refuse them turns the refusal text from a lesson into noise.
  const owned = CURRENCIES.filter(
    (c) => c.tier !== 'key' && c.tier !== 'fragment' && (purse[c.id] ?? 0) > 0,
  );
  const hasFragments = CURRENCIES.some((c) => c.tier === 'fragment' && (purse[c.id] ?? 0) > 0);

  return (
    <div
      // Lighter than the panel's own backdrop. Two 70% scrims stacked left the
      // modal reading as disabled rather than focused.
      className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Craft"
      >
        <header className="shrink-0 border-b border-neutral-800 px-4 py-3">
          <div className="flex items-start gap-2">
            <AtlasSprite id={itemSprite(item)} scale={2} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className={`truncate text-sm font-medium ${style.text}`}>{itemName(item)}</p>
              <p className="text-[10px] uppercase tracking-wide text-neutral-500">
                {style.label} · iLvl {item.itemLevel}
                {item.rerolls > 0 ? ` · ${item.rerolls} rerolls` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close craft"
              className="ml-auto shrink-0 rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            >
              ✕
            </button>
          </div>

          {/* The modifiers being changed, in the window doing the changing. */}
          <div className="mt-2">
            <ItemMods item={item} />
          </div>

          {equipped && (
            <dl className="mt-2 flex gap-4 border-t border-neutral-800 pt-2 text-[11px]">
              <div className="flex gap-1.5">
                <dt className="text-neutral-500">DPS</dt>
                <dd className="font-mono text-neutral-200">{compact(dps)}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-neutral-500">Effective HP</dt>
                <dd className="font-mono text-neutral-200">{compact(effectiveHp)}</dd>
              </div>
              {/* Only while equipped: an item on the bench changes nothing, and
                  showing unmoving numbers would suggest the roll did nothing. */}
            </dl>
          )}
        </header>

        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
          {/* Gold sits in the same list as currency deliberately: it is one
              option among several now, not the only way to change an item. */}
          <li>
            <OptionRow
              sprite="item.coin_purse"
              name="Gold Reroll"
              description="Rerolls every modifier except the implicit. There is no way to keep one."
              trailing={`${compact(goldCost)}g`}
              reason={
                isUnique
                  ? 'uniques cannot be modified'
                  : gold < goldCost
                    ? `need ${compact(goldCost)} gold`
                    : null
              }
              busy={busy}
              onClick={onReroll}
            />
          </li>

          {owned.length === 0 && (
            <li className="px-2 py-6 text-center text-xs text-neutral-500">
              {/* Holding fragments is not the same as holding nothing, and
                  telling a player with twenty shards that they have no
                  currency sends them looking for a drop they already have. */}
              {hasFragments
                ? 'No currency ready. Combine fragments in the Currency tab first.'
                : 'No crafting currency yet. Stage bosses drop fragments, and ten of a kind combine into one.'}
            </li>
          )}

          {owned.map((currency) => (
            <li key={currency.id}>
              <CurrencyOption
                currency={currency}
                count={purse[currency.id] ?? 0}
                item={item}
                equipped={equipped}
                busy={busy}
                onApply={() => onApply(currency.id)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CurrencyOption({
  currency,
  count,
  item,
  equipped,
  busy,
  onApply,
}: {
  currency: CurrencyDefinition;
  count: number;
  item: ItemInstance;
  equipped: boolean;
  busy: boolean;
  onApply: () => void;
}) {
  const reason = currencyLegality(item, currency, equipped);
  const tier = CURRENCY_TIER_STYLE[currency.tier];

  return (
    <OptionRow
      sprite={currency.sprite}
      name={currency.name}
      nameClass={tier.text}
      borderClass={tier.border}
      description={currency.description}
      trailing={`x${count}`}
      reason={reason}
      busy={busy}
      onClick={onApply}
    />
  );
}

function OptionRow({
  sprite,
  name,
  nameClass = 'text-neutral-200',
  borderClass = 'border-neutral-800',
  description,
  trailing,
  reason,
  busy,
  onClick,
}: {
  sprite: string;
  name: string;
  nameClass?: string;
  borderClass?: string;
  description: string;
  trailing: string;
  reason: string | null;
  busy: boolean;
  onClick: () => void;
}) {
  const blocked = busy || reason !== null;

  return (
    <button
      type="button"
      disabled={blocked}
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded border ${borderClass} bg-neutral-900/70 p-2.5 text-left ${
        blocked ? 'opacity-50' : 'hover:bg-neutral-800'
      }`}
    >
      <AtlasSprite id={sprite} scale={2} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`text-sm font-medium ${nameClass}`}>{name}</span>
          <span className="font-mono text-[11px] text-neutral-500">{trailing}</span>
        </span>
        <span className="mt-0.5 block text-[11px] text-neutral-400">{description}</span>
        {/* The refusal is the teaching surface. Hiding it would leave a player
            guessing why half their currency does nothing. */}
        {reason && <span className="mt-0.5 block text-[11px] text-amber-500">{reason}</span>}
      </span>
    </button>
  );
}
