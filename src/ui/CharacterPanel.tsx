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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ITEM_SLOTS,
  DISSEMBLE_YIELD,
  effectiveHp,
  enemyCount,
  getCurrency,
  itemName,
  itemPower,
  itemSprite,
  isWeaponBase,
  isResourceBound,
  baseSkillId,
  getSkill,
  UNARMED,
  killsPerSecond,
  statsDps,
  critFactor,
  type CurrencyId,
  type HudSnapshot,
  type ItemInstance,
  type Rarity,
  type SaveState,
  type Skill,
} from '@/sim';
import { AtlasSprite } from './atlasSprite';
import { CraftModal } from './CraftModal';
import { CurrencyStash } from './CurrencyStash';
import { compact, RARITY_STYLE, resourceName, skillSummary, statEntries } from './format';
import { ItemMods } from './ItemMods';

type Tab = 'character' | 'inventory' | 'currency';
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
  onEquipWeapon: (itemId: string | null) => void;
  onReroll: (uid: string) => void;
  onDissemble: (uids: string[]) => void;
  onApplyCurrency: (currencyId: CurrencyId, uid: string) => void;
  onCombine: (currencyId: CurrencyId) => void;
  onClose: () => void;
}

export function CharacterPanel({
  state,
  hud,
  busy,
  onEquip,
  onEquipWeapon,
  onReroll,
  onDissemble,
  onApplyCurrency,
  onCombine,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>('character');
  /**
   * The currency the stash armed, if any.
   *
   * Lives here rather than in the stash because arming is a cross-tab gesture:
   * you pick in Currency and spend in Inventory.
   */
  const [armed, setArmed] = useState<CurrencyId | null>(null);

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
          <TabButton active={tab === 'currency'} onClick={() => setTab('currency')}>
            Currency
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
          {tab === 'character' && <CharacterTab state={state} hud={hud} />}
          {tab === 'inventory' && (
            <InventoryTab
              hud={hud}
              busy={busy}
              armed={armed}
              onEquip={onEquip}
              onEquipWeapon={onEquipWeapon}
              onReroll={onReroll}
              onDissemble={onDissemble}
              onApplyCurrency={(currencyId, uid) => {
                onApplyCurrency(currencyId, uid);
                // Disarm after one use. Leaving it armed turns the next
                // inspecting click into an accidental craft.
                setArmed(null);
              }}
            />
          )}
          {tab === 'currency' && (
            <CurrencyStash
              purse={hud.currency}
              armed={armed}
              busy={busy}
              onArm={(currencyId) => {
                setArmed(currencyId);
                if (currencyId) setTab('inventory');
              }}
              onCombine={onCombine}
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
  armed,
  onEquip,
  onEquipWeapon,
  onReroll,
  onDissemble,
  onApplyCurrency,
}: {
  hud: HudSnapshot;
  busy: boolean;
  armed: CurrencyId | null;
  onEquip: (slot: number, itemId: string | null) => void;
  onEquipWeapon: (itemId: string | null) => void;
  onReroll: (uid: string) => void;
  onDissemble: (uids: string[]) => void;
  onApplyCurrency: (currencyId: CurrencyId, uid: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('newest');
  const [rarityFilter, setRarityFilter] = useState<Rarity[]>([]);
  const [equippedOnly, setEquippedOnly] = useState(false);
  const [crafting, setCrafting] = useState<string | null>(null);
  /**
   * Items awaiting a dissemble confirmation.
   *
   * One list for one item and for two hundred. A single rare and a bulk
   * selection are the same irreversible action at different scales, and giving
   * them separate dialogs would mean two places to keep the wording honest.
   */
  const [confirming, setConfirming] = useState<string[] | null>(null);
  /**
   * Multi-select mode, and what is in the selection.
   *
   * An explicit mode rather than a modifier-click, because a modifier is
   * invisible until you already know about it and does not exist on touch. It
   * replaced a button that dissembled everything the filter showed - which was
   * fast, and far too easy to fire at the wrong filter.
   */
  const [selectRequested, setSelectRequested] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  /**
   * Arming a currency suspends select mode.
   *
   * Both claim the grid click, so rather than deciding what a click means when
   * both are on, only one can be. Derived rather than synchronised into state:
   * an effect that flipped `selectRequested` off would fight whichever of the
   * two the player touched last, and the selection survives disarming.
   */
  const selecting = selectRequested && armed === null;

  const byUid = useMemo(() => new Map(hud.items.map((item) => [item.uid, item])), [hud.items]);

  /**
   * Worn anywhere, gear slot or weapon slot.
   *
   * A useCallback because the filter memo below depends on it, and a plain
   * function would be a new value every render and defeat the memo entirely.
   */
  const isEquipped = useCallback(
    (uid: string) => hud.loadout.includes(uid) || hud.weapon === uid,
    [hud.loadout, hud.weapon],
  );

  const visible = useMemo(() => {
    const filtered = hud.items.filter((item) => {
      if (rarityFilter.length > 0 && !rarityFilter.includes(item.rarity)) return false;
      if (equippedOnly && !isEquipped(item.uid)) return false;
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
  }, [hud.items, isEquipped, rarityFilter, equippedOnly, sort]);

  const selectedItem = selected ? byUid.get(selected) : undefined;

  const toggleRarity = (rarity: Rarity) =>
    setRarityFilter((current) =>
      current.includes(rarity) ? current.filter((r) => r !== rarity) : [...current, rarity],
    );

  const weaponItem = hud.weapon ? byUid.get(hud.weapon) : undefined;
  const equippedSkill = getSkill(
    (weaponItem && baseSkillId(weaponItem.baseId)) || UNARMED.id,
  )!;
  const weaponSkillLevel = weaponItem ? weaponItem.itemLevel : 0;
  const resourceLabel = resourceName(equippedSkill);
  const resourceBound = isResourceBound(hud.stats, equippedSkill);

  const equip = (uid: string) => {
    const item = byUid.get(uid);
    // A weapon never goes in a gear slot. There is one weapon slot, so equipping is
    // a straight swap rather than a hunt for a free space.
    if (item && isWeaponBase(item.baseId)) {
      return onEquipWeapon(hud.weapon === uid ? null : uid);
    }
    const equippedSlot = hud.loadout.indexOf(uid);
    if (equippedSlot !== -1) return onEquip(equippedSlot, null);
    const free = hud.loadout.indexOf(null);
    // Every slot taken is a choice to make, not an error to swallow - the
    // player unequips something first.
    if (free === -1) return;
    onEquip(free, uid);
  };


  /**
   * A grid click means one of three things, and the order matters.
   *
   * Arming a currency wins, then multi-select, then inspect. Each mode has a
   * visible banner or a pressed button above the grid, because a silent mode
   * switch on a click that can destroy things is a trap.
   */
  const onTileClick = (uid: string) => {
    if (armed) return onApplyCurrency(armed, uid);
    if (selecting) {
      // Equipped items are not selectable at all. The command refuses them
      // anyway, but offering a checkbox that cannot be honoured is worse than
      // not offering one.
      if (isEquipped(uid)) return;
      return setChosen((current) => {
        const next = new Set(current);
        if (!next.delete(uid)) next.add(uid);
        return next;
      });
    }
    setSelected(uid);
  };

  /**
   * Only what is both selected and still owned - and never what is worn.
   *
   * Taken over the whole inventory rather than only what the filter shows, so
   * narrowing the filter after picking does not silently drop items from the
   * selection. The count on the button and the breakdown in the dialog are what
   * disclose a selection that reaches beyond the current view.
   */
  const selection = hud.items.filter(
    (item) => chosen.has(item.uid) && !isEquipped(item.uid),
  );

  const leaveSelectMode = () => {
    setSelectRequested(false);
    setChosen(new Set());
  };

  /** Rares and uniques are worth a confirmation; commons and magics are not. */
  const requestDissemble = (item: ItemInstance) => {
    if (item.rarity === 'rare' || item.rarity === 'unique') return setConfirming([item.uid]);
    onDissemble([item.uid]);
    setSelected(null);
  };

  const craftingItem = crafting ? byUid.get(crafting) : undefined;
  const confirmingItems = confirming
    ? confirming.map((uid) => byUid.get(uid)).filter((item): item is ItemInstance => !!item)
    : [];

  return (
    <div className="flex flex-col gap-4">
      {/*
        The weapon sits above the gear row and on its own, because it is not one of
        five equal slots. It decides the skill, and the skill decides which stats
        matter at all - so putting it in line with four Charms would read as though
        swapping it were the same kind of choice.
      */}
      <Section title="Weapon">
        <button
          type="button"
          disabled={busy || !weaponItem}
          onClick={() => weaponItem && setSelected(weaponItem.uid)}
          title={weaponItem ? itemName(weaponItem) : 'No weapon - fighting unarmed'}
          className={`flex w-full items-center gap-3 rounded border p-2 text-left ${
            weaponItem
              ? `${RARITY_STYLE[weaponItem.rarity].border} bg-neutral-900 hover:bg-neutral-800`
              : 'border-dashed border-neutral-800 bg-neutral-900/50'
          }`}
        >
          <AtlasSprite id={weaponItem ? itemSprite(weaponItem) : 'item.axe'} scale={2} />
          <span className="flex flex-col gap-0.5">
            <span
              className={`text-xs leading-tight ${
                weaponItem ? RARITY_STYLE[weaponItem.rarity].text : 'text-neutral-600'
              }`}
            >
              {weaponItem ? itemName(weaponItem) : 'Unarmed'}
            </span>
            <span className="text-[10px] text-neutral-500">
              {equippedSkill.name}
              {weaponItem ? ` · skill level ${weaponSkillLevel}` : ' · find a weapon'}
              {/*
                Cost and regen together, never one alone. The cap is regen/cost, so a
                player shown only their regen cannot tell whether 3.40/s is generous or
                starving - that depends entirely on what the skill in their hand charges.
              */}
              {` · ${resourceLabel} ${equippedSkill.resourceCost.toFixed(1)}/use, regen ${hud.stats.resourceRegen.toFixed(2)}/s`}
            </span>
            {/*
              Named here and nowhere else, because which resource it is depends on the
              weapon in your hand - and the "limiting" note is the whole reason this
              line exists. Attack speed is silently capped at regen/cost, so a player
              who buys more of it and sees no change has no way to find out why.
            */}
            {resourceBound && (
              <span className="text-[10px] text-amber-400">
                {resourceLabel} is capping your attack speed — buy Recovery
              </span>
            )}
          </span>
        </button>
      </Section>

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

        <button
          type="button"
          aria-pressed={selecting}
          disabled={busy}
          onClick={() => (selecting ? leaveSelectMode() : setSelectRequested(true))}
          className={`rounded border px-2 py-1 ${
            selecting
              ? 'border-sky-500/60 bg-sky-500/15 text-sky-100'
              : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'
          }`}
        >
          Select
        </button>

        <span className="ml-auto font-mono text-neutral-500">
          {visible.length}/{hud.items.length}
        </span>
      </div>

      {/* The selection toolbar only exists in select mode, so the destructive
          button cannot be clicked by someone who never opted in. */}
      {selecting && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-xs">
          <span className="text-sky-100">
            {selection.length} selected
            {/* Says so when the selection reaches past what is on screen -
                otherwise the count looks wrong against the visible grid. */}
            {selection.length > visible.filter((i) => chosen.has(i.uid)).length &&
              ' (some hidden by the filter)'}
          </span>

          <button
            type="button"
            onClick={() =>
              setChosen((current) => {
                const next = new Set(current);
                for (const item of visible) {
                  if (!isEquipped(item.uid)) next.add(item.uid);
                }
                return next;
              })
            }
            className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
          >
            Select shown
          </button>

          <button
            type="button"
            disabled={chosen.size === 0}
            onClick={() => setChosen(new Set())}
            className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800 disabled:opacity-40"
          >
            Clear
          </button>

          <button
            type="button"
            disabled={busy || selection.length === 0}
            onClick={() => setConfirming(selection.map((item) => item.uid))}
            className="ml-auto rounded border border-red-900/70 px-2 py-1 text-red-400 hover:bg-red-950/40 disabled:opacity-40"
          >
            Dissemble {selection.length}
          </button>
        </div>
      )}

      {armed && (
        <p className="rounded border border-emerald-500/60 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
          {getCurrency(armed)?.name} armed — click an item to use it.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <ItemGrid
          items={visible}
          loadout={hud.loadout}
          weapon={hud.weapon}
          selected={selected}
          armed={armed !== null}
          selecting={selecting}
          chosen={chosen}
          onSelect={onTileClick}
          empty={hud.items.length === 0}
        />

        <ItemDetail
          item={selectedItem}
          // The pane compares a weapon's demand against what you can actually pay,
          // which is the only form in which a cost tells a player anything.
          resourceRegen={hud.stats.resourceRegen}
          equipped={selectedItem ? isEquipped(selectedItem.uid) : false}
          slotsFull={!hud.loadout.includes(null)}
          busy={busy}
          onEquip={() => selectedItem && equip(selectedItem.uid)}
          onCraft={() => selectedItem && setCrafting(selectedItem.uid)}
          onDissemble={() => selectedItem && requestDissemble(selectedItem)}
        />
      </div>

      {craftingItem && (
        <CraftModal
          item={craftingItem}
          purse={hud.currency}
          gold={hud.gold}
          equipped={hud.loadout.includes(craftingItem.uid)}
          busy={busy}
          dps={statsDps(hud.stats)}
          effectiveHp={effectiveHp(hud.stats)}
          // Neither of these closes the modal. Crafting is roll-look-roll, and
          // closing after each application made a player reopen it to continue
          // the loop they were already in.
          onApply={(currencyId) => onApplyCurrency(currencyId, craftingItem.uid)}
          onReroll={() => onReroll(craftingItem.uid)}
          onClose={() => setCrafting(null)}
        />
      )}

      {confirmingItems.length > 0 && (
        <ConfirmDissemble
          items={confirmingItems}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            onDissemble(confirmingItems.map((item) => item.uid));
            setConfirming(null);
            setSelected(null);
            // Selection cleared, mode kept. A player clearing out an inventory
            // is usually not done after one batch.
            setChosen(new Set());
          }}
        />
      )}
    </div>
  );
}

/**
 * Confirmation for dissembling.
 *
 * A single common never reaches here - confirming every common would train the
 * reflex that makes the dialog useless on the one item where it matters. A
 * single rare or unique does, and so does every sweep regardless of what is in
 * it, because destroying dozens of items at once is worth a beat even when each
 * one individually would not be.
 *
 * The breakdown by rarity is the point: "dissemble 47 items" tells a player
 * nothing about whether they are about to lose something they wanted.
 */
function ConfirmDissemble({
  items,
  onCancel,
  onConfirm,
}: {
  items: ItemInstance[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (items.length > 1) {
    const counts = RARITIES.map((rarity) => ({
      rarity,
      count: items.filter((item) => item.rarity === rarity).length,
    })).filter((entry) => entry.count > 0);

    const yields = new Map<string, number>();
    for (const item of items) {
      const id = DISSEMBLE_YIELD[item.rarity];
      yields.set(id, (yields.get(id) ?? 0) + 1);
    }

    return (
      <Backdrop onCancel={onCancel}>
        <p className="text-sm text-neutral-200">Dissemble {items.length} items?</p>

        <ul className="mt-2 space-y-0.5 text-xs">
          {counts.map((entry) => (
            <li key={entry.rarity} className={RARITY_STYLE[entry.rarity].text}>
              {entry.count} × {RARITY_STYLE[entry.rarity].label}
            </li>
          ))}
        </ul>

        <p className="mt-2 border-t border-neutral-800 pt-2 text-xs text-neutral-400">
          Yields{' '}
          {[...yields]
            .map(([id, count]) => `${count} × ${getCurrency(id)?.name ?? id}`)
            .join(', ')}
          .
        </p>

        <p className="mt-2 text-xs text-neutral-500">
          The items are destroyed. This cannot be undone.
        </p>

        <Actions onCancel={onCancel} onConfirm={onConfirm} label={`Dissemble ${items.length}`} />
      </Backdrop>
    );
  }

  const item = items[0];
  const style = RARITY_STYLE[item.rarity];
  return (
    <Backdrop onCancel={onCancel}>
      <p className="text-sm text-neutral-200">
        Dissemble <span className={style.text}>{itemName(item)}</span>?
      </p>
      <p className="mt-1 text-xs text-neutral-400">
        Yields 1 × {getCurrency(DISSEMBLE_YIELD[item.rarity])?.name}.
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        The item is destroyed. This cannot be undone.
      </p>
      <Actions onCancel={onCancel} onConfirm={onConfirm} label="Dissemble" />
    </Backdrop>
  );
}

function Backdrop({
  onCancel,
  children,
}: {
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-sm rounded-lg border border-red-900/70 bg-neutral-950 p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm dissemble"
      >
        {children}
      </div>
    </div>
  );
}

function Actions({
  onCancel,
  onConfirm,
  label,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  label: string;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        className="rounded border border-red-900/70 bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/70"
      >
        {label}
      </button>
    </div>
  );
}

function ItemGrid({
  items,
  loadout,
  weapon,
  selected,
  armed,
  selecting,
  chosen,
  onSelect,
  empty,
}: {
  items: ItemInstance[];
  loadout: (string | null)[];
  weapon: string | null;
  selected: string | null;
  armed: boolean;
  selecting: boolean;
  chosen: Set<string>;
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
        // The weapon slot counts too, or the grid would offer the weapon you are
        // holding as a dissemble candidate that the command then refuses.
        const isEquipped = loadout.includes(item.uid) || weapon === item.uid;
        // Equipped items cannot be dissembled, so in select mode they are not
        // candidates at all rather than candidates that would be refused.
        const selectable = selecting && !isEquipped;
        const isChosen = selecting && chosen.has(item.uid);

        return (
          <li key={item.uid}>
            <button
              type="button"
              onClick={() => onSelect(item.uid)}
              disabled={selecting && isEquipped}
              title={
                selecting && isEquipped
                  ? `${itemName(item)} — equipped, cannot be dissembled`
                  : `${itemName(item)} — iLvl ${item.itemLevel}`
              }
              aria-pressed={selecting ? isChosen : selected === item.uid}
              className={[
                'relative grid aspect-square w-full place-items-center rounded border bg-neutral-900/70',
                style.border,
                armed ? 'cursor-crosshair hover:bg-emerald-900/40' : '',
                selectable ? 'hover:bg-sky-900/40' : '',
                !armed && !selecting ? 'hover:bg-neutral-800' : '',
                selecting && isEquipped ? 'cursor-not-allowed opacity-30' : '',
                // A red ring rather than the neutral inspect ring: these are the
                // items about to be destroyed, and the colour should say so.
                isChosen ? 'ring-2 ring-red-400' : '',
                !selecting && selected === item.uid ? 'ring-2 ring-neutral-100' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <AtlasSprite id={itemSprite(item)} scale={2} />
              {/* A dot rather than a word: at this tile size there is no room
                  for a label, and the equipped row above is the full answer. */}
              {isEquipped && !selecting && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
              )}
              {isChosen && (
                <span className="absolute right-0.5 top-0.5 rounded bg-red-500 px-1 text-[9px] font-bold leading-tight text-white">
                  ✓
                </span>
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
  resourceRegen,
  equipped,
  slotsFull,
  busy,
  onEquip,
  onCraft,
  onDissemble,
}: {
  item: ItemInstance | undefined;
  resourceRegen: number;
  equipped: boolean;
  slotsFull: boolean;
  busy: boolean;
  onEquip: () => void;
  onCraft: () => void;
  onDissemble: () => void;
}) {
  if (!item) {
    return (
      <aside className="rounded border border-dashed border-neutral-800 p-3 text-xs text-neutral-500">
        Select an item to inspect it.
      </aside>
    );
  }

  const style = RARITY_STYLE[item.rarity];
  const skillId = baseSkillId(item.baseId);
  const skill = skillId ? getSkill(skillId) : undefined;

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

      {skill && <WeaponSkill skill={skill} itemLevel={item.itemLevel} regen={resourceRegen} />}

      <ItemMods item={item} />

      <div className="mt-auto flex flex-col gap-1">
        <button
          type="button"
          disabled={busy || (!equipped && slotsFull)}
          onClick={onEquip}
          className="rounded border border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
        >
          {equipped ? 'Unequip' : slotsFull ? 'Slots full' : 'Equip'}
        </button>

        {/* One button for every way of changing an item - gold and currency alike.
            Uniques open it too now: their effects are authored but their MAGNITUDES
            are rolled, so Angel Flame has something to reroll. The modal greys out
            everything else with the reason, which is a better answer than a missing
            button - a player who cannot open it never learns the flame applies. */}
        <button
          type="button"
          disabled={busy}
          onClick={onCraft}
          className="rounded border border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
        >
          Craft…
        </button>

        <button
          type="button"
          disabled={busy || equipped}
          onClick={onDissemble}
          title={equipped ? 'Unequip it first' : 'Destroys the item for a fragment'}
          className="rounded border border-red-900/70 px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-40"
        >
          Dissemble
        </button>
      </div>
    </aside>
  );
}

/**
 * What a weapon's skill costs to use, above its modifier list.
 *
 * A weapon is the only item whose worth is not in its affixes, and the cost line is
 * the part that cannot be inferred from anything else on screen: attack speed is
 * capped at regen/cost inside deriveStats, so a Staff swings slower than an Axe for
 * a reason that appears nowhere on either item. Quoting the cost alone would not fix
 * that - 3.0 is only meaningful next to the regen it demands and the regen you have.
 */
function WeaponSkill({
  skill,
  itemLevel,
  regen,
}: {
  skill: Skill;
  itemLevel: number;
  regen: number;
}) {
  const summary = skillSummary(skill, itemLevel);
  const sustained = Math.min(skill.baseSpeed, regen / skill.resourceCost);
  const short = sustained < skill.baseSpeed - 1e-9;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950/60 p-2 text-[11px]">
      <p className="text-neutral-200">
        {skill.name} <span className="text-neutral-500">· {skill.kind}</span>
      </p>
      {/* "base" is load-bearing: these are what the layers build on, not what the
          character sheet will read once gear and upgrades are applied. */}
      <p className="text-neutral-400">
        {summary.damage} base damage · {summary.speed} · {summary.area} · {summary.crit} crit
      </p>
      <p className={short ? 'text-amber-400' : 'text-neutral-400'}>
        {summary.resource} {summary.cost}/use · needs {summary.regenToSustain.toFixed(2)}/s regen
        {short && `, you regen ${regen.toFixed(2)}/s — ${sustained.toFixed(2)}/s`}
      </p>
    </div>
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
