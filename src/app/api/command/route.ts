/**
 * POST /api/command - the trust boundary.
 *
 * The client applies commands optimistically for instant feedback, but this is
 * where they actually happen. Note what the request body does NOT contain: any
 * game state. The client sends intent; the server owns the numbers and answers
 * with them. A client claiming "I have 4e18 gold" has nowhere to say so.
 */

import { NextResponse } from 'next/server';
import type { ApiError, GameStateResponse } from '@/contract';
import { applyCommand, CommandSchema, getHudSnapshot } from '@/sim';
import { getSession } from '@/server/session';
import { getSaveStore } from '@/server/store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiError>({ error: 'malformed request body' }, { status: 400 });
  }

  const parsed = CommandSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiError>(
      { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      { status: 400 },
    );
  }

  const { playerId, state } = await getSession();
  // Server time, never the client's. Otherwise claimOffline is a free money
  // button for anyone willing to change their system clock.
  const now = Date.now();

  const result = applyCommand(state, parsed.data, now);
  if (!result.ok) {
    // A rejected command is not a server fault - it usually means the client's
    // optimistic copy drifted. Send the real state back so it can resync.
    return NextResponse.json<ApiError & GameStateResponse>(
      {
        error: result.error,
        state,
        hud: getHudSnapshot(state, now),
        events: [],
        serverNowMs: now,
      },
      { status: 409 },
    );
  }

  await getSaveStore().save(playerId, result.value.state);

  return NextResponse.json<GameStateResponse>({
    state: result.value.state,
    hud: getHudSnapshot(result.value.state, now),
    events: result.value.events,
    serverNowMs: now,
  });
}
