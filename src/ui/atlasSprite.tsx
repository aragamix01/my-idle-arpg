'use client';

/**
 * Atlas frames in the DOM.
 *
 * Pixi owns the canvas, but the character panel is ordinary markup. Rather than
 * stand up a second renderer for a handful of icons, each frame is drawn as a
 * CSS background: the whole sheet scaled up, offset so the wanted cell lands in
 * the box.
 *
 * The manifest is fetched once per page and shared, so twenty item icons
 * cost one request between them.
 */

import { useEffect, useState } from 'react';
import { ATLAS_URL, type AtlasManifest, type SpriteId } from '@/render/sprites';

let cached: AtlasManifest | null = null;
let inFlight: Promise<AtlasManifest> | null = null;

function loadManifest(): Promise<AtlasManifest> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= fetch(ATLAS_URL)
    .then((r) => r.json() as Promise<AtlasManifest>)
    .then((manifest) => {
      cached = manifest;
      return manifest;
    })
    .catch((error) => {
      // Let a later mount retry rather than caching the failure forever.
      inFlight = null;
      throw error;
    });
  return inFlight;
}

export function useAtlasManifest(): AtlasManifest | null {
  const [manifest, setManifest] = useState<AtlasManifest | null>(cached);

  useEffect(() => {
    if (manifest) return;
    let cancelled = false;
    loadManifest()
      .then((loaded) => {
        if (!cancelled) setManifest(loaded);
      })
      .catch(() => {
        // A missing atlas degrades to placeholder tiles, exactly as the Pixi
        // renderer does. It must not take the panel down.
      });
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  return manifest;
}

export function AtlasSprite({
  id,
  scale = 2,
  className = '',
}: {
  id: SpriteId | string;
  scale?: number;
  className?: string;
}) {
  const manifest = useAtlasManifest();
  const frame = manifest?.frames[id];
  const size = (manifest?.cell ?? 16) * scale;

  if (!manifest || !frame) {
    // Same tolerance as the renderer: a sprite with no art is a gap, not a
    // crash, so a partly-migrated pack still shows a usable panel.
    return (
      <div
        aria-hidden
        className={`shrink-0 rounded-sm bg-neutral-700 ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      aria-hidden
      className={`shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${manifest.image})`,
        backgroundPosition: `-${frame.x * scale}px -${frame.y * scale}px`,
        backgroundSize: `${manifest.imageWidth * scale}px ${manifest.imageHeight * scale}px`,
        // Without this the browser smooths 16px art into mush when scaled.
        imageRendering: 'pixelated',
      }}
    />
  );
}
