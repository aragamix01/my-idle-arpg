'use client';

/**
 * Atlas loading.
 *
 * Resolves logical sprite IDs to Pixi textures. An ID with no frame returns
 * null rather than throwing, so the renderer can fall back to a placeholder and
 * a half-migrated art pack still runs.
 */

import { Assets, Rectangle, Texture } from 'pixi.js';
import { ATLAS_URL, type AtlasManifest, type SpriteId } from './sprites';

export interface Atlas {
  get(id: SpriteId): Texture | null;
}

export async function loadAtlas(): Promise<Atlas> {
  const manifest = (await fetch(ATLAS_URL).then((r) => r.json())) as AtlasManifest;

  // Loaded in parallel and indexed by position, so a frame's `sheet` is a lookup
  // rather than a search. One request per pack, not per sprite.
  const sheets = await Promise.all(
    manifest.sheets.map((sheet) => Assets.load<Texture>(sheet.image)),
  );

  // Without this, 16px art bilinear-filters into mush the moment it is scaled
  // up - which it always is.
  for (const sheet of sheets) sheet.source.scaleMode = 'nearest';

  const textures = new Map<string, Texture>();
  for (const [id, frame] of Object.entries(manifest.frames)) {
    const sheet = sheets[frame.sheet];
    // A frame naming a sheet that is not there is a broken build, not a broken
    // game: skip it and let the renderer draw its placeholder.
    if (!sheet) continue;
    textures.set(
      id,
      new Texture({
        source: sheet.source,
        frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
      }),
    );
  }

  return { get: (id) => textures.get(id) ?? null };
}
