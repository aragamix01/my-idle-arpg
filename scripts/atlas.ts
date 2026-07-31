/**
 * Atlas build.
 *
 *   pnpm atlas
 *
 * Copies each source sheet into public/atlas/ and emits a manifest mapping
 * logical sprite IDs to frame rectangles. Runs as part of `pnpm dev` and
 * `pnpm build`, so the output is generated rather than committed.
 *
 * There is no bin-packer here on purpose. Every source so far is a uniform
 * grid, which makes frame rects arithmetic; a packer would be code earning its
 * keep only once a pack arrives that needs it.
 */

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { SPRITE_IDS, type AtlasFrame, type AtlasManifest } from '../src/render/sprites';
import { SOURCES } from './atlas/sources';

const ASSETS = resolve(process.cwd(), 'assets/source');
const OUT_DIR = resolve(process.cwd(), 'public/atlas');

/** PNG dimensions from the IHDR chunk. Cheaper and more honest than a decode. */
function pngSize(file: string): { width: number; height: number } {
  const buffer = readFileSync(file);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error(`${file} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function build() {
  await mkdir(OUT_DIR, { recursive: true });

  const frames: Record<string, AtlasFrame> = {};
  const licenses: string[] = [];
  let cell = 16;
  let image = '';
  let imageWidth = 0;
  let imageHeight = 0;

  for (const source of SOURCES) {
    const sheetPath = join(ASSETS, source.sheet);
    const { width, height } = pngSize(sheetPath);

    const stride = source.cell + source.spacing;
    const rows = Math.floor((height + source.spacing) / stride);
    const capacity = source.columns * rows;

    const outName = `${source.name}.png`;
    await copyFile(sheetPath, join(OUT_DIR, outName));
    image = `/atlas/${outName}`;
    cell = source.cell;
    imageWidth = width;
    imageHeight = height;
    licenses.push(`${source.name}: ${source.license}`);

    console.log(
      `${source.name}: ${basename(source.sheet)} ${width}x${height} -> ${source.columns}x${rows} cells (${capacity} tiles)`,
    );

    // Placeholders are built exactly like real bindings - they point at a tile that
    // exists and produce a frame like any other. The only difference is that they are
    // declared separately, so the duplicate-tile test can tell a deliberate borrow
    // from a copy-paste slip.
    for (const [id, index] of Object.entries({ ...source.tiles, ...source.placeholders })) {
      if (index === undefined) continue;
      if (index < 0 || index >= capacity) {
        throw new Error(`${id}: tile ${index} is outside the sheet (0..${capacity - 1})`);
      }
      const column = index % source.columns;
      const row = Math.floor(index / source.columns);
      frames[id] = {
        x: column * stride,
        y: row * stride,
        w: source.cell,
        h: source.cell,
      };
    }
  }

  const missing = SPRITE_IDS.filter((id) => !(id in frames));
  if (missing.length > 0) {
    // Not fatal. A missing ID renders as a placeholder, which is what makes
    // migrating a pack twenty sprites at a time possible.
    console.log(`\n${missing.length} sprite(s) without art, will fall back to placeholders:`);
    for (const id of missing) console.log(`  ${id}`);
  }

  const manifest: AtlasManifest = { image, cell, imageWidth, imageHeight, frames };
  await writeFile(join(OUT_DIR, 'atlas.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(OUT_DIR, 'LICENSE.txt'), `${licenses.join('\n')}\n`, 'utf8');

  console.log(`\n${Object.keys(frames).length}/${SPRITE_IDS.length} sprites mapped -> public/atlas/`);
}

build().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
