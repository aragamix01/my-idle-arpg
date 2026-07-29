'use client';

/**
 * Character sheet and artifact inventory.
 *
 * The inventory is the first UI that can equip anything. Until now artifacts
 * dropped, persisted, and did nothing - the equipArtifact command existed and
 * had no caller, which left the whole effects-as-data content layer inert.
 */

import { useEffect, useState } from 'react';
import {
  ARTIFACT_SLOTS,
  effectiveHp,
  enemyCount,
  itemEffects,
  itemName,
  itemSprite,
  killsPerSecond,
  rerollCost,
  statsDps,
  critFactor,
  type HudSnapshot,
  type ItemInstance,
  type SaveState,
} from '@/sim';
import { AtlasSprite } from './atlasSprite';
import {
  compact,
  describeArtifactEffect,
  describeRolledAffix,
  RARITY_STYLE,
  statEntries,
} from './format';

type Tab = 'character' | 'inventory';

interface Props {
  state: SaveState;
  hud: HudSnapshot;
  busy: boolean;
  onEquip: (slot: number, artifactId: string | null) => void;
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
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl"
        // Clicks inside must not reach the backdrop's close handler.
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Character"
      >
        <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
          <TabButton active={tab === 'character'} onClick={() => setTab('character')}>
            Character
          </TabButton>
          <TabButton active={tab === 'inventory'} onClick={() => setTab('inventory')}>
            Inventory ({hud.artifactsOwned.length}/{hud.inventoryCap})
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

        <div className="p-4">
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
  onEquip: (slot: number, artifactId: string | null) => void;
  onReroll: (uid: string) => void;
  onDiscard: (uid: string) => void;
}) {
  const equip = (uid: string) => {
    const free = hud.loadout.indexOf(null);
    // Every slot taken is a choice to make, not an error to swallow - the
    // player unequips something first.
    if (free === -1) return;
    onEquip(free, uid);
  };

  const slotsFull = !hud.loadout.includes(null);
  const byUid = new Map(hud.artifactsOwned.map((item) => [item.uid, item]));

  return (
    <div className="flex flex-col gap-5">
      <Section title={`Equipped (${hud.loadout.filter(Boolean).length}/${ARTIFACT_SLOTS})`}>
        <div className="grid grid-cols-4 gap-2">
          {hud.loadout.map((uid, slot) => {
            const item = uid ? byUid.get(uid) : undefined;
            return (
              <button
                key={slot}
                type="button"
                disabled={busy || !item}
                onClick={() => item && onEquip(slot, null)}
                title={item ? `Unequip ${itemName(item)}` : 'Empty slot'}
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

      <Section title={`Collection (${hud.artifactsOwned.length}/${hud.inventoryCap})`}>
        {hud.artifactsOwned.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No items yet — every stage clear drops one. Clear stage 1 to find your first.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {/* Newest first: the item you just found is the one you want to look at. */}
            {[...hud.artifactsOwned].reverse().map((item) => (
              <ItemRow
                key={item.uid}
                item={item}
                equipped={hud.loadout.includes(item.uid)}
                gold={hud.gold}
                busy={busy}
                slotsFull={slotsFull}
                onEquip={() =>
                  hud.loadout.includes(item.uid)
                    ? onEquip(hud.loadout.indexOf(item.uid), null)
                    : equip(item.uid)
                }
                onReroll={() => onReroll(item.uid)}
                onDiscard={() => onDiscard(item.uid)}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ItemRow({
  item,
  equipped,
  gold,
  busy,
  slotsFull,
  onEquip,
  onReroll,
  onDiscard,
}: {
  item: ItemInstance;
  equipped: boolean;
  gold: number;
  busy: boolean;
  slotsFull: boolean;
  onEquip: () => void;
  onReroll: () => void;
  onDiscard: () => void;
}) {
  const style = RARITY_STYLE[item.rarity];
  const isUnique = item.rarity === 'unique';
  const cost = isUnique ? Infinity : rerollCost(item.rarity, item.itemLevel, item.rerolls);

  return (
    <li className={`flex items-start gap-3 rounded border ${style.border} bg-neutral-900/70 p-2.5`}>
      <AtlasSprite id={itemSprite(item)} scale={2} className="mt-0.5" />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={`text-sm font-medium ${style.text}`}>{itemName(item)}</span>
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">
            {style.label} · iLvl {item.itemLevel}
            {item.rerolls > 0 ? ` · ${item.rerolls} rerolls` : ''}
          </span>
        </div>

        <ul className="mt-0.5 text-[11px] text-neutral-400">
          {isUnique
            ? itemEffects(item).map((effect, i) => <li key={i}>{describeArtifactEffect(effect)}</li>)
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
      </div>

      <div className="flex shrink-0 flex-col gap-1">
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
            title="Rerolls every modifier. There is no way to keep one."
            className="rounded border border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
          >
            Reroll {compact(cost)}g
          </button>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={onDiscard}
          className="rounded border border-red-900/70 px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-40"
        >
          Discard
        </button>
      </div>
    </li>
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
