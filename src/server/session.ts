/**
 * Anonymous identity.
 *
 * A server-issued opaque id in an httpOnly cookie. The player never sees it and
 * client JavaScript cannot read it, which matters because in this slice the
 * cookie *is* the account.
 *
 * Supabase replaces this wholesale: signInAnonymously() creates a real
 * auth.users row, and the linking flow attaches a Discord or Google identity to
 * it later without the save moving. This exists so the slice is not blocked on
 * that, and the shape - "a request resolves to a player id" - is identical.
 */

import { cookies } from 'next/headers';
import { newSave, type SaveState } from '@/sim';
import { getSaveStore } from './store';

const COOKIE = 'player_id';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface Session {
  playerId: string;
  state: SaveState;
  /** True when this request created the account. */
  created: boolean;
}

/**
 * Resolve the current player, creating the account on first visit.
 *
 * Seeds come from crypto, not Math.random - a guessable seed would let a player
 * predict every artifact drop the account will ever roll.
 */
export async function getSession(): Promise<Session> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  const store = getSaveStore();

  if (existing) {
    const state = await store.load(existing);
    if (state) return { playerId: existing, state, created: false };
  }

  const playerId = crypto.randomUUID();
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const state = newSave(seed, Date.now());
  await store.save(playerId, state);

  jar.set(COOKIE, playerId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  });

  return { playerId, state, created: true };
}
