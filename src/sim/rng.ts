/**
 * Deterministic PRNG for the simulation.
 *
 * The sim must never call Math.random(). Offline progress is recomputed on the
 * server from the player's save, so every random roll has to be reproducible
 * from (seed, sequence). See src/sim/README.md.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Independent stream derived from this one; does not advance the parent. */
  fork(salt: number): Rng;
  /** Current internal state, for persisting mid-run randomness. */
  snapshot(): number;
}

/** mulberry32 — small, fast, good enough distribution for gameplay rolls. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    range: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    fork: (salt) => createRng((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0),
    snapshot: () => state,
  };
}

/** Rebuild an Rng that was persisted mid-stream. */
export function restoreRng(state: number): Rng {
  return createRng(state);
}
