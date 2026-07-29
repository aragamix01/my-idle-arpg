import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { report, runLadder } from '../scripts/balance';
import {
  applyCommand,
  ARTIFACTS,
  BULK_PURCHASE_LIMIT,
  bulkUpgradeCost,
  CLEAR_TIME_BAND_SECONDS,
  CommandSchema,
  computeOffline,
  createRng,
  feedbackExponent,
  sideExponents,
  newSave,
  OFFLINE_CAP_SECONDS,
  resolveStage,
  UPGRADE_TRACKS,
  upgradeCost,
  validateRegistry,
  type Command,
  type SaveState,
} from '../src/sim';

const T0 = 1_700_000_000_000;

/** Run a command sequence, asserting each one succeeds. */
function play(save: SaveState, commands: Command[], nowMs = T0): SaveState {
  let state = save;
  for (const cmd of commands) {
    const result = applyCommand(state, cmd, nowMs);
    if (!result.ok) throw new Error(`${cmd.type} failed: ${result.error}`);
    state = result.value.state;
  }
  return state;
}

describe('determinism', () => {
  it('same seed and same commands produce identical state', () => {
    const commands: Command[] = [
      { type: 'attemptStage' },
      { type: 'buyUpgrade', key: 'damage' },
      { type: 'attemptStage' },
      { type: 'buyUpgrade', key: 'health' },
      { type: 'attemptStage' },
    ];

    const a = play(newSave(42, T0), commands);
    const b = play(newSave(42, T0), commands);

    expect(a).toEqual(b);
  });

  it('different seeds diverge on drops', () => {
    // The drop table is seeded per account, so two accounts clearing the same
    // stage should not be guaranteed the same artifact.
    const owned = (seed: number) => {
      let state = newSave(seed, T0);
      for (let i = 0; i < 12; i++) {
        state = play(state, [{ type: 'attemptStage' }]);
      }
      return state.artifactsOwned.join(',');
    };
    const results = new Set([owned(1), owned(2), owned(3), owned(4), owned(5)]);
    expect(results.size).toBeGreaterThan(1);
  });

  it('the PRNG never touches Math.random', () => {
    const rng = createRng(7);
    const first = [rng.next(), rng.next(), rng.next()];
    const second = createRng(7);
    expect([second.next(), second.next(), second.next()]).toEqual(first);
  });
});

describe('offline claim', () => {
  const farmingSave = (): SaveState => ({
    ...newSave(1, T0),
    bestStage: 10,
    upgrades: { ...newSave(1, T0).upgrades, damage: 20, area: 8 },
  });

  it('pays out proportional to elapsed time', () => {
    const save = farmingSave();
    const oneHour = computeOffline(save, T0 + 3600_000);
    const twoHours = computeOffline(save, T0 + 7200_000);
    expect(twoHours.goldEarned).toBeGreaterThan(oneHour.goldEarned);
    expect(twoHours.goldEarned / oneHour.goldEarned).toBeCloseTo(2, 1);
  });

  it('caps accrual', () => {
    const save = farmingSave();
    const atCap = computeOffline(save, T0 + OFFLINE_CAP_SECONDS * 1000);
    const wayPastCap = computeOffline(save, T0 + OFFLINE_CAP_SECONDS * 1000 * 10);
    expect(wayPastCap.goldEarned).toBe(atCap.goldEarned);
    expect(wayPastCap.capped).toBe(true);
  });

  it('cannot be double-claimed', () => {
    // The classic idle exploit: claim, then immediately claim again.
    const save = farmingSave();
    const now = T0 + 4 * 3600_000;

    const first = applyCommand(save, { type: 'claimOffline' }, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.state.gold).toBeGreaterThan(0);

    const second = applyCommand(first.value.state, { type: 'claimOffline' }, now);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.state.gold).toBe(first.value.state.gold);
  });

  it('never pays out for time before the last claim', () => {
    const save = farmingSave();
    const report = computeOffline(save, T0 - 60_000);
    expect(report.goldEarned).toBe(0);
  });
});

describe('command validation', () => {
  it('rejects an upgrade the player cannot afford', () => {
    const result = applyCommand(newSave(1, T0), { type: 'buyUpgrade', key: 'damage' }, T0);
    expect(result.ok).toBe(false);
  });

  it('rejects equipping an artifact the player does not own', () => {
    const result = applyCommand(
      newSave(1, T0),
      { type: 'equipArtifact', slot: 0, artifactId: 'bloodstone' },
      T0,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a stage that is not unlocked', () => {
    const result = applyCommand(newSave(1, T0), { type: 'setStage', stage: 50 }, T0);
    expect(result.ok).toBe(false);
  });

  it('deducts exactly the quoted cost', () => {
    const rich: SaveState = { ...newSave(1, T0), gold: 1000 };
    const cost = upgradeCost('damage', 0);
    const result = applyCommand(rich, { type: 'buyUpgrade', key: 'damage' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.gold).toBe(1000 - cost);
    expect(result.value.state.upgrades.damage).toBe(1);
  });

  it('charges the same for a bulk buy as for the same levels one at a time', () => {
    // If these diverge, the bulk button is either a discount or a penalty.
    // upgradeCost rounds each level up, so the geometric closed form is wrong
    // here by up to one gold per level.
    for (const key of ['damage', 'health', 'greed'] as const) {
      for (const count of [2, 5, 10, 37]) {
        const oneByOne = Array.from({ length: count }, (_, i) => upgradeCost(key, 3 + i)).reduce(
          (a, b) => a + b,
          0,
        );
        expect(bulkUpgradeCost(key, 3, count), `${key} x${count}`).toBe(oneByOne);
      }
    }
  });

  it('buying 10 at once equals buying 1 ten times', () => {
    const rich: SaveState = { ...newSave(1, T0), gold: 1_000_000 };

    const bulk = play(rich, [{ type: 'buyUpgrade', key: 'damage', count: 10 }]);
    const singles = play(
      rich,
      Array.from({ length: 10 }, () => ({ type: 'buyUpgrade', key: 'damage' }) as const),
    );

    expect(bulk.upgrades.damage).toBe(singles.upgrades.damage);
    expect(bulk.gold).toBe(singles.gold);
  });

  it('refuses a fixed multiplier it cannot fully afford', () => {
    // All-or-nothing: quietly buying 3 of a requested 20 spends gold on
    // something the player did not choose.
    const save: SaveState = { ...newSave(1, T0), gold: upgradeCost('damage', 0) + 1 };
    const result = applyCommand(save, { type: 'buyUpgrade', key: 'damage', count: 20 }, T0);
    expect(result.ok).toBe(false);
  });

  it('max spends what it can and never overdraws', () => {
    const save: SaveState = { ...newSave(1, T0), gold: 5000 };
    const result = applyCommand(save, { type: 'buyUpgrade', key: 'damage', count: 'max' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bought = result.value.state.upgrades.damage;
    expect(bought).toBeGreaterThan(0);
    expect(result.value.state.gold).toBeGreaterThanOrEqual(0);
    // Exactly maximal: one more level must not have been affordable.
    expect(bulkUpgradeCost('damage', 0, bought + 1)).toBeGreaterThan(5000);
  });

  it('max stops at a capped track rather than overshooting', () => {
    const key = 'crit';
    const cap = UPGRADE_TRACKS[key].maxLevel!;
    const save: SaveState = { ...newSave(1, T0), gold: Number.MAX_SAFE_INTEGER };
    const result = applyCommand(save, { type: 'buyUpgrade', key, count: 'max' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.upgrades[key]).toBe(cap);
  });

  it('rejects a count beyond the bulk limit at the schema boundary', () => {
    // Bounds how much work an untrusted 'count' can ask the server to do.
    expect(
      CommandSchema.safeParse({ type: 'buyUpgrade', key: 'damage', count: BULK_PURCHASE_LIMIT + 1 })
        .success,
    ).toBe(false);
    expect(CommandSchema.safeParse({ type: 'buyUpgrade', key: 'damage', count: 0 }).success).toBe(
      false,
    );
    expect(CommandSchema.safeParse({ type: 'buyUpgrade', key: 'damage', count: 2.5 }).success).toBe(
      false,
    );
  });

  it('still accepts a command with no count', () => {
    // Backward compatibility: a client predating bulk purchase omits the field.
    const rich: SaveState = { ...newSave(1, T0), gold: 1000 };
    const result = applyCommand(rich, { type: 'buyUpgrade', key: 'damage' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.upgrades.damage).toBe(1);
  });

  it('rejects malformed command payloads at the schema boundary', () => {
    expect(CommandSchema.safeParse({ type: 'buyUpgrade', key: 'nonsense' }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'equipArtifact', slot: 99, artifactId: null }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'attemptStage', extra: 1 }).success).toBe(false);
  });

  it('does not let an artifact occupy two slots', () => {
    let save: SaveState = { ...newSave(1, T0), artifactsOwned: ['whetstone'] };
    save = play(save, [
      { type: 'equipArtifact', slot: 0, artifactId: 'whetstone' },
      { type: 'equipArtifact', slot: 2, artifactId: 'whetstone' },
    ]);
    expect(save.loadout.filter((id) => id === 'whetstone')).toHaveLength(1);
    expect(save.loadout[2]).toBe('whetstone');
  });
});

describe('content registry', () => {
  it('parses against the effect schema', () => {
    const result = validateRegistry();
    expect(result).toEqual({ ok: true });
  });

  it('matches its snapshot', () => {
    // Unintended content edits show up as a diff here rather than as a
    // mysterious balance shift weeks later.
    expect(ARTIFACTS).toMatchSnapshot();
  });

  it('every artifact changes at least one outcome', () => {
    // An artifact whose effects are inert is a content bug, not a design choice.
    const base: SaveState = { ...newSave(1, T0), bestStage: 45, currentStage: 45 };
    const baseline = resolveStage(base, 45);

    for (const artifact of ARTIFACTS) {
      const equipped: SaveState = {
        ...base,
        artifactsOwned: [artifact.id],
        loadout: [artifact.id, null, null, null],
      };
      const outcome = resolveStage(equipped, 45);
      const changed =
        outcome.seconds !== baseline.seconds || outcome.goldEarned !== baseline.goldEarned;
      expect(changed, `${artifact.id} has no measurable effect`).toBe(true);
    }
  });
});

describe('economy invariants', () => {
  it('the feedback exponent stays below 1', () => {
    // Above 1, gold obeys dG/dt proportional to G^k with k > 1 and reaches
    // infinity in finite time. Measured at k = 1.9: the ladder collapsed from a
    // year to 37 minutes.
    expect(feedbackExponent()).toBeLessThan(1);
  });

  it('offence and defence grow at matching rates', () => {
    // Offence ahead of defence means the player over-kills and stages resolve
    // instantly. Measured with offence at 0.65 against defence at 0.35: clear
    // time fell from 49s to under 0.1s by stage 250.
    const { offence, defence } = sideExponents();
    expect(Math.abs(offence - defence)).toBeLessThan(0.05);
  });

  it('stage 1 is beatable with no upgrades', () => {
    const outcome = resolveStage(newSave(1, T0), 1);
    expect(outcome.cleared).toBe(true);
  });

  it('stage 1 is not trivially beatable', () => {
    // If the opening stage costs nothing, the first upgrade means nothing.
    const outcome = resolveStage(newSave(1, T0), 1);
    expect(outcome.damageTakenFraction).toBeGreaterThan(0.3);
  });

  it('every upgrade track is worth buying at some point', () => {
    // The Area track was silently unbuyable because target count was floored.
    const base: SaveState = { ...newSave(1, T0), bestStage: 30, currentStage: 30 };
    // trashPhaseSeconds, not seconds: on a failed attempt `seconds` is
    // truncated at the moment of death, which offense upgrades do not move.
    const offenseBaseline = resolveStage(base, 30).trashPhaseSeconds;

    for (const key of ['damage', 'attackSpeed', 'area', 'crit'] as const) {
      const bumped: SaveState = {
        ...base,
        upgrades: { ...base.upgrades, [key]: base.upgrades[key] + 1 },
      };
      expect(
        resolveStage(bumped, 30).trashPhaseSeconds,
        `${key} level 1 has no effect`,
      ).toBeLessThan(offenseBaseline);
    }

    const defenceBaseline = resolveStage(base, 30).damageTakenFraction;
    for (const key of ['health', 'toughness'] as const) {
      const bumped: SaveState = {
        ...base,
        upgrades: { ...base.upgrades, [key]: base.upgrades[key] + 1 },
      };
      expect(
        resolveStage(bumped, 30).damageTakenFraction,
        `${key} level 1 has no effect`,
      ).toBeLessThan(defenceBaseline);
    }
  });
});

describe('clear time stays watchable', () => {
  // The cosmetic layer only earns its keep if a stage lasts long enough to
  // watch. This degrades silently: it is invisible in unit tests, invisible in
  // the early game, and only shows up 150 stages in.
  const { rows } = runLadder();

  it('never collapses below the band', () => {
    const worst = rows.reduce((a, b) => (a.clearSeconds < b.clearSeconds ? a : b));
    expect(
      worst.clearSeconds,
      `stage ${worst.stage} resolves in ${worst.clearSeconds.toFixed(2)}s`,
    ).toBeGreaterThanOrEqual(CLEAR_TIME_BAND_SECONDS.min);
  });

  it('never exceeds the stage timer', () => {
    const worst = rows.reduce((a, b) => (a.clearSeconds > b.clearSeconds ? a : b));
    expect(worst.clearSeconds).toBeLessThanOrEqual(CLEAR_TIME_BAND_SECONDS.max);
  });

  it('does not drift downward across the ladder', () => {
    // Offence outrunning defence shows up here first: late stages resolving
    // much faster than early ones.
    const early = rows.slice(0, 20);
    const late = rows.slice(-20);
    const mean = (xs: typeof rows) => xs.reduce((s, r) => s + r.clearSeconds, 0) / xs.length;
    expect(mean(late)).toBeGreaterThan(mean(early) * 0.35);
  });
});

describe('balance curve', () => {
  it('matches the golden snapshot', () => {
    // Change a constant in curves.ts and this diff shows exactly how pacing
    // moved. Regenerate deliberately with `pnpm balance --write`.
    const golden = readFileSync(
      resolve(process.cwd(), 'tests/__snapshots__/balance.golden.txt'),
      'utf8',
    ).trimEnd();
    expect(report()).toBe(golden);
  }, 60_000);
});
