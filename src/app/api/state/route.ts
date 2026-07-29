/**
 * GET /api/state - load the authoritative save, creating the account if needed.
 */

import { NextResponse } from 'next/server';
import type { ApiError, GameStateResponse } from '@/contract';
import { getHudSnapshot } from '@/sim';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { state } = await getSession();
    const now = Date.now();

    return NextResponse.json<GameStateResponse>({
      state,
      hud: getHudSnapshot(state, now),
      events: [],
      serverNowMs: now,
    });
  } catch (error) {
    // Without this the route throws into Next's production handler, which
    // returns a 500 with an empty body - and every carefully worded setup
    // error (anonymous sign-in disabled, partial config) is lost. The message
    // is surfaced; the stack is not.
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[api/state]', error);
    return NextResponse.json<ApiError>({ error: message }, { status: 500 });
  }
}
