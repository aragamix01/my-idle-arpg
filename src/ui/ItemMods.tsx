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

import { affixRows, getCurrency, itemEffects, type ItemInstance } from '@/sim';
import { AFFIX_SLOT_STYLE, describeEffect, describeRolledAffix } from './format';

export function ItemMods({ item }: { item: ItemInstance }) {
  const isUnique = item.rarity === 'unique';
  const implicit = item.baseAffix ? describeRolledAffix(item.baseAffix, true) : null;
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
          ? itemEffects(item).map((effect, i) => <li key={i}>{describeEffect(effect)}</li>)
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

function ModLine({ line }: { line: ReturnType<typeof describeRolledAffix> }) {
  return (
    <li className="flex gap-2">
      <span className={`w-3 shrink-0 font-mono ${AFFIX_SLOT_STYLE[line.slot]}`}>{line.badge}</span>
      <span className="w-6 shrink-0 font-mono text-neutral-600">{line.tier}</span>
      <span>{line.text}</span>
    </li>
  );
}
