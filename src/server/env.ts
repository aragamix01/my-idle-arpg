/**
 * Server configuration.
 *
 * Validated once, here, so a missing variable surfaces as a sentence rather
 * than as `undefined` reaching the Supabase client and failing somewhere less
 * obvious.
 */

import 'server-only';

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
  secretKey: string;
}

export function readSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !publishableKey || !secretKey) {
    const missing = [
      !url && 'NEXT_PUBLIC_SUPABASE_URL',
      !publishableKey && 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      !secretKey && 'SUPABASE_SECRET_KEY',
    ].filter(Boolean);

    // Partial configuration is always a mistake - usually a variable added to
    // one Vercel environment but not another.
    if (missing.length < 3) {
      throw new Error(`Supabase is partially configured. Missing: ${missing.join(', ')}`);
    }
    return null;
  }

  return { url, publishableKey, secretKey };
}

export const isProduction = process.env.NODE_ENV === 'production';

/**
 * Opt-in escape hatch for the file adapter in a production build.
 *
 * The e2e suite runs against `next build && next start` on purpose - dev-mode
 * leniency hides white-screen failures - so it needs persistence without a
 * Supabase project. An explicit variable keeps that a deliberate local choice
 * rather than a hole in the guard that a real deployment could fall through.
 */
export const allowFilePersistence = process.env.ALLOW_FILE_PERSISTENCE === '1';
