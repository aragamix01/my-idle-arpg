/**
 * GET /api/health - setup diagnosis.
 *
 * Exists because a misconfigured deployment fails as one opaque 500, and the
 * three things that can be wrong (env vars, anonymous sign-in, the players
 * table) are indistinguishable from the outside. This probes each separately.
 *
 * Reports whether variables are *present*, never their values. Supabase error
 * strings are passed through, which can name a table or column - acceptable
 * against a schema that is public in this repo anyway, and worth deleting once
 * the deployment is healthy.
 */

import { NextResponse } from 'next/server';
import { readSupabaseConfig } from '@/server/env';
import { getSaveStore } from '@/server/store';
import { createUserClient, getAdminClient } from '@/server/supabase';

export const dynamic = 'force-dynamic';

type Check = { ok: true } | { ok: false; error: string };

const failed = (error: unknown): Check => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

export async function GET() {
  const checks: Record<string, Check | string | boolean> = {};

  checks.hasUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  checks.hasPublishableKey = Boolean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  checks.hasSecretKey = Boolean(process.env.SUPABASE_SECRET_KEY);

  let config: ReturnType<typeof readSupabaseConfig> = null;
  try {
    config = readSupabaseConfig();
    checks.config = config ? { ok: true } : failed('no Supabase variables set');
  } catch (error) {
    checks.config = failed(error);
  }

  if (!config) return NextResponse.json(checks, { status: 500 });

  // Which key type is in use, without revealing either. `sb_secret_` in the
  // publishable slot would be a catastrophic copy-paste and is worth catching.
  checks.keyStyle = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_')
    ? 'modern'
    : 'legacy-jwt';
  checks.secretKeyInPublicSlot =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_secret_') ?? false;

  // Does the players table exist and is it reachable with the secret key?
  try {
    const { error } = await getAdminClient(config).from('players').select('id').limit(1);
    checks.playersTable = error ? failed(error.message) : { ok: true };
  } catch (error) {
    checks.playersTable = failed(error);
  }

  // The check most likely to fail: anonymous sign-ins are off by default.
  try {
    const supabase = await createUserClient(config);
    const { error } = await supabase.auth.signInAnonymously();
    checks.anonymousSignIn = error
      ? failed(`${error.message} - enable Authentication > Sign In / Providers > Allow anonymous sign-ins`)
      : { ok: true };
  } catch (error) {
    checks.anonymousSignIn = failed(error);
  }

  try {
    getSaveStore();
    checks.saveStore = { ok: true };
  } catch (error) {
    checks.saveStore = failed(error);
  }

  const healthy = Object.values(checks).every((c) => typeof c !== 'object' || c.ok);
  return NextResponse.json(checks, { status: healthy ? 200 : 500 });
}
