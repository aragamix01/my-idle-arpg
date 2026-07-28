/**
 * Save persistence.
 *
 * The interface is the point. The file adapter carried the vertical slice
 * before a Supabase project existed; the Supabase adapter slots in behind the
 * same two methods without a line of game code moving.
 *
 * Server-only. Never import this from a client component.
 */

import 'server-only';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SaveState } from '@/sim';
import { allowFilePersistence, isProduction, readSupabaseConfig, type SupabaseConfig } from './env';
import { getAdminClient } from './supabase';

export interface SaveStore {
  load(playerId: string): Promise<SaveState | null>;
  save(playerId: string, state: SaveState): Promise<void>;
}

/**
 * Development adapter. Writes one JSON file per player under .data/.
 *
 * Deliberately not production-shaped: no locking, no concurrency control, and
 * it cannot run on Vercel at all - the deployment filesystem is read-only apart
 * from /tmp, so the first save throws EROFS. That is why selectSaveStore()
 * refuses to fall back to this in production rather than letting a deploy come
 * up looking healthy and losing every save.
 */
class FileSaveStore implements SaveStore {
  private readonly root = resolve(process.cwd(), '.data', 'saves');

  private path(playerId: string): string {
    // Player ids are server-issued UUIDs, but this is the boundary between a
    // request value and the filesystem, so it does not get to be trusted.
    if (!/^[0-9a-f-]{36}$/i.test(playerId)) throw new Error('invalid player id');
    return join(this.root, `${playerId}.json`);
  }

  async load(playerId: string): Promise<SaveState | null> {
    try {
      return JSON.parse(await readFile(this.path(playerId), 'utf8')) as SaveState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(playerId: string, state: SaveState): Promise<void> {
    const file = this.path(playerId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
  }
}

/**
 * Production adapter.
 *
 * Uses the secret key, which bypasses RLS. That is required, not convenient:
 * the policy in supabase/schema.sql gives players SELECT on their own row and
 * no write permission at all, precisely so a save can only change by going
 * through applyCommand in the command route.
 */
class SupabaseSaveStore implements SaveStore {
  constructor(private readonly config: SupabaseConfig) {}

  async load(playerId: string): Promise<SaveState | null> {
    const { data, error } = await getAdminClient(this.config)
      .from('players')
      .select('save')
      .eq('id', playerId)
      .maybeSingle();

    if (error) throw new Error(`load failed: ${error.message}`);
    return (data?.save as SaveState | undefined) ?? null;
  }

  async save(playerId: string, state: SaveState): Promise<void> {
    // The denormalised columns exist so offline progress and leaderboards do
    // not have to parse every blob. They are derived here, never sent by a
    // client.
    const { error } = await getAdminClient(this.config)
      .from('players')
      .upsert(
        {
          id: playerId,
          save: state,
          content_version: state.contentVersion,
          best_stage: state.bestStage,
          last_seen_at: new Date(state.lastSeenAt).toISOString(),
        },
        { onConflict: 'id' },
      );

    if (error) throw new Error(`save failed: ${error.message}`);
  }
}

let store: SaveStore | null = null;

export function getSaveStore(): SaveStore {
  if (store) return store;

  const config = readSupabaseConfig();
  if (config) {
    store = new SupabaseSaveStore(config);
    return store;
  }

  if (isProduction && !allowFilePersistence) {
    // Failing loudly beats a deployment that boots, serves a page, and drops
    // every player's progress on the next cold start.
    throw new Error(
      'No persistence configured. Set NEXT_PUBLIC_SUPABASE_URL, ' +
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY. ' +
        'To run a production build locally without Supabase, set ALLOW_FILE_PERSISTENCE=1.',
    );
  }

  store = new FileSaveStore();
  return store;
}

export function isSupabaseConfigured(): boolean {
  return readSupabaseConfig() !== null;
}
