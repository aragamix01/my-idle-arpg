'use client';

/**
 * Character sheet and item inventory.
 *
 * The inventory is a grid of icons with a detail pane, not a list of cards.
 * That is forced by capacity: at 100 slots a card list is a page and a half of
 * scrolling, and finding one item in it means reading every other. A grid shows
 * the whole inventory at once and spends its vertical space on the one item the
 * player actually selected.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ITEM_SLOTS,
  effectiveHp,
  enemyCount,
  itemEffects,
  itemName,
  itemPower,
  itemSprite,
  killsPerSecond,
  rerollCost,
  statsDps,
  critFactor,
  type HudSnapshot,
  type ItemInstance,
  type Rarity,
  type SaveState,
} from '@/sim';
import { AtlasSprite } from './atlasSprite';
import {
  compact,
  describeEffect,
  describeRolledAffix,
  RARITY_STYLE,
  statEntries,
} from './format';

type Tab = 'character' | 'inventory';
type SortKey = 'newest' | 'rarity' | 'itemLevel' | 'power';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'newest', label: 'Newest' },
  { key: 'rarity', label: 'Rarity' },
  { key: 'itemLevel', label: 'Item level' },
  { key: 'power', label: 'Power' },
];

/** Descending, so "sort by rarity" puts the interesting end first. */
const RARITY_ORDER: Record<Rarity, number> = { unique: 3, rare: 2, magic: 1, common: 0 };
const RARITIES: Rarity[] = ['common', 'magic', 'rare', 'unique'];

interface Props {
  state: SaveState;
  hud: HudSnapshot;
  busy: boolean;
  onEquip: (slot: number, itemId: string | null) => void;
  onReroll: (uid: string) => void;
  onDiscard: (uid: string) => void;
  onClose: () => void;
}

export function CharacterPanel({
  state,
  hud,
  busy,
  onEquip,
  onReroll,
  onDiscard,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>('character');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl"
        // Clicks inside must not reach the backdrop's close handler.
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Character"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-4 py-3">
          <TabButton active={tab === 'character'} onClick={() => setTab('character')}>
            Character
          </TabButton>
          <TabButton active={tab === 'inventory'} onClick={() => setTab('inventory')}>
            Inventory ({hud.items.length}/{hud.inventoryCap})
          </TabButton>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'character' ? (
            <CharacterTab state={state} hud={hud} />
          ) : (
            <InventoryTab
              hud={hud}
              busy={busy}
              onEquip={onEquip}
              onReroll={onReroll}
              onDiscard={onDiscard}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1.5 text-sm font-medium ${
        active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  );
}

function CharacterTab({ state, hud }: { state: SaveState; hud: HudSnapshot }) {
  const stats = hud.stats;
  const stage = Math.max(1, hud.bestStage || 1);

  // Derived figures, not stats. These are what actually decide a run: effective
  // HP is what damage is measured against, and wave DPS is why Area matters.
  const derived = [
    { label: 'Effective HP', value: compact(effectiveHp(stats)) },
    { label: 'DPS (single)', value: compact(statsDps(stats)) },
    {
      label: 'DPS (wave)',
      value: compact(statsDps(stats) * Math.min(stats.area, enemyCount(stage))),
    },
    { label: 'Crit multiplier', value: `x${critFactor(stats).toFixed(3)}` },
    { label: 'Kills / sec', value: compact(killsPerSecond(state, stage)) },
    { label: 'Gold / sec', value: compact(hud.goldPerSecond) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Section title="Stats">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {statEntries(stats).map((entry) => (
            <Row key={entry.key} label={entry.label} value={entry.value} />
          ))}
        </dl>
      </Section>

      <Section title="Derived">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
          {derived.map((entry) => (
            <Row key={entry.label} label={entry.label} value={entry.value} />
          ))}
        </dl>
        <p className="mt-2 text-[11px] text-neutral-500">
          Measured at stage {stage}. Area only helps against waves - bosses are fought one at a
          time.
        </p>
      </Section>
    </div>
  );
}

function InventoryTab({
  hud,
  busy,
  onEquip,
  onReroll,
  onDiscard,
}: {
  hud: HudSnapshot;
  busy: boolean;
  onEquip: (slot: number, itemId: string | null) => void;
  onReroll: (uid: string) => void;
  onDiscard: (uid: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('newest');
  const [rarityFilter, setRarityFilter] = useState<Rarity[]>([]);
  const [equippedOnly, setEquippedOnly] = useState(false);

  const byUid = useMemo(() => new Map(hud.items.map((item) => [item.uid, item])), [hud.items]);

  const visible = useMemo(() => {
    const filtered = hud.items.filter((item) => {
      if (rarityFilter.length > 0 && !rarityFilter.includes(item.rarity)) return false;
      if (equippedOnly && !hud.loadout.includes(item.uid)) return false;
      return true;
    });

    // Sorted on a copy - hud.items is the store's array, and sorting in place
    // would mutate state React believes it owns.
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case 'rarity':
          return RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity] || itemPower(b) - itemPower(a);
        case 'itemLevel':
          return b.itemLevel - a.itemLevel;
        case 'power':
          return itemPower(b) - itemPower(a);
        default:
          // uids are assigned from a monotonic counter, so numeric order is
          // drop order.
          return Number(b.uid) - Number(a.uid);
      }
    });
  }, [hud.items, hud.loadout, rarityFilter, equippedOnly, sort]);

  const selectedItem = selected ? byUid.get(selected) : undefined;

  const toggleRarity = (rarity: Rarity) =>
    setRarityFilter((current) =>
      current.includes(rarity) ? current.filter((r) => r !== rarity) : [...current, rarity],
    );

  const equip = (uid: string) => {
    const equippedSlot = hud.loadout.indexOf(uid);
    if (equippedSlot !== -1) return onEquip(equippedSlot, null);
    const free = hud.loadout.indexOf(null);
    // Every slot taken is a choice to make, not an error to swallow - the
    // player unequips something first.
    if (free === -1) return;
    onEquip(free, uid);
  };

  return (
    <div className="flex flex-col gap-4">
      <Section title={`Equipped (${hud.loadout.filter(Boolean).length}/${ITEM_SLOTS})`}>
        <div className="grid grid-cols-4 gap-2">
          {hud.loadout.map((uid, slot) => {
            const item = uid ? byUid.get(uid) : undefined;
            return (
              <button
                key={slot}
                type="button"
                disabled={busy || !item}
                onClick={() => item && setSelected(item.uid)}
                title={item ? itemName(item) : 'Empty slot'}
                className={`flex flex-col items-center gap-1 rounded border p-2 text-center ${
                  item
                    ? `${RARITY_STYLE[item.rarity].border} bg-neutral-900 hover:bg-neutral-800`
                    : 'border-dashed border-neutral-800 bg-neutral-900/50'
                }`}
              >
                {item ? (
                  <>
                    <AtlasSprite id={itemSprite(item)} scale={2} />
                    <span className={`text-[10px] leading-tight ${RARITY_STYLE[item.rarity].text}`}>
                      {itemName(item)}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="h-8 w-8" />
                    <span className="text-[10px] text-neutral-600">empty</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor="inv-sort" className="text-neutral-400">
          Sort
        </label>
        <select
          id="inv-sort"
          value={sort}
          onChange={(event) => setSort(event.target.value as SortKey)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
        >
          {SORTS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>

        <span className="ml-2 text-neutral-400">Filter</span>
        {RARITIES.map((rarity) => {
          const active = rarityFilter.includes(rarity);
          return (
            <button
              key={rarity}
              type="button"
              aria-pressed={active}
              onClick={() => toggleRarity(rarity)}
              className={`rounded border px-2 py-1 ${
                active
                  ? `${RARITY_STYLE[rarity].border} ${RARITY_STYLE[rarity].text} bg-neutral-800`
                  : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {RARITY_STYLE[rarity].label}
            </button>
          );
        })}

        <button
          type="button"
          aria-pressed={equippedOnly}
          onClick={() => setEquippedOnly((v) => !v)}
          className={`rounded border px-2 py-1 ${
            equippedOnly
              ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-100'
              : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'
          }`}
        >
          Equipped
        </button>

        <span className="ml-auto font-mono text-neutral-500">
          {visible.length}/{hud.items.length}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <ItemGrid
          items={visible}
          loadout={hud.loadout}
          selected={selected}
          onSelect={setSelected}
          empty={hud.items.length === 0}
        />

        <ItemDetail
          item={selectedItem}
          equipped={selectedItem ? hud.loadout.includes(selectedItem.uid) : false}
          slotsFull={!hud.loadout.includes(null)}
          gold={hud.gold}
          busy={busy}
          onEquip={() => selectedItem && equip(selectedItem.uid)}
          onReroll={() => selectedItem && onReroll(selectedItem.uid)}
          onDiscard={() => {
            if (!selectedItem) return;
            onDiscard(selectedItem.uid);
            setSelected(null);
          }}
        />
      </div>
    </div>
  );
}

function ItemGrid({
  items,
  loadout,
  selected,
  onSelect,
  empty,
}: {
  items: ItemInstance[];
  loadout: (string | null)[];
  selected: string | null;
  onSelect: (uid: string) => void;
  empty: boolean;
}) {
  if (empty) {
    return (
      <p className="text-sm text-neutral-500">
        No items yet — every stage clear drops one to three. Clear stage 1 to find your first.
      </p>
    );
  }

  if (items.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing matches this filter.</p>;
  }

  return (
    <ul
      // content-start matters: the grid sits in a row alongside the detail
      // pane, and without it the rows stretch to the pane's height and the
      // tiles drift apart into bands with gaps between them.
      className="grid auto-rows-min content-start grid-cols-6 gap-1.5 sm:grid-cols-8 lg:grid-cols-10"
      aria-label="Item grid"
    >
      {items.map((item) => {
        const style = RARITY_STYLE[item.rarity];
        const isEquipped = loadout.includes(item.uid);
        return (
          <li key={item.uid}>
            <button
              type="button"
              onClick={() => onSelect(item.uid)}
              title={`${itemName(item)} — iLvl ${item.itemLevel}`}
              aria-pressed={selected === item.uid}
              className={`relative grid aspect-square w-full place-items-center rounded border bg-neutral-900/70 hover:bg-neutral-800 ${
                style.border
              } ${selected === item.uid ? 'ring-2 ring-neutral-100' : ''}`}
            >
              <AtlasSprite id={itemSprite(item)} scale={2} />
              {/* A dot rather than a word: at this tile size there is no room
                  for a label, and the equipped row above is the full answer. */}
              {isEquipped && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ItemDetail({
  item,
  equipped,
  slotsFull,
  gold,
  busy,
  onEquip,
  onReroll,
  onDiscard,
}: {
  item: ItemInstance | undefined;
  equipped: boolean;
  slotsFull: boolean;
  gold: number;
  busy: boolean;
  onEquip: () => void;
  onReroll: () => void;
  onDiscard: () => void;
}) {
  if (!item) {
    return (
      <aside className="rounded border border-dashed border-neutral-800 p-3 text-xs text-neutral-500">
        Select an item to inspect it.
      </aside>
    );
  }

  const style = RARITY_STYLE[item.rarity];
  const isUnique = item.rarity === 'unique';
  const cost = isUnique ? Infinity : rerollCost(item.rarity, item.itemLevel, item.rerolls);
  const implicit = item.baseAffix ? describeRolledAffix(item.baseAffix) : null;

  return (
    <aside className={`flex flex-col gap-3 rounded border ${style.border} bg-neutral-900/70 p-3`}>
      <div className="flex items-start gap-2">
        <AtlasSprite id={itemSprite(item)} scale={2} className="mt-0.5" />
        <div className="min-w-0">
          <p className={`text-sm font-medium ${style.text}`}>{itemName(item)}</p>
          <p className="text-[10px] uppercase tracking-wide text-neutral-500">
            {style.label} · iLvl {item.itemLevel}
            {item.rerolls > 0 ? ` · ${item.rerolls} rerolls` : ''}
          </p>
        </div>
      </div>

      {/* The implicit sits above a rule, the way an item's fixed half reads in
          the game this borrows from - it is the part a reroll cannot touch. */}
      {implicit && (
        <ul className="border-b border-neutral-800 pb-2 text-[11px] text-neutral-300">
          <li className="flex gap-2">
            <span className="w-7 shrink-0 font-mono text-neutral-600">{implicit.tier}</span>
            <span>{implicit.text}</span>
          </li>
        </ul>
      )}

      <ul className="text-[11px] text-neutral-400">
        {isUnique
          ? itemEffects(item).map((effect, i) => <li key={i}>{describeEffect(effect)}</li>)
          : item.affixes.map((rolled, i) => {
              const line = describeRolledAffix(rolled);
              return (
                <li key={i} className="flex gap-2">
                  <span className="w-7 shrink-0 font-mono text-neutral-600">{line.tier}</span>
                  <span>{line.text}</span>
                </li>
              );
            })}
      </ul>

      <div className="mt-auto flex flex-col gap-1">
        <button
          type="button"
          disabled={busy || (!equipped && slotsFull)}
          onClick={onEquip}
          className="rounded border border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
        >
          {equipped ? 'Unequip' : slotsFull ? 'Slots full' : 'Equip'}
        </button>

        {/* Uniques have no affixes to reroll - that is what makes them unique. */}
        {!isUnique && (
          <button
            type="button"
            disabled={busy || gold < cost}
            onClick={onReroll}
            title="Rerolls every modifier except the implicit. There is no way to keep one."
            className="rounded border border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
          >
            Reroll {compact(cost)}g
          </button>
        )}

        <button
          type="button"
          disabled={busy || equipped}
          onClick={onDiscard}
          title={equipped ? 'Unequip it first' : undefined}
          className="rounded border border-red-900/70 px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-40"
        >
          Discard
        </button>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-neutral-900 py-0.5">
      <dt className="text-xs text-neutral-400">{label}</dt>
      <dd className="font-mono text-sm text-neutral-100">{value}</dd>
    </div>
  );
}
