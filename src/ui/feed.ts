/**
 * The loot feed: what the last few minutes paid, newest first.
 *
 * Built from the events the SERVER sent back, so it lists what actually landed rather
 * than what the optimistic prediction expected. Kept in the browser between visits -
 * it is a convenience for reading back a session, not a record anything depends on,
 * so it is per device and allowed to vanish (a private window, cleared site data).
 */

import { getCurrency, itemSprite, type SaveState, type SimEvent } from '@/sim';

export type FeedTone = 'common' | 'magic' | 'rare' | 'unique' | 'currency' | 'tablet' | 'clear' | 'fail';

export interface FeedEntry {
  id: string;
  tone: FeedTone;
  text: string;
  /** A second line - base, stage, count. */
  sub: string;
  sprite: string | null;
  at: number;
}

const KEY = 'arpg.feed.v1';
const LIMIT = 40;

export function loadFeed(): FeedEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FeedEntry[]).slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveFeed(feed: FeedEntry[]): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(feed));
  } catch {
    // Storage blocked or full. The feed is a convenience; losing it is fine.
  }
}

/**
 * Prepend whatever in `events` is worth listing.
 *
 * `state` is the save AFTER the command, which is what lets an itemDropped event be
 * drawn with its own icon - the event carries the uid, the save carries the item.
 */
export function feedFrom(events: SimEvent[], state: SaveState, previous: FeedEntry[]): FeedEntry[] {
  const now = Date.now();
  const fresh: FeedEntry[] = [];

  events.forEach((event, i) => {
    const id = `${now}-${i}`;
    switch (event.type) {
      case 'itemDropped': {
        const item = state.items.find((it) => it.uid === event.itemId);
        const rarity = (['common', 'magic', 'rare', 'unique'] as const).find((r) => r === event.rarity) ?? 'common';
        fresh.push({
          id,
          tone: rarity,
          text: event.name,
          sub: item ? `${rarity} · ilvl ${item.itemLevel}` : rarity,
          sprite: item ? itemSprite(item) : null,
          at: now,
        });
        break;
      }
      case 'currencyDropped':
        fresh.push({
          id,
          tone: 'currency',
          text: event.count > 1 ? `${event.name} x${event.count}` : event.name,
          sub: 'currency',
          sprite: getCurrency(event.currencyId)?.sprite ?? null,
          at: now,
        });
        break;
      case 'tabletFound':
        fresh.push({ id, tone: 'tablet', text: event.name, sub: `tablet · tier ${event.tier}`, sprite: null, at: now });
        break;
      case 'stageCleared':
        fresh.push({ id, tone: 'clear', text: `Floor ${event.stage} cleared`, sub: `${event.seconds.toFixed(1)}s`, sprite: null, at: now });
        break;
      case 'stageFailed':
        fresh.push({ id, tone: 'fail', text: `Floor ${event.stage} failed`, sub: event.reason, sprite: null, at: now });
        break;
      case 'dungeonCleared':
        fresh.push({ id, tone: 'clear', text: `Dungeon ${event.stage} cleared`, sub: `${event.seconds.toFixed(1)}s`, sprite: null, at: now });
        break;
      case 'dungeonFailed':
        fresh.push({ id, tone: 'fail', text: `Dungeon ${event.stage} failed`, sub: `${event.reason} · key spent`, sprite: null, at: now });
        break;
      case 'abyssalCleared':
        fresh.push({ id, tone: 'clear', text: `Abyss T${event.tier} cleared`, sub: `${event.seconds.toFixed(1)}s`, sprite: null, at: now });
        break;
      case 'abyssalFailed':
        fresh.push({ id, tone: 'fail', text: `Abyss T${event.tier} failed`, sub: `${event.reason} · tablet spent`, sprite: null, at: now });
        break;
      case 'inventoryFull':
        fresh.push({ id, tone: 'fail', text: 'Inventory full', sub: `lost ${event.lost}`, sprite: null, at: now });
        break;
      default:
        break;
    }
  });

  if (fresh.length === 0) return previous;
  // Reversed so one command's lines read newest-first like the rest of the feed.
  return [...fresh.reverse(), ...previous].slice(0, LIMIT);
}
