/**
 * GET /api/state - load the authoritative save, creating the account if needed.
 */

import { NextResponse } from 'next/server';
import type { GameStateResponse } from '@/contract';
import { getHudSnapshot } from '@/sim';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { state } = await getSession();
  const now = Date.now();

  return NextResponse.json<GameStateResponse>({
    state,
    hud: getHudSnapshot(state, now),
    events: [],
    serverNowMs: now,
  });
}
