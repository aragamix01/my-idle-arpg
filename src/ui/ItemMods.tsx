'use client';

/**
 * An item's modifier list.
 *
 * Shared by the inventory detail pane and the craft modal. They used to be two
 * copies, which meant the craft modal - the one place a player is actively
 * changing modifiers - was the place that showed them least.
 *
 * The implicit sits above a rule, the way an item's fixed half reads in the
 * game this borrows from: it is the part no reroll and no currency can touch.
 */

import {
  affixRows,
  getCurrency,
  getUnique,
  itemEffects,
  rollQuality,
  type ItemInstance,
} from '@/sim';
import { AFFIX_SLOT_STYLE, describeEffect, describeRolledAffix } from './format';

export function ItemMods({ item }: { item: ItemInstance }) {
  const isUnique = item.rarity === 'unique';
  // The base id goes through for the tablet implicit, whose sentence depends on which
  // reward the BASE pays rather than on the affix.
  const implicit = item.baseAffix ? describeRolledAffix(item.baseAffix, true, item.baseId) : null;
  const spirit = item.spirit ? getCurrency(item.spirit) : undefined;
  const rows = affixRows(item);

  return (
    <div className="flex flex-col gap-2">
      {/* A spirit is permanent and one-shot, so the item has to say so plainly -
          a player must never spend a second one to find out. */}
      {spirit && (
        <p className="text-[10px] text-fuchsia-300">
          {spirit.name} · {rows.prefix}p/{rows.suffix}s · 1/1
        </p>
      )}

      {implicit && (
        <ul className="border-b border-neutral-800 pb-2 text-[11px] text-neutral-300">
          <ModLine line={implicit} />
        </ul>
      )}

      <ul className="text-[11px] text-neutral-400">
        {isUnique
          ? itemEffects(item).map((effect, i) => (
              <UniqueLine key={i} item={item} index={i} text={describeEffect(effect)} />
            ))
          : // Prefixes first, then suffixes. The stored order is roll order,
            // which puts a rare's four modifiers in whatever sequence the RNG
            // produced and makes "reroll only the prefixes" hard to read.
            [...item.affixes]
              .map((rolled) => describeRolledAffix(rolled))
              .sort((a, b) => (a.slot === b.slot ? 0 : a.slot === 'prefix' ? -1 : 1))
              .map((line, i) => <ModLine key={i} line={line} />)}
      </ul>
    </div>
  );
}

/**
 * One authored effect, with how well it rolled inside its range.
 *
 * The percentage is the reason ranges exist. Without it a unique's numbers are just
 * numbers and there is no way to know whether the one you are holding is worth a
 * flame - which makes both the range and the currency invisible. Constants show no
 * percentage at all, because a fixed downside is not a roll a player can chase.
 *
 * Colour only at the ends: a middling roll is the common case and does not need to
 * shout, while a near-perfect one is the thing a player is hunting for.
 */
function UniqueLine({ item, index, text }: { item: ItemInstance; index: number; text: string }) {
  const unique = item.uniqueId ? getUnique(item.uniqueId) : undefined;
  const quality = unique ? rollQuality(unique, item.uniqueRolls, index) : null;

  return (
    <li className="flex gap-2">
      <span
        className={`w-8 shrink-0 text-right font-mono ${
          quality === null
            ? 'text-neutral-700'
            : quality >= 0.85
              ? 'text-orange-300'
              : quality <= 0.15
                ? 'text-neutral-600'
                : 'text-neutral-500'
        }`}
      >
        {quality === null ? '—' : `${Math.round(quality * 100)}%`}
      </span>
      <span>{text}</span>
    </li>
  );
}

function ModLine({ line }: { line: ReturnType<typeof describeRolledAffix> }) {
  return (
    <li className="flex gap-2">
      <span className={`w-3 shrink-0 font-mono ${AFFIX_SLOT_STYLE[line.slot]}`}>{line.badge}</span>
      <span className="w-6 shrink-0 font-mono text-neutral-600">{line.tier}</span>
      <span>{line.text}</span>
    </li>
  );
}
