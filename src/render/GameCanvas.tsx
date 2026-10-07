'use client';

/**
 * Pixi renderer.
 *
 * Reads StageVisual's entity arrays directly inside the ticker. No React state,
 * no store subscription, no re-render per frame - the only React involvement is
 * mounting the canvas once and pushing new options in when the sim's numbers
 * change.
 *
 * Phase 7b made it a side view: a brick wall and a tiled floor drawn once per
 * size, sprites anchored at their FEET on that floor (the cosmetic layer reports
 * foot positions), and the boss striding in from the right.
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

/**
 * What the fight looks like right now, for the DOM around it.
 *
 * Pushed out of the ticker at a few hertz rather than read through a store at sixty -
 * the orbs and the timer are numbers a human reads, and the canvas is the only thing
 * that knows them.
 */
export interface FightReadout {
  active: boolean;
  phase: AttemptPlayback['phase'];
  kind: AttemptKind;
  /** 1 at full health. Stays at 1 while idle farming, which costs no health. */
  playerHp: number;
  bossHp: number;
  /** Simulated seconds left on the clock, or the full limit while idle. */
  remaining: number;
}

interface Props {
  killsPerSecond: number;
  hitLabel: (jitter: number) => string;
  attacksPerSecond: number;
  stage: number;
  stageTimeLimit: number;
  attempt: AttemptRequest | null;
  /**
   * Fast-forward, as a whole number of cosmetic steps per frame.
   *
   * Display only. The outcome was resolved before the replay began, so running the
   * picture faster changes when the command is sent and nothing about what it says.
   */
  speed?: number;
  /** Fired once when a replay reaches its end. */
  onAttemptComplete: () => void;
  onReadout?: (readout: FightReadout) => void;
}

const FLOATER_POOL = 40;
const MAX_SPRITES = 240;
/** Matches MAX_DROPS in the cosmetic layer - the pool must not be the tighter bound. */
const MAX_DROP_SPRITES = 24;
/** 16px source art, always scaled by whole numbers so it stays on the pixel grid. */
const ENEMY_SCALE = 3;
const HERO_SCALE = 4;
const DROP_SCALE = 2;
/** Bosses are the same 16px art at a larger whole-number scale. */
const BOSS_SCALE = 6;
const BOSS_BAR_WIDTH = 150;
/** Readouts per second pushed to the DOM. */
const READOUT_HZ = 8;

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

/** How dark the dungeon gets at the midpoint of the boss entrance. */
const DIM_PEAK_ALPHA = 0.45;

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
        : `FLOOR ${playback.stage}`;

  // The entrance says so in as many words. A player who cannot tell whether the boss has
  // arrived is the entire complaint this beat exists to answer.
  const what =
    playback.phase === 'entrance' ? 'BOSS INCOMING' : playback.phase === 'boss' ? 'BOSS' : 'WAVE';
  return `${where}  ·  ${what}`;
}

/** Health bar: ink frame, dark backing, flat fill with a one-pixel highlight. */
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
  const left = Math.round(x);
  const top = Math.round(y);
  g.rect(left - 2, top - 2, width + 4, height + 4).fill({ color: 0x030202 });
  g.rect(left, top, width, height).fill({ color: 0x1a120e });
  if (clamped > 0) {
    const fill = Math.max(1, Math.round(width * clamped));
    g.rect(left, top, fill, height).fill({ color });
    g.rect(left, top, fill, 1).fill({ color: 0xffffff, alpha: 0.25 });
  }
}

/**
 * The dungeon: a brick wall, a lip, and a tiled floor.
 *
 * Drawn into one Graphics and only when the size changes. Rebuilding a few hundred
 * rectangles sixty times a second would be pure waste for something that never moves.
 */
function drawScenery(g: Graphics, width: number, height: number, ground: number) {
  g.clear();
  const wallBottom = Math.round(ground - 22);

  // Wall.
  g.rect(0, 0, width, wallBottom).fill({ color: 0x1a1614 });
  const brickH = 16;
  const brickW = 32;
  for (let row = 0; row * brickH < wallBottom; row++) {
    const y = row * brickH;
    g.rect(0, y, width, 3).fill({ color: 0x0d0b0a });
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let x = -offset; x < width; x += brickW) {
      g.rect(Math.round(x), y, 3, brickH).fill({ color: 0x0d0b0a });
      // A lit edge on a scatter of bricks, so the wall has texture without noise.
      if ((row * 7 + Math.round(x / brickW) * 3) % 5 === 0) {
        g.rect(Math.round(x) + 3, y + 3, brickW - 3, 2).fill({ color: 0x262019 });
      }
    }
  }

  // The lip where wall meets floor.
  g.rect(0, wallBottom, width, 6).fill({ color: 0x2a221c });
  g.rect(0, wallBottom, width, 2).fill({ color: 0x030202 });

  // Floor.
  const floorTop = wallBottom + 6;
  g.rect(0, floorTop, width, height - floorTop).fill({ color: 0x141110 });
  for (let y = floorTop; y < height; y += 24) {
    g.rect(0, y, width, 3).fill({ color: 0x0a0807 });
  }
  const tile = 48;
  for (let x = 0; x < width; x += tile) {
    g.rect(x, floorTop, 3, height - floorTop).fill({ color: 0x0a0807 });
  }

  // Hard-stepped vignette: three bands, no gradient. A blur would smear the pixels.
  for (const [inset, alpha] of [
    [0, 0.35],
    [16, 0.2],
    [32, 0.1],
  ] as const) {
    g.rect(inset, inset, width - inset * 2, height - inset * 2).stroke({
      width: 16,
      color: 0x000000,
      alpha,
      alignment: 1,
    });
  }
}

/** Torches on the wall, re-lit every frame so the flame flickers. */
function drawTorches(g: Graphics, width: number, ground: number, clock: number) {
  g.clear();
  const top = Math.round((ground - 22) * 0.32);
  for (const fraction of [0.3, 0.74]) {
    const x = Math.round(width * fraction);
    const flicker = Math.sin(clock * 11 + fraction * 40) > 0 ? 1 : 0;
    // Light pool: two stepped squares, faint.
    g.rect(x - 40, top - 34, 80, 80).fill({ color: 0xff8c28, alpha: 0.05 });
    g.rect(x - 24, top - 18, 48, 48).fill({ color: 0xff8c28, alpha: 0.06 });
    // Sconce and flame, 4px "pixels".
    g.rect(x - 4, top + 8, 8, 16).fill({ color: 0x4a3020 });
    g.rect(x - 8, top + 8, 16, 4).fill({ color: 0x6b4a2e });
    g.rect(x - 4, top, 8, 8).fill({ color: 0xff8a2a });
    g.rect(x - 4 + flicker * 4, top - 4, 4, 8).fill({ color: 0xffd36a });
    g.rect(x - flicker * 4, top - 8, 4, 8).fill({ color: 0xff5a1a });
  }
}

/** The family a next/font face was registered under, or a fallback. */
function cssFont(variable: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return value ? `${value}, ${fallback}` : fallback;
}

export function GameCanvas({
  killsPerSecond,
  hitLabel,
  attacksPerSecond,
  stage,
  stageTimeLimit,
  attempt,
  speed = 1,
  onAttemptComplete,
  onReadout,
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
  const readoutRef = useRef(onReadout);
  const limitRef = useRef(stageTimeLimit);
  const speedRef = useRef(speed);
  useEffect(() => {
    attemptRef.current = attempt;
    completeRef.current = onAttemptComplete;
    readoutRef.current = onReadout;
    limitRef.current = stageTimeLimit;
    speedRef.current = speed;
  }, [attempt, onAttemptComplete, onReadout, stageTimeLimit, speed]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let app: Application | null = null;

    (async () => {
      const instance = new Application();
      await instance.init({
        background: '#0d0a08',
        resizeTo: host,
        antialias: false,
        resolution: Math.min(globalThis.devicePixelRatio ?? 1, 2),
        autoDensity: true,
        roundPixels: true,
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
      // cosmetic positions and nothing else.
      (globalThis as unknown as { __stageVisual?: StageVisual }).__stageVisual = visual;

      // Whether art is reaching the screen is invisible from the DOM: a canvas
      // full of fallback circles looks exactly like a canvas full of sprites.
      // These counters are what let the smoke test tell the two apart.
      const renderStats = { atlasLoaded: atlas !== null, sprites: 0, placeholders: 0 };
      (globalThis as unknown as { __renderStats?: typeof renderStats }).__renderStats = renderStats;

      const numberFont = cssFont('--font-vt323', 'monospace');
      const labelFont = cssFont('--font-silkscreen', 'monospace');

      const scenery = new Graphics();
      const torches = new Graphics();
      const placeholders = new Graphics();
      const spriteLayer = new Container();
      const floaterLayer = new Container();
      instance.stage.addChild(scenery, torches, placeholders, spriteLayer);

      const spritePool: Sprite[] = [];
      for (let i = 0; i < MAX_SPRITES; i++) {
        const sprite = new Sprite();
        sprite.anchor.set(0.5, 1);
        sprite.visible = false;
        spriteLayer.addChild(sprite);
        spritePool.push(sprite);
      }

      // Floor shadows are drawn into the placeholders Graphics, which is already cleared
      // and redrawn every frame - a pooled shadow sprite would need a texture of its own.
      const playerSprite = new Sprite();
      playerSprite.anchor.set(0.5, 1);
      playerSprite.visible = false;
      spriteLayer.addChild(playerSprite);

      // Drawn after the player so the blade passes in front of the body.
      const swordSprite = new Sprite();
      swordSprite.anchor.set(0.5);
      swordSprite.visible = false;
      spriteLayer.addChild(swordSprite);

      const bossSprite = new Sprite();
      bossSprite.anchor.set(0.5, 1);
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
      // the darkened dungeon, or the one thing the beat exists to point at is the thing
      // the beat is hiding.
      const dim = new Graphics();
      const bossLayer = new Container();
      bossLayer.addChild(bossSprite);

      const bars = new Graphics();
      const banner = new Text({
        text: '',
        style: {
          fontFamily: labelFont,
          fontSize: 13,
          fill: 0xefe4cc,
          letterSpacing: 1,
          dropShadow: { color: 0x000000, distance: 2, angle: Math.PI / 4, blur: 0, alpha: 1 },
        },
      });
      banner.anchor.set(0.5, 0);
      banner.visible = false;
      instance.stage.addChild(dim, bossLayer, bars, floaterLayer, banner);

      const floaterPool: Text[] = [];
      for (let i = 0; i < FLOATER_POOL; i++) {
        const text = new Text({
          text: '',
          style: {
            fontFamily: numberFont,
            fontSize: 24,
            fill: 0xefe4cc,
            stroke: { color: 0x000000, width: 3 },
          },
        });
        text.anchor.set(0.5);
        text.visible = false;
        floaterLayer.addChild(text);
        floaterPool.push(text);
      }

      let startedAttemptId = -1;
      let sceneryW = -1;
      let sceneryH = -1;
      let clock = 0;
      let sinceReadout = Infinity;

      instance.ticker.add((ticker) => {
        // Clamped: an alt-tabbed tab resumes with a huge delta and would
        // teleport every enemy onto the hero.
        const dt = Math.min(ticker.deltaMS / 1000, 0.05);
        clock += dt;

        const width = instance.screen.width;
        const height = instance.screen.height;

        const request = attemptRef.current;
        if (request && request.id !== startedAttemptId) {
          startedAttemptId = request.id;
          visual.startAttempt(request);
        }
        visual.setOptions({ ...optionsRef.current, width, height });

        // Fast-forward is more steps, not a bigger step. A bigger dt would let a homing
        // drop overshoot the hero and the queue walk through itself.
        const steps = Math.max(1, Math.min(8, Math.round(speedRef.current)));
        for (let i = 0; i < steps; i++) visual.update(dt);

        const ground = visual.groundY();
        if (width !== sceneryW || height !== sceneryH) {
          drawScenery(scenery, width, height, ground);
          sceneryW = width;
          sceneryH = height;
        }
        drawTorches(torches, width, ground, clock);

        placeholders.clear();
        let slot = 0;
        let placeholderCount = 0;

        // Survivors of the wave fade as they run, so the ones that do not reach the edge
        // before the boss lands are already invisible when the layer drops them.
        const fleeAlpha =
          visual.attempt.active && visual.attempt.phase === 'entrance'
            ? Math.max(0, 1 - visual.attempt.entrance)
            : 1;

        // Back to front by depth, so a creature nearer the camera overlaps the one
        // behind it rather than whichever happened to be earlier in the pool.
        const living = visual.enemies.filter((enemy) => enemy.alive).sort((a, b) => a.y - b.y);

        for (const enemy of living) {
          const texture = atlas?.get(enemy.sprite) ?? null;
          // A shadow on the floor, so a sprite reads as standing rather than floating.
          placeholders
            .rect(Math.round(enemy.x - 14), Math.round(enemy.y - 2), 28, 4)
            .fill({ color: 0x000000, alpha: 0.35 * (enemy.fleeing ? fleeAlpha : 1) });

          if (texture && slot < spritePool.length) {
            const sprite = spritePool[slot++];
            sprite.visible = true;
            sprite.texture = texture;
            sprite.x = Math.round(enemy.x);
            sprite.y = Math.round(enemy.y);
            sprite.scale.set(enemy.facing * ENEMY_SCALE, ENEMY_SCALE);
            sprite.alpha = enemy.fleeing ? fleeAlpha : 1;
          } else {
            // The fallback that makes partial art migrations survivable.
            placeholders.circle(enemy.x, enemy.y - enemy.r * 2, enemy.r * 2).fill(0x3a2e24);
            placeholderCount++;
          }
        }

        for (let i = slot; i < spritePool.length; i++) spritePool[i].visible = false;
        renderStats.sprites = slot;
        renderStats.placeholders = placeholderCount;

        placeholders
          .rect(Math.round(visual.player.x - 20), Math.round(visual.player.y - 2), 40, 5)
          .fill({ color: 0x000000, alpha: 0.4 });
        const playerTexture = atlas?.get('player.knight') ?? null;
        if (playerTexture) {
          playerSprite.visible = true;
          playerSprite.texture = playerTexture;
          playerSprite.x = Math.round(visual.player.x);
          playerSprite.y = Math.round(visual.player.y);
          playerSprite.scale.set(HERO_SCALE);
        } else {
          placeholders.rect(visual.player.x - 12, visual.player.y - 40, 24, 40).fill(0x8a8f98);
        }

        // Drops. Bobbing while they tumble, so a 16px icon still reads as loot against
        // creatures the same size.
        let dropSlot = 0;
        for (const drop of visual.drops) {
          if (dropSlot >= dropPool.length) break;
          const texture = atlas?.get(drop.sprite) ?? null;
          if (!texture) {
            placeholders.rect(drop.x - 4, drop.y - 4, 8, 8).fill(0xffd479);
            continue;
          }
          const sprite = dropPool[dropSlot++];
          sprite.visible = true;
          sprite.texture = texture;
          sprite.x = Math.round(drop.x);
          sprite.y = Math.round(drop.y);
          sprite.scale.set(DROP_SCALE);
          // Fades as it reaches the hero rather than blinking out of existence.
          sprite.alpha = drop.age > 5 ? Math.max(0, 6 - drop.age) : 1;
        }
        for (let i = dropSlot; i < dropPool.length; i++) dropPool[i].visible = false;

        const swordTexture = atlas?.get('weapon.sword') ?? null;
        if (swordTexture && visual.swing.active) {
          const blade = visual.swingPosition();
          swordSprite.visible = true;
          swordSprite.texture = swordTexture;
          swordSprite.x = Math.round(blade.x);
          swordSprite.y = Math.round(blade.y);
          swordSprite.rotation = blade.rotation;
          swordSprite.scale.set(DROP_SCALE + 1);
          // Fades in and out across the sweep, which reads as motion on a sprite that
          // has no animation frames of its own.
          swordSprite.alpha = Math.sin(visual.swing.progress * Math.PI) * 0.85 + 0.15;
        } else {
          swordSprite.visible = false;
        }

        bars.clear();
        dim.clear();
        const playback = visual.attempt;
        const entering = playback.active && playback.phase === 'entrance';

        // Up over the first half of the entrance and back down over the second, so the
        // dungeon darkens as the boss strides in and is clear again the moment it plants.
        if (entering) {
          dim
            .rect(0, 0, width, height)
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
          const style = DELVE_STYLE[playback.kind];
          const bossScale = BOSS_SCALE * style.scale;
          if (visual.boss.alive && bossTexture) {
            bossSprite.visible = true;
            bossSprite.texture = bossTexture;
            bossSprite.x = Math.round(visual.boss.x);
            bossSprite.y = Math.round(visual.boss.y);
            // Facing the hero, which is to its left - the same flip the wave uses.
            bossSprite.scale.set(-bossScale, bossScale);
            bossSprite.tint = style.tint;
            placeholders
              .rect(Math.round(visual.boss.x - 36 * style.scale), Math.round(visual.boss.y - 3), 72 * style.scale, 6)
              .fill({ color: 0x000000, alpha: 0.45 });
            // No bar until the fight starts. It is full for the whole entrance anyway,
            // and a bar that appears with the first tick of damage is the clearest
            // possible statement of when the boss actually became fightable.
            if (playback.phase === 'boss') {
              drawBar(
                bars,
                visual.boss.x - BOSS_BAR_WIDTH / 2,
                visual.boss.y - 16 * bossScale - 16,
                BOSS_BAR_WIDTH,
                8,
                playback.bossHp,
                0xb0221c,
              );
            }
          } else {
            bossSprite.visible = false;
          }

          drawBar(bars, visual.player.x - 26, visual.player.y - 16 * HERO_SCALE - 14, 52, 6, playback.playerHp, 0x4fae4f);

          const remaining = visual.timeRemaining(limitRef.current);
          banner.visible = true;
          banner.x = width / 2;
          banner.y = 12;
          // The countdown is frozen along with `elapsed` during the entrance, which is
          // correct: no fight time is passing, so the timer must not tick.
          banner.text = `${bannerHead(playback)}  ·  ${remaining.toFixed(1)}s`;
          // The timer is the second failure mode, and it deserves to look like one
          // before it fires rather than only in the result line. The entrance overrides
          // it - the arrival is what the player should be reading.
          banner.style.fill = entering ? 0xf0c56a : remaining < 10 ? 0xf87171 : 0xefe4cc;
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
          text.x = Math.round(floater.x);
          text.y = Math.round(floater.y);
          text.alpha = Math.min(1, floater.life);
        }

        sinceReadout += dt;
        if (readoutRef.current && sinceReadout >= 1 / READOUT_HZ) {
          sinceReadout = 0;
          readoutRef.current({
            active: playback.active,
            phase: playback.phase,
            kind: playback.kind,
            playerHp: playback.active ? playback.playerHp : 1,
            bossHp: playback.bossHp,
            remaining: playback.active ? visual.timeRemaining(limitRef.current) : limitRef.current,
          });
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
