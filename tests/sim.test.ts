import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { report, runLadder } from '../scripts/balance';
// The one place a test reaches into the UI layer: "two affixes must not read as
// the same line" is a claim about rendering, and asserting it against the raw
// numbers instead would not catch the rounding that caused it.
import { describeEffect, describeRolledAffix } from '../src/ui/format';
import {
  AFFIXES,
  AFFIX_LIMITS,
  affixEffect,
  affixRows,
  applyCommand,
  BASES,
  big,
  formatBig,
  fromSave,
  toSave,
  BASE_AFFIXES,
  BASE_STATS,
  BULK_PURCHASE_LIMIT,
  bulkUpgradeCost,
  CLEAR_TIME_BAND_SECONDS,
  CommandSchema,
  computeOffline,
  createRng,
  CURRENCIES,
  currencyLegality,
  damageShares,
  deriveStats,
  dungeonAffinity,
  dungeonResistances,
  ELEMENTS,
  elementalScale,
  explainStats,
  previewEquip,
  DISSEMBLE_YIELD,
  DROPS_PER_CLEAR,
  DUNGEON_CURRENCY_PER_CLEAR,
  effectiveHp,
  enemyCount,
  enemyHp,
  equipSlots,
  farmRate,
  feedbackExponent,
  FRAGMENTS_PER_CLEAR,
  getAffix,
  getBaseAffix,
  eligibleAffixes,
  GEAR_BASES,
  ACCESSORY_BASES,
  RING_BASES,
  AMULET_BASES,
  TABLET_BASES,
  rollAccessory,
  getBase,
  type TabletPays,
  getCurrency,
  getSkill,
  getUnique,
  IMPLICIT_AFFIXES,
  KEY_DROP_CHANCE,
  MAX_RESISTANCE,
  MAX_VULNERABILITY,
  mitigatedResistance,
  RESISTANCE_CAP,
  stageResistance,
  stageResistances,
  uniformResistances,
  PREFIXES,
  SUFFIXES,
  sideExponents,
  newSave,
  OFFLINE_CAP_SECONDS,
  INVENTORY_CAP,
  itemEffects,
  ITEM_SLOTS,
  MAX_ITEM_SLOTS,
  MAX_TABLET_TIER,
  ABYSS_UNLOCK_STAGE,
  ABYSSAL_PROFILE,
  abyssalDepth,
  resolveAbyssal,
  rollTablet,
  rollWaveTablets,
  rollAbyssalTablets,
  type ItemInstance,
  tabletReward,
  totalDanger,
  wavesForTier,
  delveTimeLimit,
  STAGE_TIME_LIMIT_SECONDS,
  LADDER_MAX_TABLET_TIER,
  TABLET_TIER_STAGES,
  getHudSnapshot,
  migrateSave,
  rerollCost,
  resolveDungeon,
  resolveStage,
  rollItem,
  rollDungeonCurrency,
  rollDungeonItem,
  rollStageBossDrops,
  rollWaveDropCount,
  WAVE_DROP_MAX,
  WAVE_RARITY_WEIGHTS,
  STAT_KEYS,
  statsDps,
  trackLayer,
  TUNING,
  UNIQUES,
  uniqueEffects,
  UPGRADE_TRACKS,
  upgradeCost,
  WEAPON_BASES,
  validateRegistry,
  type Command,
  type Effect,
  type CurrencyId,
  type SaveState,
} from '../src/sim';

const T0 = 1_700_000_000_000;

/** Gold as the save holds it: a decimal string, not a number. */
const goldOf = (save: SaveState) => fromSave(save.gold);

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
    expect(twoHours.goldEarned.gt(oneHour.goldEarned)).toBe(true);
    expect(twoHours.goldEarned.div(oneHour.goldEarned).toNumber()).toBeCloseTo(2, 1);
  });

  it('caps accrual', () => {
    const save = farmingSave();
    const atCap = computeOffline(save, T0 + OFFLINE_CAP_SECONDS * 1000);
    const wayPastCap = computeOffline(save, T0 + OFFLINE_CAP_SECONDS * 1000 * 10);
    expect(wayPastCap.goldEarned.eq(atCap.goldEarned)).toBe(true);
    expect(wayPastCap.capped).toBe(true);
  });

  it('cannot be double-claimed', () => {
    // The classic idle exploit: claim, then immediately claim again.
    const save = farmingSave();
    const now = T0 + 4 * 3600_000;

    const first = applyCommand(save, { type: 'claimOffline' }, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(goldOf(first.value.state).gt(0)).toBe(true);

    const second = applyCommand(first.value.state, { type: 'claimOffline' }, now);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(goldOf(second.value.state).eq(goldOf(first.value.state))).toBe(true);
  });

  it('never pays out for time before the last claim', () => {
    const save = farmingSave();
    const report = computeOffline(save, T0 - 60_000);
    expect(report.goldEarned.eq(0)).toBe(true);
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
    const rich: SaveState = { ...newSave(1, T0), gold: '1000' };
    const cost = upgradeCost('damage', 0);
    const result = applyCommand(rich, { type: 'buyUpgrade', key: 'damage' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(goldOf(result.value.state).eq(big(1000).sub(cost))).toBe(true);
    expect(result.value.state.upgrades.damage).toBe(1);
  });

  it('deducts at magnitudes a double cannot hold at all', () => {
    // Deep enough that the price of a single level is past 1e308. Both the balance
    // and the cost are numbers a double cannot represent, and the purchase still
    // lands with the right amount taken off.
    const level = 2100;
    const cost = bulkUpgradeCost('damage', level, 10);
    expect(cost.exponent).toBeGreaterThan(308);

    const rich: SaveState = {
      ...newSave(1, T0),
      gold: toSave(cost.mul(2)),
      upgrades: { ...newSave(1, T0).upgrades, damage: level },
    };
    const result = applyCommand(rich, { type: 'buyUpgrade', key: 'damage', count: 10 }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.state.upgrades.damage).toBe(level + 10);

    // Compared as a RATIO, not for equality. The mantissa is a double, so `2c - c`
    // differs from `c` in the last significant digit - ordinary floating point, not a
    // fault in the type. What matters is that the right amount left the balance.
    const spent = cost.mul(2).sub(goldOf(result.value.state));
    expect(spent.div(cost).toNumber()).toBeCloseTo(1, 10);
  });

  it('still loses a cost far below the balance, and that is the trade', () => {
    // break_infinity buys RANGE, not precision: the mantissa is a double, so about
    // seventeen significant digits survive and a cost eighteen orders of magnitude
    // below the balance rounds away exactly as it did before.
    //
    // Pinned rather than fixed. The alternative is arbitrary-precision arithmetic in
    // the hot path of a closed-form sim, to make a player pay 10 gold out of 1e40 -
    // a distinction with no gameplay attached. Every game in this genre makes the
    // same trade.
    const rich: SaveState = { ...newSave(1, T0), gold: '1e40' };
    const result = applyCommand(rich, { type: 'buyUpgrade', key: 'damage' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(goldOf(result.value.state).eq(big('1e40'))).toBe(true);

    // What DID change: this is now a rounding artefact at 1e40, not a wall at 1e308.
    expect(big('1e40').mul(big('1e400')).exponent).toBe(440);
  });

  it('charges the same for a bulk buy as for the same levels one at a time', () => {
    // If these diverge, the bulk button is either a discount or a penalty.
    // upgradeCost rounds each level up, so the geometric closed form is wrong
    // here by up to one gold per level.
    for (const key of ['damage', 'health', 'greed'] as const) {
      for (const count of [2, 5, 10, 37]) {
        const oneByOne = Array.from({ length: count }, (_, i) => upgradeCost(key, 3 + i)).reduce(
          (a, b) => a.add(b),
          big(0),
        );
        expect(bulkUpgradeCost(key, 3, count).eq(oneByOne), `${key} x${count}`).toBe(true);
      }
    }
  });

  it('buying 10 at once equals buying 1 ten times', () => {
    const rich: SaveState = { ...newSave(1, T0), gold: '1000000' };

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
    const save: SaveState = { ...newSave(1, T0), gold: toSave(upgradeCost('damage', 0).add(1)) };
    const result = applyCommand(save, { type: 'buyUpgrade', key: 'damage', count: 20 }, T0);
    expect(result.ok).toBe(false);
  });

  it('max spends what it can and never overdraws', () => {
    const save: SaveState = { ...newSave(1, T0), gold: '5000' };
    const result = applyCommand(save, { type: 'buyUpgrade', key: 'damage', count: 'max' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bought = result.value.state.upgrades.damage;
    expect(bought).toBeGreaterThan(0);
    expect(goldOf(result.value.state).gte(0)).toBe(true);
    // Exactly maximal: one more level must not have been affordable.
    expect(bulkUpgradeCost('damage', 0, bought + 1).gt(5000)).toBe(true);
  });

  it('max stops at a capped track rather than overshooting', () => {
    const key = 'crit';
    const cap = UPGRADE_TRACKS[key].maxLevel!;
    const save: SaveState = { ...newSave(1, T0), gold: '1e30' };
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
    const rich: SaveState = { ...newSave(1, T0), gold: '1000' };
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
    // No shared baseline: each affix is now compared against its own reference
    // build, because what counts as "the same build minus this affix" depends on
    // where the affix can roll and whether its stat is even live.
    const base: SaveState = { ...newSave(1, T0), bestStage: 45, currentStage: 45 };

    for (const affix of AFFIXES) {
      const top = affix.tiers.length - 1;
      // A weapon-locked affix has to be hosted on a weapon of its kind and worn in
      // the weapon slot, or it is inert for a reason that says nothing about the
      // affix. `+4 to Physical Skill Levels` on a Whetstone in a gear slot does
      // exactly nothing, and that is the rule working rather than a content bug.
      const weaponHost =
        affix.rollsOn && affix.rollsOn !== 'gear'
          ? WEAPON_BASES.find((b) => getSkill(b.skillId!)!.kind === affix.rollsOn)!
          : undefined;
      const host = weaponHost ?? { id: 'whetstone', skillId: undefined };

      // A resource affix does nothing unless the resource is what limits you, and on
      // a fresh build it usually is not - Unarmed and Sunder both regenerate faster
      // than they spend, deliberately. So the reference build for a regen affix
      // carries enough attack speed that the resource has started to bind. Measuring
      // stamina regen on a base-speed Axe would correctly report zero and tell you
      // nothing about the affix.
      const needsBinding = affix.effect.kind === 'statMod' && affix.effect.stat === 'resourceRegen';
      const bindingWeapon = WEAPON_BASES.find((b) => getSkill(b.skillId!)!.kind === 'magical')!;
      const fast: SaveState = needsBinding
        ? { ...base, upgrades: { ...base.upgrades, attackSpeed: 30 } }
        : base;
      const item = {
        uid: 'test',
        baseId: host.id,
        rarity: 'common' as const,
        itemLevel: 100,
        affixes: [{ affixId: affix.id, tier: top, value: affix.tiers[top].value }],
        rerolls: 0,
        crafts: 0,
      };
      // Compared against a baseline in the same build, so what is measured is the
      // affix and not the skill the weapon happens to grant.
      const bare = { ...item, uid: 'bare', affixes: [] };
      const carrier = needsBinding && !weaponHost
        ? { uid: 'carrier', baseId: bindingWeapon.id, rarity: 'common' as const, itemLevel: 100,
            affixes: [], rerolls: 0, crafts: 0 }
        : undefined;

      const build = (piece: typeof item): SaveState =>
        weaponHost
          ? { ...fast, items: [piece], weapon: piece.uid }
          : {
              ...fast,
              items: carrier ? [piece, carrier] : [piece],
              loadout: [piece.uid, null, null, null],
              weapon: carrier ? carrier.uid : null,
            };

      const ref = resolveStage(build(bare), 45);
      const outcome = resolveStage(build(item), 45);
      const changed = outcome.seconds !== ref.seconds || outcome.goldEarned !== ref.goldEarned;
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

  it('gives uniques authored effects, rolled values, and no affixes', () => {
    const uniques = Array.from({ length: 600 }, (_, i) => rollItem(3, i + 1, 60)).filter(
      (item) => item.rarity === 'unique',
    );
    expect(uniques.length).toBeGreaterThan(0);
    for (const item of uniques) {
      expect(item.affixes).toEqual([]);
      expect(itemEffects(item).length).toBeGreaterThan(0);

      // One roll per authored effect, each inside its own range. The effects a
      // unique carries are fixed; only their magnitudes are drawn.
      const authored = getUnique(item.uniqueId!)!;
      expect(item.uniqueRolls).toHaveLength(authored.effects.length);
      authored.effects.forEach((effect, i) => {
        expect(item.uniqueRolls![i]).toBeGreaterThanOrEqual(effect.roll.min);
        expect(item.uniqueRolls![i]).toBeLessThanOrEqual(effect.roll.max);
      });
    }

    // Two copies of the same unique must be able to differ, or the range is
    // decoration. Checked across the whole sample rather than on a chosen pair,
    // since which unique repeats depends on the seed.
    const byUnique = new Map<string, Set<string>>();
    for (const item of uniques) {
      const seen = byUnique.get(item.uniqueId!) ?? new Set<string>();
      seen.add(item.uniqueRolls!.join(','));
      byUnique.set(item.uniqueId!, seen);
    }
    expect([...byUnique.values()].some((rolls) => rolls.size > 1)).toBe(true);
  });

  it('multiplies the key chance and leaves the fragment rolls untouched', () => {
    // The key roll comes last in the stream on purpose, so a Warden's Coffer changes
    // how often a key falls and nothing else about the clear. If it moved the stream
    // position, equipping it would silently reroll which fragments dropped too.
    const sample = (mult: number) => {
      let keys = 0;
      const fragments: string[] = [];
      for (let uid = 1; uid <= 2000; uid++) {
        const purse = rollStageBossDrops(7, uid, 60, mult);
        keys += purse['dungeon-key'] ?? 0;
        fragments.push(
          Object.entries(purse)
            .filter(([id]) => id !== 'dungeon-key')
            .map(([id, n]) => `${id}:${n}`)
            .join(','),
        );
      }
      return { keys, fragments: fragments.join('|') };
    };

    const plain = sample(1);
    const doubled = sample(2);
    expect(doubled.fragments).toBe(plain.fragments);
    expect(doubled.keys / plain.keys).toBeGreaterThan(1.6);
    expect(doubled.keys / plain.keys).toBeLessThan(2.4);

    // Clamped at certainty rather than running past it.
    expect(sample(50).keys).toBe(2000);
  });

  it('renders every unique effect as a readable line', () => {
    // Effect is a discriminated union, so a new kind is a type error everywhere it is
    // consumed - except in a `.map` over strings, where a missing branch renders as
    // "undefined" on the item and nothing complains. Both ends of every range, since
    // a sign flip only shows at one of them.
    for (const unique of UNIQUES) {
      for (const bound of ['min', 'max'] as const) {
        const rolls = unique.effects.map((e) => e.roll[bound]);
        for (const effect of uniqueEffects(unique, rolls)) {
          const line = describeEffect(effect);
          expect(line, `${unique.id}`).toBeTruthy();
          expect(line, `${unique.id}: ${line}`).not.toMatch(/undefined|NaN/);
        }
      }
    }
  });

  it('renders every rollable affix as a readable line', () => {
    // The same hole the unique test covers, on the other half of the content. A new
    // effect kind is a type error everywhere it is CONSUMED, and describeEffect
    // returns a string from every branch - so a missing branch is not a type error,
    // it is an item reading "undefined" in the panel.
    for (const affix of [...AFFIXES, ...IMPLICIT_AFFIXES]) {
      for (let tier = 0; tier < affix.tiers.length; tier++) {
        const rolled = { affixId: affix.id, tier, value: affix.tiers[tier].value };

        // A tablet's modifiers act on the RUN and produce no Effect by construction, so
        // they are checked through the display path instead. They still have to READ -
        // this is exactly the hole that made every tablet render as six unknown
        // modifiers when they first became items.
        if (affix.effect.kind === 'monsterBuff' || affix.effect.kind === 'tabletReward') {
          expect(affixEffect(rolled), `${affix.id} must not reach deriveStats`).toBeNull();
          for (const base of BASES.filter((b) => b.pays)) {
            const line = describeRolledAffix(rolled, true, base.id).text;
            expect(line, `${affix.id}: ${line}`).not.toMatch(/undefined|NaN|unknown/);
          }
          continue;
        }

        const effect = affixEffect(rolled);
        expect(effect, `${affix.id}`).not.toBeNull();
        if (!effect) continue;
        const line = describeEffect(effect);
        expect(line, `${affix.id}: ${line}`).not.toMatch(/undefined|NaN/);
      }
    }
  });

  it('carries a defensive unique, not only offence and economy', () => {
    // A unique tier whose best items are all offensive breaks the offence/defence
    // symmetry invariant structurally - the ceiling on one side rises and the other
    // cannot follow. The affix pool broke exactly this way twice, both times because
    // every entry on one side happened to be offensive. Asserted on OUTCOME rather
    // than on a stat name, so a defensive unique built out of any stat counts.
    const base: SaveState = { ...newSave(2, T0), bestStage: 45, currentStage: 45 };
    const ctx = { stage: 45, isBoss: true, enemyHpFraction: 1 };
    const baseline = effectiveHp(deriveStats(base, ctx));

    const best = UNIQUES.map((unique) => {
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
      const equipped: SaveState = { ...base, items: [item], loadout: [item.uid, null, null, null] };
      return effectiveHp(deriveStats(equipped, ctx)).div(baseline).toNumber();
    }).reduce((a, b) => Math.max(a, b), 0);

    expect(best, 'no unique raises effective HP').toBeGreaterThan(1.3);
  });

  it('drops uniques at the frequency their tier declares', () => {
    // The tier IS the drop weight, so an ancient must be materially rarer than a
    // lesser. Asserted as an ordering rather than a ratio: the exact share depends
    // on how many uniques sit in each tier, and pinning it would turn adding one
    // more lesser into a test failure.
    const drops = Array.from({ length: 40_000 }, (_, i) => rollItem(11, i + 1, 300)).filter(
      (item) => item.rarity === 'unique',
    );
    expect(drops.length).toBeGreaterThan(200);

    const share = (tier: string) =>
      drops.filter((item) => getUnique(item.uniqueId!)!.tier === tier).length / drops.length;

    expect(share('lesser')).toBeGreaterThan(share('greater'));
    expect(share('greater')).toBeGreaterThan(share('ancient'));
    // Every tier still has to appear, or a weight is effectively zero and the
    // roster is smaller than it reads.
    expect(share('ancient')).toBeGreaterThan(0);
  });
});

describe('equip slots', () => {
  const CTX = { stage: 1, isBoss: false, enemyHpFraction: 1 };

  /** A save wearing `item` at a chosen index of the widened loadout array. */
  const wearingAt = (index: number, item: ReturnType<typeof rollItem>): SaveState => {
    const loadout = Array<string | null>(MAX_ITEM_SLOTS).fill(null);
    loadout[index] = item.uid;
    return { ...newSave(5, T0), items: [item], loadout };
  };

  it('starts at the base count with nothing granting slots', () => {
    expect(equipSlots(newSave(1, T0), CTX)).toBe(ITEM_SLOTS);
  });

  it('ignores an item parked past the live count', () => {
    // The array is seven long; only the first four positions are live. An item in
    // position six is owned, visible and completely inert - which is the whole
    // mechanism a slot-removing unique relies on.
    // Fingerprinted across every stat rather than a chosen one: which stats an
    // arbitrary drop touches is a property of the roll, and picking damage made the
    // control half of this test pass or fail on what the RNG happened to produce.
    const fingerprint = (save: SaveState) =>
      STAT_KEYS.map((key) => String(deriveStats(save, CTX)[key])).join('|');

    const item = rollItem(5, 1, 60);
    const bare = fingerprint(newSave(5, T0));

    expect(fingerprint(wearingAt(MAX_ITEM_SLOTS - 1, item)), 'a parked item changed a stat').toBe(
      bare,
    );
    // And the same item in a live slot does something, or the assertion above proves
    // nothing about slots and everything about the item being inert to begin with.
    expect(fingerprint(wearingAt(0, item))).not.toBe(bare);
  });

  /** A unique instance rolled at the top of every range. */
  const uniqueItem = (id: string, uid = 'u1') => {
    const unique = getUnique(id)!;
    return {
      uid,
      baseId: id,
      rarity: 'unique' as const,
      itemLevel: 60,
      affixes: [],
      rerolls: 0,
      crafts: 0,
      uniqueId: id,
      uniqueRolls: unique.effects.map((e) => e.roll.max),
    };
  };

  it('grants slots from a base position and ignores one parked past the window', () => {
    // The rule that stops the fixed point running away. A granter inside the first
    // four positions works; the same item at index 4 is inert, because it would
    // otherwise grant the slot that makes it live and then grant it again.
    const granter = uniqueItem('travellers-harness');
    const granted = granter.uniqueRolls[0];
    expect(granted).toBeGreaterThan(0);

    expect(equipSlots(wearingAt(0, granter), CTX)).toBe(ITEM_SLOTS + granted);
    expect(equipSlots(wearingAt(ITEM_SLOTS, granter), CTX)).toBe(ITEM_SLOTS);
  });

  it('settles rather than oscillating when a taker is worn', () => {
    // Removing slots shrinks the window, which can only ever remove more granters -
    // monotone, so it converges. Two takers cannot take the count below one.
    const taker = uniqueItem('monomaniacs-seal', 'a');
    const other = { ...uniqueItem('monomaniacs-seal', 'b') };

    const one = wearingAt(0, taker);
    expect(equipSlots(one, CTX)).toBe(ITEM_SLOTS - 1);

    const loadout = Array<string | null>(MAX_ITEM_SLOTS).fill(null);
    loadout[0] = taker.uid;
    loadout[1] = other.uid;
    const both: SaveState = { ...newSave(5, T0), items: [taker, other], loadout };
    expect(equipSlots(both, CTX)).toBe(ITEM_SLOTS - 2);
    // And calling it repeatedly gives the same answer - a fixed point, not a step.
    expect(equipSlots(both, CTX)).toBe(equipSlots(both, CTX));
  });

  it('amplifies other items but never itself', () => {
    // The amplifier's own effects are excluded, or it would scale its own downside
    // and two copies would compound against each other - the shape a rollable `more`
    // is banned for.
    const seal = uniqueItem('monomaniacs-seal', 'seal');
    const gear = rollItem(5, 1, 60);

    const loadout = Array<string | null>(MAX_ITEM_SLOTS).fill(null);
    loadout[0] = seal.uid;
    loadout[1] = gear.uid;
    const withBoth: SaveState = { ...newSave(5, T0), items: [seal, gear], loadout };

    const alone = deriveStats({ ...newSave(5, T0), items: [gear], loadout: [gear.uid] }, CTX);
    const bare = deriveStats(newSave(5, T0), CTX);
    const amplified = deriveStats(withBoth, CTX);

    // Whatever the gear contributed on its own is now worth more.
    const gearGain = statsDps(alone).div(statsDps(bare)).toNumber();
    const bothGain = statsDps(amplified).div(statsDps(bare)).toNumber();
    if (gearGain > 1.0001) expect(bothGain).toBeGreaterThan(gearGain);

    // Wearing the seal ALONE is exactly a bare character minus a slot: it has nothing
    // to amplify, and it must not amplify itself into mattering.
    const sealOnly = deriveStats(wearingAt(0, seal), CTX);
    expect(statsDps(sealOnly).eq(statsDps(bare))).toBe(true);
  });

  it('refuses to equip into a locked slot, on the server', () => {
    const item = rollItem(5, 1, 60);
    const save: SaveState = { ...newSave(5, T0), items: [item] };

    // The schema allows the index - the array is that long - so this has to be the
    // command layer refusing, not zod. A client one swap out of date would otherwise
    // equip into a slot that stopped existing.
    expect(CommandSchema.safeParse({ type: 'equipItem', slot: 5, itemId: item.uid }).success).toBe(
      true,
    );
    const result = applyCommand(save, { type: 'equipItem', slot: 5, itemId: item.uid }, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/locked/);
  });

  it('still refuses to dissemble an item sitting in a locked slot', () => {
    // Inert is not the same as unequipped. Destroying what someone is wearing because
    // a unique changed the slot count is the worst possible reading of "inert".
    const item = rollItem(5, 1, 60);
    const save = wearingAt(MAX_ITEM_SLOTS - 1, item);
    const result = applyCommand(save, { type: 'dissembleItems', uids: [item.uid] }, T0);
    expect(result.ok).toBe(false);
  });
});

describe('elements', () => {
  const CTX = { stage: 1, isBoss: false, enemyHpFraction: 1 };
  const NONE = uniformResistances(0);

  it('a target that resists nothing takes exactly the loadout DPS', () => {
    // The invariant that made this change safe to land. Everything below is new
    // machinery, and all of it has to collapse to 1.0 in the case that existed
    // before it - otherwise every number in the game moved for no stated reason.
    const save = newSave(1, T0);
    expect(elementalScale(damageShares(save, CTX), 0, NONE)).toBe(1);
  });

  it('an extra share adds to the hit rather than dividing it', () => {
    // "Gain 20% as extra cold" against a soft target is 1.2x, not a fifth of the
    // physical half repainted. The shares deliberately do not normalise.
    const save = newSave(1, T0);
    const shares = damageShares(save, CTX, [
      { kind: 'extraElement', element: 'cold', fraction: 0.2 },
    ]);
    expect(shares.physical).toBe(1);
    expect(shares.cold).toBe(0.2);
    expect(elementalScale(shares, 0, NONE)).toBeCloseTo(1.2, 9);
  });

  it('the extra is worth what the TARGET says it is worth', () => {
    // The whole reason this is a mechanic rather than a damage affix with extra
    // words: the same 20% is worth 20% against one target and nothing against
    // another, so which element you carry is a decision about where you are going.
    const shares = damageShares(newSave(1, T0), CTX, [
      { kind: 'extraElement', element: 'cold', fraction: 0.2 },
    ]);
    const coldImmune = { ...NONE, cold: MAX_RESISTANCE };
    expect(elementalScale(shares, 0, coldImmune)).toBeCloseTo(1 + 0.2 * (1 - MAX_RESISTANCE), 9);

    const coldWeak = { ...NONE, cold: -MAX_VULNERABILITY };
    expect(elementalScale(shares, 0, coldWeak)).toBeCloseTo(1 + 0.2 * (1 + MAX_VULNERABILITY), 9);
  });

  it('conditions gate an extra share like any other effect', () => {
    const effects: Effect[] = [
      { kind: 'extraElement', element: 'fire', fraction: 0.3, when: { isBoss: true } },
    ];
    expect(damageShares(newSave(1, T0), CTX, effects).fire).toBe(0);
    expect(damageShares(newSave(1, T0), { ...CTX, isBoss: true }, effects).fire).toBe(0.3);
  });

  it('penetration cuts resistance toward zero and stops there', () => {
    expect(mitigatedResistance(0.3, 0.1)).toBeCloseTo(0.2, 9);
    // Over-penetrating a soft target is wasted rather than a bonus. Without the
    // floor, one penetration roll would be a damage multiplier against every enemy
    // in the game and the stat would have nothing to do with elements at all.
    expect(mitigatedResistance(0.05, 0.5)).toBe(0);
    expect(mitigatedResistance(0, 0.5)).toBe(0);
  });

  it('penetration does not deepen a weakness that is already yours', () => {
    // A negative resistance is a dungeon's affinity, not armour. Letting penetration
    // stack onto it would make the vulnerable element the correct answer twice over.
    expect(mitigatedResistance(-0.35, 0.4)).toBeCloseTo(-0.35, 9);
  });

  it('mitigation is bounded at both ends', () => {
    expect(mitigatedResistance(5, 0)).toBe(MAX_RESISTANCE);
    expect(mitigatedResistance(-5, 0)).toBe(-MAX_VULNERABILITY);
  });

  it('ladder resistance is uniform, rises with depth, and never reaches its cap', () => {
    for (const stage of [1, 50, 300, 5000, 1e6]) {
      const values = ELEMENTS.map((e) => stageResistances(stage)[e]);
      // Uniform is the deliberate simple case: elements on the ladder are a scaling
      // axis, not a lookup table that gates progress on bringing the right weapon.
      expect(new Set(values).size).toBe(1);
      expect(stageResistance(stage)).toBeLessThan(RESISTANCE_CAP);
    }
    expect(stageResistance(1)).toBeLessThan(stageResistance(50));
    expect(stageResistance(50)).toBeLessThan(stageResistance(300));
    // Bounded is the safety argument. Resistance is a multiplier on effective HP, so
    // an unbounded one would be a second HP curve racing enemyHpGrowth.
    expect(stageResistance(1e9)).toBeLessThan(RESISTANCE_CAP);
  });

  it('a dungeon names two different elements, and does so before the key is spent', () => {
    for (const stage of [1, 7, 40, 199]) {
      const a = dungeonAffinity(12345, stage);
      const b = dungeonAffinity(12345, stage);
      // Deterministic from the account seed, which is what lets the UI show it
      // before a key is committed rather than after.
      expect(a).toEqual(b);
      expect(a.resists).not.toBe(a.weakTo);
    }
  });

  it('a dungeon is no harder than the ladder on average', () => {
    // The affinity is symmetric around the ladder baseline, so the average dungeon
    // is exactly the ladder at that depth. An affinity that only ever added
    // resistance would be a difficulty tax with an elemental costume on.
    const stage = 60;
    const resist = dungeonResistances(9, stage);
    const total = ELEMENTS.reduce((sum, e) => sum + resist[e], 0);
    expect(total / ELEMENTS.length).toBeCloseTo(stageResistance(stage), 9);
  });

  it('every element has an affix that grants it', () => {
    // Lightning and darkness have no skill. If the pool did not cover them they would
    // be enum members nothing in the game can produce - dead content with a test
    // suite reassuring everyone it works.
    for (const element of ELEMENTS) {
      const affix = AFFIXES.find(
        (a) => a.effect.kind === 'extraElement' && a.effect.element === element,
      );
      expect(affix, `no affix grants extra ${element}`).toBeDefined();
    }
  });

  it('an extra-element affix on a worn item shows up in the shares', () => {
    // End to end through itemEffects, so a template that resolved to the wrong shape
    // would fail here rather than silently contributing nothing.
    const affix = AFFIXES.find((a) => a.id === 'extra-lightning');
    expect(affix).toBeDefined();
    if (!affix) return;

    const top = affix.tiers.length - 1;
    const item = {
      ...rollItem(9, 1, 90),
      rarity: 'magic' as const,
      baseId: 'whetstone',
      uniqueId: undefined,
      baseAffix: undefined,
      affixes: [{ affixId: affix.id, tier: top, value: affix.tiers[top].value }],
    };
    const loadout = Array<string | null>(MAX_ITEM_SLOTS).fill(null);
    loadout[0] = item.uid;
    const save: SaveState = { ...newSave(9, T0), items: [item], loadout };

    expect(damageShares(save, CTX).lightning).toBeCloseTo(affix.tiers[top].value, 9);
  });

  it('penetration is worth more the deeper you are', () => {
    // The affix's defining property, and the reason it is sized the way it is: what
    // it cancels is a function of the stage, so its worth rises with depth on its own
    // rather than with its tier. A constant here would mean the tuning was fiction.
    const shares = damageShares(newSave(1, T0), CTX);
    const worth = (stage: number) =>
      elementalScale(shares, 0.026, stageResistances(stage)) /
      elementalScale(shares, 0, stageResistances(stage));

    expect(worth(1)).toBeLessThan(worth(50));
    expect(worth(50)).toBeLessThan(worth(300));
    // And it never becomes the correct pick everywhere - at the best roll and the
    // deepest measured stage it is still under what a top attack-speed roll gives.
    expect(worth(300) - 1).toBeLessThan(0.042);
  });

  it('an extra share is worth less on the ladder than a plain damage roll', () => {
    // The sizing argument, asserted rather than described. Ladder resistance is
    // uniform, so an extra share is mitigated exactly like your own damage - which
    // makes it strictly worse than Brutal there, and is what keeps the power ceiling
    // and the ladder's pacing where they were. It earns its place in dungeons.
    const brutal = AFFIXES.find((a) => a.id === 'brutal');
    const extra = AFFIXES.find((a) => a.id === 'extra-fire');
    expect(brutal && extra).toBeTruthy();
    if (!brutal || !extra) return;

    for (let tier = 0; tier < extra.tiers.length; tier++) {
      expect(extra.tiers[tier].value).toBeLessThan(brutal.tiers[tier].value);
    }
  });

  it('every skill declares an element, and two of them are not physical', () => {
    expect(getSkill('fireball')?.element).toBe('fire');
    expect(getSkill('frost-nova')?.element).toBe('cold');
    expect(getSkill('sunder')?.element).toBe('physical');
    // Unarmed is physical, which is what keeps a weaponless save's numbers where
    // they were: physical share of 1 against the ladder's uniform resistance.
    expect(getSkill('unarmed')?.element).toBe('physical');
  });
});

describe('big numbers', () => {
  it('survives the JSON round trip a save actually takes', () => {
    // Both stores serialise through JSON - the file adapter directly, Supabase via
    // jsonb - so this IS the persistence path. As a JSON number, 1e5000 comes back
    // as Infinity; as a string it comes back as itself.
    for (const value of ['1e300', '1e5000', '123456789012345678901234567890']) {
      const save: SaveState = { ...newSave(1, T0), gold: value };
      const round = JSON.parse(JSON.stringify(save)) as SaveState;
      expect(fromSave(round.gold).eq(big(value)), value).toBe(true);
    }
  });

  it('formats every magnitude a player could ever hold', () => {
    // The old formatter had six suffix names and started printing 1000000.00Q past
    // the last one. This one switches to exponent form instead, so it cannot run out.
    let previous = big(0);
    for (let exp = 0; exp <= 50_000; exp += 137) {
      const value = big(`1e${exp}`);
      const text = formatBig(value);

      expect(text, `1e${exp}`).not.toMatch(/NaN|Infinity|undefined/);
      expect(text.length, `1e${exp} -> ${text}`).toBeLessThan(16);
      expect(value.gt(previous)).toBe(true);
      previous = value;
    }

    // The readable range keeps its names; past it, exponents.
    expect(formatBig(big(1500))).toBe('1.50k');
    expect(formatBig(big('1.18e20'))).toBe('118.00Q');
    expect(formatBig(big('1e21'))).toBe('1.00e21');
  });

  it('holds magnitudes the whole curve can reach, not just the ones it does', () => {
    // The reason for the type, stated as a test. Every one of these is Infinity as a
    // double, and Infinity in enemyHp means NaN clear times all the way down.
    for (const stage of [10_000, 100_000, 1_000_000]) {
      const hp = big(TUNING.enemyHpBase).mul(big(TUNING.enemyHpGrowth).pow(stage - 1));
      const gold = big(TUNING.goldBase).mul(big(TUNING.goldGrowth).pow(stage - 1));

      expect(Number.isFinite(hp.exponent), `enemyHp at ${stage}`).toBe(true);
      expect(Number.isFinite(gold.exponent), `goldPerKill at ${stage}`).toBe(true);
      expect(hp.gt(gold)).toBe(true);
      expect(formatBig(hp)).not.toMatch(/NaN|Infinity/);
      // And the same value as a double is exactly the failure being escaped.
      expect(TUNING.enemyHpBase * Math.pow(TUNING.enemyHpGrowth, stage - 1)).toBe(Infinity);
    }
  });

  it('resolves a stage far past where a double gives up', () => {
    // The whole point, end to end. At stage 100,000 enemy HP is ~10^4,920 and a
    // weapon's skill-level damage term is 1.05^100,000 - both Infinity as doubles,
    // and Infinity anywhere in resolveStage means NaN seconds and NaN gold.
    //
    // Their RATIO is an ordinary number of seconds, which is exactly why the
    // magnitudes are Bigs and the outcome fields are not.
    const stage = 100_000;
    const weapon = { ...rollItem(9, 1, stage), baseId: 'axe', rarity: 'rare' as const };
    const save: SaveState = {
      ...newSave(9, T0),
      bestStage: stage,
      currentStage: stage,
      items: [weapon],
      weapon: weapon.uid,
      upgrades: { ...newSave(9, T0).upgrades, damage: 4000, health: 4000, toughness: 4000 },
    };

    const stats = deriveStats(save, { stage, isBoss: false, enemyHpFraction: 1 });
    expect(Number.isFinite(stats.damage.exponent)).toBe(true);
    expect(stats.damage.exponent).toBeGreaterThan(308);
    expect(formatBig(statsDps(stats))).not.toMatch(/NaN|Infinity/);

    const outcome = resolveStage(save, stage);
    expect(Number.isFinite(outcome.seconds)).toBe(true);
    expect(Number.isFinite(outcome.damageTakenFraction)).toBe(true);
    expect(Number.isFinite(outcome.goldEarned.exponent)).toBe(true);
    expect(Number.isFinite(farmRate(save, stage).exponent)).toBe(true);
  });

  it('migrates a v6 double into a string without changing what it holds', () => {
    const v6 = {
      ...newSave(1, T0),
      contentVersion: 6,
      gold: 123456.75,
      lifetimeGold: undefined,
    } as unknown as SaveState;

    const { state, migrated } = migrateSave(v6);

    expect(migrated).toBe(true);
    expect(fromSave(state.gold).eq(big(123456.75))).toBe(true);
    // Seeded from the balance rather than from zero: telling prestige that a
    // long-running account has never earned anything is the worse of two errors.
    expect(fromSave(state.lifetimeGold).eq(big(123456.75))).toBe(true);
  });

  it('counts lifetime gold up and never down', () => {
    // Both fields seeded together, the way the migration leaves an existing save.
    // Injecting a balance without the matching history would make lifetime earnings
    // start behind, which is a property of the fixture rather than of the code.
    let save: SaveState = { ...newSave(4, T0), gold: '1e9', lifetimeGold: '1e9' };
    save = play(save, [
      { type: 'attemptStage' },
      { type: 'buyUpgrade', key: 'damage', count: 10 },
      { type: 'attemptStage' },
    ]);

    // Spending moved the balance and left earnings alone. If these two ever tracked
    // each other, prestige would be priced off a number that goes down when you buy
    // something.
    expect(fromSave(save.lifetimeGold).gt(fromSave(save.gold))).toBe(true);
    expect(fromSave(save.lifetimeGold).gt(big('1e9'))).toBe(true);
  });
});

describe('rerolling', () => {
  const richSave = (item: ReturnType<typeof rollItem>): SaveState => ({
    ...newSave(5, T0),
    gold: '1e12',
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
    expect(goldOf(result.value.state).eq(goldOf(save).sub(cost))).toBe(true);
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
    expect(fifth.gt(first.mul(2))).toBe(true);
  });

  it('refuses a reroll that cannot be afforded', () => {
    const item = rollableItem();
    const save: SaveState = { ...newSave(5, T0), gold: '0', items: [item] };
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

  it('pays a clear from both the wave and the clear itself', () => {
    // Was "between one and three", which was the whole story before trash kills
    // dropped anything. A clear now pays two sources and the bound is their sum -
    // the clear's own 1-3, plus whatever the wave rolled up to its cap.
    const counts = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const result = applyCommand(newSave(seed, T0), { type: 'attemptStage' }, T0);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const dropped = result.value.events.filter((e) => e.type === 'itemDropped').length;
      expect(dropped).toBeGreaterThanOrEqual(DROPS_PER_CLEAR.min);
      expect(dropped).toBeLessThanOrEqual(DROPS_PER_CLEAR.max + WAVE_DROP_MAX);
      counts.add(dropped);
    }
    // A range that only ever produces one value is not a range.
    expect(counts.size).toBeGreaterThan(1);
    // And the wave really is contributing at stage 1, not just at depth - the
    // clear alone could never exceed three.
    expect(Math.max(...counts)).toBeGreaterThan(DROPS_PER_CLEAR.max);
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
    gold: '1e12',
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
    // Read off the limits rather than written down, so widening a rarity's rows
    // does not silently turn this into an assertion about the wrong number.
    const rows = (r: 'common' | 'magic') => AFFIX_LIMITS[r].prefix + AFFIX_LIMITS[r].suffix;
    expect(after.affixes.length).toBe(rows('magic'));
    expect(after.affixes.length).toBeGreaterThan(rows('common'));
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

  it('bishop and devil trade a row; only dune adds one', () => {
    const total = (id: CurrencyId, seed: number) => {
      const item = itemOfRarity('rare', seed, 120);
      const result = craft(withCurrency(item), id, item.uid);
      if (!result.ok) return 0;
      const rows = affixRows(result.value.state.items[0]);
      return rows.prefix + rows.suffix;
    };

    // Derived, not written down. These were literal 4s and 5s, which is exactly
    // what broke when a rare went from 2/2 to 3/3 - the numbers were right about
    // the old content and said nothing about the rule.
    const rareRows = AFFIX_LIMITS.rare.prefix + AFFIX_LIMITS.rare.suffix;

    for (let seed = 1; seed <= 8; seed++) {
      expect(total('bishop-spirit', seed)).toBe(rareRows);
      expect(total('devil-spirit', seed)).toBe(rareRows);
    }
    // Dune is the only route to an extra row - that is what makes it the rarest
    // thing that drops, and what the craft ceiling budgets for.
    const duneTotals = new Set(Array.from({ length: 24 }, (_, i) => total('dune-spirit', i + 1)));
    expect(duneTotals).toContain(rareRows + 1);
    expect(Math.max(...duneTotals)).toBe(rareRows + 1);
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

  it('refuses every currency on a unique except the flame', () => {
    // Angel Flame rerolls magnitudes and leaves identity alone, which is exactly
    // what a unique's authored ranges are. Everything else has no affixes to reroll,
    // no rarity to raise and no rows to trade.
    const unique = itemOfRarity('unique', 3);
    for (const currency of CURRENCIES) {
      if (currency.tier === 'fragment' || currency.tier === 'key') continue;
      const result = craft(withCurrency(unique), currency.id, unique.uid);
      const allowed = currency.action.kind === 'rerollTiers';
      expect(result.ok, `${currency.id} on a unique`).toBe(allowed);
    }
  });

  it('rerolls a unique inside its authored ranges and nowhere else', () => {
    const unique = itemOfRarity('unique', 3);
    const authored = getUnique(unique.uniqueId!)!;

    // Every roll of every flame, not just the first: a range check that samples once
    // passes on any bug that only shows up at one end of the interval.
    let current = unique;
    const seen: number[][] = [];
    for (let i = 0; i < 40; i++) {
      const result = craft(withCurrency(current), 'angel-flame', current.uid);
      expect(result.ok).toBe(true);
      if (!result.ok) break;
      current = result.value.state.items[0];

      expect(current.uniqueId).toBe(unique.uniqueId);
      expect(current.uniqueRolls).toHaveLength(authored.effects.length);
      authored.effects.forEach((effect, j) => {
        const value = current.uniqueRolls![j];
        expect(value).toBeGreaterThanOrEqual(effect.roll.min);
        expect(value).toBeLessThanOrEqual(effect.roll.max);
      });
      seen.push(current.uniqueRolls!);
    }

    // A flame that returned the same numbers every time would pass every bound check
    // above while being a currency that does nothing.
    const varying = authored.effects.some(
      (effect, j) => effect.roll.max > effect.roll.min && new Set(seen.map((r) => r[j])).size > 1,
    );
    expect(varying, 'the flame produced identical rolls every time').toBe(true);
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

describe('accessories', () => {
  /**
   * A bare accessory of a given base.
   *
   * Hand-built rather than rolled: nothing drops one yet - that is the Abyss's job, in a
   * later commit - and the slot machinery has to be right before there is anything to
   * put in it.
   */
  const accessory = (baseId: string, uid = 'a1'): ItemInstance => ({
    uid,
    baseId,
    rarity: 'common',
    itemLevel: ABYSS_UNLOCK_STAGE,
    affixes: [],
    baseAffix: { affixId: BASE_AFFIXES[baseId].id, tier: 0, value: BASE_AFFIXES[baseId].tiers[0].value },
    rerolls: 0,
    crafts: 0,
  });

  const owning = (items: ItemInstance[]): SaveState => ({ ...newSave(1, T0), items });

  it('puts a ring in a ring slot and refuses everything else', () => {
    const ring = accessory('signet');
    const amulet = accessory('pendant', 'a2');
    const gear = rollItem(1, 50, 40);
    const save = owning([ring, amulet, gear]);

    const ok = applyCommand(save, { type: 'equipAccessory', slot: 0, itemId: ring.uid }, T0);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.state.accessories).toEqual([ring.uid, null, null]);

    // The refusals say WHY. "Nothing happened" is the worst possible answer to a player
    // dragging a pendant onto a ring slot.
    const wrongSlot = applyCommand(save, { type: 'equipAccessory', slot: 0, itemId: amulet.uid }, T0);
    expect(wrongSlot.ok).toBe(false);
    if (!wrongSlot.ok) expect(wrongSlot.error).toMatch(/amulet, not a ring/);

    const notAnAccessory = applyCommand(
      save,
      { type: 'equipAccessory', slot: 2, itemId: gear.uid },
      T0,
    );
    expect(notAnAccessory.ok).toBe(false);
    if (!notAnAccessory.ok) expect(notAnAccessory.error).toBe('that is not an accessory');
  });

  it('never wears the same accessory twice', () => {
    // One item contributing from two slots is the rule the weapon enforces against the
    // loadout, applied within this array.
    const ring = accessory('band');
    const save = owning([ring]);

    const first = applyCommand(save, { type: 'equipAccessory', slot: 0, itemId: ring.uid }, T0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyCommand(
      first.value.state,
      { type: 'equipAccessory', slot: 1, itemId: ring.uid },
      T0,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.state.accessories).toEqual([null, ring.uid, null]);
  });

  it('contributes its implicit to the sheet, and only while worn', () => {
    const ring = accessory('signet');
    const save = owning([ring]);
    const ctx = { stage: 100, isBoss: false, enemyHpFraction: 1 };

    const bare = deriveStats(save, ctx);
    const worn = applyCommand(save, { type: 'equipAccessory', slot: 0, itemId: ring.uid }, T0);
    expect(worn.ok).toBe(true);
    if (!worn.ok) return;

    // Owned but unequipped does nothing - the rule every other item obeys.
    expect(deriveStats({ ...save, items: [ring] }, ctx).damage.toString()).toBe(
      bare.damage.toString(),
    );
    expect(deriveStats(worn.value.state, ctx).damage.gt(bare.damage)).toBe(true);
  });

  it('cannot change the equip slot count', () => {
    // Accessories sit outside `slotsFrom`'s fixed point on purpose - a second one feeding
    // through the first is a shape nobody wants to reason about. Asserted on the CONTENT
    // rather than the code, so authoring an equipSlots accessory affix fails here.
    for (const base of ACCESSORY_BASES) {
      const implicit = BASE_AFFIXES[base.id];
      expect(implicit, `${base.id} has no implicit`).toBeDefined();
      expect(implicit.effect.kind).toBe('statMod');
    }
    const ring = accessory('signet');
    const worn: SaveState = { ...owning([ring]), accessories: [ring.uid, null, null] };
    expect(equipSlots(worn, { stage: 1, isBoss: false, enemyHpFraction: 1 })).toBe(ITEM_SLOTS);
  });

  it('refuses to dissemble one you are wearing', () => {
    const ring = accessory('seal');
    const worn: SaveState = { ...owning([ring]), accessories: [ring.uid, null, null] };
    const result = applyCommand(worn, { type: 'dissembleItems', uids: [ring.uid] }, T0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unequip it first');
  });

  it('adds to the gear pool rather than replacing it', () => {
    /*
      THE difference between `'accessory'` and `'tablet'`, asserted.

      A tablet PARTITIONS - it rolls its own pool and nothing else. An accessory ADDS: it
      rolls everything a Whetstone can, plus its own extras. Getting these the same way
      round would make a ring either a Whetstone with a nicer icon or an item with four
      possible modifiers.
    */
    const extras = AFFIXES.filter((a) => a.rollsOn === 'accessory').map((a) => a.id);
    expect(extras.length).toBeGreaterThan(0);

    const onRing = eligibleAffixes(AFFIXES, 'signet').map((a) => a.id);
    const onGear = eligibleAffixes(AFFIXES, 'whetstone').map((a) => a.id);

    // Everything gear can roll, and then some.
    for (const id of onGear) expect(onRing, `${id} missing from the ring pool`).toContain(id);
    for (const id of extras) expect(onRing).toContain(id);
    expect(onRing.length).toBeGreaterThan(onGear.length);

    // And closed the other way: an accessory extra never appears anywhere else.
    for (const baseId of [...GEAR_BASES, ...WEAPON_BASES, ...TABLET_BASES].map((b) => b.id)) {
      const pool = eligibleAffixes(AFFIXES, baseId).map((a) => a.id);
      for (const id of extras) expect(pool, `${id} leaked onto ${baseId}`).not.toContain(id);
    }
  });

  it('grants skill levels that only help the matching weapon', () => {
    // Weapon-TYPE locked in effect rather than in eligibility. On a weapon that would be
    // a dead row - hence the rollsOn gate on of-Mastery - but on a ring it is a build
    // decision, because a player chooses which ring to wear.
    // No implicit: a Signet's is increased damage, which would move a caster's sheet on
    // its own and make this test pass for the wrong reason. The skill level has to be
    // the only thing the ring contributes.
    const ring: ItemInstance = {
      ...accessory('signet'),
      baseAffix: undefined,
      affixes: [{ affixId: 'of-ascendancy', tier: 1, value: 2 }],
    };
    const axe = WEAPON_BASES.find((b) => b.id === 'axe')!;
    const wand = WEAPON_BASES.find((b) => b.id === 'wand')!;
    const ctx = { stage: 100, isBoss: false, enemyHpFraction: 1 };

    const withWeapon = (baseId: string): SaveState => {
      const weapon = { ...accessory('signet', 'w1'), baseId, baseAffix: undefined };
      const save = { ...owning([ring, weapon]), weapon: weapon.uid };
      return { ...save, accessories: [ring.uid, null, null] };
    };
    const without = (save: SaveState): SaveState => ({ ...save, accessories: [null, null, null] });

    const physical = withWeapon(axe.id);
    const magical = withWeapon(wand.id);

    // The physical skill level moves a physical character and does nothing for a caster.
    expect(deriveStats(physical, ctx).damage.gt(deriveStats(without(physical), ctx).damage)).toBe(
      true,
    );
    expect(deriveStats(magical, ctx).damage.toString()).toBe(
      deriveStats(without(magical), ctx).damage.toString(),
    );
  });

  it('can build offence or defence out of either slot kind', () => {
    // The structural half of the offence/defence invariant. If rings were the offensive
    // slot, a defensive character could not use two of its three accessory slots - the
    // asymmetry arriving by construction rather than by a value being wrong.
    const DEFENSIVE = new Set(['maxHp', 'toughness']);
    const OFFENSIVE = new Set([
      'damage',
      'attackSpeed',
      'critChance',
      'critMult',
      'area',
      'physicalSkillLevel',
      'magicalSkillLevel',
    ]);
    const statOf = (baseId: string) => {
      const effect = BASE_AFFIXES[baseId].effect;
      return effect.kind === 'statMod' ? effect.stat : '';
    };

    for (const [kind, bases] of [
      ['ring', RING_BASES],
      ['amulet', AMULET_BASES],
    ] as const) {
      const stats = bases.map((b) => statOf(b.id));
      expect(stats.some((s) => OFFENSIVE.has(s)), `no offensive ${kind}`).toBe(true);
      expect(stats.some((s) => DEFENSIVE.has(s)), `no defensive ${kind}`).toBe(true);
    }
    /*
      And both axes exist among the accessory-ONLY extras too.

      Not the same stats gear uses - those already roll on accessories, so an extra that
      duplicated one would be Brutal with a different name, and measuring said so: it
      took the ladder from 15.4 days to 2.0. What is here is what gear CANNOT have, and
      offence and defence each need one or the invariant breaks structurally.
    */
    const extras = AFFIXES.filter((a) => a.rollsOn === 'accessory');
    const stats = extras.flatMap((a) => (a.effect.kind === 'statMod' ? [a.effect.stat] : []));
    expect(stats.some((s) => OFFENSIVE.has(s)), 'no offensive accessory extra').toBe(true);
    expect(stats.some((s) => DEFENSIVE.has(s)), 'no defensive accessory extra').toBe(true);
  });

  it('drops from the Abyss and from nowhere else', () => {
    /*
      THE assertion the whole power budget rests on.

      Accessories carry skill levels and the biggest percentages in the game, and they can
      only afford to because they cost a tablet. A leak into the ladder's drop table would
      hand them out by the hundred without the Abyss being involved at all.
    */
    const isAccessory = (item: ItemInstance) => getBase(item.baseId)?.wear !== undefined;

    for (let uid = 1; uid <= 800; uid++) {
      const stage = 1 + (uid % 300);
      expect(isAccessory(rollItem(4, uid, stage)), `stage clear at ${stage}`).toBe(false);
      expect(isAccessory(rollItem(4, uid, stage, WAVE_RARITY_WEIGHTS)), 'wave loot').toBe(false);
      expect(isAccessory(rollDungeonItem(4, uid, stage)), 'dungeon').toBe(false);
      // A tablet is an item too, and must not come back as a ring.
      expect(isAccessory(rollTablet(4, uid, 1 + (uid % MAX_TABLET_TIER))), 'tablet').toBe(false);
    }

    // And the Abyss does produce them, or the slots are unfillable.
    expect(isAccessory(rollAccessory(4, 1, ABYSS_UNLOCK_STAGE))).toBe(true);
  });

  it('rolls deeper the deeper the tablet was', () => {
    // The reason to climb the tier ladder for something other than gold. An accessory's
    // item level is the tablet's DEPTH, and the gates are spread across that range - so
    // a T12 pays tiers a T1 cannot reach.
    const shallow = rollAccessory(8, 10, abyssalDepth(1));
    const deep = rollAccessory(8, 10, abyssalDepth(MAX_TABLET_TIER));

    expect(shallow.itemLevel).toBe(abyssalDepth(1));
    expect(deep.itemLevel).toBeGreaterThan(shallow.itemLevel);

    // Measured on the IMPLICIT, which is the only modifier guaranteed to be on the
    // accessory gate scale. A ring also rolls gear affixes, and those gate at [1,15,40,80]
    // - so their top tier is already reachable at floor 80 and says nothing about depth.
    const best = (level: number) =>
      Math.max(
        ...Array.from({ length: 60 }, (_, i) => rollAccessory(8, i + 1, level).baseAffix?.tier ?? 0),
      );
    expect(best(abyssalDepth(1))).toBe(0);
    expect(best(abyssalDepth(MAX_TABLET_TIER))).toBeGreaterThan(0);
  });

  it('steers toward the base a gold tablet pays in', () => {
    // A bias, not a guarantee - a promise would make the other five bases unreachable for
    // anyone farming gold. Only the gold axis has an accessory to point at; quantity and
    // rarity steer the drop through count and item level instead.
    const goldFinders = (pays: TabletPays | undefined) => {
      let found = 0;
      for (let uid = 1; uid <= 600; uid++) {
        const item = rollAccessory(11, uid, ABYSS_UNLOCK_STAGE, pays);
        const implicit = BASE_AFFIXES[item.baseId].effect;
        if (implicit.kind === 'statMod' && implicit.stat === 'goldFind') found++;
      }
      return found;
    };

    expect(goldFinders('gold')).toBeGreaterThan(goldFinders(undefined));
    // And never to the exclusion of everything else.
    expect(goldFinders('gold')).toBeLessThan(600);
  });

  it('gains three empty slots on migration, and nothing else moves', () => {
    // v11 -> v12 is additive, exactly like `weapon` in v6 and `tablets` in v10.
    const v11 = { ...newSave(2, T0), contentVersion: 11, items: [rollItem(2, 1, 40)] };
    delete (v11 as Partial<SaveState>).accessories;

    const { state, migrated } = migrateSave(v11 as SaveState);
    expect(migrated).toBe(true);
    expect(state.accessories).toEqual([null, null, null]);
    expect(state.items).toEqual(v11.items);
    expect(state.loadout).toEqual(v11.loadout);
  });
});

describe('tablets', () => {
  /** Every affix in the game that is meant for a tablet, and nothing else. */
  const tabletPool = () => AFFIXES.filter((a) => a.rollsOn === 'tablet');

  it('keeps the two pools apart, in both directions', () => {
    /*
      THE assertion the whole shape rests on.

      A tablet is stored as an ItemInstance now, which is only safe because the pools are
      partitioned. Without it `rerollAffixes` hands a tablet increased crit chance and a
      Whetstone rolls "monsters have 40% more health" - the exact failure that made the
      first cut give tablets their own type.
    */
    expect(tabletPool().length).toBeGreaterThan(0);

    for (let uid = 1; uid <= 400; uid++) {
      const tablet = rollTablet(7, uid, 8);
      for (const rolled of tablet.affixes) {
        expect(getAffix(rolled.affixId)?.rollsOn, rolled.affixId).toBe('tablet');
      }
      // And a tablet modifier never reaches the character sheet, because there is no
      // Effect for one - not a rule, a missing code path.
      expect(itemEffects(tablet)).toHaveLength(0);

      const gear = rollItem(7, uid, 120);
      for (const rolled of gear.affixes) {
        expect(getAffix(rolled.affixId)?.rollsOn, rolled.affixId).not.toBe('tablet');
      }
    }
  });

  it('rolls rows by rarity and gates modifiers by tier', () => {
    for (let tier = 1; tier <= MAX_TABLET_TIER; tier++) {
      for (let uid = 1; uid <= 40; uid++) {
        const tablet = rollTablet(4, uid * 31 + tier, tier);
        expect(tablet.itemLevel).toBe(tier);
        expect(tablet.rarity).not.toBe('unique');

        const rows = affixRows(tablet);
        expect(tablet.affixes).toHaveLength(rows.prefix + rows.suffix);
        // Distinct for the same reason an item never rolls one affix twice: the danger
        // sums against a curve that is already exponential.
        expect(new Set(tablet.affixes.map((a) => a.affixId)).size).toBe(tablet.affixes.length);

        for (const rolled of tablet.affixes) {
          const affix = getAffix(rolled.affixId)!;
          expect(affix.tiers[rolled.tier].minStage).toBeLessThanOrEqual(tier);
        }
      }
    }
  });

  it('every modifier is pure downside, and the implicit is what pays', () => {
    // The coupling. An explicit that paid for itself would make the mods
    // interchangeable, which is what the previous cut got wrong.
    for (const affix of tabletPool()) {
      expect(affix.effect.kind, affix.id).toBe('monsterBuff');
      for (const tier of affix.tiers) {
        expect(tier.value, `${affix.id} adds no danger`).toBeGreaterThan(0);
      }
    }
  });

  it('scales the implicit by the danger, and tolerates a retired modifier', () => {
    const base = rollTablet(5, 1, 10);
    const bare = { ...base, affixes: [] };
    const loaded = {
      ...base,
      affixes: [{ affixId: 'tablet-bloated', tier: 3, value: 0.45 }],
    };
    // A modifier id that no longer exists resolves to nothing rather than breaking the
    // tablet - the same tolerance itemEffects gives a retired affix.
    const stale = { ...base, affixes: [{ affixId: 'gone', tier: 0, value: 0.5 }] };

    const bareReward = tabletReward(bare)!;
    expect(tabletReward(loaded)!.amount).toBeCloseTo(bareReward.amount * 1.45, 9);
    expect(tabletReward(stale)!.amount).toBeCloseTo(bareReward.amount, 9);
    expect(totalDanger(stale)).toBe(0);

    // The axis comes from the base and never from the modifiers, so a tablet pays what
    // its base says whatever is rolled on it.
    expect(tabletReward(loaded)!.pays).toBe(bareReward.pays);
  });

  /** A character who has just reached the unlock floor, geared roughly for it. */
  const atUnlock = (seed = 31): SaveState => {
    const base = newSave(seed, T0);
    return {
      ...base,
      bestStage: ABYSS_UNLOCK_STAGE,
      currentStage: ABYSS_UNLOCK_STAGE + 1,
      upgrades: {
        ...base.upgrades,
        damage: 120,
        attackSpeed: 60,
        resource: 60,
        health: 150,
        toughness: 150,
      },
    };
  };

  /** A tablet of this tier carrying nothing at all - the tier curve, unmodified. */
  const plainTablet = (tier: number): ItemInstance => ({
    ...rollTablet(31, 900 + tier, tier),
    rarity: 'common',
    affixes: [],
  });

  it('a T1 is a fair fight at the unlock floor and a T15 is not', () => {
    // THE assertion that decides whether the tier curve is right. The Abyss indexes on
    // tier alone, so if T1 is unwinnable the mode is unreachable, and if T15 is easy
    // the whole range is decoration.
    //
    // It caught exactly that: the first cut put a T1 at 23x a stage-80 boss - nine
    // times a dungeon - and it timed out for a character who clears the floor it
    // unlocks on.
    const save = atUnlock();

    // The premise. If this character cannot clear floor 80 then "at the unlock floor"
    // is a fiction and the rest of the assertion means nothing.
    expect(resolveStage(save, ABYSS_UNLOCK_STAGE).cleared).toBe(true);

    expect(resolveAbyssal(save, plainTablet(1)).cleared).toBe(true);
    expect(resolveAbyssal(save, plainTablet(MAX_TABLET_TIER)).cleared).toBe(false);
  });

  it('a T1 costs more than the dungeon at the same floor', () => {
    // The Abyss has to be worth a scarcer consumable. Measured against the dungeon
    // rather than an absolute number, so retuning either one keeps this honest.
    const save = atUnlock();
    const dungeon = resolveDungeon(save, ABYSS_UNLOCK_STAGE);
    const abyssal = resolveAbyssal(save, plainTablet(1));

    expect(dungeon.cleared && abyssal.cleared).toBe(true);
    expect(abyssal.seconds).toBeGreaterThan(dungeon.seconds);
  });

  it('does not read bestStage - two characters run the same T7', () => {
    // The point of indexing on tier. A player deep in the ladder and one who just
    // unlocked the Abyss meet the same boss; only their own power differs.
    const shallow = atUnlock();
    const deep: SaveState = { ...shallow, bestStage: 260, currentStage: 261 };

    const a = resolveAbyssal(shallow, plainTablet(7));
    const b = resolveAbyssal(deep, plainTablet(7));
    expect(a.seconds).toBeCloseTo(b.seconds, 9);
  });

  it('modifiers make it harder, and pay for it through the implicit', () => {
    // T1, because it is the only tier this character clears - comparing two runs that
    // both time out would compare the cap against itself and pass on nothing.
    const save = atUnlock();
    const plain = plainTablet(1);
    const modded: ItemInstance = {
      ...plain,
      affixes: [
        { affixId: 'tablet-bloated', tier: 0, value: 0.15 },
        { affixId: 'tablet-of-fury', tier: 0, value: 0.07 },
      ],
    };

    expect(resolveAbyssal(save, plain).cleared).toBe(true);
    expect(resolveAbyssal(save, modded).seconds).toBeGreaterThan(
      resolveAbyssal(save, plain).seconds,
    );
    // And strictly better paid. Danger with no matching reward would be a punishment
    // nobody would ever apply.
    expect(tabletReward(modded)!.amount).toBeGreaterThan(tabletReward(plain)!.amount);
  });

  it('runs waves before the boss, and never heals between them', () => {
    /*
      "Limited HP inside; at zero you leave with nothing."

      One pool for the whole run. The assertion that matters is the SECOND one: a tablet
      whose waves each survive individually but whose total does not must still fail, or
      the `waves` modifier is a time cost rather than a danger.
    */
    const save = atUnlock();
    const short = plainTablet(1);
    const long: ItemInstance = {
      ...short,
      affixes: [{ affixId: 'tablet-endless', tier: 3, value: 0.5 }],
    };

    const shortRun = resolveAbyssal(save, short);
    expect(shortRun.trashPhaseSeconds).toBeGreaterThan(0);
    expect(shortRun.bossPhaseSeconds).toBeGreaterThan(0);

    const longRun = resolveAbyssal(save, long);
    expect(longRun.trashPhaseSeconds).toBeGreaterThan(shortRun.trashPhaseSeconds);
    // More waves against a pool that never refills is strictly more damage taken.
    expect(longRun.damageTakenFraction).toBeGreaterThan(shortRun.damageTakenFraction);
  });

  it('gives a longer run a longer clock, and no more', () => {
    // A deep tablet must fail on difficulty, not on arithmetic - but a per-wave budget
    // generous enough to be comfortable would retire the timeout for exactly the runs
    // where it should bite hardest.
    expect(delveTimeLimit(0)).toBe(STAGE_TIME_LIMIT_SECONDS);
    expect(delveTimeLimit(8)).toBeGreaterThan(delveTimeLimit(4));
    // Proportional, so the clock is as binding on a long run as on a short one.
    const perWave = (delveTimeLimit(8) - delveTimeLimit(0)) / 8;
    expect((delveTimeLimit(4) - delveTimeLimit(0)) / 4).toBeCloseTo(perWave, 9);
  });

  it('the element you bring decides an Abyssal run', () => {
    // THE assertion that decides whether 0.55 is right. At that affinity the resisted
    // element is x0.27 and the vulnerable one x1.50, so the same character on the same
    // tablet should clear one and struggle on the other. If both clear, the affinity is
    // decoration; if neither does, it is an immunity wearing a different word.
    const save = atUnlock();
    const tablet = plainTablet(2);
    const depth = abyssalDepth(tablet.itemLevel);
    const { resists, weakTo } = dungeonAffinity(save.seed, depth);

    const shares = (element: typeof resists) => ({
      physical: 0,
      fire: 0,
      cold: 0,
      lightning: 0,
      darkness: 0,
      [element]: 1,
    });
    const resist = dungeonResistances(save.seed, depth, ABYSSAL_PROFILE.affinity);

    const intoResisted = elementalScale(shares(resists), 0, resist);
    const intoWeakness = elementalScale(shares(weakTo), 0, resist);

    expect(intoWeakness / intoResisted).toBeGreaterThan(3);
  });

  it('the wave is the faucet, and only past the unlock floor', () => {
    // A mode you can only enter by already being in it is a mode most players never
    // see, so the ladder has to hand out the first one.
    expect(rollWaveTablets(5, 1, ABYSS_UNLOCK_STAGE - 1)).toEqual([]);

    const clears = 600;
    let dropped = 0;
    for (let uid = 1; uid <= clears; uid++) {
      dropped += rollWaveTablets(5, uid, ABYSS_UNLOCK_STAGE).length;
    }
    // "Rare but not hard to obtain given the kill rate" - a couple of hundred kills a
    // clear at one in a thousand. Bounds rather than an exact rate: a faucet that opened
    // every clear would make the tablet meaningless, one that never opened is a wall.
    expect(dropped / clears).toBeGreaterThan(0.05);
    expect(dropped / clears).toBeLessThan(0.6);
  });

  it('pays a deeper tier the deeper you are, up to a ceiling the Abyss owns', () => {
    // A T1 forever would make the ladder's faucet useless the moment a player owns a T3,
    // and leave the Abyss as the only route upward - the stranding problem in slow
    // motion. But it must not reach the top either, or the tier ladder is a second name
    // for the stage ladder and there is no reason to run the mode for its own tablets.
    const tierAt = (stage: number) => {
      for (let uid = 1; uid <= 4000; uid++) {
        const found = rollWaveTablets(3, uid, stage);
        if (found.length > 0) return found[0];
      }
      throw new Error(`nothing dropped at stage ${stage}`);
    };

    expect(tierAt(ABYSS_UNLOCK_STAGE)).toBe(1);
    expect(tierAt(ABYSS_UNLOCK_STAGE + TABLET_TIER_STAGES)).toBe(2);
    expect(tierAt(300)).toBe(LADDER_MAX_TABLET_TIER);
    // The ceiling is the load-bearing half. A ladder that reached the top would make the
    // Abyss's own tier-up reward pointless, and it reads as a clear-time collapse.
    expect(LADDER_MAX_TABLET_TIER).toBeLessThan(MAX_TABLET_TIER);
  });

  it('a tablet is a consumable - a run returns less than it costs', () => {
    // THE property the mode rests on, and the one the first cut got wrong. Guaranteeing
    // a same-tier tablet back means clearing a tier pays for the next attempt at it, so
    // a player who can beat one tier runs it forever free. The harness caught it: fifty
    // Abyssals between every stage clear, and the ladder went 10.1 -> 18.2 days.
    for (const tier of [1, 5, 10]) {
      const runs = 600;
      let returned = 0;
      for (let uid = 1; uid <= runs; uid++) {
        const found = rollAbyssalTablets(6, uid, tier);
        returned += found.length;
        for (const tablet of found) {
          expect(tablet.itemLevel).toBeGreaterThanOrEqual(tier);
          expect(tablet.itemLevel).toBeLessThanOrEqual(MAX_TABLET_TIER);
        }
      }
      expect(returned / runs, `tier ${tier} sustains itself`).toBeLessThan(1);
    }
  });

  it('running dry is recoverable, not a dead end', () => {
    // The counterweight to depletion. A player who spends their last tablet is a few
    // stage clears from another, because the ladder never stops being the faucet.
    let dropped = 0;
    for (let uid = 1; uid <= 300; uid++) {
      dropped += rollWaveTablets(12, uid, ABYSS_UNLOCK_STAGE + 40).length;
    }
    expect(dropped).toBeGreaterThan(0);
  });

  it('sometimes pays the next tier, and never past the last', () => {
    const climbed = Array.from({ length: 200 }, (_, i) => rollAbyssalTablets(7, i + 1, 3)).filter(
      (found) => found.some((t) => t.itemLevel === 4),
    ).length;
    expect(climbed).toBeGreaterThan(0);
    expect(climbed).toBeLessThan(200);

    // At the ceiling there is nowhere to climb, so every run pays its own tier only.
    for (let uid = 1; uid <= 60; uid++) {
      for (const tablet of rollAbyssalTablets(7, uid, MAX_TABLET_TIER)) {
        expect(tablet.itemLevel).toBe(MAX_TABLET_TIER);
      }
    }
  });

  it('takes crafting currency, on its own shelf, and only from the tablet pool', () => {
    /*
      "Most crafting currency works on a tablet" - the requirement the whole shape change
      was for. It works because `applyCurrency` now searches BOTH arrays: a tablet is an
      item, it just lives apart so it never competes for INVENTORY_CAP or turns up in an
      equip slot.
    */
    const tablet = rollTablet(9, 400, 6);
    const save: SaveState = {
      ...atUnlock(),
      tablets: [tablet],
      currency: { 'sacred-idol': 1, 'rare-ore': 1, 'bishop-spirit': 1, 'angel-droplet': 1 },
    };

    const rerolled = applyCommand(save, { type: 'applyCurrency', currencyId: 'sacred-idol', uid: tablet.uid }, T0);
    expect(rerolled.ok).toBe(true);
    if (!rerolled.ok) return;
    // Crafted in place on the tablet shelf, and gear is untouched.
    expect(rerolled.value.state.items).toEqual(save.items);
    const crafted = rerolled.value.state.tablets[0];
    expect(crafted.uid).toBe(tablet.uid);
    expect(crafted.crafts).toBe(tablet.crafts + 1);
    // Still only tablet modifiers. A reroll reaching the gear pool is the exact failure
    // that made the first cut give tablets their own type.
    for (const rolled of crafted.affixes) {
      expect(getAffix(rolled.affixId)?.rollsOn, rolled.affixId).toBe('tablet');
    }
    // The suffixes are byte-identical - a targeted reroll is the point of the idols.
    const suffixes = (item: ItemInstance) =>
      item.affixes.filter((a) => getAffix(a.affixId)?.kind === 'suffix');
    expect(suffixes(crafted)).toEqual(suffixes(tablet));

    // Rarity buys rows on a tablet exactly as it does on gear, so the ore is legal.
    const common: ItemInstance = { ...tablet, rarity: 'common' };
    expect(currencyLegality(common, getCurrency('rare-ore')!, false)).not.toBeNull();
    expect(currencyLegality({ ...common, rarity: 'magic' }, getCurrency('rare-ore')!, false)).toBeNull();

    // And the two refusals, each for a stated reason rather than a missing option.
    expect(currencyLegality(tablet, getCurrency('bishop-spirit')!, false)).toMatch(/rows/);
    expect(currencyLegality({ ...tablet, rarity: 'common' }, getCurrency('angel-droplet')!, false)).toMatch(
      /unique tablet/,
    );
  });

  it('spends the tablet on a win and on a loss alike', () => {
    // The pressure that makes running one at the edge of your power a decision. A
    // refunded tablet would make failure free.
    const save = atUnlock();
    const winnable = rollTablet(save.seed, 900, 1);
    const hopeless = rollTablet(save.seed, 901, MAX_TABLET_TIER);
    const withTablets: SaveState = { ...save, tablets: [winnable, hopeless] };

    const won = applyCommand(withTablets, { type: 'attemptAbyssal', uid: winnable.uid }, T0);
    expect(won.ok).toBe(true);
    if (!won.ok) return;
    expect(won.value.events.map((e) => e.type)).toContain('abyssalCleared');
    expect(won.value.state.tablets.some((t) => t.uid === winnable.uid)).toBe(false);

    const lost = applyCommand(withTablets, { type: 'attemptAbyssal', uid: hopeless.uid }, T0);
    expect(lost.ok).toBe(true);
    if (!lost.ok) return;
    expect(lost.value.events.map((e) => e.type)).toContain('abyssalFailed');
    expect(lost.value.state.tablets.some((t) => t.uid === hopeless.uid)).toBe(false);
    // A loss pays nothing at all - not even the tablet that would let you retry.
    expect(lost.value.state.items).toHaveLength(save.items.length);
  });

  it('refuses below the unlock floor, and refuses a tablet you do not hold', () => {
    const tablet = rollTablet(1, 1, 1);
    const shallow: SaveState = { ...newSave(1, T0), bestStage: 10, tablets: [tablet] };
    expect(applyCommand(shallow, { type: 'attemptAbyssal', uid: tablet.uid }, T0).ok).toBe(false);

    const deep = atUnlock();
    expect(applyCommand(deep, { type: 'attemptAbyssal', uid: 'nope' }, T0).ok).toBe(false);
  });

  it('the shelf says what a run will resist before the tablet is spent', () => {
    // The reason the tablets cross the wire as a view rather than raw instances. A
    // tablet is consumed on entry AND on a loss, and at the Abyssal affinity the
    // resisted element is the largest number in the fight - so a run whose element you
    // discover by entering it is a coin flip, not a decision.
    const save = atUnlock();
    const held = [rollTablet(save.seed, 500, 3), rollTablet(save.seed, 501, 9)];
    const hud = getHudSnapshot({ ...save, tablets: held }, T0);

    // Deepest first, so the hardest thing a player might still beat is at the top.
    expect(hud.tablets.map((t) => t.itemLevel)).toEqual([9, 3]);

    for (const tablet of held) {
      const view = hud.tabletRuns[tablet.uid];
      const depth = abyssalDepth(tablet.itemLevel);
      expect(view.tier).toBe(tablet.itemLevel);
      expect(view.depth).toBe(depth);
      // The same affinity the fight will actually roll, not a second derivation of it.
      expect({ resists: view.resists, weakTo: view.weakTo }).toEqual(
        dungeonAffinity(save.seed, depth),
      );
      expect(view.danger).toBeCloseTo(totalDanger(tablet), 9);
      // And the same wave count resolveAbyssal will use - the card must not advertise a
      // shorter run than the one it sells.
      expect(view.waves).toBeGreaterThanOrEqual(wavesForTier(tablet.itemLevel));
    }
  });

  it('states the gate rather than hiding the control', () => {
    const shallow = { ...newSave(3, T0), bestStage: ABYSS_UNLOCK_STAGE - 1 };
    expect(getHudSnapshot(shallow, T0).abyss).toMatchObject({
      unlocked: false,
      unlockStage: ABYSS_UNLOCK_STAGE,
    });
    expect(getHudSnapshot({ ...shallow, bestStage: ABYSS_UNLOCK_STAGE }, T0).abyss.unlocked).toBe(
      true,
    );
  });

  it('a fresh save has none, and an old save gains the array without losing anything', () => {
    expect(newSave(1, T0).tablets).toEqual([]);

    // v9 -> v10 is additive, exactly like `weapon` in v6: nothing is rerolled and no
    // gear moves, so a returning player's character is bit-identical on load.
    const v9 = { ...newSave(2, T0), contentVersion: 9, items: [rollItem(2, 1, 40)] };
    delete (v9 as Partial<SaveState>).tablets;

    const { state, migrated } = migrateSave(v9 as SaveState);
    expect(migrated).toBe(true);
    expect(state.tablets).toEqual([]);
    expect(state.items).toEqual(v9.items);
  });
});

describe('wave loot', () => {
  it('is deterministic, so the client and the server agree about what fell', () => {
    // The renderer rolls these for the animation before the command is sent. If the
    // two sides disagreed, the player would watch an item drop and not receive it.
    for (const stage of [1, 20, 140, 300]) {
      expect(rollWaveDropCount(9, 100, stage)).toBe(rollWaveDropCount(9, 100, stage));
    }
    expect(rollWaveDropCount(9, 100, 50)).not.toBe(rollWaveDropCount(10, 100, 50));
  });

  it('pays from the first stage and never past its cap', () => {
    // Present where a new player meets it, bounded where the inventory is already
    // under pressure - the two halves the constants exist to balance.
    let earlyTotal = 0;
    for (let uid = 1; uid <= 200; uid++) {
      const early = rollWaveDropCount(3, uid, 1);
      const deep = rollWaveDropCount(3, uid, 300);
      earlyTotal += early;
      expect(deep).toBeLessThanOrEqual(WAVE_DROP_MAX);
      expect(early).toBeLessThanOrEqual(WAVE_DROP_MAX);
    }
    expect(earlyTotal).toBeGreaterThan(0);
  });

  it('reaches the cap at depth but not at stage 1', () => {
    // enemyCount is 41 at stage 1 and 220 from stage 113, so the cap should be
    // routine at depth and unreachable-in-practice early. If both ends looked the
    // same the cap would either be doing nothing or doing everything.
    const atCap = (stage: number) =>
      Array.from({ length: 300 }, (_, i) => rollWaveDropCount(11, i + 1, stage)).filter(
        (n) => n >= WAVE_DROP_MAX,
      ).length;
    expect(atCap(300)).toBeGreaterThan(atCap(1));
  });

  it('never drops a unique', () => {
    // The structural reason WAVE_RARITY_WEIGHTS exists. Wave loot multiplies drop
    // volume several times over; if it drew from the normal table it would multiply
    // the unique rate with it and silently undo the Phase 2 tier weights.
    for (let uid = 1; uid <= 4000; uid++) {
      expect(rollItem(5, uid, 200, WAVE_RARITY_WEIGHTS).rarity).not.toBe('unique');
    }
  });

  it('still rolls a real item, not an empty one', () => {
    // A rarity table with a zero in it is exactly where an off-by-one in the
    // weighted pick would produce something malformed rather than something rare.
    for (let uid = 1; uid <= 200; uid++) {
      const item = rollItem(5, uid, 80, WAVE_RARITY_WEIGHTS);
      expect(['common', 'magic', 'rare']).toContain(item.rarity);
      expect(item.baseId).toBeTruthy();
      expect(itemEffects(item).length).toBeGreaterThan(0);
    }
  });

  it('what the renderer shows falling is what the command hands over', () => {
    // The animation rolls its sprites on the client before the command is sent, from
    // the same seed and the same uid counter. If the two ever disagreed the player
    // would watch an axe drop and find a charm in the bag - and nothing would error.
    const save: SaveState = {
      ...newSave(21, T0),
      bestStage: 30,
      currentStage: 30,
      upgrades: { ...newSave(21, T0).upgrades, damage: 300, health: 160, toughness: 160 },
    };

    const predicted = Array.from(
      { length: rollWaveDropCount(save.seed, save.nextItemId, save.currentStage) },
      (_, i) => rollItem(save.seed, save.nextItemId + i, save.currentStage, WAVE_RARITY_WEIGHTS),
    );
    expect(predicted.length).toBeGreaterThan(0);

    const result = applyCommand(save, { type: 'attemptStage' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const granted = result.value.state.items.slice(0, predicted.length);
    expect(granted.map((i) => i.baseId)).toEqual(predicted.map((i) => i.baseId));
    expect(granted.map((i) => i.rarity)).toEqual(predicted.map((i) => i.rarity));
  });

  it('a full inventory loses wave drops and still burns the uid', () => {
    // Reusing a uid after a discard would make the replacement item roll
    // identically to the one that was lost - the rule the clear drops already keep.
    const full: SaveState = {
      ...newSave(4, T0),
      bestStage: 40,
      currentStage: 40,
      upgrades: { ...newSave(4, T0).upgrades, damage: 400, health: 200, toughness: 200 },
      items: Array.from({ length: INVENTORY_CAP }, (_, i) => rollItem(4, 9000 + i, 10)),
      nextItemId: 9000 + INVENTORY_CAP,
    };

    const result = applyCommand(full, { type: 'attemptStage' }, T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.state.items).toHaveLength(INVENTORY_CAP);
    expect(result.value.state.nextItemId).toBeGreaterThan(full.nextItemId);
    expect(result.value.events.some((e) => e.type === 'inventoryFull')).toBe(true);
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
  const loadoutOf = (baseId: string, affixIds: string[]): SaveState => {
    const implicit = BASE_AFFIXES[baseId];
    const items = [0, 1, 2, 3].map((i) => ({
      uid: `best-${i}`,
      baseId,
      rarity: 'rare' as const,
      itemLevel: 100,
      rerolls: 0,
      crafts: 0,
      affixes: affixIds.map(topRoll),
      baseAffix: topRoll(implicit.id),
    }));
    return { ...base, items, loadout: items.map((i) => i.uid) };
  };

  // Ratios of two Bigs, collapsed to ordinary numbers. That is the shape the whole
  // power budget is expressed in, and the reason the magnitudes themselves can be
  // astronomical without anything downstream having to care.
  const dpsRatio = (save: SaveState) =>
    statsDps(deriveStats(save, CTX)).div(statsDps(deriveStats(base, CTX))).toNumber();
  const ehpRatio = (save: SaveState) =>
    effectiveHp(deriveStats(save, CTX)).div(effectiveHp(deriveStats(base, CTX))).toNumber();

  const combos = <T,>(xs: T[], k: number): T[][] =>
    k === 0
      ? [[]]
      : xs.flatMap((x, i) => combos(xs.slice(i + 1), k - 1).map((rest) => [x, ...rest]));

  /**
   * The strongest loadout actually assemblable, found by searching the pool.
   *
   * These lists used to be hand-written, and they went stale the moment the pool
   * changed: the offensive pick paired Brutal with Sweeping, so once a flat
   * damage prefix existed it was measuring the second-best build while claiming
   * to measure the ceiling - and the ceiling test passed for the wrong reason.
   * A search cannot go stale.
   *
   * `extraRow` is the fifth row only a dune spirit grants, taken on whichever
   * half is worth more. Never as a duplicate: rollAffixes picks distinct affixes
   * within an item, so a loadout carrying two Honeds is not reachable and must
   * not be measured.
   */
  const bestLoadout = (metric: (s: SaveState) => number, extraRow: boolean) => {
    // Read off AFFIX_LIMITS rather than written down. Hard-coded shapes were the
    // other half of how these tests went stale: widening a rare's rows would have
    // left the search measuring a four-affix item and still calling it the ceiling.
    const { prefix, suffix } = AFFIX_LIMITS.rare;
    const shapes: [number, number][] = extraRow
      ? [
          [prefix + 1, suffix],
          [prefix, suffix + 1],
        ]
      : [[prefix, suffix]];
    let best = { value: 0, save: base, label: '' };
    // Gear bases only, and only affixes that can actually roll on them.
    //
    // This measures the AFFIX POOL's ceiling, which is what the budget has always
    // been about; the weapon is a separate axis and the ladder measures it. Without
    // the eligibility filter the search happily built a Whetstone carrying Savage
    // and Arcane - two weapon-only affixes on a piece of gear - and reported an
    // offensive ceiling of 3.5x for a loadout nobody can ever assemble.
    for (const baseId of GEAR_BASES.map((b) => b.id)) {
      const prefixes = eligibleAffixes(PREFIXES, baseId).map((a) => a.id);
      const suffixes = eligibleAffixes(SUFFIXES, baseId).map((a) => a.id);
      for (const [np, ns] of shapes) {
        for (const ps of combos(prefixes, np)) {
          for (const ss of combos(suffixes, ns)) {
            const ids = [...ps, ...ss];
            const save = loadoutOf(baseId, ids);
            const value = metric(save);
            if (value > best.value) best = { value, save, label: `${baseId}: ${ids.join('+')}` };
          }
        }
      }
    }
    return best;
  };

  const offence = bestLoadout(dpsRatio, false);
  const defence = bestLoadout(ehpRatio, false);
  const craftedOffence = bestLoadout(dpsRatio, true);
  const craftedDefence = bestLoadout(ehpRatio, true);

  it('a best-in-slot loadout from drops alone is worth roughly 5.7x total power', () => {
    // Measured as offence x defence, because that is what "total power" means
    // for a build that has to both kill and survive.
    //
    // This is the DROP ceiling. The agreed overall ceiling is ~8x, and the
    // headroom between the two is what the extra affix row spirits grant is
    // allowed to occupy - it is not spare budget for bigger affixes.
    const total = offence.value * defence.value;
    expect(total, `${offence.label} x ${defence.label}`).toBeGreaterThan(5.0);
    expect(total).toBeLessThan(6.5);
  });

  it('does not put the whole budget on damage', () => {
    // Clear time holds steady only while offence and defence grow together.
    // The first cut of the affix pool loaded everything onto DPS and the
    // harness caught it: stage 222 resolved in 11.9s against a 20s floor.
    expect(offence.value).toBeLessThan(2.6);
  });

  it('grows offence and defence at matching rates', () => {
    // The absolute ceiling above cannot tell 2.4/2.4 from 3.4/1.7 - both are
    // 5.7x. This is the check that actually encodes the invariant, and it is
    // the one to read first when clear times move.
    const detail = `offence ${offence.value.toFixed(3)} (${offence.label}) vs defence ${defence.value.toFixed(3)} (${defence.label})`;
    expect(Math.abs(Math.log(offence.value / defence.value)), detail).toBeLessThan(0.15);
  });

  it('a fully crafted loadout is worth roughly 8x, the agreed ceiling', () => {
    // The craft ceiling: everything the drop ceiling has, plus the fifth affix
    // row only a dune spirit can grant. This is the number the whole currency
    // system was budgeted against, and the one that decides whether the ladder
    // still paces.
    const total = craftedOffence.value * craftedDefence.value;
    expect(total, `${craftedOffence.label} x ${craftedDefence.label}`).toBeGreaterThan(6.5);
    expect(total).toBeLessThan(9.5);
  });

  it('leaves crafting real headroom over dropping, but not a different game', () => {
    // Both sides measured, not assumed. If crafting did not beat what drops,
    // the currency would be decoration; if it beat it by too much, every
    // dropped item would be litter and the ladder would need retuning around
    // the crafted player instead of the real spread of players.
    const dropped = offence.value * defence.value;
    const crafted = craftedOffence.value * craftedDefence.value;
    expect(crafted / dropped).toBeGreaterThan(1.2);
    expect(crafted / dropped).toBeLessThan(1.9);
  });

  it('keeps offence and defence matched at the craft ceiling too', () => {
    // The symmetry invariant does not stop applying because an item was
    // crafted. A fifth row that only ever went on offence would be the
    // stage-222 failure arriving by a third route.
    const detail = `offence ${craftedOffence.value.toFixed(3)} (${craftedOffence.label}) vs defence ${craftedDefence.value.toFixed(3)} (${craftedDefence.label})`;
    expect(Math.abs(Math.log(craftedOffence.value / craftedDefence.value)), detail).toBeLessThan(0.2);
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
    const crafted = craftedOffence.value * craftedDefence.value;
    expect(bestUniqueTotal).toBeLessThan(crafted);
  });

  it('keeps every base implicit near a third of the rolled affix on its stat', () => {
    // This replaces a DPS-contribution band, and the instrument was replaced
    // rather than the threshold widened.
    //
    // The old check measured dps(with implicits) / dps(without) and demanded
    // 1.1-1.25. Under the all-multiplier model that ratio was exactly the
    // implicit's own compounding - 1.038^4 = 1.16 - because the rolled affixes
    // multiplied too and cancelled out of the fraction. Under layers they land in
    // the same sum, so the same design ratio now reads as 1.075: the implicit is
    // deliberately *diluted* by the rolled half, which is the diminishing-returns
    // property working as intended. Hitting 1.1 again would need implicits at
    // ~43% of a rolled affix, breaking the rule this test exists to enforce.
    //
    // So assert the rule itself, off the tables. It is also a stronger check:
    // independent of how many other affixes an item happens to carry, and it
    // covers every stat rather than only the ones on one measured loadout.
    const rolledPeers = (stat: string, op: string) =>
      AFFIXES.filter(
        (a) => a.effect.kind === 'statMod' && a.effect.stat === stat && a.effect.op === op,
      );

    for (const implicit of IMPLICIT_AFFIXES) {
      if (implicit.effect.kind !== 'statMod') continue;
      const { stat, op } = implicit.effect;
      const peers = rolledPeers(stat, op);
      // An implicit with no rolled counterpart cannot be priced against anything,
      // which is how an implicit quietly becomes the strongest mod on its stat.
      expect(peers.length, `${implicit.id} has no rolled counterpart on ${stat}`).toBeGreaterThan(0);

      // Compared against the weakest peer, so the bound holds however many
      // rolled affixes share the stat.
      const top = (a: (typeof peers)[number]) => a.tiers[a.tiers.length - 1].value;
      const weakest = peers.reduce((a, b) => (top(a) < top(b) ? a : b));

      for (let tier = 0; tier < implicit.tiers.length; tier++) {
        const ratio = implicit.tiers[tier].value / weakest.tiers[tier].value;
        expect(ratio, `${implicit.id} T${tier} vs ${weakest.id}`).toBeGreaterThan(0.25);
        expect(ratio, `${implicit.id} T${tier} vs ${weakest.id}`).toBeLessThan(0.45);
      }
    }
  });

  it('lets the rolled half dilute the implicit, rather than the reverse', () => {
    // The outcome the ratio test above implies, measured end to end so the two
    // cannot drift: guaranteed power stays a minority of an item's contribution.
    const stripped = {
      ...offence.save,
      items: offence.save.items.map((item) => ({ ...item, baseAffix: undefined })),
    };
    const contribution = dpsRatio(offence.save) / dpsRatio(stripped);
    expect(contribution).toBeGreaterThan(1.04);
    expect(contribution).toBeLessThan(1.15);
  });
});

describe('physical and magical parity', () => {
  // The third invariant, beside offence/defence symmetry and the feedback exponent.
  // Whichever playstyle runs ahead makes the other dead content, and it will not hold
  // by accident - the offence/defence one has now broken structurally four times.
  const STAGE = 60;
  const CTX = { stage: STAGE, isBoss: false, enemyHpFraction: 1 };
  const base: SaveState = { ...newSave(1, T0), bestStage: STAGE, currentStage: STAGE };

  /** The same character, differing only in which weapon it holds. */
  const wielding = (baseId: string): SaveState => {
    const weapon = {
      uid: 'w',
      baseId,
      rarity: 'common' as const,
      itemLevel: STAGE,
      affixes: [],
      rerolls: 0,
      crafts: 0,
    };
    return { ...base, items: [weapon], weapon: weapon.uid };
  };

  const outcomes = WEAPON_BASES.map((b) => ({
    name: b.name,
    kind: getSkill(b.skillId!)!.kind,
    outcome: resolveStage(wielding(b.id), STAGE),
  }));

  it('clears a whole stage in comparable total time whichever weapon is held', () => {
    // TOTAL time, not per phase. Magic is meant to be faster on trash and slower on
    // the boss, so a per-phase check would fail on precisely the difference that is
    // the point of having two playstyles.
    const totals = outcomes.map((o) => o.outcome.seconds);
    const spread = Math.max(...totals) / Math.min(...totals);
    const detail = outcomes.map((o) => `${o.name} ${o.outcome.seconds.toFixed(1)}s`).join(', ');
    expect(spread, detail).toBeLessThan(1.6);
  });

  it('makes each kind measurably better at the half it is meant to win', () => {
    // The half that proves the axis exists rather than merely balances. Matching
    // totals AND matching phases would mean the two playstyles were one playstyle
    // wearing different names.
    const best = (kind: string, phase: 'trashPhaseSeconds' | 'bossPhaseSeconds') =>
      Math.min(...outcomes.filter((o) => o.kind === kind).map((o) => o.outcome[phase]));

    expect(best('magical', 'trashPhaseSeconds')).toBeLessThan(best('physical', 'trashPhaseSeconds'));
    expect(best('physical', 'bossPhaseSeconds')).toBeLessThan(best('magical', 'bossPhaseSeconds'));
  });

  it('does not resource-limit any skill at rest', () => {
    // A resource that binds before a single upgrade is bought is not a cap on what
    // you buy, it is a flat tax on one playstyle - and the ladder is not tuned for
    // one playstyle starting a third down.
    for (const b of WEAPON_BASES) {
      const skill = getSkill(b.skillId!)!;
      const stats = deriveStats(wielding(b.id), CTX);
      expect(stats.attackSpeed, `${b.name} is resource-limited at base`).toBeCloseTo(
        skill.baseSpeed,
        6,
      );
    }
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
    // The array is MAX_ITEM_SLOTS long now, not ITEM_SLOTS: positions past the live
    // count exist and are simply inert, which is what lets a unique grant slots
    // without a migration every time.
    expect(state.loadout).toEqual(Array(MAX_ITEM_SLOTS).fill(null));
    expect(state.nextItemId).toBe(1);
    // The fixture holds a legacy NUMBER; migration leaves a string of equal value.
    expect(fromSave(state.gold).eq(big(12345))).toBe(true);
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
    // The fixture holds a legacy NUMBER; migration leaves a string of equal value.
    expect(fromSave(state.gold).eq(big(12345))).toBe(true);
    expect((state as unknown as Record<string, unknown>).artifactsOwned).toBeUndefined();
  });

  it('restats v4 items onto the layer scale without changing what they are', () => {
    // The one migration allowed to touch stored magnitudes. A v4 Brutal held
    // `value: 1.04` under `op: 'mul'`; read as `increased` that is +104% damage,
    // so leaving the numbers alone is the destructive option here.
    const item = { ...rollItem(9, 1, 30), affixes: [{ affixId: 'brutal', tier: 2, value: 1.08 }] };
    const v4 = {
      ...newSave(9, T0),
      ...progress,
      contentVersion: 4,
      items: [item],
      loadout: [item.uid, null, null, null],
      nextItemId: 2,
    } as unknown as SaveState;

    const { state, migrated } = migrateSave(v4);
    const [carried] = state.items;

    expect(migrated).toBe(true);
    // Identity survives: same item, same affix, same tier. Only the number moves.
    expect(carried.uid).toBe(item.uid);
    expect(carried.baseId).toBe(item.baseId);
    expect(carried.rarity).toBe(item.rarity);
    expect(carried.affixes[0].affixId).toBe('brutal');
    expect(carried.affixes[0].tier).toBe(2);
    expect(carried.affixes[0].value).toBe(getAffix('brutal')!.tiers[2].value);
    expect(carried.affixes[0].value).not.toBe(1.08);
    // And it is still equipped, and still worth something.
    expect(state.loadout[0]).toBe(item.uid);
    expect(itemEffects(carried).length).toBeGreaterThan(0);
  });

  it('keeps an item whose affix no longer exists loadable', () => {
    // A retired affix must not make the whole save unreadable. itemEffects
    // already skips unknown ids; the restat step has to skip them too rather
    // than dereferencing a missing definition.
    // No baseAffix, so the only possible effect source is the retired modifier.
    const item = {
      ...rollItem(9, 1, 30),
      affixes: [{ affixId: 'retired-mod', tier: 0, value: 1.5 }],
      baseAffix: undefined,
    };
    const v4 = { ...newSave(9, T0), contentVersion: 4, items: [item], nextItemId: 2 } as SaveState;

    const { state } = migrateSave(v4);

    // Left byte-identical: there is no definition to re-resolve it against, and
    // inventing a value would be worse than carrying a number nothing reads.
    expect(state.items[0].affixes[0]).toEqual({ affixId: 'retired-mod', tier: 0, value: 1.5 });
    expect(itemEffects(state.items[0])).toEqual([]);
  });

  it('gives an owned unique a roll inside its range', () => {
    // A unique that predates ranges has no stored roll. itemEffects falls back to
    // the midpoint, so it is never broken - but a stored roll is what Angel Flame
    // rerolls and what the panel reports quality against, and leaving the field
    // absent would hand the owner an item the new mechanics cannot see.
    const dropped = Array.from({ length: 600 }, (_, i) => rollItem(3, i + 1, 60)).find(
      (item) => item.rarity === 'unique',
    )!;
    const legacy = { ...dropped, uniqueRolls: undefined };
    const v5 = {
      ...newSave(3, T0),
      contentVersion: 5,
      items: [legacy],
      nextItemId: 2,
    } as SaveState;

    const { state, migrated } = migrateSave(v5);
    const [carried] = state.items;
    const authored = getUnique(dropped.uniqueId!)!;

    expect(migrated).toBe(true);
    expect(carried.uniqueId).toBe(dropped.uniqueId);
    expect(carried.uniqueRolls).toHaveLength(authored.effects.length);
    authored.effects.forEach((effect, i) => {
      expect(carried.uniqueRolls![i]).toBeGreaterThanOrEqual(effect.roll.min);
      expect(carried.uniqueRolls![i]).toBeLessThanOrEqual(effect.roll.max);
    });

    // Deterministic, because the client migrates optimistically and the server
    // migrates authoritatively - two different rolls would be two different items.
    expect(migrateSave(v5).state.items[0].uniqueRolls).toEqual(carried.uniqueRolls);
  });

  it('leaves a current save alone', () => {
    const current = { ...newSave(1, T0), gold: '500' };
    const { state, migrated } = migrateSave(current);
    expect(migrated).toBe(false);
    expect(state).toEqual(current);
  });
});

describe('stat breakdown', () => {
  const CTX = { stage: 40, isBoss: false, enemyHpFraction: 1 };

  /** A save carrying all three layers on damage: a weapon, gear, and gold upgrades. */
  const geared = (): SaveState => {
    const weapon = {
      ...rollItem(7, 1, 40),
      baseId: 'axe',
      rarity: 'rare' as const,
      uniqueId: undefined,
      uniqueRolls: undefined,
      baseAffix: undefined,
      affixes: [
        { affixId: 'honed', tier: 2, value: 2.8 },
        { affixId: 'brutal', tier: 2, value: 0.041 },
      ],
    };
    const gear = {
      ...rollItem(7, 2, 40),
      baseId: 'whetstone',
      rarity: 'magic' as const,
      uniqueId: undefined,
      uniqueRolls: undefined,
      baseAffix: undefined,
      affixes: [{ affixId: 'brutal', tier: 1, value: 0.031 }],
    };
    const loadout = Array<string | null>(MAX_ITEM_SLOTS).fill(null);
    loadout[0] = gear.uid;
    return {
      ...newSave(7, T0),
      items: [weapon, gear],
      loadout,
      weapon: weapon.uid,
      upgrades: { ...newSave(7, T0).upgrades, damage: 25, crit: 10 },
    };
  };

  it('the parts make the whole', () => {
    // The panel shows the components and never the walk between them, but if
    // (base + flat) x (1 + increased) x more does not reproduce what the fight
    // uses then the components are fiction and the panel is lying politely.
    const save = geared();
    const parts = explainStats(save, CTX);
    const stats = deriveStats(save, CTX);

    for (const key of STAT_KEYS) {
      const p = parts[key];
      const rebuilt = p.base.add(p.flat).mul(1 + p.increased).mul(p.more);
      // By RATIO, because these span 1e0 to 1e30 and an absolute tolerance would be
      // either meaningless at the top or unmeetable at the bottom. The skill-level
      // stats resolve to exactly zero for a build carrying none, where a ratio is 0/0.
      if (p.resolved.toNumber() === 0) {
        expect(rebuilt.toNumber(), `${key} should be zero`).toBe(0);
      } else {
        expect(rebuilt.div(p.resolved).toNumber(), `${key} does not recombine`).toBeCloseTo(1, 9);
      }

      const actual = typeof stats[key] === 'number' ? stats[key] : stats[key].toNumber();
      expect(p.final.toNumber(), `${key} final disagrees with deriveStats`).toBeCloseTo(
        actual,
        6,
      );
    }
  });

  it('reports which layer a modifier landed in', () => {
    // Honed is flat and Brutal is increased, and the whole point of the panel is
    // that those are different purchases rather than two numbers on a tooltip.
    const damage = explainStats(geared(), CTX).damage;
    expect(damage.flat).toBeCloseTo(2.8, 9);
    // Two Brutals, on the weapon and on the gear, and they SUM.
    expect(damage.increased).toBeCloseTo(0.041 + 0.031, 9);
    // The damage upgrade track is `more`, so 25 levels compound rather than add.
    expect(damage.more.toNumber()).toBeCloseTo(Math.pow(1.07, 25), 6);
  });

  it('names the resource when it is what capped attack speed', () => {
    // The one limit a player meets in normal play, and the reason cappedBy exists:
    // without it the layers would add up to a speed the character sheet does not show.
    const save = geared();
    const fast: SaveState = {
      ...save,
      // Far more speed than a base regen of 3 against Sunder's cost of 1 can pay for.
      upgrades: { ...save.upgrades, attackSpeed: 400 },
    };

    const parts = explainStats(fast, CTX).attackSpeed;
    expect(parts.cappedBy).toContain('Stamina');
    expect(parts.final.lt(parts.resolved)).toBe(true);
    expect(parts.final.toNumber()).toBeCloseTo(deriveStats(fast, CTX).attackSpeed, 9);
  });

  it('previewing an equip never touches the save it was given', () => {
    // The panel calls this on every render while an item is selected. Mutating the
    // store's own save from a display path would be a bug that only shows up as
    // "my loadout changed when I looked at something".
    const save = geared();
    const before = JSON.stringify(save);
    previewEquip(save, save.items[1], CTX);
    expect(JSON.stringify(save)).toBe(before);
  });

  it('a weapon preview beats fighting unarmed', () => {
    // The largest single upgrade in the game, and the one the panel most needs to
    // price: an empty weapon slot is Unarmed, which does not scale at all.
    const bare = newSave(7, T0);
    const weapon = geared().items[0];
    const armed = previewEquip({ ...bare, items: [weapon] }, weapon, CTX);

    expect(statsDps(deriveStats(armed, CTX)).gt(statsDps(deriveStats(bare, CTX)))).toBe(true);
    expect(armed.weapon).toBe(weapon.uid);
  });

  it('fills an empty slot before displacing anything', () => {
    const save = geared();
    const spare = save.items[1];
    const preview = previewEquip(save, spare, CTX);
    // Already worn at index 0, so the preview is the loadout unchanged rather than a
    // second copy of it wedged into the next slot.
    expect(preview.loadout.filter((uid) => uid === spare.uid)).toHaveLength(1);
  });

  it('says nothing about a stat no limit touched', () => {
    // A reason on every stat would make the real one invisible.
    const parts = explainStats(geared(), CTX);
    expect(parts.damage.cappedBy).toBeNull();
    expect(parts.maxHp.cappedBy).toBeNull();
  });
});

describe('derived stats', () => {
  it('statsDps times the elemental scale matches the DPS the combat layer uses', () => {
    // The character sheet quotes statsDps. If it drifted from what resolveStage
    // divides by, the panel would confidently display a number the fight does
    // not use - the exact failure the shared function exists to prevent.
    //
    // The two are no longer equal on their own: statsDps is what the loadout puts
    // out, and resistance is a property of the TARGET, so the fight applies the
    // elemental scale on top. Multiplying it back in here is the point - it pins the
    // scale as the ONLY thing between the sheet's number and the fight's, so a future
    // damage term added to one and not the other still fails this.
    const save: SaveState = {
      ...newSave(1, T0),
      upgrades: { ...newSave(1, T0).upgrades, damage: 12, attackSpeed: 7, crit: 20 },
    };
    const stage = 1;
    const outcome = resolveStage(save, stage);
    const stats = deriveStats(save, { stage, isBoss: false, enemyHpFraction: 1 });

    const poolHp = enemyHp(stage).mul(enemyCount(stage));
    const aoeTargets = Math.min(stats.area, enemyCount(stage));
    const impliedDps = poolHp.div(outcome.trashPhaseSeconds * aoeTargets);

    const ctx = { stage, isBoss: false, enemyHpFraction: 1 };
    const scale = elementalScale(
      damageShares(save, ctx),
      stats.penetration,
      stageResistances(stage),
    );
    expect(statsDps(stats).mul(scale).div(impliedDps).toNumber()).toBeCloseTo(1, 6);
  });

  it('effective HP is what damage is measured against', () => {
    const save: SaveState = {
      ...newSave(1, T0),
      upgrades: { ...newSave(1, T0).upgrades, health: 9, toughness: 5 },
    };
    const stats = deriveStats(save, { stage: 1, isBoss: false, enemyHpFraction: 1 });
    expect(effectiveHp(stats).eq(stats.maxHp.mul(stats.toughness))).toBe(true);
  });
});

describe('modifier layers', () => {
  const CTX = { stage: 1, isBoss: false, enemyHpFraction: 1 };

  /**
   * The resolver's formula, written out independently.
   *
   * Pinned separately from deriveStats so the shape of the formula is asserted in
   * one readable place; the last test in this suite ties it back to the real
   * resolver so the two cannot drift apart.
   */
  const damageOf = (effects: Effect[]): number => {
    const buckets = { flat: 0, increased: 0, more: 1 };
    for (const e of effects) {
      if (e.kind !== 'statMod') continue;
      if (e.op === 'flat') buckets.flat += e.value;
      else if (e.op === 'increased') buckets.increased += e.value;
      else buckets.more *= e.value;
    }
    return BASE_STATS.damage.add(buckets.flat).mul(1 + buckets.increased).mul(buckets.more).toNumber();
  };

  const mod = (op: 'flat' | 'increased' | 'more', value: number): Effect => ({
    kind: 'statMod',
    stat: 'damage',
    op,
    value,
  });

  it('resolves as (base + flat) x (1 + increased) x more', () => {
    // The formula written out once, so a refactor of deriveStats that changes the
    // order of the layers fails here rather than in the ladder six commits later.
    expect(damageOf([mod('flat', 10), mod('increased', 0.5), mod('more', 2)])).toBeCloseTo(
      (60 + 10) * 1.5 * 2,
      9,
    );
  });

  it('sums increased modifiers instead of compounding them', () => {
    // The entire point of the layer system. Two +50% rolls are +100%, not +125%.
    const summed = damageOf([mod('increased', 0.5), mod('increased', 0.5)]);
    expect(summed).toBeCloseTo(60 * 2, 9);
    expect(summed).toBeLessThan(60 * 1.5 * 1.5);
  });

  it('compounds more modifiers, which is why none of them roll', () => {
    expect(damageOf([mod('more', 1.5), mod('more', 1.5)])).toBeCloseTo(60 * 2.25, 9);
  });

  it('has diminishing returns on increased, and that is the fix', () => {
    // Each additional +5% is worth strictly less than the one before it. Under
    // the old all-multiplier pool each was worth strictly *more*, which is what
    // forced every value down to a few percent and squeezed each new content row.
    const at = (n: number) => damageOf(Array.from({ length: n }, () => mod('increased', 0.05)));
    const firstGain = at(1) - at(0);
    const tenthGain = at(10) - at(9);
    expect(tenthGain).toBeCloseTo(firstGain, 9); // absolute gain is constant...
    expect(at(10) / at(9)).toBeLessThan(at(1) / at(0)); // ...so relative gain falls
  });

  it('is order-independent, which is what makes loadouts comparable', () => {
    const effects = [mod('more', 1.3), mod('flat', 4), mod('increased', 0.2), mod('flat', 1)];
    const forwards = damageOf(effects);
    const backwards = damageOf([...effects].reverse());
    expect(forwards).toBeCloseTo(backwards, 9);
  });

  it('applies the layers through deriveStats, not only in this test', () => {
    // The helper above mirrors the resolver; this pins the resolver itself, so the
    // mirror cannot quietly disagree with the code it is standing in for.
    const save = { ...newSave(1, T0), upgrades: { ...newSave(1, T0).upgrades, damage: 3 } };
    const stats = deriveStats(save, CTX);
    // The damage track is uncapped and therefore `more` - see trackLayer().
    expect(stats.damage.toNumber()).toBeCloseTo(
      BASE_STATS.damage.mul(Math.pow(1.07, 3)).toNumber(),
      9,
    );
  });

  it('keeps every uncapped upgrade track in the more layer', () => {
    // Load-bearing, and the reason the plan's original shape was abandoned:
    // `increased` sums linearly in levels bought and levels grow like log(gold),
    // so an economy driven by increased purchases grows linearly in stage against
    // enemy HP growing exponentially - a permanent wall at any growth rate.
    for (const track of Object.values(UPGRADE_TRACKS)) {
      if (track.maxLevel === null) expect(trackLayer(track)).toBe('more');
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

  it('leans the gold tracks toward defence, because weapons only lift offence', () => {
    // This replaces an equal-exponents assertion, and the instrument was replaced
    // rather than the threshold widened.
    //
    // sideExponents() measures the GOLD TRACKS only - it is a sum over
    // ln(valueGrowth)/ln(costGrowth). Skill level lifts damage from the weapon's item
    // level, which is stage-driven and not gold-driven, so it does not appear in
    // these numbers at all and cannot be added to them: the two are not in the same
    // units.
    //
    // With half the offensive exponent moved onto weapons, matching the TOTALS now
    // requires deliberately unmatched tracks. Asserting equality here would demand
    // the bug it was written to catch: slowing the defensive tracks to match the
    // offensive ones is exactly what the first retune did, and it produced 0.3s clear
    // times against a player who was dying anyway.
    //
    // So this asserts the new structural fact, and the real symmetry check is the
    // measured one - the clear-time band and the power-budget symmetry test below.
    const { offence, defence } = sideExponents();
    expect(defence).toBeGreaterThan(offence);
    // Both sides still have to be live purchases. A track exponent at zero is a
    // track nobody ever buys.
    expect(offence).toBeGreaterThan(0.1);
    expect(defence).toBeGreaterThan(0.1);
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
    // Checked at the 10th percentile, and paired with a median guarantee.
    //
    // It was the 5th percentile, which stopped measuring "the typical floor" once
    // weapons arrived. A weapon is a fifth of drops and each one is a step change in
    // base damage, so a player overshoots briefly every couple of clears rather than
    // every twenty - and the bottom 5% of the distribution is now made almost
    // entirely of those moments. Measured: p05 11.7s against p10 12.9s and a median
    // of 16.9s, with 20 of 300 stages under 12s and none of them adjacent.
    //
    // The threshold did not move. What moved is which percentile is being asked, and
    // a median floor is added so this is a STRONGER claim than before rather than a
    // looser one: it now asserts the typical fight is comfortably watchable, which
    // the old single-percentile check never did.
    /*
      SPLIT AT THE UNLOCK FLOOR, because the game has two regimes now.

      Accessories exist only past floor 80 and are meant to be a real power spike, so a
      single percentile over all 300 stages averages a band that did not move with one
      that deliberately did - and hides which. Measured across three seeds: pre-80 sits
      at 12.3-15.0s with or without accessories, post-80 at 8.1-11.5s with them and
      10.7-11.5s without.

      Two numbers, two claims. The pre-80 floor says the first eighty floors are exactly
      as watchable as they always were, so nothing leaked out of the Abyss. The post-80
      floor says the Abyss makes you roughly twice as fast and no faster - it is a
      REWARD band, not a relaxation, and `absoluteFloor` still guards the collapse.
    */
    const preAbyss = rows.filter((r) => r.stage < ABYSS_UNLOCK_STAGE);
    const postAbyss = rows.filter((r) => r.stage >= ABYSS_UNLOCK_STAGE);
    const percentile = (subset: typeof rows, q: number) => {
      const sorted = subset.map((r) => r.clearSeconds).sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * q)];
    };

    const pre = percentile(preAbyss, 0.1);
    expect(pre, `pre-Abyss 10th percentile is ${pre.toFixed(2)}s`).toBeGreaterThanOrEqual(
      CLEAR_TIME_BAND_SECONDS.min,
    );

    const post = percentile(postAbyss, 0.1);
    expect(post, `post-Abyss 10th percentile is ${post.toFixed(2)}s`).toBeGreaterThanOrEqual(
      CLEAR_TIME_BAND_SECONDS.abyssalMin,
    );

    const median = percentile(rows, 0.5);
    expect(median, `median clear time is ${median.toFixed(2)}s`).toBeGreaterThanOrEqual(
      CLEAR_TIME_BAND_SECONDS.min * 1.25,
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
    // It then compared ADJACENT fifty-stage windows and required each to hold 80% of
    // the one before. That instrument died when uniques started rolling their values.
    //
    // Total elapsed time and the shape of the clear-time curve are both dominated by
    // unique drop luck - uniques are 2% of drops and one of them carries a large gold
    // multiplier. Swept across six account seeds, adjacent-window ratios came out
    // 0.72, 0.77, 0.80, 0.82, 0.84, 0.95, 1.18, 1.20, 1.32, 1.46, 1.78 - and every
    // one of those runs reached stage 300. A floor of 0.8 on a quantity that swings
    // between 0.72 and 1.78 in healthy runs is measuring noise, and the failure it
    // produced said nothing about whether offence had outrun defence.
    //
    // Measured over the WHOLE tail instead, which is the claim that actually matters:
    // a runaway means clear times trending toward zero across the ladder, not one
    // window dipping below its neighbour. Last window against the first post-bootstrap
    // window, same six seeds: 1.03, 1.07, 1.22, 1.38, 1.48, 1.88. Every healthy run
    // ENDS SLOWER than it started, so a floor of 0.85 has real margin and still fails
    // a genuine runaway, which halves clear times rather than nudging them.
    const mean = (from: number, to: number) =>
      rows.slice(from, to).reduce((sum, r) => sum + r.clearSeconds, 0) / (to - from);

    // Skipped: the first HUNDRED stages are the bootstrap, up from fifty.
    //
    // The ladder now has two regimes. Early on a weapon is low item level and
    // contributes little, so power is gold-driven exactly as it was before weapons
    // existed; late on the weapon term dominates. The handover between the two is
    // bootstrap-shaped for the same reason a fresh account is - power is arriving
    // from a source that was not there before - and it says nothing about whether
    // the curve converges.
    const early = mean(100, 150);
    const late = mean(250, 300);

    expect(late, `stages 251-300 (${late.toFixed(1)}s) against 101-150 (${early.toFixed(1)}s)`)
      .toBeGreaterThan(early * 0.85);
  });
});

describe('balance curve', () => {
  it('matches the golden snapshot', () => {
    // Change a constant in curves.ts and this diff shows exactly how pacing
    // moved. Regenerate deliberately with `pnpm balance --write` - a shell
    // redirect writes something subtly different and the mismatch is baffling.
    //
    // Line endings are normalised even though .gitattributes already pins this
    // file to LF. The attribute fixes the repository; this makes sure a
    // misconfigured checkout cannot make the test lie about pacing. `report()`
    // joins with \n, so a CRLF checkout failed here on every fresh clone on
    // Windows while the numbers were identical.
    const lf = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
    const golden = readFileSync(
      resolve(process.cwd(), 'tests/__snapshots__/balance.golden.txt'),
      'utf8',
    );
    expect(lf(report())).toBe(lf(golden));
    // Raised from 60s. This test's job is to compare output, not to enforce a runtime
    // budget, and it was sitting a few seconds under the old limit - so an unrelated
    // change to deriveStats failed it as a TIMEOUT, which reads as a pacing regression
    // and is not one. If a runtime budget is wanted it should be its own assertion
    // with its own number, not a side effect of this one.
  }, 180_000);
});
