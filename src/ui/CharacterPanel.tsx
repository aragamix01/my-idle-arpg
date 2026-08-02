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
  damageShares,
  deriveStats,
  DISSEMBLE_YIELD,
  effectiveHp,
  elementalScale,
  ELEMENTS,
  enemyCount,
  equippedSkill,
  explainStats,
  formatBig,
  fromSave,
  getCurrency,
  itemName,
  itemPower,
  itemSprite,
  isWeaponBase,
  isResourceBound,
  baseSkillId,
  getSkill,
  previewEquip,
  skillLevel,
  stageResistance,
  stageResistances,
  UNARMED,
  killsPerSecond,
  statsDps,
  statsFromWire,
  critFactor,
  type CurrencyId,
  type HudSnapshot,
  type ItemInstance,
  type Rarity,
  type Big,
  type SaveState,
  type Skill,
  type StatBreakdown,
} from '@/sim';
import { AtlasSprite } from './atlasSprite';
import { CraftModal } from './CraftModal';
import { CurrencyStash } from './CurrencyStash';
import {
  breakdownLines,
  compact,
  ELEMENT_STYLE,
  elementName,
  RARITY_STYLE,
  resourceName,
  skillSummary,
  statEntries,
} from './format';
import { ItemMods } from './ItemMods';
import { TabletTab } from './TabletTab';

type Tab = 'character' | 'inventory' | 'tablets' | 'currency';
type SortKey = 'newest' | 'rarity' | 'itemLevel' | 'power';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'newest', label: 'Newest' },
  { key: 'rarity', label: 'Rarity' },
  { key: 'itemLevel', label: 'Item level' },
  { key: 'power', label: 'Power' },
];

/**
 * The crossed-swords mark that says "this is a weapon".
 *
 * An inline SVG rather than a glyph character. `⚔` renders as a colour emoji on most
 * platforms, which ignores the text colour and sits at a size the font decides - and it
 * is a different shape on every OS. This is the same eleven pixels everywhere.
 *
 * SHAPE, not colour. The element tint was the alternative and it says nothing in
 * greyscale or to a colourblind player; a mark you can see is worth more than one that
 * also tells you the element.
 */
function WeaponMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={`h-3 w-3 ${className}`} fill="none">
      <path
        d="M2.5 2.5 L8 8 M9.5 2.5 L4 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* The hilts. Without them two crossed lines are an X, which already means
          "unavailable" everywhere else in this panel. */}
      <path
        d="M7.4 9.2 L9.6 10.2 M4.6 9.2 L2.4 10.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

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
  /**
   * Which shelf arming a currency should send you back to.
   *
   * Two things now take currency, and "arm in Currency, spend in Inventory" stopped
   * being the whole story - a player crafting a run of tablets would be kicked to their
   * gear on every single application.
   *
   * Written where the tab CHANGES rather than derived in an effect: an effect that calls
   * setState cascades a second render for a value that was already known at the click.
   */
  const [lastShelf, setLastShelf] = useState<'inventory' | 'tablets'>('inventory');
  const openTab = useCallback((next: Tab) => {
    setTab(next);
    if (next === 'inventory' || next === 'tablets') setLastShelf(next);
  }, []);

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
          <TabButton active={tab === 'character'} onClick={() => openTab('character')}>
            Character
          </TabButton>
          <TabButton active={tab === 'inventory'} onClick={() => openTab('inventory')}>
            Inventory ({hud.items.length}/{hud.inventoryCap})
          </TabButton>
          {/* Its own tab rather than a filter on Inventory: a tablet is never equipped,
              never dissembled and never sorted by power, so it would spend its life
              being filtered out of a grid built for gear. */}
          <TabButton active={tab === 'tablets'} onClick={() => openTab('tablets')}>
            Tablets ({hud.tablets.length})
          </TabButton>
          <TabButton active={tab === 'currency'} onClick={() => openTab('currency')}>
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
              state={state}
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
          {tab === 'tablets' && (
            <TabletTab
              hud={hud}
              busy={busy}
              armed={armed}
              onApplyCurrency={(currencyId, uid) => {
                onApplyCurrency(currencyId, uid);
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
                // Back to whichever shelf the player was last on, so arming a currency
                // with the Tablets tab open does not silently move them to gear.
                setArmed(currencyId);
                if (currencyId) openTab(lastShelf);
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
  // Revived once. The snapshot arrives as JSON, where a Decimal is an object with no
  // prototype left - see WireStats in src/sim/hud.ts.
  const stats = statsFromWire(hud.stats);
  const stage = Math.max(1, hud.bestStage || 1);

  // Everything below is computed CLIENT-SIDE from the save the panel already holds.
  // None of it crosses the wire: a breakdown is only wanted while the sheet is open,
  // and shipping twelve extra objects in every snapshot to serve that would be waste.
  const ctx = { stage, isBoss: false, enemyHpFraction: 1 };
  const parts = explainStats(state, ctx);
  const shares = damageShares(state, ctx);
  const skill = equippedSkill(state);
  const resistance = stageResistance(stage);
  const elemental = elementalScale(shares, stats.penetration, stageResistances(stage));

  // Damage's base is the one number a player cannot trace to an item, because it comes
  // from the weapon's skill and its level rather than from a modifier line.
  const skillNote = `${skill.name}, skill level ${skillLevel(state, ctx)}`;

  // Derived figures, not stats. These are what actually decide a run: effective
  // HP is what damage is measured against, and wave DPS is why Area matters.
  const derived = [
    { label: 'Effective HP', value: formatBig(effectiveHp(stats)) },
    { label: 'DPS (single)', value: formatBig(statsDps(stats)) },
    {
      label: 'DPS (wave)',
      value: formatBig(statsDps(stats).mul(Math.min(stats.area, enemyCount(stage)))),
    },
    { label: 'Crit multiplier', value: `x${critFactor(stats).toFixed(3)}` },
    { label: 'Kills / sec', value: compact(killsPerSecond(state, stage)) },
    { label: 'Gold / sec', value: formatBig(fromSave(hud.goldPerSecond)) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Section title="Stats">
        {/* One column, not two. Each row can expand, and a two-column grid would
            push the expanded half sideways into its neighbour's column. A plain div
            rather than a dl: the rows are buttons now, and a dl whose children are
            not dt/dd pairs is a list that lies about its own structure. */}
        <div className="flex flex-col">
          {statEntries(stats).map((entry) => (
            <StatRow
              key={entry.key}
              label={entry.label}
              value={entry.value}
              parts={parts[entry.key]}
              lines={breakdownLines(entry.key, parts[entry.key])}
              detail={entry.key === 'damage' ? skillNote : undefined}
            />
          ))}
        </div>
        <p className="mt-2 text-[11px] text-neutral-500">
          Tap a stat to see what produced it.
        </p>
      </Section>

      <Section title="Elemental">
        <dl className="flex flex-col">
          {ELEMENTS.filter((element) => shares[element] !== 0).map((element) => (
            <Row
              key={element}
              label={elementName(element)}
              value={
                element === skill.element
                  ? shares[element].toFixed(2)
                  : `+${(shares[element] * 100).toFixed(1)}%`
              }
              valueClass={ELEMENT_STYLE[element]}
            />
          ))}
          {stats.penetration > 0 && (
            <Row label="Penetration" value={`${(stats.penetration * 100).toFixed(1)}%`} />
          )}
          <Row
            label={`vs stage ${stage}`}
            value={`x${elemental.toFixed(3)}`}
            note={`${(resistance * 100).toFixed(1)}% resistance`}
          />
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
  state,
  hud,
  busy,
  armed,
  onEquip,
  onEquipWeapon,
  onReroll,
  onDissemble,
  onApplyCurrency,
}: {
  /** The save itself, so the detail pane can price an item by simulating the swap. */
  state: SaveState;
  hud: HudSnapshot;
  busy: boolean;
  armed: CurrencyId | null;
  onEquip: (slot: number, itemId: string | null) => void;
  onEquipWeapon: (itemId: string | null) => void;
  onReroll: (uid: string) => void;
  onDissemble: (uids: string[]) => void;
  onApplyCurrency: (currencyId: CurrencyId, uid: string) => void;
}) {
  // Revived from the wire, same as the character tab - a Decimal does not survive
  // JSON with its prototype, and everything below does Big arithmetic on it.
  const stats = statsFromWire(hud.stats);
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
  const resourceBound = isResourceBound(stats, equippedSkill);

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
              {` · ${resourceLabel} ${equippedSkill.resourceCost.toFixed(1)}/use, regen ${stats.resourceRegen.toFixed(2)}/s`}
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

      <Section
        title={`Equipped (${hud.loadout.slice(0, hud.equipSlots).filter(Boolean).length}/${hud.equipSlots})`}
      >
        <div className="grid grid-cols-4 gap-2">
          {hud.loadout.map((uid, slot) => {
            const item = uid ? byUid.get(uid) : undefined;
            // Past the live count the slot is locked: whatever is in it is still owned
            // and still refuses to be dissembled, but contributes nothing. Rendered
            // rather than hidden, because a slot that silently disappears with an item
            // inside it is the worst possible reading of a slot-removing unique.
            const locked = slot >= hud.equipSlots;
            if (locked && !item) return null;

            return (
              <button
                key={slot}
                type="button"
                disabled={busy || !item}
                onClick={() => item && setSelected(item.uid)}
                title={
                  locked
                    ? `${item ? itemName(item) : 'Empty'} — slot locked, nothing here applies`
                    : item
                      ? itemName(item)
                      : 'Empty slot'
                }
                className={`flex flex-col items-center gap-1 rounded border p-2 text-center ${
                  locked
                    ? 'border-dashed border-amber-800/70 bg-neutral-900/40 opacity-60'
                    : item
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
                {locked && <span className="text-[10px] text-amber-500">locked</span>}
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
          resourceRegen={stats.resourceRegen}
          equipped={selectedItem ? isEquipped(selectedItem.uid) : false}
          slotsFull={!hud.loadout.includes(null)}
          busy={busy}
          state={state}
          // Priced at the deepest stage cleared, which is where the loadout is
          // actually used - pricing at stage 1 would flatten every elemental term.
          stage={Math.max(1, hud.bestStage || 1)}
          onEquip={() => selectedItem && equip(selectedItem.uid)}
          onCraft={() => selectedItem && setCrafting(selectedItem.uid)}
          onDissemble={() => selectedItem && requestDissemble(selectedItem)}
        />
      </div>

      {craftingItem && (
        <CraftModal
          item={craftingItem}
          purse={hud.currency}
          gold={fromSave(hud.gold)}
          equipped={hud.loadout.includes(craftingItem.uid)}
          busy={busy}
          dps={statsDps(stats)}
          effectiveHp={effectiveHp(stats)}
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
        const isWeapon = isWeaponBase(item.baseId);

        return (
          <li key={item.uid}>
            <button
              type="button"
              onClick={() => onSelect(item.uid)}
              disabled={selecting && isEquipped}
              title={
                selecting && isEquipped
                  ? `${itemName(item)} — equipped, cannot be dissembled`
                  : // The mark is unlabelled, so the word lives here. A player who
                    // has not learned the glyph yet still gets an answer on hover.
                    `${itemName(item)} — ${isWeapon ? 'Weapon, ' : ''}iLvl ${item.itemLevel}`
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
              {/* Bottom-LEFT, because the top-right corner is already spoken for
                  twice - the equipped dot and the select tick - and a third mark
                  there would collide exactly when both of the others matter. */}
              {isWeapon && (
                <WeaponMark className="absolute bottom-0.5 left-0.5 text-neutral-400" />
              )}
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
  state,
  stage,
  onEquip,
  onCraft,
  onDissemble,
}: {
  item: ItemInstance | undefined;
  resourceRegen: number;
  equipped: boolean;
  slotsFull: boolean;
  busy: boolean;
  /** The live save, so the pane can price this item by simulating the swap. */
  state: SaveState;
  stage: number;
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
          <p className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
            {/* The same mark the tile carries, so the two agree about what this is. */}
            {skill && <WeaponMark className="text-neutral-400" />}
            <span>
              {skill ? 'Weapon · ' : ''}
              {style.label} · iLvl {item.itemLevel}
              {item.rerolls > 0 ? ` · ${item.rerolls} rerolls` : ''}
            </span>
          </p>
        </div>
      </div>

      {skill && <WeaponSkill skill={skill} itemLevel={item.itemLevel} regen={resourceRegen} />}

      <ItemWorth item={item} state={state} stage={stage} equipped={equipped} />

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
        {skill.name} <span className="text-neutral-500">· {skill.kind} skill</span>{' '}
        {/* The element belongs beside the kind rather than in the damage line, because
            the two are the axes that describe the skill: kind decides what it costs to
            use, element decides what shrugs it off. Both carry a NOUN - "physical ·
            Physical" is technically complete and reads as a stutter, where "physical
            skill · Physical damage" says which axis each word is on. */}
        <span className={ELEMENT_STYLE[skill.element]}>· {elementName(skill.element)} damage</span>
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

/**
 * What this item is worth, as the two numbers that decide a run.
 *
 * Not a score. `itemPower` exists and would be one line, but its own doc says it is a
 * heuristic that is not shown to players - and it is the function that once rated a
 * `crit chance more 0` penalty as the biggest bonus in the game. This re-derives
 * through the real formula instead, so it cannot disagree with the fight.
 *
 * The question changes with what you are looking at. An unequipped item is asked what
 * it WOULD do; a worn one is asked what you would lose by taking it off - which is the
 * same computation with the two sides swapped, and the only way to price something
 * that is already contributing.
 */
function ItemWorth({
  item,
  state,
  stage,
  equipped,
}: {
  item: ItemInstance;
  state: SaveState;
  stage: number;
  equipped: boolean;
}) {
  const worth = useMemo(() => {
    const ctx = { stage, isBoss: false, enemyHpFraction: 1 };

    // Worn items are priced by REMOVAL, so "with" is the save as it stands.
    const without: SaveState = equipped
      ? {
          ...state,
          loadout: state.loadout.map((uid) => (uid === item.uid ? null : uid)),
          weapon: state.weapon === item.uid ? null : state.weapon,
        }
      : state;
    const with_ = equipped ? state : previewEquip(state, item, ctx);

    const before = deriveStats(without, ctx);
    const after = deriveStats(with_, ctx);

    // WAVE dps as well as single, and it is not padding. statsDps excludes area on
    // purpose - a boss is fought one at a time - so a wide skill scores below Unarmed
    // on it. A Maul really did read as -13% while being the better weapon, because the
    // three targets it hits are the entire reason to carry one.
    const wave = (s: ReturnType<typeof deriveStats>) =>
      statsDps(s).mul(Math.min(s.area, enemyCount(stage)));

    return {
      dps: { before: statsDps(before), after: statsDps(after) },
      wave: { before: wave(before), after: wave(after) },
      ehp: { before: effectiveHp(before), after: effectiveHp(after) },
    };
  }, [item, state, stage, equipped]);

  return (
    <dl className="flex flex-col gap-0.5 rounded border border-neutral-800 bg-neutral-950/60 p-2 text-[11px]">
      <p className="mb-0.5 text-[10px] uppercase tracking-wide text-neutral-500">
        {equipped ? 'Worth to you now' : 'If you equipped it'}
      </p>
      <WorthRow label="DPS (single)" before={worth.dps.before} after={worth.dps.after} />
      <WorthRow label="DPS (wave)" before={worth.wave.before} after={worth.wave.after} />
      <WorthRow label="Effective HP" before={worth.ehp.before} after={worth.ehp.after} />
    </dl>
  );
}

function WorthRow({ label, before, after }: { label: string; before: Big; after: Big }) {
  // As a RATIO, not a difference. These numbers reach 1e30, where a subtraction is
  // unreadable and "+2.4e28" says nothing about whether the swap is worth making.
  const ratio = before.toNumber() > 0 ? after.div(before).toNumber() : after.gt(0) ? Infinity : 1;
  const pct = (ratio - 1) * 100;
  const flat = Math.abs(pct) < 0.05;

  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="flex items-baseline gap-2 font-mono">
        <span className="text-neutral-300">{formatBig(after)}</span>
        <span
          className={`w-14 text-right ${
            flat ? 'text-neutral-600' : pct > 0 ? 'text-emerald-400' : 'text-red-400'
          }`}
        >
          {flat
            ? '—'
            : !Number.isFinite(pct)
              ? '+∞'
              : `${pct > 0 ? '+' : ''}${Math.abs(pct) < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`}
        </span>
      </dd>
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

function Row({
  label,
  value,
  note,
  valueClass = 'text-neutral-100',
}: {
  label: string;
  value: string;
  note?: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-neutral-900 py-0.5">
      <dt className="text-xs text-neutral-400">
        {label}
        {note && <span className="ml-1.5 text-[10px] text-neutral-600">{note}</span>}
      </dt>
      <dd className={`font-mono text-sm ${valueClass}`}>{value}</dd>
    </div>
  );
}

/**
 * A stat, and on demand what produced it.
 *
 * Collapsed by default. The sheet's job is still to answer "how much damage do I have"
 * in one glance, and twelve stats each showing four components would bury that under
 * fifty rows - most of them on a phone screen.
 *
 * A `<button>` rather than a clickable div: this is keyboard-reachable and announces
 * its expanded state without any of that being written by hand.
 */
function StatRow({
  label,
  value,
  parts,
  lines,
  detail,
}: {
  label: string;
  value: string;
  parts: StatBreakdown;
  lines: { label: string; value: string; note?: string }[];
  detail?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-neutral-900">
      {/* Plain spans, not dt/dd. A <button> may not contain them - a definition list
          takes dt and dd as its own children - and the invalid nesting cost the row its
          accessible name, which is how the e2e suite found it. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-1.5 py-0.5 text-left hover:bg-neutral-900/60"
      >
        <span className="w-2 shrink-0 font-mono text-[9px] text-neutral-600">
          {open ? '−' : '+'}
        </span>
        <span className="text-xs text-neutral-400">{label}</span>
        {/* The cap is flagged on the COLLAPSED row too. A number quietly lower than
            the gear implies is the one case where a player has to be told without
            having to go looking for it. */}
        {parts.cappedBy && <span className="text-[10px] text-amber-400">capped</span>}
        <span className="ml-auto font-mono text-sm text-neutral-100">{value}</span>
      </button>

      {open && (
        <dl className="mb-1 ml-3.5 flex flex-col gap-0.5 border-l border-neutral-800 pl-2.5 text-[11px]">
          {lines.map((line) => (
            <div key={line.label} className="flex items-baseline justify-between gap-3">
              <dt className={line.label === 'capped' ? 'text-amber-400' : 'text-neutral-500'}>
                {/* Own span, for the same reason the stat label above has one: a bare
                    text node beside a note makes the dt read "baseUnarmed, skill level
                    0", and nothing on the page has the layer's name as its own text. */}
                <span>{line.label}</span>
                {line.note && <span className="ml-1.5 text-neutral-600">{line.note}</span>}
                {line.label === 'base' && detail && (
                  <span className="ml-1.5 text-neutral-600">{detail}</span>
                )}
              </dt>
              <dd
                className={`font-mono ${
                  line.label === 'capped' ? 'text-amber-400/80' : 'text-neutral-300'
                }`}
              >
                {line.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
