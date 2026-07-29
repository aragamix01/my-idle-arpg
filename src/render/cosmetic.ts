/**
 * The cosmetic layer.
 *
 * This is the half of the game that does not decide anything. The abstract
 * layer in src/sim/combat.ts already computed the kill rate; this arranges
 * circles so that killing looks like it is happening at exactly that rate.
 *
 * It holds mutable entity arrays that the Pixi renderer reads directly inside
 * its own frame loop. React never sees them - see src/ui/store.ts.
 */

import { enemySpritesForStage, type SpriteId } from './sprites';

export interface CosmeticEnemy {
  x: number;
  y: number;
  alive: boolean;
  /** Radius. Drives display size, and is the placeholder circle's size. */
  r: number;
  sprite: SpriteId;
  /** Sprites face the player; -1 flips horizontally. */
  facing: 1 | -1;
}

export interface Floater {
  x: number;
  y: number;
  text: string;
  /** Seconds remaining before it disappears. */
  life: number;
}

export interface VisualOptions {
  killsPerSecond: number;
  /** Typical hit for the damage numbers. Cosmetic - the real number lives in the sim. */
  hitSize: number;
  /** Swings per second, from the sim's attackSpeed stat. Paces the animation only. */
  attacksPerSecond: number;
  /** Decides which creatures appear. Has no effect on outcomes. */
  stage: number;
  width: number;
  height: number;
}

/**
 * A stage attempt being replayed.
 *
 * resolveStage already decided every number here before the first frame drew.
 * This walks the clock through that verdict - it cannot change the outcome, and
 * the player watching has no influence over it. That is the price of the same
 * rules running offline on a server with nobody watching at all.
 */
export interface AttemptPlayback {
  active: boolean;
  phase: 'trash' | 'boss' | 'finished';
  /** Seconds into the attempt. */
  elapsed: number;
  /** Total the replay will run for - the truncated survival time on a failure. */
  duration: number;
  trashSeconds: number;
  bossSeconds: number;
  /** 1 at full health, 0 at empty. Clamped, so a lethal run bottoms out at 0. */
  playerHp: number;
  /** 1 when the boss spawns, 0 when it dies. Meaningless before the boss phase. */
  bossHp: number;
  stage: number;
  cleared: boolean;
  failure: 'none' | 'died' | 'timeout';
}

/** What the replay needs from resolveStage. Structural, so the sim stays unimported here. */
export interface AttemptOutcome {
  cleared: boolean;
  failure: 'none' | 'died' | 'timeout';
  seconds: number;
  trashPhaseSeconds: number;
  bossPhaseSeconds: number;
  trashDamageFraction: number;
  bossDamageFraction: number;
}

/** A sword sweep. Purely presentational - it never decides who dies. */
export interface Swing {
  active: boolean;
  /** Centre of the arc, radians. */
  aim: number;
  /** 0 at the start of the sweep, 1 at the end. */
  progress: number;
}

const MAX_ENEMIES = 240;
const MAX_FLOATERS = 40;

/**
 * Enemies must outpace the player's orbit, or they trail behind in a receding
 * cloud and the screen never fills. Measured at 34 against an orbit of ~113
 * px/s: the swarm never arrived.
 *
 * Orbit tangential speed is roughly amplitude x angular speed, so keep
 * PLAYER_ORBIT_RADIUS x PLAYER_ORBIT_SPEED x width comfortably under this.
 */
const ENEMY_SPEED = 72;
const PLAYER_ORBIT_SPEED = 0.4;
const PLAYER_ORBIT_RADIUS = 0.12;

/** Half-width of the sword sweep, radians. The blade covers 120 degrees. */
const SWING_ARC = Math.PI / 3;
/** How far the blade orbits from the player, in pixels. */
const SWING_RADIUS = 20;
/**
 * Attack speed compounds without limit, so by late stages the sim's rate is
 * hundreds of swings per second. Past this the animation is a strobe rather
 * than a swing, and the number on the HUD is the honest place to read it.
 */
const MAX_VISUAL_SWINGS_PER_SECOND = 7;
/** Fraction of the interval the blade is mid-sweep; the rest is wind-up. */
const SWING_DUTY = 0.55;

/**
 * How many simulated seconds a replay plays per real second.
 *
 * Attempts run 20-75 simulated seconds and the balance harness needs anywhere
 * from 3 to 40 of them per stage. Played at 1x that is half an hour of watching
 * to clear one stage, which is not a game.
 *
 * Only the playback is compressed. Elapsed time, the countdown, and the health
 * bars are all reported in simulated seconds, so the numbers on screen stay the
 * ones the sim actually produced.
 */
export const PLAYBACK_SPEED = 6;

export class StageVisual {
  readonly enemies: CosmeticEnemy[] = [];
  readonly floaters: Floater[] = [];
  player = { x: 0, y: 0 };
  readonly swing: Swing = { active: false, aim: 0, progress: 0 };

  readonly attempt: AttemptPlayback = {
    active: false,
    phase: 'finished',
    elapsed: 0,
    duration: 0,
    trashSeconds: 0,
    bossSeconds: 0,
    playerHp: 1,
    bossHp: 1,
    stage: 1,
    cleared: false,
    failure: 'none',
  };

  /** The boss, alive only during the boss phase. */
  boss = { x: 0, y: 0, alive: false };

  private swingClock = 0;
  private outcome: AttemptOutcome | null = null;

  private options: VisualOptions;
  private killCredit = 0;
  private orbitAngle = 0;
  private seed: number;
  /** First fill places enemies on screen; every fill after walks them in. */
  private seeded = false;

  constructor(options: VisualOptions) {
    this.options = options;
    this.seed = 0x1234_5678;
    this.player = { x: options.width / 2, y: options.height / 2 };
    for (let i = 0; i < MAX_ENEMIES; i++) {
      this.enemies.push({ x: 0, y: 0, alive: false, r: 6, sprite: 'enemy.slime', facing: 1 });
    }
  }

  setOptions(options: VisualOptions) {
    this.options = options;
  }

  /** Begin replaying a resolved attempt. Ignored while one is already running. */
  startAttempt(outcome: AttemptOutcome, stage: number) {
    if (this.attempt.active) return;

    // A failure ends when the player died, not when the fight would have. The
    // boss slice of the replay shrinks to whatever was survived.
    const duration = outcome.cleared
      ? outcome.trashPhaseSeconds + outcome.bossPhaseSeconds
      : Math.max(0.6, outcome.seconds);

    this.outcome = outcome;
    Object.assign(this.attempt, {
      active: true,
      phase: 'trash' as const,
      elapsed: 0,
      duration,
      trashSeconds: Math.min(outcome.trashPhaseSeconds, duration),
      bossSeconds: Math.max(0, duration - Math.min(outcome.trashPhaseSeconds, duration)),
      playerHp: 1,
      bossHp: 1,
      stage,
      cleared: outcome.cleared,
      failure: outcome.failure,
    });
    this.boss.alive = false;
  }

  /** Clear a finished replay so the idle view resumes. */
  endAttempt() {
    this.attempt.active = false;
    this.attempt.phase = 'finished';
    this.boss.alive = false;
    this.outcome = null;
  }

  private updateAttempt(dt: number) {
    const a = this.attempt;
    if (!a.active || !this.outcome) return;

    // elapsed is in simulated seconds; dt is real. This is the only place the
    // two are related.
    a.elapsed = Math.min(a.duration, a.elapsed + dt * PLAYBACK_SPEED);
    const inBoss = a.elapsed >= a.trashSeconds && a.bossSeconds > 0;
    a.phase = inBoss ? 'boss' : 'trash';

    // Health drains at each phase's own rate rather than an average, which is
    // what makes a boss-phase death look like a boss-phase death.
    const trashProgress = a.trashSeconds > 0 ? Math.min(1, a.elapsed / a.trashSeconds) : 1;
    const bossProgress =
      a.bossSeconds > 0 ? Math.min(1, Math.max(0, a.elapsed - a.trashSeconds) / a.bossSeconds) : 0;

    const taken =
      this.outcome.trashDamageFraction * trashProgress +
      this.outcome.bossDamageFraction * bossProgress;
    a.playerHp = Math.max(0, 1 - taken);
    a.bossHp = inBoss ? Math.max(0, 1 - bossProgress) : 1;

    if (inBoss && !this.boss.alive) {
      this.boss.alive = true;
      this.boss.x = this.options.width / 2;
      this.boss.y = this.options.height * 0.32;
    }
    if (!inBoss) this.boss.alive = false;

    if (a.elapsed >= a.duration) {
      a.phase = 'finished';
      a.active = false;
      this.boss.alive = false;
    }
  }

  /** Seconds remaining before the stage timer expires. */
  timeRemaining(limitSeconds: number): number {
    return Math.max(0, limitSeconds - this.attempt.elapsed);
  }

  /**
   * Kills per second for the current mode.
   *
   * Idle farming uses the sim's rate directly. An attempt has to clear a finite
   * wave in exactly trashPhaseSeconds, so the rate is derived from what is
   * actually on screen - otherwise the field empties early and the player
   * watches nothing, or is still full when the boss arrives.
   */
  private effectiveKillRate(living: number): number {
    const a = this.attempt;
    if (!a.active) return this.options.killsPerSecond;
    // The boss phase is a duel; remaining stragglers stop dying so the boss is
    // unambiguously the thing being fought.
    if (a.phase !== 'trash') return 0;
    // trashSeconds is simulated; the caller multiplies by a real dt. Without
    // the speed factor the wave would only be a sixth cleared when the boss
    // arrives.
    const remaining = Math.max(0.2, a.trashSeconds - a.elapsed);
    return (living / remaining) * PLAYBACK_SPEED;
  }

  /** Local PRNG so the visual never reaches for Math.random either. */
  private random(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private spawn(enemy: CosmeticEnemy, placeOnScreen = false) {
    const { width, height } = this.options;
    const angle = this.random() * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    if (placeOnScreen) {
      // Seeding the first wave. Spawning everything off-screen leaves the
      // player watching an empty field for the first several seconds.
      let x: number;
      let y: number;
      do {
        x = this.random() * width;
        y = this.random() * height;
      } while (Math.hypot(x - this.player.x, y - this.player.y) < 70);
      enemy.x = x;
      enemy.y = y;
    } else {
      // Just beyond the edge *in that direction*, not on a circle around the
      // centre. A circle sized for the corners puts enemies approaching from
      // top and bottom hundreds of pixels further out than the ones from the
      // sides, and they trickle in for seconds.
      const toEdge = Math.min(
        Math.abs(cos) < 1e-6 ? Infinity : width / 2 / Math.abs(cos),
        Math.abs(sin) < 1e-6 ? Infinity : height / 2 / Math.abs(sin),
      );
      const radius = toEdge + 24 + this.random() * 40;
      enemy.x = width / 2 + cos * radius;
      enemy.y = height / 2 + sin * radius;
    }

    enemy.r = 5 + this.random() * 4;
    enemy.alive = true;

    const roster = enemySpritesForStage(this.options.stage);
    enemy.sprite = roster[Math.floor(this.random() * roster.length)] ?? 'enemy.slime';
    enemy.facing = 1;
  }

  private kill(enemy: CosmeticEnemy) {
    enemy.alive = false;
    if (this.floaters.length < MAX_FLOATERS) {
      const jitter = () => (this.random() - 0.5) * 14;
      this.floaters.push({
        x: enemy.x + jitter(),
        y: enemy.y + jitter(),
        text: Math.round(this.options.hitSize * (0.8 + this.random() * 0.4)).toString(),
        life: 0.9,
      });
    }
  }

  update(dt: number) {
    const { width, height, killsPerSecond } = this.options;

    // The player pilots itself. Movement is cosmetic by design: outcomes were
    // already decided, so a kiting orbit is enough to look deliberate.
    this.orbitAngle += dt * PLAYER_ORBIT_SPEED;
    this.player.x = width / 2 + Math.cos(this.orbitAngle) * width * PLAYER_ORBIT_RADIUS;
    this.player.y = height / 2 + Math.sin(this.orbitAngle * 1.3) * height * PLAYER_ORBIT_RADIUS;

    let living = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      living++;
      const dx = this.player.x - enemy.x;
      const dy = this.player.y - enemy.y;
      const distance = Math.hypot(dx, dy) || 1;
      enemy.x += (dx / distance) * ENEMY_SPEED * dt;
      enemy.y += (dy / distance) * ENEMY_SPEED * dt;
      // Only flip on decisive horizontal movement; near-vertical approaches
      // otherwise jitter left/right every frame.
      if (Math.abs(dx) > 4) enemy.facing = dx < 0 ? -1 : 1;
    }

    this.updateAttempt(dt);

    // During an attempt the wave is finite: it has to visibly empty as the
    // trash phase runs out, so nothing respawns. Idle farming is endless and
    // keeps the field full.
    if (!this.attempt.active) {
      const target = Math.min(MAX_ENEMIES, 90 + Math.floor(killsPerSecond * 4));
      for (const enemy of this.enemies) {
        if (living >= target) break;
        if (!enemy.alive) {
          this.spawn(enemy, !this.seeded);
          living++;
        }
      }
      this.seeded = true;
    }

    this.updateSwing(dt);

    // Kills are paid out of a fractional budget, so a rate of 0.3/s produces one
    // kill every ~3s rather than rounding to zero and freezing the screen.
    this.killCredit += this.effectiveKillRate(living) * dt;
    while (this.killCredit >= 1) {
      // Prefer something inside the sword's arc so the swing looks like the
      // cause. It is not - the abstract layer already decided the rate - but
      // kills landing in empty air read as a bug.
      const victim = this.livingInSwingArc() ?? this.nearestLiving();
      if (!victim) break;
      this.kill(victim);
      this.killCredit -= 1;
    }
    // A huge rate would otherwise queue kills faster than enemies can spawn.
    if (this.killCredit > 50) this.killCredit = 50;

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const floater = this.floaters[i];
      floater.life -= dt;
      floater.y -= 26 * dt;
      if (floater.life <= 0) this.floaters.splice(i, 1);
    }
  }

  /**
   * Advance the sword sweep.
   *
   * Cadence comes from the sim's attackSpeed, but nothing here feeds back into
   * it. The swing is a depiction of a decision already made.
   */
  private updateSwing(dt: number) {
    const rate = Math.max(
      0.2,
      Math.min(this.options.attacksPerSecond, MAX_VISUAL_SWINGS_PER_SECOND),
    );
    const interval = 1 / rate;

    this.swingClock += dt;
    if (this.swingClock >= interval) {
      this.swingClock -= interval;
      // Aim where the fight is. Holding the previous aim when the field is
      // empty avoids the blade snapping back to angle zero between waves.
      const target = this.nearestLiving();
      if (target) {
        this.swing.aim = Math.atan2(target.y - this.player.y, target.x - this.player.x);
      }
      this.swing.active = true;
      this.swing.progress = 0;
    }

    if (!this.swing.active) return;

    this.swing.progress += dt / (interval * SWING_DUTY);
    if (this.swing.progress >= 1) {
      this.swing.progress = 1;
      this.swing.active = false;
    }
  }

  /** Angle the blade currently occupies. Meaningless while the swing is idle. */
  swingAngle(): number {
    return this.swing.aim - SWING_ARC + 2 * SWING_ARC * this.swing.progress;
  }

  /** Blade tip position, for the renderer. */
  swingPosition(): { x: number; y: number; rotation: number } {
    const angle = this.swingAngle();
    return {
      x: this.player.x + Math.cos(angle) * SWING_RADIUS,
      y: this.player.y + Math.sin(angle) * SWING_RADIUS,
      // The sprite's blade points up, so it needs a quarter turn to lie along
      // the radius rather than across it.
      rotation: angle + Math.PI / 2,
    };
  }

  private livingInSwingArc(): CosmeticEnemy | null {
    if (!this.swing.active) return null;
    const angle = this.swingAngle();
    const reach = SWING_RADIUS + 26;

    let best: CosmeticEnemy | null = null;
    let bestDistance = Infinity;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const dx = enemy.x - this.player.x;
      const dy = enemy.y - this.player.y;
      const distance = Math.hypot(dx, dy);
      if (distance > reach) continue;

      // Shortest signed angular difference, so the wrap at +/-PI does not
      // exclude everything on one side.
      let delta = Math.atan2(dy, dx) - angle;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      if (Math.abs(delta) > SWING_ARC * 0.6) continue;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = enemy;
      }
    }
    return best;
  }

  private nearestLiving(): CosmeticEnemy | null {
    let best: CosmeticEnemy | null = null;
    let bestDistance = Infinity;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const d = (enemy.x - this.player.x) ** 2 + (enemy.y - this.player.y) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = enemy;
      }
    }
    return best;
  }

  resize(width: number, height: number) {
    this.options = { ...this.options, width, height };
  }
}
