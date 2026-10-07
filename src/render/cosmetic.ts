/**
 * The cosmetic layer.
 *
 * This is the half of the game that does not decide anything. The abstract
 * layer in src/sim/combat.ts already computed the kill rate; this arranges
 * creatures so that killing looks like it is happening at exactly that rate.
 *
 * A SIDE VIEW since Phase 7b: the hero holds the left of a dungeon floor and the
 * wave walks in from the right, queueing up to be cut down. Every position is a
 * FOOT position on that floor - the renderer anchors sprites at their base - so
 * "standing on the ground" is one number rather than a per-sprite size guess.
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
  /**
   * Running from the boss rather than toward the player.
   *
   * Set on every survivor when the boss lands. They are not killed: kills come out of
   * the sim's budget and these were never in it, so killing them here would invent
   * deaths - and floating damage numbers - the fight never paid for. They leave instead.
   */
  fleeing: boolean;
  /**
   * How far behind the front of the queue this one stops, in pixels.
   *
   * A wave that all stopped on the same pixel would read as one creature with a stack
   * of health bars. A per-enemy offset is what makes it a crowd pressing in.
   */
  hold: number;
}

/**
 * An item falling out of something that just died.
 *
 * Pops away from the corpse, slows, then homes into the player and vanishes -
 * "collected" without a pickup mechanic, which the abstract layer has nowhere to put.
 * Nothing here decides anything: the items were rolled before the first frame drew.
 */
export interface CosmeticDrop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  sprite: SpriteId;
  /** Seconds since it fell. Drives the toss-then-home handover. */
  age: number;
  alive: boolean;
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
  /**
   * Renders one floating damage number, given this hit's jitter multiplier.
   *
   * A formatter rather than a number, because damage outgrows a double and this layer
   * is deliberately kept on bounded values. The renderer owns the jitter - it is the
   * thing with the seeded RNG - and the caller owns how a magnitude reads.
   */
  hitLabel: (jitter: number) => string;
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
  /**
   * Where in the fight this is.
   *
   * `entrance` is the one phase that costs no simulated time - see `entrance` below.
   * It sits between the wave and the boss so the two are visibly different fights
   * rather than the same screen with a new sprite on it.
   */
  phase: 'trash' | 'entrance' | 'boss' | 'finished';
  /**
   * How far through the boss entrance, 0 to 1.
   *
   * REAL time, not simulated - the only value here that is. The sim decided
   * trashPhaseSeconds and bossPhaseSeconds and the countdown is reported against them,
   * so an entrance that consumed simulated seconds would be the cosmetic layer editing
   * the fight. It stops the clock instead: `elapsed` does not move while this does.
   *
   * Meaningless outside the entrance phase, where it holds whatever it last reached.
   */
  entrance: number;
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
  /**
   * Which of the three fights this is.
   *
   * Only the presentation differs - a boss sprite, a banner, and whether the idle
   * swarm is cleared. The playback machinery is identical, because `resolveDelve`
   * returns the same outcome shape with no trash phase whichever depth it ran.
   *
   * A boolean here would have had to mean "not a stage", which was true of a dungeon
   * only for as long as a dungeon was the only other thing.
   */
  kind: AttemptKind;
  /**
   * Tablet tier, for an Abyssal run. Zero otherwise.
   *
   * Carried rather than folded into `stage` because they are different numbers: a T7
   * fights at depth 152, and the banner has to say the tier - that is what the player
   * chose and what the tablet is called.
   */
  tier: number;
}

/**
 * Stage, dungeon, or Abyss.
 *
 * The cosmetic layer knows these apart only to draw them apart. Nothing here decides
 * anything - the sim resolved all three before the first frame.
 */
export type AttemptKind = 'stage' | 'dungeon' | 'abyssal';

/** Everything a replay needs. An object, because the last positional argument was the third. */
export interface AttemptSpec {
  outcome: AttemptOutcome;
  /** Ladder floor. For an Abyssal that is the tier's DEPTH, not the tier. */
  stage: number;
  kind?: AttemptKind;
  /** What the trash wave will drop, already rolled. Stages only. */
  waveDrops?: SpriteId[];
  tier?: number;
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
/** Same reasoning as MAX_FLOATERS: a huge clear must not flood the layer. */
const MAX_DROPS = 24;
/** Seconds a drop tumbles before it starts homing into the player. */
const DROP_TOSS_SECONDS = 0.35;

/**
 * How long the boss takes to arrive, in REAL seconds.
 *
 * Long enough to register as an event, short enough not to be a toll on someone who runs
 * hundreds of attempts - the whole replay is only a few real seconds at PLAYBACK_SPEED,
 * so this is a noticeable share of it and cannot be generous.
 *
 * The Abyss gets longer because it is the rarest fight in the game and, until this, its
 * boss simply existed on the first frame with nothing to mark the descent at all.
 */
const ENTRANCE_SECONDS: Record<AttemptKind, number> = {
  stage: 0.8,
  dungeon: 0.8,
  abyssal: 1.3,
};

/** The floor line, as a fraction of height. Everything stands on it. */
const GROUND = 0.76;
/**
 * How far the floor recedes, in pixels. Enemies stand at slightly different depths so
 * a queue reads as a crowd on a floor rather than a conga line on a tightrope.
 */
const LANE_DEPTH = 28;
/** Where the hero holds, as a fraction of width. */
const HERO_X = 0.22;
/** How far the hero steps forward to meet a boss, as a fraction of width. */
const DUEL_STEP = 0.1;
/** Where the boss stands once it has walked in, as a fraction of width. */
const BOSS_STAND_X = 0.68;
/** Where it starts walking from: this far past the right edge, in pixels. */
const BOSS_ENTRY_MARGIN = 90;
/** The front of the queue stops this far in front of the hero. */
const ENGAGE_DISTANCE = 58;
/** How deep the queue behind the front may spread, in pixels. */
const QUEUE_SPREAD = 70;
/** Survivors leave faster than they arrived, or the wave lingers into the duel. */
const FLEE_SPEED_MULT = 2.4;
/** Past this far outside the screen a fleeing enemy is gone for good. */
const FLEE_DESPAWN_MARGIN = 40;
/** Idle farming keeps this many on the floor. More is a smear, not a crowd, side on. */
const IDLE_CROWD = 14;
/**
 * A stage wave is topped up to this many when the attempt starts, queued off the right
 * edge so it marches in across the trash phase rather than all being on screen at once.
 */
const WAVE_SIZE = 28;
/** Height of the hero's chest above the floor - where the blade swings from. */
const CHEST = 24;

/** Fast at first, settling at the end. What makes the boss land rather than slide. */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Walking pace. Fast enough that a queue refills the front before the next swing, or the
 * hero spends the wave cutting at empty air while the crowd ambles in.
 */
const ENEMY_SPEED = 90;

/** Half-width of the sword sweep, radians. The blade covers 120 degrees. */
const SWING_ARC = Math.PI / 3;
/** How far the blade orbits from the player, in pixels. */
const SWING_RADIUS = 26;
/** How far in front of the hero a swing can land. The queue's front stands inside it. */
const SWING_REACH = ENGAGE_DISTANCE + 34;
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
  readonly drops: CosmeticDrop[] = [];

  /**
   * Sprites the wave is going to drop, in the order they will fall.
   *
   * Handed in by the caller, which rolled them with the same pure functions the
   * server will use. The alternative was a generic coin, which would be theatre - this
   * layer's rule is that the spectacle matches what the sim concluded, the same reason
   * killsPerSecond drives the kill rate rather than looking busy.
   */
  private pendingDrops: SpriteId[] = [];
  private dropsToSpawn = 0;
  private dropsSpawned = 0;
  player = { x: 0, y: 0 };
  readonly swing: Swing = { active: false, aim: 0, progress: 0 };

  readonly attempt: AttemptPlayback = {
    active: false,
    phase: 'finished',
    entrance: 0,
    elapsed: 0,
    duration: 0,
    trashSeconds: 0,
    bossSeconds: 0,
    playerHp: 1,
    bossHp: 1,
    stage: 1,
    cleared: false,
    failure: 'none',
    kind: 'stage',
    tier: 0,
  };

  /** The boss, alive only during the boss phase. */
  boss = { x: 0, y: 0, alive: false };

  private swingClock = 0;
  private outcome: AttemptOutcome | null = null;

  private options: VisualOptions;
  private killCredit = 0;
  /**
   * Real seconds this layer has been stepped. Drives the hero's idle bob, and is the
   * cheapest proof from outside that the ticker is running - the hero no longer roams.
   */
  clock = 0;
  private seed: number;
  /** First fill places enemies on screen; every fill after walks them in. */
  private seeded = false;

  constructor(options: VisualOptions) {
    this.options = options;
    this.seed = 0x1234_5678;
    this.player = { x: options.width * HERO_X, y: options.height * GROUND };
    for (let i = 0; i < MAX_ENEMIES; i++) {
      this.enemies.push({
        x: 0,
        y: 0,
        alive: false,
        r: 6,
        sprite: 'enemy.slime',
        facing: 1,
        fleeing: false,
        hold: 0,
      });
    }
  }

  setOptions(options: VisualOptions) {
    this.options = options;
  }

  /** Begin replaying a resolved attempt. Ignored while one is already running. */
  startAttempt({ outcome, stage, kind = 'stage', waveDrops = [], tier = 0 }: AttemptSpec) {
    if (this.attempt.active) return;

    // Truncated rather than queued. A stage deep enough to drop more than the layer
    // can hold would otherwise leave items trailing into the boss phase, long after
    // the enemies that were supposed to have dropped them.
    this.pendingDrops = waveDrops.slice(0, MAX_DROPS);
    this.dropsToSpawn = this.pendingDrops.length;
    this.dropsSpawned = 0;

    // A failure ends when the player died, not when the fight would have. The
    // boss slice of the replay shrinks to whatever was survived.
    const duration = outcome.cleared
      ? outcome.trashPhaseSeconds + outcome.bossPhaseSeconds
      : Math.max(0.6, outcome.seconds);

    this.outcome = outcome;
    Object.assign(this.attempt, {
      active: true,
      phase: 'trash' as const,
      entrance: 0,
      elapsed: 0,
      duration,
      trashSeconds: Math.min(outcome.trashPhaseSeconds, duration),
      bossSeconds: Math.max(0, duration - Math.min(outcome.trashPhaseSeconds, duration)),
      playerHp: 1,
      bossHp: 1,
      stage,
      cleared: outcome.cleared,
      failure: outcome.failure,
      kind,
      tier,
    });
    this.boss.alive = false;

    // A delve is a duel. The idle swarm is still on screen from farming, and
    // leaving it there would show a crowd standing around watching - they stop
    // dying the moment the boss phase starts, so they would simply pile up.
    if (kind !== 'stage') {
      for (const enemy of this.enemies) enemy.alive = false;
      return;
    }

    // A stage is a wave, and a wave is more than the idle crowd. The rest queue off the
    // right edge and march in across the trash phase - the rate they die at is still
    // `effectiveKillRate`, which counts them, so a bigger wave dies faster rather than
    // making the phase run long.
    let alive = this.enemies.filter((enemy) => enemy.alive).length;
    let queued = 0;
    for (const enemy of this.enemies) {
      if (alive >= WAVE_SIZE) break;
      if (!enemy.alive) {
        this.spawn(enemy, false, queued * 30);
        queued++;
        alive++;
      }
    }
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

    // The entrance, and the ONE place the simulated clock stands still.
    //
    // `elapsed` is not touched here, so no fight time passes: the countdown holds, the
    // health bars hold, and the outcome the sim reached is the outcome that plays. All
    // this buys is a moment for the player to see what they are now fighting.
    if (a.phase === 'entrance') {
      a.entrance = Math.min(1, a.entrance + dt / ENTRANCE_SECONDS[a.kind]);
      // Eased, so it strides in and plants rather than sliding at a constant rate.
      const landed = easeOutCubic(a.entrance);
      const from = this.options.width + BOSS_ENTRY_MARGIN;
      this.boss.x = from + (this.options.width * BOSS_STAND_X - from) * landed;
      this.boss.y = this.groundY();
      if (a.entrance >= 1) {
        a.phase = 'boss';
        // Anything that did not make the edge in time is gone anyway.
        //
        // Not a cheat covering a hole: a fleeing enemy fades out across the entrance
        // (the renderer reads `entrance` for its alpha), so by the moment this runs
        // they are already invisible. Without it a 400px screen full of survivors
        // would still hold a third of them when the duel starts, at zero opacity,
        // which is a crowd that exists only in the arrays.
        for (const enemy of this.enemies) {
          if (enemy.fleeing) {
            enemy.alive = false;
            enemy.fleeing = false;
          }
        }
      }
      return;
    }

    // elapsed is in simulated seconds; dt is real. This is the only place the
    // two are related.
    a.elapsed = Math.min(a.duration, a.elapsed + dt * PLAYBACK_SPEED);
    const reachedBoss = a.elapsed >= a.trashSeconds && a.bossSeconds > 0;

    // Crossing into the boss starts the entrance instead of the boss phase. Reaching it
    // from 'trash' is a sufficient once-only guard: the sequence never runs backwards,
    // and a delve has trashSeconds of 0 so it enters on its first frame - which is the
    // point, because until now its boss simply existed before the player looked.
    if (reachedBoss && a.phase === 'trash') {
      // Pinned exactly at the boundary rather than wherever the frame landed, so the
      // wave does not lose the fraction of a simulated second the crossing overshot by.
      a.elapsed = a.trashSeconds;
      a.phase = 'entrance';
      a.entrance = 0;
      this.boss.alive = true;
      this.boss.x = this.options.width + BOSS_ENTRY_MARGIN;
      this.boss.y = this.groundY();
      for (const enemy of this.enemies) {
        if (enemy.alive) enemy.fleeing = true;
      }
      return;
    }

    // Health drains at each phase's own rate rather than an average, which is
    // what makes a boss-phase death look like a boss-phase death.
    const trashProgress = a.trashSeconds > 0 ? Math.min(1, a.elapsed / a.trashSeconds) : 1;
    const bossProgress =
      a.bossSeconds > 0 ? Math.min(1, Math.max(0, a.elapsed - a.trashSeconds) / a.bossSeconds) : 0;

    const taken =
      this.outcome.trashDamageFraction * trashProgress +
      this.outcome.bossDamageFraction * bossProgress;
    a.playerHp = Math.max(0, 1 - taken);
    a.bossHp = reachedBoss ? Math.max(0, 1 - bossProgress) : 1;

    if (reachedBoss) {
      // Re-derived every frame rather than pinned once at the entrance, so rotating a
      // phone mid-duel does not leave the boss standing where the old viewport was.
      this.boss.x = this.options.width * BOSS_STAND_X;
      this.boss.y = this.groundY();
    } else {
      this.boss.alive = false;
    }

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
   * How far the fight has closed into a duel: 0 during the wave, 1 once the boss stands.
   *
   * Eased across the entrance so the player drifts up to meet the boss over the same
   * moment the boss is falling, rather than snapping into position when it lands.
   */
  private duelClosing(): number {
    const a = this.attempt;
    if (!a.active) return 0;
    if (a.phase === 'boss') return 1;
    if (a.phase === 'entrance') return easeOutCubic(a.entrance);
    return 0;
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

  /**
   * Put an enemy on the lane.
   *
   * `behind` is how far past the right edge it starts, so a batch spawned together
   * arrives as a queue rather than as one clump that crosses the screen in step.
   */
  private spawn(enemy: CosmeticEnemy, placeOnScreen = false, behind = 0) {
    const { width } = this.options;
    const front = this.player.x + ENGAGE_DISTANCE;

    if (placeOnScreen) {
      // Seeding the first wave. Spawning everything off-screen leaves the player
      // watching an empty floor for the first several seconds.
      enemy.x = front + this.random() * Math.max(40, width - front);
    } else {
      enemy.x = width + 24 + behind + this.random() * 40;
    }
    // Depth on the floor: a little forward or back of the line, never through the wall.
    enemy.y = this.groundY() + (this.random() - 0.35) * LANE_DEPTH;
    enemy.hold = this.random() * QUEUE_SPREAD;

    enemy.r = 5 + this.random() * 4;
    enemy.alive = true;
    // Reset, because the array is a pool: a slot that fled the last boss would
    // otherwise respawn already running for the edge.
    enemy.fleeing = false;

    const roster = enemySpritesForStage(this.options.stage);
    enemy.sprite = roster[Math.floor(this.random() * roster.length)] ?? 'enemy.slime';
    enemy.facing = 1;
  }

  private kill(enemy: CosmeticEnemy) {
    enemy.alive = false;
    this.maybeDrop(enemy.x, enemy.y);
    if (this.floaters.length < MAX_FLOATERS) {
      const jitter = () => (this.random() - 0.5) * 14;
      this.floaters.push({
        x: enemy.x + jitter(),
        y: enemy.y - 34 + jitter(),
        text: this.options.hitLabel(0.8 + this.random() * 0.4),
        life: 0.9,
      });
    }
  }

  /**
   * Drop an item out of this corpse, if one is due.
   *
   * Paced by progress through the TRASH PHASE rather than by a per-kill chance, so the
   * items that fall are exactly the items the clear will hand over - no more, no fewer,
   * and spread across the wave instead of arriving in a heap. Attaching it to a kill is
   * what makes loot come out of something rather than out of the air.
   */
  private maybeDrop(x: number, y: number) {
    if (this.dropsSpawned >= this.dropsToSpawn) return;

    // ACTIVE and in the trash phase, both required. The first cut read
    // `active && phase !== 'trash'`, which is false when no attempt is running at
    // all - so every drop fell out of an idle-farming kill after the replay had
    // finished. The wave played with no loot and then four items appeared, which is
    // precisely the behaviour this was written to remove.
    if (!this.attempt.active || this.attempt.phase !== 'trash') return;

    if (this.attempt.trashSeconds > 0) {
      const progress = Math.min(1, this.attempt.elapsed / this.attempt.trashSeconds);
      if (this.dropsSpawned >= Math.ceil(progress * this.dropsToSpawn)) return;
    }

    const sprite = this.pendingDrops[this.dropsSpawned];
    this.dropsSpawned++;
    if (!sprite || this.drops.length >= MAX_DROPS) return;

    // Up and back toward the hero, the way loot spills out of something cut down.
    this.drops.push({
      x,
      y: y - 20,
      vx: -20 - this.random() * 50,
      vy: -150 - this.random() * 60,
      sprite,
      age: 0,
      alive: true,
    });
  }

  private updateDrops(dt: number) {
    for (const drop of this.drops) {
      drop.age += dt;

      if (drop.age < DROP_TOSS_SECONDS) {
        // Arcing out of the corpse under gravity.
        drop.x += drop.vx * dt;
        drop.y += drop.vy * dt;
        drop.vy += 620 * dt;
        continue;
      }

      // Homing, and ACCELERATING - a constant speed reads as drifting, where a pull
      // that tightens reads as being collected.
      const dx = this.player.x - drop.x;
      const dy = this.player.y - drop.y;
      const distance = Math.hypot(dx, dy) || 1;
      if (distance < 10) {
        drop.alive = false;
        continue;
      }
      const pull = 260 + (drop.age - DROP_TOSS_SECONDS) * 900;
      drop.x += (dx / distance) * pull * dt;
      drop.y += (dy / distance) * pull * dt;
    }

    // Compacted in place: the array is read every frame by the renderer, and a
    // filter would hand it a new one sixty times a second.
    let write = 0;
    for (let read = 0; read < this.drops.length; read++) {
      // Nothing should orbit forever if the player somehow never arrives.
      if (this.drops[read].alive && this.drops[read].age < 6) {
        this.drops[write++] = this.drops[read];
      }
    }
    this.drops.length = write;
  }

  update(dt: number) {
    const { width, killsPerSecond } = this.options;

    // The hero holds the left of the floor. It steps forward to meet a boss as the boss
    // strides in, so the duel closes from both sides rather than one.
    this.clock += dt;
    this.player.x = width * (HERO_X + DUEL_STEP * this.duelClosing());
    // A one-pixel breath. Enough to read as alive on a sprite with no animation frames.
    this.player.y = this.groundY() - (Math.sin(this.clock * 5) > 0.6 ? 1 : 0);

    let living = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;

      // Survivors of the wave run for the edge and are gone.
      //
      // They used to keep walking into the player forever: effectiveKillRate returns 0
      // outside the trash phase, so nothing killed them, and the duel played behind a
      // pile of immortal enemies with the boss somewhere behind it. That is what made
      // the boss look slow to arrive - it was there, and you could not find it.
      if (enemy.fleeing) {
        // Back the way they came - out to the right, the way the boss is arriving from.
        enemy.x += ENEMY_SPEED * FLEE_SPEED_MULT * dt;
        enemy.facing = 1;
        if (enemy.x > width + FLEE_DESPAWN_MARGIN) {
          enemy.alive = false;
          enemy.fleeing = false;
        }
        continue;
      }

      living++;
      // Walk left until reaching your place in the queue, then hold it.
      const stopAt = this.player.x + ENGAGE_DISTANCE + enemy.hold;
      if (enemy.x > stopAt) enemy.x = Math.max(stopAt, enemy.x - ENEMY_SPEED * dt);
      // Facing the hero, which is always to the left.
      enemy.facing = -1;
    }

    this.updateAttempt(dt);

    // During an attempt the wave is finite: it has to visibly empty as the
    // trash phase runs out, so nothing respawns. Idle farming is endless and
    // keeps the field full.
    if (!this.attempt.active) {
      const target = Math.min(MAX_ENEMIES, IDLE_CROWD + Math.floor(Math.min(killsPerSecond, 10)));
      let queued = 0;
      for (const enemy of this.enemies) {
        if (living >= target) break;
        if (!enemy.alive) {
          this.spawn(enemy, !this.seeded, queued * 26);
          queued++;
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

    // Loot is paced by the SCHEDULE, not by when a kill happens to land. Hooking it
    // to kill() alone means a wave whose deaths cluster - and they do, because the
    // replay compresses a 75-second fight into a few seconds - drops everything in a
    // burst or, at the tail, not at all. maybeDrop still gates on the schedule, so
    // this only fires for a drop that is genuinely due, and it still comes out of a
    // live enemy rather than out of the air.
    if (this.attempt.active && this.attempt.phase === 'trash') {
      // Falls back to a point beside the player when nothing is left alive, and that
      // case is not hypothetical: the wave is finite and drains on purpose, so the
      // LAST scheduled drop comes due exactly when the field is emptiest. Without the
      // fallback the tail of every clear would silently drop nothing.
      const victim = this.enemies.find((enemy) => enemy.alive);
      const x = victim ? victim.x : this.player.x + (this.random() - 0.5) * 60;
      const y = victim ? victim.y : this.player.y + (this.random() - 0.5) * 60;
      this.maybeDrop(x, y);
    }

    this.updateDrops(dt);
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
      //
      // The boss takes priority once it is on the floor, and it has to: this searched
      // only the `enemies` array, which the boss is not in, so the whole duel played
      // with the player swinging at trash while the boss's bar fell on its own.
      const target =
        this.boss.alive && this.attempt.phase === 'boss' ? this.boss : this.nearestLiving();
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
      y: this.player.y - CHEST + Math.sin(angle) * SWING_RADIUS,
      // The sprite's blade points up, so it needs a quarter turn to lie along
      // the radius rather than across it.
      rotation: angle + Math.PI / 2,
    };
  }

  private livingInSwingArc(): CosmeticEnemy | null {
    if (!this.swing.active) return null;
    const angle = this.swingAngle();
    const reach = SWING_REACH;

    let best: CosmeticEnemy | null = null;
    let bestDistance = Infinity;
    for (const enemy of this.enemies) {
      // Fleeing enemies are excluded from both target searches, or the blade tracks a
      // runner off the edge while the boss it should be pointing at stands untouched.
      if (!enemy.alive || enemy.fleeing) continue;
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
      if (!enemy.alive || enemy.fleeing) continue;
      const d = (enemy.x - this.player.x) ** 2 + (enemy.y - this.player.y) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = enemy;
      }
    }
    return best;
  }

  /** The floor line every foot position stands on. */
  groundY(): number {
    return this.options.height * GROUND;
  }

  resize(width: number, height: number) {
    this.options = { ...this.options, width, height };
  }
}
