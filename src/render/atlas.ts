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
  cell: number;
  get(id: SpriteId): Texture | null;
}

export async function loadAtlas(): Promise<Atlas> {
  const manifest = (await fetch(ATLAS_URL).then((r) => r.json())) as AtlasManifest;
  const sheet = await Assets.load<Texture>(manifest.image);

  // Without this, 16px art bilinear-filters into mush the moment it is scaled
  // up - which it always is.
  sheet.source.scaleMode = 'nearest';

  const textures = new Map<string, Texture>();
  for (const [id, frame] of Object.entries(manifest.frames)) {
    textures.set(
      id,
      new Texture({
        source: sheet.source,
        frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
      }),
    );
  }

  return {
    cell: manifest.cell,
    get: (id) => textures.get(id) ?? null,
  };
}
