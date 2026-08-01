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
    visual.startAttempt({ outcome: OUTCOME, stage: 40, waveDrops: drops });

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
    visual.startAttempt({ outcome: OUTCOME, stage: 40, waveDrops: drops });

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
    visual.startAttempt({ outcome: OUTCOME, stage: 40, waveDrops: drops });

    run(visual, 20);
    expect(visual.drops).toHaveLength(0);
  });

  it('moves them toward the player rather than away', () => {
    const visual = idling();
    visual.startAttempt({ outcome: OUTCOME, stage: 40, waveDrops: drops });

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
    visual.startAttempt({ outcome: OUTCOME, stage: 40 });
    run(visual, 9);
    expect(visual.drops).toHaveLength(0);
  });

  it('does not carry a wave into the next attempt', () => {
    // startAttempt replaces the queue. A leftover would show items falling from a
    // fight that has already been paid out.
    const visual = idling();
    visual.startAttempt({ outcome: OUTCOME, stage: 40, waveDrops: drops });
    run(visual, 20);

    visual.startAttempt({ outcome: OUTCOME, stage: 40 });
    run(visual, 9);
    expect(visual.drops).toHaveLength(0);
  });
});

describe('what kind of fight this is', () => {
  /** A delve: one boss, no trash phase, which is what resolveDelve returns. */
  const DUEL = { ...OUTCOME, seconds: 6, trashPhaseSeconds: 0, bossPhaseSeconds: 6 };

  it('carries the tier, because the depth is a different number', () => {
    // The banner says the tier - it is what the player picked off the shelf and what
    // the tablet is named for - while `stage` is the floor the fight actually happens
    // at. Folding them into one field would make T7 read as "ABYSS 152".
    const visual = idling();
    visual.startAttempt({ outcome: DUEL, stage: 152, kind: 'abyssal', tier: 7 });

    expect(visual.attempt.kind).toBe('abyssal');
    expect(visual.attempt.tier).toBe(7);
    expect(visual.attempt.stage).toBe(152);
  });

  it('clears the idle swarm for every duel, not just for dungeons', () => {
    // The swarm stops dying the moment the boss phase starts, so leaving it up shows a
    // crowd standing around watching. This was a `dungeon` boolean, and the Abyss was
    // the case that proved a boolean could not say which of three fights it was.
    for (const kind of ['dungeon', 'abyssal'] as const) {
      const visual = idling();
      expect(visual.enemies.some((enemy) => enemy.alive)).toBe(true);
      visual.startAttempt({ outcome: DUEL, stage: 152, kind, tier: 7 });
      expect(visual.enemies.some((enemy) => enemy.alive)).toBe(false);
    }
  });

  it('leaves a stage as a stage', () => {
    const visual = idling();
    visual.startAttempt({ outcome: OUTCOME, stage: 40 });
    expect(visual.attempt.kind).toBe('stage');
    expect(visual.attempt.tier).toBe(0);
    expect(visual.enemies.some((enemy) => enemy.alive)).toBe(true);
  });
});

/**
 * The boss entrance.
 *
 * Every one of these was driven from node rather than watched, for the reason at the top
 * of this file: the replay advances on requestAnimationFrame, and the pane the browser
 * tools drive does not composite. Watching cannot see any of it.
 */
describe('the boss arrives', () => {
  const DUEL = { ...OUTCOME, seconds: 6, trashPhaseSeconds: 0, bossPhaseSeconds: 6 };

  /** Step until the predicate holds, or give up. Returns the frames it took. */
  function runUntil(visual: StageVisual, done: () => boolean, limitSeconds = 20): number {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(limitSeconds / dt); i++) {
      if (done()) return i;
      visual.update(dt);
    }
    return -1;
  }

  it('stops the simulated clock while the boss falls', () => {
    // THE assertion that decides whether this is cosmetic. The sim owns
    // trashPhaseSeconds and bossPhaseSeconds and the countdown is reported against them,
    // so an entrance that spent simulated seconds would be the renderer editing the
    // fight rather than depicting it.
    const visual = idling();
    visual.startAttempt({ outcome: OUTCOME, stage: 40 });

    expect(runUntil(visual, () => visual.attempt.phase === 'entrance')).toBeGreaterThan(0);
    const frozen = visual.attempt.elapsed;
    // Pinned exactly at the boundary, not wherever the crossing frame landed.
    expect(frozen).toBeCloseTo(visual.attempt.trashSeconds, 9);

    const seen = new Set<number>();
    runUntil(visual, () => visual.attempt.phase !== 'entrance');
    // Re-run the same window sampling every frame, since runUntil steps past it.
    const second = idling();
    second.startAttempt({ outcome: OUTCOME, stage: 40 });
    runUntil(second, () => second.attempt.phase === 'entrance');
    while (second.attempt.phase === 'entrance') {
      seen.add(second.attempt.elapsed);
      second.update(1 / 60);
    }
    expect([...seen]).toEqual([frozen]);
  });

  it('spends no simulated time at all, so the fight still runs its full length', () => {
    // The counterweight to the assertion above. Freezing the clock would be just as
    // wrong if the replay then ended early.
    const visual = idling();
    visual.startAttempt({ outcome: OUTCOME, stage: 40 });
    run(visual, 20);

    expect(visual.attempt.phase).toBe('finished');
    expect(visual.attempt.elapsed).toBeCloseTo(visual.attempt.duration, 9);
  });

  it('holds the boss at full health until it has landed', () => {
    // "The boss is slow to appear but its HP is already going down" was the report. The
    // bar does not exist during the entrance and the value behind it does not move.
    const visual = idling();
    visual.startAttempt({ outcome: OUTCOME, stage: 40 });
    runUntil(visual, () => visual.attempt.phase === 'entrance');

    while (visual.attempt.phase === 'entrance') {
      expect(visual.attempt.bossHp).toBe(1);
      expect(visual.boss.alive).toBe(true);
      visual.update(1 / 60);
    }

    run(visual, 0.3);
    expect(visual.attempt.phase).toBe('boss');
    expect(visual.attempt.bossHp).toBeLessThan(1);
  });

  it('scatters the survivors of a wave that ended early', () => {
    /*
      Survivors are the exception, and measuring said so: the drain rate is
      `living / remaining`, so a 50-second trash phase - what a real stage actually
      produces - reliably ends at zero enemies. They only pile up when the wave barely
      runs, which is a character massively overpowering a stage:

          trashPhaseSeconds  0.05  0.5   2    5    9+
          alive at entrance   122   15    3    1    0

      So this is insurance rather than the common path, and it is worth having: without
      it those survivors are immortal (effectiveKillRate returns 0 outside the trash
      phase) and keep walking into the player right through the duel.
    */
    const rushed = { ...OUTCOME, trashPhaseSeconds: 0.05, seconds: 3.05, bossPhaseSeconds: 3 };
    const visual = idling();
    visual.startAttempt({ outcome: rushed, stage: 40 });

    runUntil(visual, () => visual.attempt.phase === 'entrance');
    expect(visual.enemies.some((enemy) => enemy.fleeing)).toBe(true);

    runUntil(visual, () => visual.attempt.phase === 'boss');
    expect(visual.enemies.filter((enemy) => enemy.alive)).toHaveLength(0);
  });

  it('leaves an ordinary wave already empty', () => {
    const visual = idling();
    visual.startAttempt({ outcome: OUTCOME, stage: 40 });
    runUntil(visual, () => visual.attempt.phase === 'boss');

    expect(visual.attempt.phase).toBe('boss');
    expect(visual.enemies.filter((enemy) => enemy.alive)).toHaveLength(0);
  });

  it('runs the phases once each, in order', () => {
    const visual = idling();
    visual.startAttempt({ outcome: OUTCOME, stage: 40 });

    const order: string[] = [];
    run(visual, 20, () => {
      const phase = visual.attempt.phase;
      if (order[order.length - 1] !== phase) order.push(phase);
    });

    expect(order).toEqual(['trash', 'entrance', 'boss', 'finished']);
  });

  it('starts a delve already arriving, and takes longer in the Abyss', () => {
    // A delve has no wave to transition out of, so the entrance IS its opening - which
    // is the point, because the Abyssal boss used to simply exist on the first frame.
    const entranceFrames = (kind: 'dungeon' | 'abyssal') => {
      const visual = idling();
      visual.startAttempt({ outcome: DUEL, stage: 152, kind, tier: 7 });
      visual.update(1 / 60);
      expect(visual.attempt.phase).toBe('entrance');
      return runUntil(visual, () => visual.attempt.phase !== 'entrance');
    };

    const dungeon = entranceFrames('dungeon');
    const abyssal = entranceFrames('abyssal');
    expect(dungeon).toBeGreaterThan(0);
    expect(abyssal).toBeGreaterThan(dungeon);
  });

  it('points the blade at the boss once the duel is on', () => {
    // It aimed at nearestLiving(), which searches the enemies array - and the boss is
    // not in it. So the player swung at trash for the whole duel while the boss's bar
    // fell on its own, which is exactly "nothing is happening to it".
    const visual = new StageVisual({ ...OPTIONS, attacksPerSecond: 8 });
    for (let i = 0; i < 120; i++) visual.update(1 / 60);
    visual.startAttempt({ outcome: OUTCOME, stage: 40 });
    runUntil(visual, () => visual.attempt.phase === 'boss');
    // Far enough in for the swing clock to have fired at least once on the boss.
    run(visual, 0.3);

    const toBoss = Math.atan2(
      visual.boss.y - visual.player.y,
      visual.boss.x - visual.player.x,
    );
    let delta = visual.swing.aim - toBoss;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    // Not exact: the aim is set when the swing fires and the player keeps orbiting
    // after it. A few degrees of drift is the animation working, not a miss.
    expect(Math.abs(delta)).toBeLessThan(0.35);
  });
});
