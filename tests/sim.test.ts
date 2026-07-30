import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { report, runLadder } from '../scripts/balance';
// The one place a test reaches into the UI layer: "two affixes must not read as
// the same line" is a claim about rendering, and asserting it against the raw
// numbers instead would not catch the rounding that caused it.
import { describeRolledAffix } from '../src/ui/format';
import {
  AFFIXES,
  AFFIX_LIMITS,
  affixRows,
  applyCommand,
  BASES,
  BASE_AFFIXES,
  BULK_PURCHASE_LIMIT,
  bulkUpgradeCost,
  CLEAR_TIME_BAND_SECONDS,
  CommandSchema,
  computeOffline,
  createRng,
  CURRENCIES,
  currencyLegality,
  deriveStats,
  DISSEMBLE_YIELD,
  DROPS_PER_CLEAR,
  DUNGEON_CURRENCY_PER_CLEAR,
  effectiveHp,
  enemyCount,
  enemyHp,
  feedbackExponent,
  FRAGMENTS_PER_CLEAR,
  getAffix,
  getBaseAffix,
  getCurrency,
  KEY_DROP_CHANCE,
  sideExponents,
  newSave,
  OFFLINE_CAP_SECONDS,
  INVENTORY_CAP,
  itemEffects,
  migrateSave,
  rerollCost,
  resolveDungeon,
  resolveStage,
  rollItem,
  rollDungeonCurrency,
  rollDungeonItem,
  rollStageBossDrops,
  statsDps,
  UNIQUES,
  UPGRADE_TRACKS,
  upgradeCost,
  validateRegistry,
  type Command,
  type CurrencyId,
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
    // Drops are seeded per account, so two accounts clearing the same stages
    // must not receive identical loot. Compared on rolled content rather than
    // uid, since uids are just a counter and always match.
    const owned = (seed: number) => {
      let state = newSave(seed, T0);
      for (let i = 0; i < 12; i++) {
        state = play(state, [{ type: 'attemptStage' }]);
      }
      return state.items
        .map((item) => `${item.rarity}:${item.baseId}:${item.affixes.map((a) => `${a.affixId}@${a.tier}`).join('+')}`)
        .join(',');
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
      { type: 'equipItem', slot: 0, itemId: 'bloodstone' },
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
    expect(CommandSchema.safeParse({ type: 'equipItem', slot: 99, itemId: null }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'attemptStage', extra: 1 }).success).toBe(false);
  });

  it('does not let an item occupy two slots', () => {
    const item = rollItem(1, 1, 10);
    let save: SaveState = { ...newSave(1, T0), items: [item] };
    save = play(save, [
      { type: 'equipItem', slot: 0, itemId: item.uid },
      { type: 'equipItem', slot: 2, itemId: item.uid },
    ]);
    expect(save.loadout.filter((uid) => uid === item.uid)).toHaveLength(1);
    expect(save.loadout[2]).toBe(item.uid);
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
    expect({ affixes: AFFIXES, bases: BASES, uniques: UNIQUES }).toMatchSnapshot();
  });

  it('every unique changes at least one outcome', () => {
    // A unique whose effects are inert is a content bug, not a design choice.
    const base: SaveState = { ...newSave(1, T0), bestStage: 45, currentStage: 45 };
    const baseline = resolveStage(base, 45);

    for (const unique of UNIQUES) {
      const item = {
        uid: 'test',
        baseId: unique.id,
        rarity: 'unique' as const,
        itemLevel: 45,
        affixes: [],
        rerolls: 0,
        crafts: 0,
        uniqueId: unique.id,
      };
      const equipped: SaveState = {
        ...base,
        items: [item],
        loadout: [item.uid, null, null, null],
      };
      const outcome = resolveStage(equipped, 45);
      const changed =
        outcome.seconds !== baseline.seconds || outcome.goldEarned !== baseline.goldEarned;
      expect(changed, `${unique.id} has no measurable effect`).toBe(true);
    }
  });

  it('every affix changes at least one outcome', () => {
    const base: SaveState = { ...newSave(1, T0), bestStage: 45, currentStage: 45 };
    const baseline = resolveStage(base, 45);

    for (const affix of AFFIXES) {
      const top = affix.tiers.length - 1;
      const item = {
        uid: 'test',
        baseId: 'whetstone',
        rarity: 'common' as const,
        itemLevel: 100,
        affixes: [{ affixId: affix.id, tier: top, value: affix.tiers[top].value }],
        rerolls: 0,
        crafts: 0,
      };
      const equipped: SaveState = {
        ...base,
        items: [item],
        loadout: [item.uid, null, null, null],
      };
      const outcome = resolveStage(equipped, 45);
      const changed =
        outcome.seconds !== baseline.seconds || outcome.goldEarned !== baseline.goldEarned;
      expect(changed, `${affix.id} has no measurable effect`).toBe(true);
    }
  });
});

describe('item rolling', () => {
  it('is fully determined by seed, uid and reroll count', () => {
    // The client predicts drops optimistically and the server re-runs the same
    // code. A disagreement here would show a player an item they do not own.
    expect(rollItem(1234, 7, 30)).toEqual(rollItem(1234, 7, 30));
    expect(rollItem(1234, 7, 30)).not.toEqual(rollItem(1234, 8, 30));
    expect(rollItem(1234, 7, 30)).not.toEqual(rollItem(9999, 7, 30));
  });

  it('never rolls a tier the item level cannot reach', () => {
    // The whole point of item level: a stage-3 drop must never be
    // best-in-slot, or deep stages stop mattering for loot.
    for (let uid = 1; uid < 400; uid++) {
      const item = rollItem(42, uid, 3);
      for (const rolled of item.affixes) {
        const affix = AFFIXES.find((a) => a.id === rolled.affixId)!;
        expect(affix.tiers[rolled.tier].minStage, `${affix.id} on a stage-3 item`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('rolls the affix counts its rarity allows', () => {
    for (let uid = 1; uid < 400; uid++) {
      const item = rollItem(7, uid, 120);
      const limits = AFFIX_LIMITS[item.rarity];
      const prefixes = item.affixes.filter(
        (r) => AFFIXES.find((a) => a.id === r.affixId)?.kind === 'prefix',
      );
      const suffixes = item.affixes.filter(
        (r) => AFFIXES.find((a) => a.id === r.affixId)?.kind === 'suffix',
      );
      expect(prefixes).toHaveLength(limits.prefix);
      expect(suffixes).toHaveLength(limits.suffix);
    }
  });

  it('never puts two affixes on an item that read as the same line', () => {
    // Two defensive stats exist, so a third defensive affix has to share one -
    // and Armoured plus Warded on the same rare rendered "+1% Toughness"
    // twice, which reads as a duplicate-render bug rather than two mods.
    // The affixes must differ in magnitude at every tier they share.
    for (let uid = 1; uid < 600; uid++) {
      for (const level of [1, 20, 50, 100]) {
        const item = rollItem(17, uid, level);
        const lines = [
          ...(item.baseAffix ? [item.baseAffix] : []),
          ...item.affixes,
        ].map((rolled) => describeRolledAffix(rolled).text);
        expect(new Set(lines).size, `${lines.join(' / ')}`).toBe(lines.length);
      }
    }
  });

  it('never rolls the same affix twice on one item', () => {
    // Duplicates would turn the power budget into an unbounded stacking problem.
    for (let uid = 1; uid < 400; uid++) {
      const item = rollItem(11, uid, 120);
      const ids = item.affixes.map((a) => a.affixId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('gives every non-unique its base implicit, within the item level gates', () => {
    for (let uid = 1; uid < 400; uid++) {
      const item = rollItem(21, uid, 20);
      if (item.rarity === 'unique') continue;

      const implicit = getBaseAffix(item.baseId)!;
      expect(item.baseAffix, `${item.baseId} rolled without an implicit`).toBeDefined();
      expect(item.baseAffix!.affixId).toBe(implicit.id);
      // Same gate rule as rolled affixes: a stage-20 item cannot carry a
      // tier that unlocks at 40.
      expect(implicit.tiers[item.baseAffix!.tier].minStage).toBeLessThanOrEqual(20);
    }
  });

  it('lets the base implicit reach every tier its level allows', () => {
    // A base whose implicit always rolls the same tier is a fixed bonus wearing
    // a tier badge, and picking between two of the same base stops mattering.
    const tiers = new Set(
      Array.from({ length: 600 }, (_, i) => rollItem(31, i + 1, 200))
        .filter((item) => item.baseId === 'whetstone' && item.baseAffix)
        .map((item) => item.baseAffix!.tier),
    );
    expect(tiers.size).toBeGreaterThan(1);
  });

  it('gives uniques fixed effects and no affixes', () => {
    const uniques = Array.from({ length: 600 }, (_, i) => rollItem(3, i + 1, 60)).filter(
      (item) => item.rarity === 'unique',
    );
    expect(uniques.length).toBeGreaterThan(0);
    for (const item of uniques) {
      expect(item.affixes).toEqual([]);
      expect(itemEffects(item).length).toBeGreaterThan(0);
    }
  });
});

describe('rerolling', () => {
  const richSave = (item: ReturnType<typeof rollItem>): SaveState => ({
    ...newSave(5, T0),
    gold: 1e12,
    items: [item],
  });

  const rollableItem = () => {
    for (let uid = 1; uid < 200; uid++) {
      const item = rollItem(5, uid, 60);
      if (item.rarity === 'rare') return item;
    }
    throw new Error('no rare rolled');
  };

  it('keeps rarity, base and item level, and charges the quoted cost', () => {
    const item = rollableItem();
    const save = richSave(item);
    const cost = rerollCost(item.rarity, item.itemLevel, item.rerolls);

    const result = applyCommand(save, { type: 'rerollItem', uid: item.uid }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.value.state.items[0];
    expect(after.rarity).toBe(item.rarity);
    expect(after.baseId).toBe(item.baseId);
    expect(after.itemLevel).toBe(item.itemLevel);
    expect(after.rerolls).toBe(1);
    expect(result.value.state.gold).toBe(save.gold - cost);
  });

  it('leaves the base implicit untouched', () => {
    // The implicit is the guaranteed half of an item. A reroll that could
    // improve it would collapse base choice into "reroll until it is good",
    // which is exactly what it exists to prevent.
    const item = rollableItem();
    expect(item.baseAffix).toBeDefined();

    let save = richSave(item);
    for (let i = 0; i < 5; i++) {
      const result = applyCommand(save, { type: 'rerollItem', uid: item.uid }, T0);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      save = result.value.state;
      expect(save.items[0].baseAffix).toEqual(item.baseAffix);
    }
  });

  it('gets more expensive each time', () => {
    // Flat pricing would let a player park on one item and grind it to perfect
    // tiers for pocket change.
    const first = rerollCost('rare', 40, 0);
    const fifth = rerollCost('rare', 40, 4);
    expect(fifth).toBeGreaterThan(first * 2);
  });

  it('refuses a reroll that cannot be afforded', () => {
    const item = rollableItem();
    const save: SaveState = { ...newSave(5, T0), gold: 0, items: [item] };
    expect(applyCommand(save, { type: 'rerollItem', uid: item.uid }, T0).ok).toBe(false);
  });

  it('refuses to reroll a unique', () => {
    const unique = Array.from({ length: 600 }, (_, i) => rollItem(3, i + 1, 60)).find(
      (item) => item.rarity === 'unique',
    )!;
    const save = richSave(unique);
    const result = applyCommand(save, { type: 'rerollItem', uid: unique.uid }, T0);
    expect(result.ok).toBe(false);
  });
});

describe('inventory', () => {
  it('refuses drops when full instead of growing without bound', () => {
    const full: SaveState = {
      ...newSave(1, T0),
      bestStage: 0,
      currentStage: 1,
      items: Array.from({ length: INVENTORY_CAP }, (_, i) => rollItem(1, i + 1, 5)),
      nextItemId: INVENTORY_CAP + 1,
    };
    const result = applyCommand(full, { type: 'attemptStage' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.state.items).toHaveLength(INVENTORY_CAP);
    const full_ = result.value.events.find((e) => e.type === 'inventoryFull');
    expect(full_).toBeDefined();
    // The event has to say how much was lost, or a player who cleared with one
    // free slot and a three-item drop has no way to know two vanished.
    expect(full_ && full_.type === 'inventoryFull' && full_.lost).toBeGreaterThan(0);
  });

  it('advances the uid counter for drops the inventory could not take', () => {
    // Reusing a uid after a lost drop would make the replacement item roll
    // identically to the one that fell on the floor.
    const full: SaveState = {
      ...newSave(1, T0),
      items: Array.from({ length: INVENTORY_CAP }, (_, i) => rollItem(1, i + 1, 5)),
      nextItemId: INVENTORY_CAP + 1,
    };
    const result = applyCommand(full, { type: 'attemptStage' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.nextItemId).toBeGreaterThan(full.nextItemId);
  });

  it('drops between one and three items on a clear', () => {
    const counts = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const result = applyCommand(newSave(seed, T0), { type: 'attemptStage' }, T0);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const dropped = result.value.events.filter((e) => e.type === 'itemDropped').length;
      expect(dropped).toBeGreaterThanOrEqual(DROPS_PER_CLEAR.min);
      expect(dropped).toBeLessThanOrEqual(DROPS_PER_CLEAR.max);
      counts.add(dropped);
    }
    // A range that only ever produces one value is not a range.
    expect(counts.size).toBeGreaterThan(1);
  });

  it('refuses to discard an equipped item', () => {
    // Destroying what you are currently wearing is the most expensive misclick
    // available, and an unequip step costs nothing to undo.
    const item = rollItem(2, 1, 10);
    const save: SaveState = { ...newSave(2, T0), items: [item] };
    const equipped = play(save, [{ type: 'equipItem', slot: 1, itemId: item.uid }]);

    const refused = applyCommand(equipped, { type: 'dissembleItems', uids: [item.uid] }, T0);
    expect(refused.ok).toBe(false);

    const after = play(equipped, [
      { type: 'equipItem', slot: 1, itemId: null },
      { type: 'dissembleItems', uids: [item.uid] },
    ]);
    expect(after.items).toHaveLength(0);
  });
});

describe('currency', () => {
  /** A save holding one item and a stack of every currency. */
  const withCurrency = (item: ReturnType<typeof rollItem>): SaveState => ({
    ...newSave(5, T0),
    gold: 1e12,
    items: [item],
    currency: Object.fromEntries(CURRENCIES.map((c) => [c.id, 20])),
  });

  const itemOfRarity = (rarity: string, seed = 5, level = 60) => {
    for (let uid = 1; uid < 800; uid++) {
      const item = rollItem(seed, uid, level);
      if (item.rarity === rarity) return item;
    }
    throw new Error(`no ${rarity} rolled`);
  };

  const craft = (save: SaveState, currencyId: CurrencyId, uid: string) =>
    applyCommand(save, { type: 'applyCurrency', currencyId, uid }, T0);

  it('rerolls only the prefixes, leaving suffixes byte-identical', () => {
    // The entire point of a targeted reroll. If the other side moves at all,
    // this is a full reroll with extra steps.
    const item = itemOfRarity('rare');
    const save = withCurrency(item);
    const suffixesBefore = item.affixes.filter((a) => getAffix(a.affixId)?.kind === 'suffix');

    const result = craft(save, 'sacred-idol', item.uid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.value.state.items[0];
    expect(after.affixes.filter((a) => getAffix(a.affixId)?.kind === 'suffix')).toEqual(
      suffixesBefore,
    );
    expect(after.affixes.filter((a) => getAffix(a.affixId)?.kind === 'prefix')).not.toEqual(
      item.affixes.filter((a) => getAffix(a.affixId)?.kind === 'prefix'),
    );
  });

  it('rerolls only the suffixes, leaving prefixes byte-identical', () => {
    const item = itemOfRarity('rare');
    const prefixesBefore = item.affixes.filter((a) => getAffix(a.affixId)?.kind === 'prefix');

    const result = craft(withCurrency(item), 'dark-idol', item.uid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.state.items[0].affixes.filter((a) => getAffix(a.affixId)?.kind === 'prefix'),
    ).toEqual(prefixesBefore);
  });

  it('angel flame keeps the modifiers and changes only their tiers', () => {
    const item = itemOfRarity('rare', 5, 120);
    const result = craft(withCurrency(item), 'angel-flame', item.uid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.value.state.items[0];
    expect(after.affixes.map((a) => a.affixId)).toEqual(item.affixes.map((a) => a.affixId));
    // The value must track the tier, or the panel shows a number the sim does
    // not apply.
    for (const rolled of after.affixes) {
      const affix = getAffix(rolled.affixId)!;
      expect(rolled.value).toBe(affix.tiers[rolled.tier].value);
    }
  });

  it('ore raises rarity and keeps what was already rolled', () => {
    // Losing the existing modifiers would make an ore a reroll in disguise.
    const item = itemOfRarity('common');
    const result = craft(withCurrency(item), 'magic-ore', item.uid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.value.state.items[0];
    expect(after.rarity).toBe('magic');
    for (const before of item.affixes) expect(after.affixes).toContainEqual(before);
    expect(after.affixes.length).toBe(item.affixes.length + 1);
  });

  it('refuses an ore on the wrong rarity, with the reason the UI shows', () => {
    const rare = itemOfRarity('rare');
    const result = craft(withCurrency(rare), 'magic-ore', rare.uid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('common items only');
    // Same string, same rules - the modal greys the option out with this.
    expect(currencyLegality(rare, getCurrency('magic-ore')!, false)).toBe(result.error);
  });

  it('refuses any currency the player does not hold', () => {
    const item = itemOfRarity('common');
    const broke: SaveState = { ...withCurrency(item), currency: {} };
    const result = craft(broke, 'magic-ore', item.uid);
    expect(result.ok).toBe(false);
  });

  it('spends exactly one of the currency used', () => {
    const item = itemOfRarity('rare');
    const save = withCurrency(item);
    const result = craft(save, 'angel-flame', item.uid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.currency['angel-flame']).toBe(
      (save.currency['angel-flame'] ?? 0) - 1,
    );
  });

  it('applies one spirit and refuses a second, forever', () => {
    const item = itemOfRarity('rare');
    const first = craft(withCurrency(item), 'bishop-spirit', item.uid);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const spirited = first.value.state.items[0];
    expect(spirited.spirit).toBe('bishop-spirit');
    expect(spirited.spiritDelta).toBeDefined();

    for (const id of ['bishop-spirit', 'devil-spirit', 'dune-spirit'] as CurrencyId[]) {
      const second = craft(first.value.state, id, item.uid);
      expect(second.ok, `${id} was allowed on a spirited item`).toBe(false);
    }
  });

  it('gives a spirited item the affix count its delta claims', () => {
    // affixRows is the single source of truth. If the rolled count and the
    // displayed count come apart, the panel is lying about the item.
    for (const id of ['bishop-spirit', 'devil-spirit', 'dune-spirit'] as CurrencyId[]) {
      for (let seed = 1; seed <= 12; seed++) {
        const item = itemOfRarity('rare', seed, 120);
        const result = craft(withCurrency(item), id, item.uid);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;

        const after = result.value.state.items[0];
        const rows = affixRows(after);
        const prefixes = after.affixes.filter((a) => getAffix(a.affixId)?.kind === 'prefix');
        const suffixes = after.affixes.filter((a) => getAffix(a.affixId)?.kind === 'suffix');
        expect(prefixes, `${id} prefixes`).toHaveLength(rows.prefix);
        expect(suffixes, `${id} suffixes`).toHaveLength(rows.suffix);
      }
    }
  });

  it('bishop and devil keep the total at four rows; dune can reach five', () => {
    const total = (id: CurrencyId, seed: number) => {
      const item = itemOfRarity('rare', seed, 120);
      const result = craft(withCurrency(item), id, item.uid);
      if (!result.ok) return 0;
      const rows = affixRows(result.value.state.items[0]);
      return rows.prefix + rows.suffix;
    };

    for (let seed = 1; seed <= 8; seed++) {
      expect(total('bishop-spirit', seed)).toBe(4);
      expect(total('devil-spirit', seed)).toBe(4);
    }
    // Dune is the only route to a fifth row - that is what makes it the
    // rarest thing that drops, and what the craft ceiling budgets for.
    const duneTotals = new Set(Array.from({ length: 24 }, (_, i) => total('dune-spirit', i + 1)));
    expect(duneTotals).toContain(5);
    expect(Math.max(...duneTotals)).toBe(5);
  });

  it('refuses a spirit on anything but a rare', () => {
    for (const rarity of ['common', 'magic']) {
      const item = itemOfRarity(rarity);
      const result = craft(withCurrency(item), 'dune-spirit', item.uid);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBe('rare items only');
    }
  });

  it('keeps a spirit rows through a gold reroll', () => {
    // Gold must not undo a permanent, one-shot decision.
    const item = itemOfRarity('rare');
    const spirited = craft(withCurrency(item), 'devil-spirit', item.uid);
    expect(spirited.ok).toBe(true);
    if (!spirited.ok) return;

    const before = affixRows(spirited.value.state.items[0]);
    const rerolled = applyCommand(spirited.value.state, { type: 'rerollItem', uid: item.uid }, T0);
    expect(rerolled.ok).toBe(true);
    if (!rerolled.ok) return;

    const after = rerolled.value.state.items[0];
    expect(after.spirit).toBe('devil-spirit');
    expect(affixRows(after)).toEqual(before);
    expect(after.affixes.filter((a) => getAffix(a.affixId)?.kind === 'prefix')).toHaveLength(
      before.prefix,
    );
  });

  it('angel droplet either transmutes or destroys, and never on an equipped item', () => {
    const outcomes = { transmuted: 0, destroyed: 0 };

    for (let seed = 1; seed <= 60; seed++) {
      const item = itemOfRarity('common', seed);
      const result = craft(withCurrency(item), 'angel-droplet', item.uid);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const state = result.value.state;
      if (state.items.length === 0) outcomes.destroyed++;
      else if (state.items[0].rarity === 'unique') outcomes.transmuted++;
    }

    // Roughly one in ten, so both branches must show up over sixty tries.
    expect(outcomes.destroyed).toBeGreaterThan(0);
    expect(outcomes.transmuted).toBeGreaterThan(0);
    expect(outcomes.destroyed).toBeGreaterThan(outcomes.transmuted);

    const equipped = itemOfRarity('common');
    const worn: SaveState = { ...withCurrency(equipped), loadout: [equipped.uid, null, null, null] };
    const refused = craft(worn, 'angel-droplet', equipped.uid);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe('unequip it first');
  });

  it('refuses every currency on a unique', () => {
    const unique = itemOfRarity('unique', 3);
    for (const currency of CURRENCIES) {
      if (currency.tier === 'fragment' || currency.tier === 'key') continue;
      const result = craft(withCurrency(unique), currency.id, unique.uid);
      expect(result.ok, `${currency.id} was allowed on a unique`).toBe(false);
    }
  });

  it('combines ten fragments into one currency, and refuses nine', () => {
    const base = newSave(1, T0);
    const nine: SaveState = { ...base, currency: { 'magic-ore-shard': 9 } };
    expect(applyCommand(nine, { type: 'combineFragments', currencyId: 'magic-ore-shard' }, T0).ok)
      .toBe(false);

    const ten: SaveState = { ...base, currency: { 'magic-ore-shard': 10 } };
    const result = applyCommand(
      ten,
      { type: 'combineFragments', currencyId: 'magic-ore-shard' },
      T0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.currency['magic-ore-shard']).toBe(0);
    expect(result.value.state.currency['magic-ore']).toBe(1);
  });

  it('dissembles into the fragment its rarity is worth', () => {
    for (const rarity of ['common', 'magic', 'rare', 'unique'] as const) {
      const item = itemOfRarity(rarity, rarity === 'unique' ? 3 : 5);
      const save: SaveState = { ...newSave(5, T0), items: [item] };
      const result = applyCommand(save, { type: 'dissembleItems', uids: [item.uid] }, T0);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.state.items).toHaveLength(0);
      expect(result.value.state.currency[DISSEMBLE_YIELD[rarity]]).toBe(1);
    }
  });

  it('dissembles many items in one command, crediting every yield', () => {
    const items = [1, 2, 3, 4, 5].map((uid) => rollItem(5, uid, 40));
    const save: SaveState = { ...newSave(5, T0), items };

    const result = applyCommand(
      save,
      { type: 'dissembleItems', uids: items.map((item) => item.uid) },
      T0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.state.items).toHaveLength(0);

    // Every item's yield lands, grouped by the fragment its rarity is worth.
    const expected: Record<string, number> = {};
    for (const item of items) {
      const id = DISSEMBLE_YIELD[item.rarity];
      expected[id] = (expected[id] ?? 0) + 1;
    }
    for (const [id, count] of Object.entries(expected)) {
      expect(result.value.state.currency[id as CurrencyId], id).toBe(count);
    }
  });

  it('destroys nothing when any item in the list is invalid', () => {
    // Melting eleven items and then failing on the twelfth would leave a player
    // unable to tell what they still owned.
    const items = [1, 2, 3].map((uid) => rollItem(5, uid, 40));
    const save: SaveState = { ...newSave(5, T0), items };

    const result = applyCommand(
      save,
      { type: 'dissembleItems', uids: [...items.map((i) => i.uid), 'nonexistent'] },
      T0,
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a bulk dissemble containing an equipped item', () => {
    const items = [1, 2, 3].map((uid) => rollItem(5, uid, 40));
    const save: SaveState = {
      ...newSave(5, T0),
      items,
      loadout: [items[1].uid, null, null, null],
    };

    const result = applyCommand(
      save,
      { type: 'dissembleItems', uids: items.map((i) => i.uid) },
      T0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('unequip it first');
  });

  it('pays out once for an item named twice', () => {
    const item = rollItem(5, 1, 40);
    const save: SaveState = { ...newSave(5, T0), items: [item] };

    const result = applyCommand(
      save,
      { type: 'dissembleItems', uids: [item.uid, item.uid, item.uid] },
      T0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.currency[DISSEMBLE_YIELD[item.rarity]]).toBe(1);
  });

  it('bounds the list at the schema boundary', () => {
    // The list comes from an untrusted client, so its length has to be capped
    // before it reaches the handler.
    const tooMany = Array.from({ length: INVENTORY_CAP + 1 }, (_, i) => String(i + 1));
    expect(CommandSchema.safeParse({ type: 'dissembleItems', uids: tooMany }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'dissembleItems', uids: [] }).success).toBe(false);
  });

  it('is fully determined by seed, uid and craft count', () => {
    // The property the whole optimistic-prediction model rests on. A craft the
    // client and server disagreed about would show a player an item they do
    // not own.
    const run = () => {
      const item = itemOfRarity('common');
      let save = withCurrency(item);
      for (const id of ['magic-ore', 'rare-ore', 'angel-flame', 'sacred-idol'] as CurrencyId[]) {
        const result = craft(save, id, item.uid);
        if (!result.ok) throw new Error(`${id}: ${result.error}`);
        save = result.value.state;
      }
      return save.items[0];
    };
    expect(run()).toEqual(run());
  });

  it('a currency craft and a gold reroll draw different numbers', () => {
    // Both used to key off `rerolls`. Sharing a stream would make "reroll,
    // flame, reroll" reproduce the first reroll's result exactly.
    const item = itemOfRarity('rare');
    const save = withCurrency(item);

    const viaGold = applyCommand(save, { type: 'rerollItem', uid: item.uid }, T0);
    const viaFlame = craft(save, 'angel-flame', item.uid);
    expect(viaGold.ok && viaFlame.ok).toBe(true);
    if (!viaGold.ok || !viaFlame.ok) return;

    const thenGold = applyCommand(viaFlame.value.state, { type: 'rerollItem', uid: item.uid }, T0);
    expect(thenGold.ok).toBe(true);
    if (!thenGold.ok) return;
    expect(thenGold.value.state.items[0].affixes).not.toEqual(viaGold.value.state.items[0].affixes);
  });
});

describe('boss drops', () => {
  it('drops fragments within the configured range', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const purse = rollStageBossDrops(seed, seed * 3, 60);
      const fragments = Object.entries(purse)
        .filter(([id]) => getCurrency(id)?.tier === 'fragment')
        .reduce((sum, [, count]) => sum + count, 0);
      expect(fragments).toBeLessThanOrEqual(FRAGMENTS_PER_CLEAR.max);
      expect(fragments).toBeGreaterThanOrEqual(FRAGMENTS_PER_CLEAR.min);
    }
  });

  it('gates the better fragments behind stage', () => {
    // Same rule as affix tiers: an early clear must not hand out the shards
    // that build the best currency, or pushing deeper stops paying.
    const early = new Set<string>();
    for (let uid = 1; uid <= 300; uid++) {
      for (const id of Object.keys(rollStageBossDrops(7, uid, 3))) early.add(id);
    }
    expect(early.has('magic-ore-shard')).toBe(true);
    expect(early.has('rare-ore-shard')).toBe(false);
    expect(early.has('angel-droplet-shard')).toBe(false);
  });

  it('drops keys at roughly the configured rate', () => {
    const trials = 3000;
    let keys = 0;
    for (let uid = 1; uid <= trials; uid++) {
      if (rollStageBossDrops(11, uid, 40)['dungeon-key']) keys++;
    }
    expect(keys / trials).toBeGreaterThan(KEY_DROP_CHANCE - 0.04);
    expect(keys / trials).toBeLessThan(KEY_DROP_CHANCE + 0.04);
  });
});

describe('dungeons', () => {
  /** A save strong enough to win a dungeon at its best stage, holding keys. */
  const runner = (keys = 3): SaveState => ({
    ...newSave(9, T0),
    bestStage: 20,
    currentStage: 21,
    upgrades: { ...newSave(9, T0).upgrades, damage: 60, health: 40, attackSpeed: 30, toughness: 30 },
    currency: { 'dungeon-key': keys },
  });

  it('refuses without a key', () => {
    const result = applyCommand({ ...runner(0) }, { type: 'attemptDungeon' }, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('you have no dungeon keys');
  });

  it('refuses before any stage has been cleared', () => {
    const fresh: SaveState = { ...newSave(1, T0), currency: { 'dungeon-key': 5 } };
    expect(applyCommand(fresh, { type: 'attemptDungeon' }, T0).ok).toBe(false);
  });

  it('is a pure duel with no trash phase', () => {
    const outcome = resolveDungeon(runner(), 20);
    expect(outcome.trashPhaseSeconds).toBe(0);
    expect(outcome.trashDamageFraction).toBe(0);
    expect(outcome.bossPhaseSeconds).toBeGreaterThan(0);
  });

  it('is harder than the stage boss it is built from', () => {
    // If a dungeon were not meaningfully harder, the key would be a formality
    // rather than a decision about whether to spend it.
    const save = runner();
    const stage = resolveStage(save, 20);
    const dungeon = resolveDungeon(save, 20);
    expect(dungeon.bossPhaseSeconds).toBeGreaterThan(stage.bossPhaseSeconds * 2);
  });

  it('spends the key on a win', () => {
    const save = runner();
    const result = applyCommand(save, { type: 'attemptDungeon' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events.map((e) => e.type)).toContain('dungeonCleared');
    expect(result.value.state.currency['dungeon-key']).toBe(2);
  });

  it('spends the key on a loss too, and pays nothing', () => {
    // The pressure that makes running one at the edge of your power a real
    // decision. A refunded key would make failure free.
    const weak: SaveState = { ...newSave(9, T0), bestStage: 60, currency: { 'dungeon-key': 1 } };
    const result = applyCommand(weak, { type: 'attemptDungeon' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.events.map((e) => e.type)).toContain('dungeonFailed');
    expect(result.value.state.currency['dungeon-key']).toBe(0);
    expect(result.value.state.gold).toBe(weak.gold);
    expect(result.value.state.items).toHaveLength(0);
  });

  it('awards exactly one item and one or two currency on a win', () => {
    const result = applyCommand(runner(), { type: 'attemptDungeon' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const items = result.value.events.filter((e) => e.type === 'itemDropped');
    expect(items).toHaveLength(1);

    const currency = result.value.events
      .filter((e) => e.type === 'currencyDropped')
      .reduce((sum, e) => sum + (e.type === 'currencyDropped' ? e.count : 0), 0);
    expect(currency).toBeGreaterThanOrEqual(DUNGEON_CURRENCY_PER_CLEAR.min);
    expect(currency).toBeLessThanOrEqual(DUNGEON_CURRENCY_PER_CLEAR.max);
  });

  it('never drops a common - a key is worth more than a free clear', () => {
    for (let uid = 1; uid <= 200; uid++) {
      expect(rollDungeonItem(3, uid, 40).rarity).not.toBe('common');
    }
  });

  it('is the only source of spirits', () => {
    // Stage bosses drop fragments, which take ten to become anything, and no
    // fragment combines into a spirit. Without dungeons the fifth affix row -
    // the thing the craft ceiling budgets for - is unreachable.
    const fromStages = new Set<string>();
    for (let uid = 1; uid <= 500; uid++) {
      for (const id of Object.keys(rollStageBossDrops(4, uid, 200))) fromStages.add(id);
    }
    for (const spirit of ['bishop-spirit', 'devil-spirit', 'dune-spirit']) {
      expect(fromStages.has(spirit), `${spirit} dropped from a stage boss`).toBe(false);
    }

    const fromDungeons = new Set<string>();
    for (let uid = 1; uid <= 500; uid++) {
      for (const id of Object.keys(rollDungeonCurrency(4, uid))) fromDungeons.add(id);
    }
    expect(fromDungeons.has('dune-spirit')).toBe(true);
  });

  it('makes spirits rarer than everything else it drops', () => {
    const counts: Record<string, number> = {};
    for (let uid = 1; uid <= 4000; uid++) {
      for (const [id, n] of Object.entries(rollDungeonCurrency(8, uid))) {
        counts[id] = (counts[id] ?? 0) + n;
      }
    }
    const spirits = ['bishop-spirit', 'devil-spirit', 'dune-spirit'].reduce(
      (sum, id) => sum + (counts[id] ?? 0),
      0,
    );
    const basics = Object.entries(counts)
      .filter(([id]) => !id.endsWith('-spirit'))
      .reduce((sum, [, n]) => sum + n, 0);
    // Each spirit is a permanent one-shot change and the only route to a fifth
    // row, so they must stay an event rather than a resource.
    expect(spirits).toBeGreaterThan(0);
    expect(spirits * 8).toBeLessThan(basics);
  });

  it('is fully determined by seed and uid', () => {
    expect(rollDungeonCurrency(77, 5)).toEqual(rollDungeonCurrency(77, 5));
    expect(rollDungeonItem(77, 5, 30)).toEqual(rollDungeonItem(77, 5, 30));
    expect(rollDungeonCurrency(77, 5)).not.toEqual(rollDungeonCurrency(78, 5));
  });
});

describe('power budget', () => {
  const CTX = { stage: 100, isBoss: false, enemyHpFraction: 1 };
  const base: SaveState = { ...newSave(1, T0), bestStage: 100, currentStage: 100 };

  const topRoll = (id: string) => {
    const affix = getAffix(id)!;
    const top = affix.tiers.length - 1;
    return { affixId: id, tier: top, value: affix.tiers[top].value };
  };

  /** Four rares on the same base, every affix and implicit at its best tier. */
  const loadoutOf = (baseId: string, prefixes: string[], suffixes: string[]): SaveState => {
    const implicit = BASE_AFFIXES[baseId];
    const items = [0, 1, 2, 3].map((i) => ({
      uid: `best-${i}`,
      baseId,
      rarity: 'rare' as const,
      itemLevel: 100,
      rerolls: 0,
      crafts: 0,
      affixes: [...prefixes, ...suffixes].map(topRoll),
      baseAffix: topRoll(implicit.id),
    }));
    return { ...base, items, loadout: items.map((i) => i.uid) };
  };

  // The best offensive and defensive builds a player could assemble from drops
  // alone: best affixes, best tiers, and the base whose implicit matches.
  const offensive = () => loadoutOf('whetstone', ['brutal', 'sweeping'], ['of-haste', 'of-precision']);
  const defensive = () => loadoutOf('charm', ['vital', 'armoured'], ['of-ruin', 'of-avarice']);

  const dpsRatio = (save: SaveState) =>
    statsDps(deriveStats(save, CTX)) / statsDps(deriveStats(base, CTX));
  const ehpRatio = (save: SaveState) =>
    effectiveHp(deriveStats(save, CTX)) / effectiveHp(deriveStats(base, CTX));

  it('a best-in-slot loadout from drops alone is worth roughly 5.7x total power', () => {
    // Measured as offence x defence, because that is what "total power" means
    // for a build that has to both kill and survive.
    //
    // This is the DROP ceiling. The agreed overall ceiling is ~8x, and the
    // headroom between the two is what the extra affix row spirits grant is
    // allowed to occupy - it is not spare budget for bigger affixes.
    const total = dpsRatio(offensive()) * ehpRatio(defensive());
    expect(total).toBeGreaterThan(5.0);
    expect(total).toBeLessThan(6.5);
  });

  it('does not put the whole budget on damage', () => {
    // Clear time holds steady only while offence and defence grow together.
    // The first cut of the affix pool loaded everything onto DPS and the
    // harness caught it: stage 222 resolved in 11.9s against a 20s floor.
    expect(dpsRatio(offensive())).toBeLessThan(2.6);
  });

  it('grows offence and defence at matching rates', () => {
    // The absolute ceiling above cannot tell 2.4/2.4 from 3.4/1.7 - both are
    // 5.7x. This is the check that actually encodes the invariant, and it is
    // the one to read first when clear times move.
    const offence = dpsRatio(offensive());
    const defence = ehpRatio(defensive());
    expect(Math.abs(Math.log(offence / defence))).toBeLessThan(0.15);
  });

  /**
   * Every item carries a dune spirit's fifth row, filled with `extra`.
   *
   * The two sides take the extra row on different halves, because that is
   * where each one's third-best affix lives: offence has three useful suffixes
   * and only two useful prefixes, and defence is the mirror of that.
   */
  const withFifthRow = (save: SaveState, side: 'prefix' | 'suffix', extra: string): SaveState => ({
    ...save,
    items: save.items.map((item) => ({
      ...item,
      spirit: 'dune-spirit',
      spiritDelta: { prefix: side === 'prefix' ? 1 : 0, suffix: side === 'suffix' ? 1 : 0 },
      affixes: [...item.affixes, topRoll(extra)],
    })),
  });

  const craftedOffence = () => withFifthRow(offensive(), 'suffix', 'of-ruin');
  const craftedDefence = () => withFifthRow(defensive(), 'prefix', 'warded');

  it('a fully crafted loadout is worth roughly 8x, the agreed ceiling', () => {
    // The craft ceiling: everything the drop ceiling has, plus the fifth affix
    // row only a dune spirit can grant. This is the number the whole currency
    // system was budgeted against, and the one that decides whether the ladder
    // still paces.
    const total = dpsRatio(craftedOffence()) * ehpRatio(craftedDefence());
    expect(total).toBeGreaterThan(6.5);
    expect(total).toBeLessThan(9.5);
  });

  it('leaves crafting real headroom over dropping, but not a different game', () => {
    // Both sides measured, not assumed. If crafting did not beat what drops,
    // the currency would be decoration; if it beat it by too much, every
    // dropped item would be litter and the ladder would need retuning around
    // the crafted player instead of the real spread of players.
    const dropped = dpsRatio(offensive()) * ehpRatio(defensive());
    const crafted = dpsRatio(craftedOffence()) * ehpRatio(craftedDefence());
    expect(crafted / dropped).toBeGreaterThan(1.2);
    expect(crafted / dropped).toBeLessThan(1.9);
  });

  it('keeps offence and defence matched at the craft ceiling too', () => {
    // The symmetry invariant does not stop applying because an item was
    // crafted. A fifth row that only ever went on offence would be the
    // stage-222 failure arriving by a third route.
    const offence = dpsRatio(craftedOffence());
    const defence = ehpRatio(craftedDefence());
    expect(Math.abs(Math.log(offence / defence))).toBeLessThan(0.2);
  });

  it('does not let stacked uniques beat a crafted loadout on total power', () => {
    // Four of the same unique is the cheapest possible "build": no crafting, no
    // currency, no decisions. It is allowed to win on one axis - four
    // Whetstones out-damage a crafted rare set, and that is the point of a
    // chase item - but it must not win overall, or the entire currency system
    // is dead content for anyone who optimises.
    //
    // It does not, because no unique carries defence: Bloodstone actively
    // trades max HP away, and the rest are neutral.
    const stacked = (id: string): SaveState => {
      const items = [0, 1, 2, 3].map((i) => ({
        uid: `u${i}`,
        baseId: id,
        rarity: 'unique' as const,
        itemLevel: 100,
        affixes: [],
        rerolls: 0,
        crafts: 0,
        uniqueId: id,
      }));
      return { ...base, items, loadout: items.map((item) => item.uid) };
    };

    const bestUniqueTotal = Math.max(
      ...UNIQUES.map((u) => dpsRatio(stacked(u.id)) * ehpRatio(stacked(u.id))),
    );
    const crafted = dpsRatio(craftedOffence()) * ehpRatio(craftedDefence());
    expect(bestUniqueTotal).toBeLessThan(crafted);
  });

  it('gives the base implicit about a sixth of an item, not a third', () => {
    // Implicits are guaranteed, so an oversized one makes the rolled half
    // decorative. A first pass at 1.075/item put the drop ceiling at 8.8x on
    // its own - the entire budget, spent before currency existed.
    const withImplicit = dpsRatio(offensive());
    const withoutImplicit = dpsRatio({
      ...offensive(),
      items: offensive().items.map((item) => ({ ...item, baseAffix: undefined })),
    });
    const contribution = withImplicit / withoutImplicit;
    expect(contribution).toBeGreaterThan(1.1);
    expect(contribution).toBeLessThan(1.25);
  });
});

describe('migration', () => {
  const progress = { gold: 12345, bestStage: 40, currentStage: 41 };

  it('clears v1 artifacts, which were bare ids, and keeps everything else', () => {
    const legacy = {
      ...newSave(1, T0),
      ...progress,
      contentVersion: 1,
      upgrades: { ...newSave(1, T0).upgrades, damage: 30 },
      // The v1 shape: plain ids under the old field name, which no amount of
      // renaming makes readable.
      artifactsOwned: ['whetstone', 'bloodstone'],
      loadout: ['whetstone', null, null, null],
    } as unknown as SaveState;

    const { state, migrated } = migrateSave(legacy);

    expect(migrated).toBe(true);
    expect(state.items).toEqual([]);
    expect(state.loadout).toEqual([null, null, null, null]);
    expect(state.nextItemId).toBe(1);
    expect(state.gold).toBe(12345);
    expect(state.bestStage).toBe(40);
    expect(state.upgrades.damage).toBe(30);
  });

  it('carries v2 items across without destroying them', () => {
    // v2 shipped a wipe. Wiping again one release later would teach players
    // that progress here is disposable, so v2 -> v3 is a rename plus an added
    // optional field and nothing else.
    const rolled = [rollItem(9, 1, 30), rollItem(9, 2, 30)];
    const v2 = {
      ...newSave(9, T0),
      ...progress,
      contentVersion: 2,
      artifactsOwned: rolled,
      loadout: [rolled[0].uid, null, null, null],
      nextItemId: 3,
    } as unknown as SaveState;

    const { state, migrated } = migrateSave(v2);

    expect(migrated).toBe(true);
    expect(state.items).toEqual(rolled);
    expect(state.loadout[0]).toBe(rolled[0].uid);
    expect(state.nextItemId).toBe(3);
    expect(state.gold).toBe(12345);
    expect((state as unknown as Record<string, unknown>).artifactsOwned).toBeUndefined();
  });

  it('leaves a current save alone', () => {
    const current = { ...newSave(1, T0), gold: 500 };
    const { state, migrated } = migrateSave(current);
    expect(migrated).toBe(false);
    expect(state).toEqual(current);
  });
});

describe('derived stats', () => {
  it('statsDps matches the DPS the combat layer actually uses', () => {
    // The character sheet quotes statsDps. If it drifted from what resolveStage
    // divides by, the panel would confidently display a number the fight does
    // not use - the exact failure the shared function exists to prevent.
    const save: SaveState = {
      ...newSave(1, T0),
      upgrades: { ...newSave(1, T0).upgrades, damage: 12, attackSpeed: 7, crit: 20 },
    };
    const stage = 1;
    const outcome = resolveStage(save, stage);
    const stats = deriveStats(save, { stage, isBoss: false, enemyHpFraction: 1 });

    const poolHp = enemyCount(stage) * enemyHp(stage);
    const aoeTargets = Math.min(stats.area, enemyCount(stage));
    const impliedDps = poolHp / (outcome.trashPhaseSeconds * aoeTargets);

    expect(statsDps(stats)).toBeCloseTo(impliedDps, 6);
  });

  it('effective HP is what damage is measured against', () => {
    const save: SaveState = {
      ...newSave(1, T0),
      upgrades: { ...newSave(1, T0).upgrades, health: 9, toughness: 5 },
    };
    const stats = deriveStats(save, { stage: 1, isBoss: false, enemyHpFraction: 1 });
    expect(effectiveHp(stats)).toBeCloseTo(stats.maxHp * stats.toughness, 6);
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

  it('never collapses outright', () => {
    // The absolute guard. Nothing about discrete loot explains a sub-3s stage;
    // offence outrunning defence once produced 0.04s.
    const worst = rows.reduce((a, b) => (a.clearSeconds < b.clearSeconds ? a : b));
    expect(
      worst.clearSeconds,
      `stage ${worst.stage} resolves in ${worst.clearSeconds.toFixed(2)}s`,
    ).toBeGreaterThanOrEqual(CLEAR_TIME_BAND_SECONDS.absoluteFloor);
  });

  it('typically stays above the floor', () => {
    // Checked at the 5th percentile, not the minimum. Equipping a good drop is
    // a step change that overshoots for a few stages, so one short stage is the
    // system working - a worst-case assertion cannot tell that apart from a
    // hundred short stages.
    const sorted = rows.map((r) => r.clearSeconds).sort((a, b) => a - b);
    const p5 = sorted[Math.floor(sorted.length * 0.05)];
    expect(p5, `5th percentile clear time is ${p5.toFixed(2)}s`).toBeGreaterThanOrEqual(
      CLEAR_TIME_BAND_SECONDS.min,
    );
  });

  it('never exceeds the stage timer', () => {
    const worst = rows.reduce((a, b) => (a.clearSeconds > b.clearSeconds ? a : b));
    expect(worst.clearSeconds).toBeLessThanOrEqual(CLEAR_TIME_BAND_SECONDS.max);
  });

  it('converges rather than drifting downward without limit', () => {
    // Offence outrunning defence shows up as clear times that keep falling.
    //
    // This used to compare the last twenty stages against the first twenty and
    // require a ratio above 0.35. That was a poor instrument: the first twenty
    // stages are a fresh account with no items and no upgrades, so the ratio
    // measured the bootstrap as much as the ladder, sat permanently within a
    // percent of its threshold, and duly tripped on a change that moved the
    // late mean by 1%.
    //
    // Measured instead: clear times fall steeply at first and then flatten
    // toward the band floor, and the shape of that flattening is what
    // distinguishes a healthy curve from a runaway. Adjacent windows -
    // 32.8, 23.0, 19.3, 16.1, 14.7, 13.5 - give ratios of 0.84, 0.84, 0.91,
    // 0.91: decelerating and converging. A runaway keeps the ratio low.
    const mean = (from: number, to: number) =>
      rows.slice(from, to).reduce((sum, r) => sum + r.clearSeconds, 0) / (to - from);

    // Skipped: the first fifty stages are the bootstrap, where a fresh account
    // has neither items nor upgrades and clear times fall for reasons that say
    // nothing about the curve.
    const windows = [50, 100, 150, 200, 250, 300];
    const ratios: number[] = [];
    for (let i = 1; i < windows.length - 1; i++) {
      const previous = mean(windows[i - 1], windows[i]);
      const next = mean(windows[i], windows[i + 1]);
      ratios.push(next / previous);
      expect(next, `stages ${windows[i] + 1}-${windows[i + 1]} against the window before`)
        .toBeGreaterThan(previous * 0.8);
    }

    // And the tail must be flattening, not still falling at the earlier rate.
    expect(ratios[ratios.length - 1]).toBeGreaterThan(0.85);
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
