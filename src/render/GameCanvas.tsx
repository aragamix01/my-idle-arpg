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
import { StageVisual, type AttemptKind, type AttemptPlayback, type AttemptSpec } from './cosmetic';
import { loadAtlas, type Atlas } from './atlas';
import type { SpriteId } from './sprites';

/**
 * A replay request. A new `id` starts one; the same id is ignored.
 *
 * Everything except the id is what the cosmetic layer already takes, so this is that
 * spec plus identity rather than a parallel shape that has to be kept in step with it.
 */
export interface AttemptRequest extends AttemptSpec {
  id: number;
}

interface Props {
  killsPerSecond: number;
  hitLabel: (jitter: number) => string;
  attacksPerSecond: number;
  stage: number;
  stageTimeLimit: number;
  attempt: AttemptRequest | null;
  /** Fired once when a replay reaches its end. */
  onAttemptComplete: () => void;
}

const FLOATER_POOL = 40;
const MAX_SPRITES = 240;
/** Matches MAX_DROPS in the cosmetic layer - the pool must not be the tighter bound. */
const MAX_DROP_SPRITES = 24;
/** 16px source art needs scaling up; this keeps it on whole pixels. */
const SPRITE_SCALE = 2;
/** Bosses are the same 16px art at a larger whole-number scale. */
const BOSS_SCALE = 6;
const BOSS_BAR_WIDTH = 150;

/**
 * How a delve boss differs from one standing at the end of a wave.
 *
 * Scale and tint rather than art: the atlas has two boss sprites and the Abyss is a
 * third kind of fight, so inventing a distinction it does not have would mean shipping
 * a dungeon warlock and calling it something else. An Abyssal is the warlock, larger
 * and lit violet, and the banner says which it is.
 */
const DELVE_STYLE: Record<AttemptKind, { scale: number; tint: number }> = {
  stage: { scale: 1, tint: 0xffffff },
  dungeon: { scale: 1.35, tint: 0xffffff },
  abyssal: { scale: 1.6, tint: 0xb18cf0 },
};

/**
 * Which boss to draw.
 *
 * Delves always show the warlock so they read as a different fight at a
 * glance; stages alternate so consecutive ones do not repeat.
 */
function bossSpriteFor(stage: number, kind: AttemptKind): SpriteId {
  if (kind !== 'stage') return 'boss.warlock';
  return stage % 2 === 0 ? 'boss.warlock' : 'boss.brute';
}

/** How dark the arena gets at the midpoint of the boss entrance. */
const DIM_PEAK_ALPHA = 0.55;
/** Fraction of full size the boss starts its arrival at. */
const ENTRANCE_SCALE_FROM = 0.5;

/** The banner's headline. The remaining time is appended by the caller. */
function bannerHead(playback: {
  kind: AttemptKind;
  stage: number;
  tier: number;
  phase: AttemptPlayback['phase'];
}): string {
  const where =
    playback.kind === 'abyssal'
      ? // The tier, not the depth. It is what the player picked off the shelf, and it is
        // the number the tablet is named for.
        `ABYSS T${playback.tier}`
      : playback.kind === 'dungeon'
        ? `DUNGEON ${playback.stage}`
        : `STAGE ${playback.stage}`;

  // The entrance says so in as many words. A player who cannot tell whether the boss has
  // arrived is the entire complaint this beat exists to answer.
  const what =
    playback.phase === 'entrance' ? 'BOSS INCOMING' : playback.phase === 'boss' ? 'BOSS' : 'WAVE';
  return `${where}  ·  ${what}`;
}

/** Health bar: dark backing, coloured fill, drawn straight into a Graphics. */
function drawBar(
  g: Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  fraction: number,
  color: number,
) {
  const clamped = Math.max(0, Math.min(1, fraction));
  g.rect(x - 1, y - 1, width + 2, height + 2).fill({ color: 0x000000, alpha: 0.55 });
  g.rect(x, y, width, height).fill({ color: 0x27272a });
  if (clamped > 0) g.rect(x, y, width * clamped, height).fill({ color });
}

export function GameCanvas({
  killsPerSecond,
  hitLabel,
  attacksPerSecond,
  stage,
  stageTimeLimit,
  attempt,
  onAttemptComplete,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Latest sim numbers, read by the ticker without re-running the mount effect.
  // Written in an effect rather than during render: React may render a
  // component without committing it, and the ticker would then be drawing from
  // numbers that were never real.
  const optionsRef = useRef({ killsPerSecond, hitLabel, attacksPerSecond, stage });
  useEffect(() => {
    optionsRef.current = { killsPerSecond, hitLabel, attacksPerSecond, stage };
  }, [killsPerSecond, hitLabel, attacksPerSecond, stage]);

  // The ticker is created once, so anything React changes later has to reach it
  // through a ref rather than through the closure it captured.
  const attemptRef = useRef<AttemptRequest | null>(attempt);
  const completeRef = useRef(onAttemptComplete);
  const limitRef = useRef(stageTimeLimit);
  useEffect(() => {
    attemptRef.current = attempt;
    completeRef.current = onAttemptComplete;
    limitRef.current = stageTimeLimit;
  }, [attempt, onAttemptComplete, stageTimeLimit]);

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

      const bossSprite = new Sprite();
      bossSprite.anchor.set(0.5);
      bossSprite.visible = false;

      // Loot draws above every combatant. It is the thing the player is watching for,
      // and a drop sliding under a corpse would read as having been missed.
      const dropPool: Sprite[] = [];
      for (let i = 0; i < MAX_DROP_SPRITES; i++) {
        const sprite = new Sprite();
        sprite.anchor.set(0.5);
        sprite.visible = false;
        spriteLayer.addChild(sprite);
        dropPool.push(sprite);
      }

      // The entrance dim, and the boss above it.
      //
      // The boss gets its own container purely for stacking: it has to arrive ON TOP of
      // the darkened arena, or the one thing the beat exists to point at is the thing
      // the beat is hiding.
      const dim = new Graphics();
      const bossLayer = new Container();
      bossLayer.addChild(bossSprite);

      const bars = new Graphics();
      const banner = new Text({
        text: '',
        style: { fontFamily: 'monospace', fontSize: 15, fill: 0xf4f4f5, fontWeight: 'bold' },
      });
      banner.anchor.set(0.5, 0);
      banner.visible = false;
      instance.stage.addChild(dim, bossLayer, bars, banner);

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

      let startedAttemptId = -1;

      instance.ticker.add((ticker) => {
        // Clamped: an alt-tabbed tab resumes with a huge delta and would
        // teleport every enemy onto the player.
        const dt = Math.min(ticker.deltaMS / 1000, 0.05);

        const request = attemptRef.current;
        if (request && request.id !== startedAttemptId) {
          startedAttemptId = request.id;
          visual.startAttempt(request);
        }
        visual.setOptions({
          ...optionsRef.current,
          width: instance.screen.width,
          height: instance.screen.height,
        });
        visual.update(dt);

        placeholders.clear();
        let slot = 0;
        let placeholderCount = 0;

        // Survivors of the wave fade as they run, so the ones that do not reach the edge
        // before the boss lands are already invisible when the layer drops them.
        const fleeAlpha =
          visual.attempt.active && visual.attempt.phase === 'entrance'
            ? Math.max(0, 1 - visual.attempt.entrance)
            : 1;

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
            sprite.alpha = enemy.fleeing ? fleeAlpha : 1;
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

        // Drops. A little larger than an enemy and bobbing while they tumble, so a
        // 16px icon still reads as loot against a field of creatures the same size.
        let dropSlot = 0;
        for (const drop of visual.drops) {
          if (dropSlot >= dropPool.length) break;
          const texture = atlas?.get(drop.sprite) ?? null;
          if (!texture) {
            placeholders.circle(drop.x, drop.y, 5).fill(0xffd479);
            continue;
          }
          const sprite = dropPool[dropSlot++];
          sprite.visible = true;
          sprite.texture = texture;
          sprite.x = Math.round(drop.x);
          sprite.y = Math.round(drop.y);
          sprite.scale.set(SPRITE_SCALE * 1.1);
          // Fades as it reaches the player rather than blinking out of existence.
          sprite.alpha = drop.age > 5 ? Math.max(0, 6 - drop.age) : 1;
        }
        for (let i = dropSlot; i < dropPool.length; i++) dropPool[i].visible = false;

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

        bars.clear();
        dim.clear();
        const playback = visual.attempt;
        const entering = playback.active && playback.phase === 'entrance';

        // Up over the first half of the entrance and back down over the second, so the
        // arena darkens as the boss falls and is clear again the moment it lands.
        if (entering) {
          dim
            .rect(0, 0, instance.screen.width, instance.screen.height)
            .fill({ color: 0x05050a, alpha: DIM_PEAK_ALPHA * Math.sin(playback.entrance * Math.PI) });
        }

        // The replay ending is the signal to commit: the command is sent only
        // now, so the numbers change when the fight visibly resolves rather
        // than the moment the button was clicked.
        if (!playback.active && startedAttemptId !== -1 && playback.phase === 'finished') {
          startedAttemptId = -1;
          visual.endAttempt();
          completeRef.current();
        }

        if (playback.active) {
          const bossTexture = atlas?.get(bossSpriteFor(playback.stage, playback.kind)) ?? null;
          if (visual.boss.alive && bossTexture) {
            const style = DELVE_STYLE[playback.kind];
            bossSprite.visible = true;
            bossSprite.texture = bossTexture;
            bossSprite.x = Math.round(visual.boss.x);
            bossSprite.y = Math.round(visual.boss.y);
            // A delve boss is the only thing on screen, so it can afford to
            // be bigger than one standing at the end of a wave.
            //
            // Growing into its full size across the entrance, so it lands rather than
            // pops. The cosmetic layer owns where it is; this owns how big it reads.
            const arriving = entering ? ENTRANCE_SCALE_FROM + (1 - ENTRANCE_SCALE_FROM) * playback.entrance : 1;
            bossSprite.scale.set(BOSS_SCALE * style.scale * arriving);
            bossSprite.tint = style.tint;
            // No bar until the fight starts. It is full for the whole entrance anyway,
            // and a bar that appears with the first tick of damage is the clearest
            // possible statement of when the boss actually became fightable.
            if (playback.phase === 'boss') {
              drawBar(
                bars,
                visual.boss.x - BOSS_BAR_WIDTH / 2,
                visual.boss.y - 16 * BOSS_SCALE * 0.5 - 18,
                BOSS_BAR_WIDTH,
                9,
                playback.bossHp,
                0xc0392b,
              );
            }
          } else {
            bossSprite.visible = false;
          }

          drawBar(bars, visual.player.x - 22, visual.player.y + 20, 44, 5, playback.playerHp, 0x4ade80);

          const remaining = visual.timeRemaining(limitRef.current);
          banner.visible = true;
          banner.x = instance.screen.width / 2;
          // Below the HUD stat chips, which are drawn in the DOM above this
          // canvas and clipped the banner at y=14.
          banner.y = 72;
          // The countdown is frozen along with `elapsed` during the entrance, which is
          // correct: no fight time is passing, so the timer must not tick.
          banner.text = `${bannerHead(playback)}  ·  ${remaining.toFixed(1)}s`;
          // The timer is the second failure mode, and it deserves to look like
          // one before it fires rather than only in the result line. The entrance
          // overrides it - the arrival is what the player should be reading, and an
          // amber line is what says so.
          banner.style.fill = entering ? 0xfbbf24 : remaining < 10 ? 0xf87171 : 0xf4f4f5;
        } else {
          bossSprite.visible = false;
          banner.visible = false;
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
