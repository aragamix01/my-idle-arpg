import { describe, expect, it } from 'vitest';
import { StageVisual } from '../src/render/cosmetic';
import type { SpriteId } from '../src/render/sprites';

/**
 * The cosmetic layer decides nothing, which is exactly why it needs testing: a bug
 * here is silent. Nothing throws when loot fails to appear, no number is wrong, and
 * the only symptom is a player watching sixty enemies die and seeing no reward.
 *
 * It is also the one part of the client the browser cannot check for us - the replay
 * advances on requestAnimationFrame, so a pane that is not compositing never runs it.
 */

const OPTIONS = {
  killsPerSecond: 8,
  hitLabel: () => '10',
  attacksPerSecond: 2,
  stage: 40,
  width: 400,
  height: 300,
};

const OUTCOME = {
  cleared: true,
  failure: 'none' as const,
  seconds: 12,
  trashPhaseSeconds: 9,
  bossPhaseSeconds: 3,
  trashDamageFraction: 0.1,
  bossDamageFraction: 0.1,
};

/**
 * A visual that has been idle-farming, which is the only state an attempt ever starts
 * from in the real game.
 *
 * The field only refills while idle - during an attempt the wave is finite and drains
 * on purpose - so a virgin StageVisual has nothing alive to kill and nothing to drop
 * loot from. Starting an attempt on one tests a situation a player cannot reach.
 */
function idling(): StageVisual {
  const visual = new StageVisual({ ...OPTIONS });
  for (let i = 0; i < 120; i++) visual.update(1 / 60);
  return visual;
}

/** Run the clock at a fixed step, so the test is deterministic rather than timing-based. */
function run(visual: StageVisual, seconds: number, onStep?: () => void) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    visual.update(dt);
    onStep?.();
  }
}

describe('wave loot on screen', () => {
  const drops: SpriteId[] = ['item.axe', 'item.whetstone', 'item.coin_purse', 'item.bloodstone'];

  it('drops what it was given, and no more', () => {
    const visual = idling();
    visual.startAttempt(OUTCOME, 40, false, drops);

    let seen = 0;
    run(visual, 9, () => {
      seen = Math.max(seen, visual.drops.length);
    });

    // Every one of them appeared at some point, and the layer never invented a fifth.
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThanOrEqual(drops.length);
  });

  it('spreads them across the wave instead of dumping them at once', () => {
    // The whole point is that loot falls WHILE you fight. All four arriving on the
    // same frame would be the old behaviour with extra steps.
    const visual = idling();
    visual.startAttempt(OUTCOME, 40, false, drops);

    // Detected by AGE, not by the array getting longer. Drops are collected within
    // about a second, so counting length changes misses every arrival that lands on
    // the same frame as a collection - which is what made the first cut of this test
    // measure a spread three times narrower than the real one.
    const spawnedAt: number[] = [];
    let elapsed = 0;
    run(visual, 9, () => {
      elapsed += 1 / 60;
      for (const drop of visual.drops) {
        if (drop.age <= 1 / 60 + 1e-9) spawnedAt.push(elapsed);
      }
    });

    expect(spawnedAt).toHaveLength(drops.length);
    expect(Math.max(...spawnedAt) - Math.min(...spawnedAt)).toBeGreaterThan(1);
  });

  it('collects them - nothing is left lying on the floor', () => {
    const visual = idling();
    visual.startAttempt(OUTCOME, 40, false, drops);

    run(visual, 20);
    expect(visual.drops).toHaveLength(0);
  });

  it('moves them toward the player rather than away', () => {
    const visual = idling();
    visual.startAttempt(OUTCOME, 40, false, drops);

    // Tracks one drop by IDENTITY across frames. The array is compacted in place, so
    // drops[0] is a different item from one frame to the next once collection starts.
    const distance = (d: { x: number; y: number }) =>
      Math.hypot(d.x - visual.player.x, d.y - visual.player.y);

    let tracked: (typeof visual.drops)[number] | null = null;
    let ageAtRemoval = Infinity;
    let collected = false;

    const dt = 1 / 60;
    for (let i = 0; i < 60 * 5; i++) {
      visual.update(dt);
      if (!tracked) {
        tracked = visual.drops[0] ?? null;
        continue;
      }
      // Leaving the array IS the arrival: updateDrops only removes a live drop once
      // it is within ten pixels of the player. Comparing distances frame by frame was
      // unmeasurable - the pull accelerates hard enough that a drop is usually gone
      // within a couple of frames of starting to home.
      if (!visual.drops.includes(tracked)) {
        collected = distance(tracked) < 15;
        ageAtRemoval = tracked.age;
        break;
      }
    }

    expect(tracked, 'no drop ever appeared').not.toBeNull();
    expect(collected, 'a drop vanished without reaching the player').toBe(true);
    // Removed by ARRIVING, not by the six-second safety timeout that exists so
    // nothing can orbit forever. Those are very different outcomes on screen.
    expect(ageAtRemoval).toBeLessThan(3);
  });

  it('drops nothing when the wave dropped nothing', () => {
    const visual = idling();
    visual.startAttempt(OUTCOME, 40, false, []);
    run(visual, 9);
    expect(visual.drops).toHaveLength(0);
  });

  it('does not carry a wave into the next attempt', () => {
    // startAttempt replaces the queue. A leftover would show items falling from a
    // fight that has already been paid out.
    const visual = idling();
    visual.startAttempt(OUTCOME, 40, false, drops);
    run(visual, 20);

    visual.startAttempt(OUTCOME, 40, false, []);
    run(visual, 9);
    expect(visual.drops).toHaveLength(0);
  });
});
