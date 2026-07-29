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
import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import { StageVisual } from './cosmetic';
import { loadAtlas, type Atlas } from './atlas';

interface Props {
  killsPerSecond: number;
  hitSize: number;
  attacksPerSecond: number;
  stage: number;
}

const FLOATER_POOL = 40;
const MAX_SPRITES = 240;
/** 16px source art needs scaling up; this keeps it on whole pixels. */
const SPRITE_SCALE = 2;

export function GameCanvas({ killsPerSecond, hitSize, attacksPerSecond, stage }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Latest sim numbers, read by the ticker without re-running the mount effect.
  // Written in an effect rather than during render: React may render a
  // component without committing it, and the ticker would then be drawing from
  // numbers that were never real.
  const optionsRef = useRef({ killsPerSecond, hitSize, attacksPerSecond, stage });
  useEffect(() => {
    optionsRef.current = { killsPerSecond, hitSize, attacksPerSecond, stage };
  }, [killsPerSecond, hitSize, attacksPerSecond, stage]);

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
        antialias: false,
        resolution: Math.min(globalThis.devicePixelRatio ?? 1, 2),
        autoDensity: true,
      });

      // StrictMode mounts effects twice in development. Without this the second
      // mount adopts a canvas the first mount is about to destroy.
      if (disposed) {
        instance.destroy(true, { children: true });
        return;
      }

      // A missing or malformed atlas must not take the game down with it -
      // placeholders are a worse experience, not a broken one.
      let atlas: Atlas | null = null;
      try {
        atlas = await loadAtlas();
      } catch (error) {
        console.warn('atlas unavailable, falling back to placeholders', error);
      }
      if (disposed) {
        instance.destroy(true, { children: true });
        return;
      }

      app = instance;
      host.appendChild(instance.canvas);

      const visual = new StageVisual({
        ...optionsRef.current,
        width: instance.screen.width,
        height: instance.screen.height,
      });

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

      // Whether art is reaching the screen is invisible from the DOM: a canvas
      // full of fallback circles looks exactly like a canvas full of sprites.
      // These counters are what let the smoke test tell the two apart.
      const renderStats = { atlasLoaded: atlas !== null, sprites: 0, placeholders: 0 };
      (globalThis as unknown as { __renderStats?: typeof renderStats }).__renderStats = renderStats;

      const placeholders = new Graphics();
      const spriteLayer = new Container();
      const floaterLayer = new Container();
      instance.stage.addChild(placeholders, spriteLayer, floaterLayer);

      const spritePool: Sprite[] = [];
      for (let i = 0; i < MAX_SPRITES; i++) {
        const sprite = new Sprite();
        sprite.anchor.set(0.5);
        sprite.visible = false;
        spriteLayer.addChild(sprite);
        spritePool.push(sprite);
      }

      const playerSprite = new Sprite();
      playerSprite.anchor.set(0.5);
      playerSprite.visible = false;
      spriteLayer.addChild(playerSprite);

      // Drawn after the player so the blade passes in front of the body.
      const swordSprite = new Sprite();
      swordSprite.anchor.set(0.5);
      swordSprite.visible = false;
      spriteLayer.addChild(swordSprite);

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
        visual.setOptions({
          ...optionsRef.current,
          width: instance.screen.width,
          height: instance.screen.height,
        });
        visual.update(dt);

        placeholders.clear();
        let slot = 0;
        let placeholderCount = 0;

        for (const enemy of visual.enemies) {
          if (!enemy.alive) continue;
          const texture = atlas?.get(enemy.sprite) ?? null;

          if (texture && slot < spritePool.length) {
            const sprite = spritePool[slot++];
            sprite.visible = true;
            sprite.texture = texture;
            sprite.x = Math.round(enemy.x);
            sprite.y = Math.round(enemy.y);
            sprite.scale.set(enemy.facing * SPRITE_SCALE, SPRITE_SCALE);
          } else {
            // The fallback that makes partial art migrations survivable.
            placeholders.circle(enemy.x, enemy.y, enemy.r).fill(0x1b1b22);
            placeholderCount++;
          }
        }

        for (let i = slot; i < spritePool.length; i++) spritePool[i].visible = false;
        renderStats.sprites = slot;
        renderStats.placeholders = placeholderCount;

        const playerTexture = atlas?.get('player.knight') ?? null;
        if (playerTexture) {
          playerSprite.visible = true;
          playerSprite.texture = playerTexture;
          playerSprite.x = Math.round(visual.player.x);
          playerSprite.y = Math.round(visual.player.y);
          playerSprite.scale.set(SPRITE_SCALE * 1.35);
        } else {
          placeholders.circle(visual.player.x, visual.player.y, 9).fill(0x8fd694);
          placeholders
            .circle(visual.player.x, visual.player.y, 13)
            .stroke({ width: 2, color: 0xe8f5e9 });
        }

        const swordTexture = atlas?.get('weapon.sword') ?? null;
        if (swordTexture && visual.swing.active) {
          const blade = visual.swingPosition();
          swordSprite.visible = true;
          swordSprite.texture = swordTexture;
          swordSprite.x = blade.x;
          swordSprite.y = blade.y;
          swordSprite.rotation = blade.rotation;
          swordSprite.scale.set(SPRITE_SCALE);
          // Fades in and out across the sweep, which reads as motion on a
          // sprite that has no animation frames of its own.
          swordSprite.alpha = Math.sin(visual.swing.progress * Math.PI) * 0.85 + 0.15;
        } else {
          swordSprite.visible = false;
        }

        for (let i = 0; i < floaterPool.length; i++) {
          const text = floaterPool[i];
          const floater = visual.floaters[i];
          if (!floater) {
            text.visible = false;
            continue;
          }
          text.visible = true;
          text.text = floater.text;
          text.x = floater.x;
          text.y = floater.y;
          text.alpha = Math.min(1, floater.life);
        }
      });
    })();

    return () => {
      disposed = true;
      app?.destroy(true, { children: true });
    };
  }, []);

  return <div ref={hostRef} className="absolute inset-0" data-testid="game-canvas" />;
}
