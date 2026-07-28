/**
 * Supabase clients.
 *
 * Two of them, and the split is the trust boundary:
 *
 * - The *user* client carries the publishable key and the player's session. It
 *   is subject to RLS, which grants SELECT on their own save and nothing else.
 *   Used for auth only.
 * - The *admin* client carries the secret key and bypasses RLS. It is the only
 *   thing that can write a save, and it is only ever reached through
 *   applyCommand.
 *
 * If the admin client leaked to the browser, every player could rewrite every
 * save directly and the command layer would be decoration.
 */

import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { readSupabaseConfig, type SupabaseConfig } from './env';

/** Session-bound client. Reads and writes the auth cookies. */
export async function createUserClient(config: SupabaseConfig): Promise<SupabaseClient> {
  const jar = await cookies();

  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            jar.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. Harmless here: every path
          // that actually needs to write one is a route handler.
        }
      },
    },
  });
}

let admin: SupabaseClient | null = null;

/** RLS-bypassing client. Never import this from anything that runs in a browser. */
export function getAdminClient(config: SupabaseConfig): SupabaseClient {
  admin ??= createClient(config.url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}

export { readSupabaseConfig };
export type { SupabaseConfig };
