'use client';

/**
 * The panels around the fight: who you are on the left, what you found on the right.
 *
 * Everything here is a READ of the snapshot. Changing anything - equipping, crafting,
 * descending - happens on its own screen, and these panels are the door to it. That keeps
 * the Combat screen safe to leave running: nothing on it destroys or spends by accident.
 */

import {
  ACCESSORY_SLOT_KINDS,
  baseSkillId,
  CURRENCIES,
  effectiveHp,
  formatBig,
  getSkill,
  itemName,
  itemSprite,
  statsDps,
  statsFromWire,
  UNARMED,
  type HudSnapshot,
  type ItemInstance,
} from '@/sim';
import { AtlasSprite } from './atlasSprite';
import type { FeedEntry, FeedTone } from './feed';
import { elementName, ELEMENT_STYLE, RARITY_STYLE, statEntries } from './format';

/** The four gear positions, the weapon and the three accessories, as one row of tiles. */
export function EquipmentTiles({
  hud,
  onPick,
  size = 'md',
}: {
  hud: HudSnapshot;
  onPick: () => void;
  size?: 'md' | 'lg';
}) {
  const byUid = new Map(hud.items.map((item) => [item.uid, item]));
  const weapon = hud.weapon ? byUid.get(hud.weapon) : undefined;
  const gear = hud.loadout.slice(0, hud.equipSlots).map((uid) => (uid ? byUid.get(uid) : undefined));
  const accessories = hud.accessories.map((uid) => (uid ? byUid.get(uid) : undefined));

  const tiles: { key: string; label: string; item: ItemInstance | undefined }[] = [
    { key: 'weapon', label: 'Weapon', item: weapon },
    ...gear.map((item, i) => ({ key: `gear-${i}`, label: `Gear ${i + 1}`, item })),
    ...accessories.map((item, i) => ({
      key: `acc-${i}`,
      label: ACCESSORY_SLOT_KINDS[i] === 'amulet' ? 'Amulet' : 'Ring',
      item,
    })),
  ];

  const box = size === 'lg' ? 'h-16 w-16' : 'h-14 w-14';
  return (
    <ul className="grid grid-cols-4 gap-2" aria-label="Equipped">
      {tiles.map((tile) => (
        <li key={tile.key} className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={onPick}
            title={tile.item ? `${tile.label}: ${itemName(tile.item)}` : `${tile.label}: empty`}
            aria-label={tile.item ? `${tile.label}: ${itemName(tile.item)}` : `${tile.label}: empty`}
            className={`px-slot grid ${box} place-items-center ${
              tile.item ? RARITY_STYLE[tile.item.rarity].border : ''
            } hover:bg-neutral-900`}
          >
            {tile.item ? (
              <AtlasSprite id={itemSprite(tile.item)} scale={2} />
            ) : (
              <span className="px-label text-[8px] text-neutral-700">empty</span>
            )}
          </button>
          <span className="px-label text-[8px]">{tile.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The left column on desktop: portrait, equipment, the stats that decide a run. */
export function CharacterSummary({
  hud,
  onOpenBag,
  onOpenCharacter,
}: {
  hud: HudSnapshot;
  onOpenBag: () => void;
  onOpenCharacter: () => void;
}) {
  const stats = statsFromWire(hud.stats);
  const weapon = hud.weapon ? hud.items.find((item) => item.uid === hud.weapon) : undefined;
  const skill = getSkill((weapon && baseSkillId(weapon.baseId)) || UNARMED.id) ?? UNARMED;

  return (
    <aside className="px-frame flex min-h-0 flex-col" aria-label="Character summary">
      <div className="px-head">
        <span>Character</span>
        <span className="font-mono text-lg normal-case text-neutral-400">best {hud.bestStage}</span>
      </div>

      <div className="flex items-center gap-3 px-4 pb-2 pt-3">
        <div className="px-slot grid h-[72px] w-[72px] shrink-0 place-items-center shadow-[inset_0_0_0_2px_#4a3a26]">
          <AtlasSprite id="player.knight" scale={4} />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="font-label text-sm text-neutral-100">{skill.name}</span>
          <span className={`text-sm ${ELEMENT_STYLE[skill.element]}`}>
            {skill.kind} · {elementName(skill.element)}
          </span>
          <span className="text-xs text-neutral-500">
            {weapon ? itemName(weapon) : 'Unarmed - find a weapon'}
          </span>
        </div>
      </div>

      <div className="px-4 pb-3">
        <EquipmentTiles hud={hud} onPick={onOpenBag} />
      </div>

      <div className="mx-4 border-t-2 border-neutral-800" />

      <dl className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-4 py-3 scrollbar-none">
        <SummaryRow label="DPS (single)" value={formatBig(statsDps(stats))} tone="text-gold-bright" />
        <SummaryRow label="Effective HP" value={formatBig(effectiveHp(stats))} tone="text-red-300" />
        {statEntries(stats).map((entry) => (
          <SummaryRow key={entry.key} label={entry.label} value={entry.value} />
        ))}
      </dl>

      <div className="px-4 pb-4">
        <button type="button" onClick={onOpenCharacter} className="px-btn w-full">
          Full stat sheet
        </button>
      </div>
    </aside>
  );
}

function SummaryRow({ label, value, tone = 'text-neutral-100' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-neutral-400">{label}</dt>
      <dd className={`font-mono text-lg ${tone}`}>{value}</dd>
    </div>
  );
}

const TONE: Record<FeedTone, string> = {
  common: 'text-neutral-200',
  magic: 'text-sky-300',
  rare: 'text-yellow-300',
  unique: 'text-orange-400',
  currency: 'text-gold',
  tablet: 'text-void-bright',
  clear: 'text-emerald-300',
  fail: 'text-red-400',
};

/** Literal class names, so Tailwind's scanner finds them - a derived 'bg-' string it cannot. */
const DOT: Record<FeedTone, string> = {
  common: 'bg-neutral-200',
  magic: 'bg-sky-300',
  rare: 'bg-yellow-300',
  unique: 'bg-orange-400',
  currency: 'bg-gold',
  tablet: 'bg-void-bright',
  clear: 'bg-emerald-300',
  fail: 'bg-red-400',
};

/** Newest first. The result line of each attempt sits above what it paid. */
export function LootFeed({ feed, limit }: { feed: FeedEntry[]; limit?: number }) {
  const shown = limit ? feed.slice(0, limit) : feed;
  if (shown.length === 0) {
    return <p className="px-1 py-3 text-sm text-neutral-500">Nothing yet. Clear a floor and the loot lands here.</p>;
  }
  return (
    <ul className="flex flex-col" aria-label="Loot feed">
      {shown.map((entry) => (
        <li key={entry.id} className="flex items-center gap-2.5 border-b-2 border-neutral-900 py-1.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center">
            {entry.sprite ? (
              <AtlasSprite id={entry.sprite} scale={2} />
            ) : (
              <span className={`h-2.5 w-2.5 ${DOT[entry.tone]} shadow-[2px_2px_0_#030202]`} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className={`truncate text-sm ${TONE[entry.tone]}`}>{entry.text}</span>
            <span className="text-xs text-neutral-600">{entry.sub}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The six basic currencies at a glance; the stash itself is the Craft screen. */
export function CurrencyMini({ purse, onOpen }: { purse: HudSnapshot['currency']; onOpen: () => void }) {
  const basics = CURRENCIES.filter((currency) => currency.tier === 'basic');
  return (
    <section className="px-frame flex flex-col" aria-label="Currency summary">
      <div className="px-head">
        <span>Currency</span>
        <button type="button" onClick={onOpen} className="font-label text-[10px] text-gold hover:text-gold-bright">
          Open stash
        </button>
      </div>
      <ul className="grid grid-cols-3 gap-2 p-3">
        {basics.map((currency) => (
          <li
            key={currency.id}
            title={currency.name}
            className="px-slot flex items-center gap-1.5 px-1.5 py-1"
          >
            <AtlasSprite id={currency.sprite} scale={1} />
            <span className="font-mono text-lg text-neutral-100">{purse[currency.id] ?? 0}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The deepest tablet on the shelf, and the door to the Abyss screen. */
export function AbyssCard({ hud, busy, onOpen }: { hud: HudSnapshot; busy: boolean; onOpen: () => void }) {
  const top = hud.tablets[0];
  const run = top ? hud.tabletRuns[top.uid] : undefined;

  return (
    <section className="px-frame-void flex flex-col gap-2 p-4" aria-label="Abyss summary">
      <span className="font-label text-sm text-void-bright">The Abyss</span>
      {!hud.abyss.unlocked ? (
        <p className="text-sm text-neutral-400">Opens at floor {hud.abyss.unlockStage}.</p>
      ) : top && run ? (
        <div className="flex flex-col text-sm">
          <span className={RARITY_STYLE[top.rarity].text}>{itemName(top)}</span>
          <span className="text-neutral-400">
            Tier {run.tier} · {run.waves} waves · resists {elementName(run.resists)}
          </span>
          <span className="text-xs text-neutral-500">
            {hud.tablets.length} tablet{hud.tablets.length === 1 ? '' : 's'} on the shelf
          </span>
        </div>
      ) : (
        <p className="text-sm text-neutral-400">No tablets. They drop past floor {hud.abyss.unlockStage}.</p>
      )}
      <button type="button" disabled={busy} onClick={onOpen} className="px-btn px-btn-void">
        Open the Abyss
      </button>
    </section>
  );
}

/**
 * A pixel orb, Diablo-style: a circle built from stepped rows, filled from the bottom.
 *
 * Rows rather than an SVG circle, because a vector circle scaled up is smooth and every
 * other edge on screen is a staircase.
 */
export function Orb({
  fraction,
  label,
  sub,
  tone,
  size = 84,
}: {
  fraction: number;
  label: string;
  sub?: string;
  tone: 'life' | 'shield';
  size?: number;
}) {
  const rows = 16;
  const radius = rows / 2;
  const cell = Math.floor(size / (rows + 2));
  const filled = Math.round(rows * Math.max(0, Math.min(1, fraction)));
  const colours =
    tone === 'life'
      ? { lo: '#a81e1a', hi: '#e04a3a', empty: '#1a0a09' }
      : { lo: '#3a4ab0', hi: '#6f8cff', empty: '#0b0c1a' };

  return (
    <div
      className="relative flex shrink-0 flex-col items-center justify-center"
      style={{ width: size, height: size }}
      role="meter"
      aria-label={tone === 'life' ? 'Life' : 'Energy shield'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuetext={label}
    >
      {Array.from({ length: rows }, (_, i) => {
        const y = i + 0.5 - radius;
        let cells = Math.round(Math.sqrt(radius * radius - y * y) * 2);
        if (cells % 2) cells += 1;
        const isFilled = i >= rows - filled;
        return (
          <div
            key={i}
            style={{
              height: cell,
              width: cells * cell,
              background: isFilled ? (i === rows - filled ? colours.hi : colours.lo) : colours.empty,
              boxShadow: `-${cell}px 0 0 #030202, ${cell}px 0 0 #030202`,
            }}
          />
        );
      })}
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-mono text-lg text-white px-shadow">{label}</span>
        {sub && <span className="font-mono text-xs text-neutral-200 px-shadow">{sub}</span>}
      </span>
    </div>
  );
}
