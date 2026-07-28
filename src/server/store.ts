/**
 * Save persistence.
 *
 * The interface is the point. Supabase needs a project, keys and a schema run
 * before it can store anything, and none of that is required to prove the
 * command round trip works. The file adapter runs today; the Supabase adapter
 * drops in behind the same three methods once .env.local exists.
 *
 * Server-only. Never import this from a client component.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SaveState } from '@/sim';

export interface SaveStore {
  load(playerId: string): Promise<SaveState | null>;
  save(playerId: string, state: SaveState): Promise<void>;
}

/**
 * Development adapter. Writes one JSON file per player under .data/.
 *
 * Deliberately not production-shaped: no locking, no concurrency control, and
 * it does not survive a Vercel deploy because the filesystem is ephemeral.
 * Those are exactly the problems the Supabase adapter exists to solve.
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

let store: SaveStore | null = null;

export function getSaveStore(): SaveStore {
  store ??= new FileSaveStore();
  return store;
}
