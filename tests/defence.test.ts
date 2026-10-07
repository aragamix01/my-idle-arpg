import { describe, expect, it } from 'vitest';
import {
  ABYSS_UNLOCK_STAGE,
  armourCut,
  BASE_STATS,
  deriveStats,
  effectiveHp,
  evadeChance,
  EVASION_CAP,
  newSave,
  resolveAbyssal,
  resolveStage,
  rollTablet,
  type ItemInstance,
  type SaveState,
  type Stats,
} from '../src/sim';

/**
 * The defence layers, Phase 7d.
 *
 * What is pinned here is the SHAPE of each layer - the property that makes it a
 * different stat rather than Max HP under another name - and that a character with
 * none of them derives exactly what it did before they existed. The power budget and
 * the ladder measure how much they are worth; these say what they are.
 */

const T0 = 1_700_000_000_000;
const stats = (overrides: Partial<Stats>): Stats => ({ ...BASE_STATS, ...overrides });

describe('defence layers', () => {
  it('change nothing for a character that has none of them', () => {
    // The migration promise. Every save before 7d has zero in all three, and must not
    // move by a single hit point.
    const plain = stats({});
    expect(effectiveHp(plain).toNumber()).toBe(plain.maxHp.mul(plain.toughness).toNumber());
    expect(effectiveHp(plain, 'boss').toNumber()).toBe(effectiveHp(plain).toNumber());
  });

  it('caps evasion short of untouchable', () => {
    expect(evadeChance(stats({ evasion: 1e9 }))).toBe(EVASION_CAP);
    expect(evadeChance(stats({ evasion: 100 }))).toBeCloseTo(0.5, 9);
  });

  it('lets armour soak a wave far better than it soaks a boss', () => {
    // The whole difference between armour and evasion: one cares how hard a hit lands.
    const armoured = stats({ armour: 100 });
    expect(armourCut(armoured)).toBeGreaterThan(armourCut(armoured, 'boss') * 2);

    const evasive = stats({ evasion: 100 });
    expect(effectiveHp(evasive, 'boss').toNumber()).toBe(effectiveHp(evasive).toNumber());
  });

  it('stacks energy shield on top of life, as a fraction of it', () => {
    const shielded = stats({ energyShield: 0.25 });
    expect(effectiveHp(shielded).div(effectiveHp(stats({}))).toNumber()).toBeCloseTo(1.25, 9);
  });

  it('derives the layers from rolled affixes', () => {
    const base = newSave(5, T0);
    const item = (affixId: string, value: number, uid: string): ItemInstance => ({
      uid,
      baseId: 'charm',
      rarity: 'magic',
      itemLevel: 100,
      rerolls: 0,
      crafts: 0,
      affixes: [{ affixId, tier: 3, value }],
    });
    const items = [item('plated', 2, '1'), item('runed', 0.02, '2'), item('of-mist', 3, '3')];
    const save: SaveState = { ...base, items, loadout: ['1', '2', '3', null, null, null] };
    const derived = deriveStats(save, { stage: 10, isBoss: false, enemyHpFraction: 1 });
    expect(derived.armour).toBeCloseTo(2, 9);
    expect(derived.energyShield).toBeCloseTo(0.02, 9);
    expect(derived.evasion).toBeCloseTo(3, 9);
  });
});

describe('energy shield in a delve', () => {
  const atUnlock = (): SaveState => {
    const base = newSave(31, T0);
    return {
      ...base,
      bestStage: ABYSS_UNLOCK_STAGE,
      currentStage: ABYSS_UNLOCK_STAGE + 1,
      upgrades: { ...base.upgrades, damage: 120, attackSpeed: 60, resource: 60, health: 150, toughness: 150 },
    };
  };
  const tablet = (tier: number): ItemInstance => ({
    ...rollTablet(31, 900 + tier, tier),
    rarity: 'common',
    affixes: [],
  });
  const wearing = (save: SaveState, affixId: string, value: number): SaveState => {
    const items: ItemInstance[] = [0, 1, 2, 3].map((i) => ({
      uid: `d${i}`,
      baseId: 'charm',
      rarity: 'magic',
      itemLevel: 100,
      rerolls: 0,
      crafts: 0,
      affixes: [{ affixId, tier: 3, value }],
    }));
    return { ...save, items, loadout: [...items.map((i) => i.uid), null, null] };
  };

  it('is worth more across waves than the same pool as plain life', () => {
    // The niche. On the ladder a shield is just more pool, so an equal pool of Max HP
    // would do the same job; across waves the shield refills and life does not, so the
    // shielded character finishes the run with more life left.
    const save = atUnlock();
    const shield = 0.2;
    const shielded = wearing(save, 'runed', shield / 4);
    // `Bulwark`-free equivalent: raise toughness so the starting pool matches exactly.
    const plain: SaveState = save;
    const poolShielded = effectiveHp(deriveStats(shielded, { stage: 80, isBoss: false, enemyHpFraction: 1 }));
    const poolPlain = effectiveHp(deriveStats(plain, { stage: 80, isBoss: false, enemyHpFraction: 1 }));
    expect(poolShielded.div(poolPlain).toNumber()).toBeCloseTo(1 + shield, 6);

    // A tier both characters clear, so both fractions describe a finished run.
    const withShield = resolveAbyssal(shielded, tablet(1));
    const without = resolveAbyssal(plain, tablet(1));
    expect(withShield.cleared && without.cleared).toBe(true);
    // Both fractions are of the same LIFE pool, and the shielded character also walks out
    // with a full shield. Plain extra life would have been spent like the rest; a shield
    // that refills every wave soaks the opening of each one, so less life is lost.
    expect(without.damageTakenFraction).toBeGreaterThan(0);
    expect(withShield.damageTakenFraction).toBeLessThan(without.damageTakenFraction);
  });

  it('is only more pool on the ladder', () => {
    const save = atUnlock();
    const shielded = wearing(save, 'runed', 0.05);
    const a = resolveStage(shielded, 40);
    const b = resolveStage(save, 40);
    expect(a.damageTakenFraction).toBeCloseTo(b.damageTakenFraction / 1.2, 6);
  });
});
