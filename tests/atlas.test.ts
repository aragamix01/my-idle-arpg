import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACTS } from '../src/sim';
import { SPRITE_IDS, type AtlasManifest } from '../src/render/sprites';
import { SOURCES } from '../scripts/atlas/sources';

/**
 * Tile indices in scripts/atlas/sources.ts were read off the sheet by eye. The
 * failure mode is not a crash - it is a sprite that silently points at an empty
 * cell, or at the wrong creature. Alpha coverage catches the first; only a human
 * catches the second.
 */

const ATLAS_DIR = resolve(process.cwd(), 'public/atlas');
const MANIFEST = resolve(ATLAS_DIR, 'atlas.json');

describe('atlas', () => {
  let manifest: AtlasManifest;
  let sheet: PNG;

  beforeAll(() => {
    if (!existsSync(MANIFEST)) throw new Error('run `pnpm atlas` first');
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as AtlasManifest;
    sheet = PNG.sync.read(readFileSync(resolve(process.cwd(), `public${manifest.image}`)));
  });

  it('resolves every declared sprite id', () => {
    const missing = SPRITE_IDS.filter((id) => !(id in manifest.frames));
    expect(missing).toEqual([]);
  });

  it('points every frame at art rather than empty space', () => {
    const blank: string[] = [];

    for (const [id, frame] of Object.entries(manifest.frames)) {
      let opaque = 0;
      for (let y = frame.y; y < frame.y + frame.h; y++) {
        for (let x = frame.x; x < frame.x + frame.w; x++) {
          if (sheet.data[(sheet.width * y + x) * 4 + 3] > 16) opaque++;
        }
      }
      // A tile with almost nothing in it means the index is wrong. Real sprites
      // in this pack cover roughly a third of their cell or more.
      const coverage = opaque / (frame.w * frame.h);
      if (coverage < 0.1) blank.push(`${id} (${(coverage * 100).toFixed(1)}% opaque)`);
    }

    expect(blank).toEqual([]);
  });

  it('records the sheet dimensions the DOM renderer needs', () => {
    // Pixi slices frames from a loaded texture and never needs these. CSS
    // background-size does, and a wrong value silently offsets every icon.
    expect(manifest.imageWidth).toBe(sheet.width);
    expect(manifest.imageHeight).toBe(sheet.height);
  });

  it('keeps every frame inside the sheet', () => {
    for (const [id, frame] of Object.entries(manifest.frames)) {
      expect(frame.x + frame.w, `${id} overflows horizontally`).toBeLessThanOrEqual(sheet.width);
      expect(frame.y + frame.h, `${id} overflows vertically`).toBeLessThanOrEqual(sheet.height);
    }
  });

  it('gives every artifact in the registry a sprite', () => {
    // Content and art drift apart quietly: an artifact added to the registry
    // without a sprite renders as a placeholder that nobody notices for weeks.
    const unmapped = ARTIFACTS.filter((artifact) => !(artifact.sprite in manifest.frames));
    expect(unmapped.map((a) => `${a.id} -> ${a.sprite}`)).toEqual([]);
  });

  it('maps no two sprite ids to the same tile', () => {
    // Not fatal, but almost always a copy-paste slip in sources.ts rather than
    // a deliberate alias.
    for (const source of SOURCES) {
      const used = new Map<number, string[]>();
      for (const [id, index] of Object.entries(source.tiles)) {
        if (index === undefined) continue;
        used.set(index, [...(used.get(index) ?? []), id]);
      }
      const duplicates = [...used.entries()].filter(([, ids]) => ids.length > 1);
      expect(duplicates.map(([index, ids]) => `tile ${index}: ${ids.join(', ')}`)).toEqual([]);
    }
  });
});
