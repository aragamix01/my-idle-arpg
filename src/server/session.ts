/**
 * Anonymous identity.
 *
 * Two paths behind one shape - "a request resolves to a player id":
 *
 * - With Supabase, signInAnonymously() creates a real auth.users row. Linking a
 *   Discord or Google identity later keeps that id, so the save comes along
 *   with it. That is the whole reason for choosing anonymous-first over a
 *   token-only scheme that cannot be upgraded.
 * - Without it, a server-issued UUID in an httpOnly cookie. Local development
 *   only; getSaveStore() refuses this path in production.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { migrateSave, newSave, type SaveState } from '@/sim';
import { readSupabaseConfig } from './env';
import { getSaveStore } from './store';
import { createUserClient } from './supabase';

const COOKIE = 'player_id';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface Session {
  playerId: string;
  state: SaveState;
  /** True when this request created the account. */
  created: boolean;
}

/**
 * Seeds come from crypto, not Math.random - a guessable seed would let a player
 * predict every artifact drop the account will ever roll.
 */
function freshSave(): SaveState {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  return newSave(seed, Date.now());
}

/**
 * Bring a loaded save up to the current content version.
 *
 * Written back immediately when anything changed, so a migration runs once
 * rather than on every request until the player happens to issue a command.
 */
async function applyMigration(playerId: string, loaded: SaveState): Promise<SaveState> {
  const { state, migrated } = migrateSave(loaded);
  if (migrated) await getSaveStore().save(playerId, state);
  return state;
}

export async function getSession(): Promise<Session> {
  const config = readSupabaseConfig();
  return config ? supabaseSession() : cookieSession();
}

async function supabaseSession(): Promise<Session> {
  const config = readSupabaseConfig()!;
  const supabase = await createUserClient(config);
  const store = getSaveStore();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const existing = await store.load(user.id);
    if (existing) {
      return { playerId: user.id, state: await applyMigration(user.id, existing), created: false };
    }

    // Authenticated but no row: the account exists and the save write failed,
    // or the row was deleted. Rebuilding beats a 500 the player cannot escape.
    const state = freshSave();
    await store.save(user.id, state);
    return { playerId: user.id, state, created: true };
  }

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) {
    // Almost always anonymous sign-ins being disabled in the dashboard, which
    // is invisible from the code and worth naming.
    throw new Error(
      `anonymous sign-in failed: ${error?.message ?? 'no user returned'}. ` +
        'Check Authentication > Sign In / Providers > Allow anonymous sign-ins.',
    );
  }

  const state = freshSave();
  await store.save(data.user.id, state);
  return { playerId: data.user.id, state, created: true };
}

async function cookieSession(): Promise<Session> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  const store = getSaveStore();

  if (existing) {
    const state = await store.load(existing);
    if (state) {
      return { playerId: existing, state: await applyMigration(existing, state), created: false };
    }
  }

  const playerId = crypto.randomUUID();
  const state = freshSave();
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
