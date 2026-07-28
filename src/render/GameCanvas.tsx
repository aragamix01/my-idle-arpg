'use client';

/**
 * Pixi renderer.
 *
 * Reads StageVisual's entity arrays directly inside the ticker. No React state,
 * no store subscription, no re-render per frame - the only React involvement is
 * mounting the canvas once and pushing new options in when the sim's numbers
 * change.
 */

import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Text } from 'pixi.js';
import { StageVisual } from './cosmetic';

interface Props {
  killsPerSecond: number;
  hitSize: number;
}

const FLOATER_POOL = 40;

export function GameCanvas({ killsPerSecond, hitSize }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const visualRef = useRef<StageVisual | null>(null);

  // Latest sim numbers, read by the ticker without re-running the mount effect.
  // Written in an effect rather than during render: React may render a
  // component without committing it, and the ticker would then be drawing from
  // numbers that were never real.
  const optionsRef = useRef({ killsPerSecond, hitSize });
  useEffect(() => {
    optionsRef.current = { killsPerSecond, hitSize };
  }, [killsPerSecond, hitSize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let app: Application | null = null;

    (async () => {
      const instance = new Application();
      await instance.init({
        background: '#22331f',
        resizeTo: host,
        antialias: true,
        // Capped: this is programmer art, not a reason to melt a laptop.
        resolution: Math.min(globalThis.devicePixelRatio ?? 1, 2),
        autoDensity: true,
      });

      // StrictMode mounts effects twice in development. Without this the second
      // mount adopts a canvas the first mount is about to destroy.
      if (disposed) {
        instance.destroy(true, { children: true });
        return;
      }
      app = instance;
      host.appendChild(instance.canvas);

      const width = instance.screen.width;
      const height = instance.screen.height;
      const visual = new StageVisual({ ...optionsRef.current, width, height });
      visualRef.current = visual;

      // A canvas offers nothing to assert against from the outside - no DOM, no
      // text, and toDataURL is empty without preserveDrawingBuffer. This handle
      // lets the smoke test check the loop is actually running rather than
      // settling for "an element exists".
      //
      // Exposed in production too, deliberately. The smoke test runs against the
      // production build - that is the whole point of it, since dev-mode
      // leniency hides white-screen failures - and gating this would leave the
      // strongest assertion untestable where it matters. The object holds
      // cosmetic circle positions and nothing else.
      (globalThis as unknown as { __stageVisual?: StageVisual }).__stageVisual = visual;

      const field = new Graphics();
      const floaterLayer = new Container();
      instance.stage.addChild(field, floaterLayer);

      const floaterPool: Text[] = [];
      for (let i = 0; i < FLOATER_POOL; i++) {
        const text = new Text({
          text: '',
          style: { fontFamily: 'monospace', fontSize: 13, fill: 0xff8d7a, fontWeight: 'bold' },
        });
        text.visible = false;
        floaterLayer.addChild(text);
        floaterPool.push(text);
      }

      instance.ticker.add((ticker) => {
        // Clamped: an alt-tabbed tab resumes with a huge delta and would
        // teleport every enemy onto the player.
        const dt = Math.min(ticker.deltaMS / 1000, 0.05);
        visual.resize(instance.screen.width, instance.screen.height);
        visual.setOptions({ ...optionsRef.current, width: instance.screen.width, height: instance.screen.height });
        visual.update(dt);

        field.clear();
        for (const enemy of visual.enemies) {
          if (!enemy.alive) continue;
          field.circle(enemy.x, enemy.y, enemy.r).fill(0x1b1b22);
        }
        field.circle(visual.player.x, visual.player.y, 9).fill(0x8fd694);
        field.circle(visual.player.x, visual.player.y, 13).stroke({ width: 2, color: 0xe8f5e9 });

        for (let i = 0; i < floaterPool.length; i++) {
          const slot = floaterPool[i];
          const floater = visual.floaters[i];
          if (!floater) {
            slot.visible = false;
            continue;
          }
          slot.visible = true;
          slot.text = floater.text;
          slot.x = floater.x;
          slot.y = floater.y;
          slot.alpha = Math.min(1, floater.life);
        }
      });
    })();

    return () => {
      disposed = true;
      visualRef.current = null;
      app?.destroy(true, { children: true });
    };
  }, []);

  return <div ref={hostRef} className="absolute inset-0" data-testid="game-canvas" />;
}
