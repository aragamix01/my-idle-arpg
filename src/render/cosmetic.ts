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

export interface CosmeticEnemy {
  x: number;
  y: number;
  alive: boolean;
  /** Radius, so a few sizes break up the visual monotony of one circle repeated. */
  r: number;
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
  width: number;
  height: number;
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

export class StageVisual {
  readonly enemies: CosmeticEnemy[] = [];
  readonly floaters: Floater[] = [];
  player = { x: 0, y: 0 };

  private options: VisualOptions;
  private killCredit = 0;
  private orbitAngle = 0;
  private seed: number;

  constructor(options: VisualOptions) {
    this.options = options;
    this.seed = 0x1234_5678;
    this.player = { x: options.width / 2, y: options.height / 2 };
    for (let i = 0; i < MAX_ENEMIES; i++) {
      this.enemies.push({ x: 0, y: 0, alive: false, r: 6 });
    }
  }

  setOptions(options: VisualOptions) {
    this.options = options;
  }

  /** Local PRNG so the visual never reaches for Math.random either. */
  private random(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private spawn(enemy: CosmeticEnemy) {
    const { width, height } = this.options;
    // Ring outside the viewport, so enemies walk in rather than appearing.
    const angle = this.random() * Math.PI * 2;
    const radius = Math.max(width, height) * 0.62;
    enemy.x = width / 2 + Math.cos(angle) * radius;
    enemy.y = height / 2 + Math.sin(angle) * radius;
    enemy.r = 5 + this.random() * 4;
    enemy.alive = true;
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
    }

    // Keep the field populated. Density is pure spectacle; it has no effect on
    // the kill rate, which comes from the abstract layer.
    const target = Math.min(MAX_ENEMIES, 90 + Math.floor(killsPerSecond * 4));
    for (const enemy of this.enemies) {
      if (living >= target) break;
      if (!enemy.alive) {
        this.spawn(enemy);
        living++;
      }
    }

    // Kills are paid out of a fractional budget, so a rate of 0.3/s produces one
    // kill every ~3s rather than rounding to zero and freezing the screen.
    this.killCredit += killsPerSecond * dt;
    while (this.killCredit >= 1) {
      const victim = this.nearestLiving();
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
