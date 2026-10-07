/**
 * The power-budget search from tests/sim.test.ts, printed rather than asserted.
 *
 *   pnpm exec tsx scripts/budget-probe.ts
 *
 * The test tells you a band was crossed; this tells you which loadout crossed it and by
 * how much, and whether a newly added affix is ever picked at all - an affix the search
 * never chooses is dead content even when every band passes.
 */

import {
  AFFIX_LIMITS,
  BASE_AFFIXES,
  deriveStats,
  effectiveHp,
  eligibleAffixes,
  GEAR_BASES,
  getAffix,
  newSave,
  PREFIXES,
  statsDps,
  SUFFIXES,
  type SaveState,
} from '../src/sim';

const CTX = { stage: 100, isBoss: false, enemyHpFraction: 1 };
const base: SaveState = { ...newSave(1, 0), bestStage: 100, currentStage: 100 };

const topRoll = (id: string) => {
  const affix = getAffix(id)!;
  const top = affix.tiers.length - 1;
  return { affixId: id, tier: top, value: affix.tiers[top].value };
};

const loadoutOf = (baseId: string, ids: string[]): SaveState => {
  const implicit = BASE_AFFIXES[baseId];
  const items = [0, 1, 2, 3].map((i) => ({
    uid: `best-${i}`,
    baseId,
    rarity: 'rare' as const,
    itemLevel: 100,
    rerolls: 0,
    crafts: 0,
    affixes: ids.map(topRoll),
    baseAffix: topRoll(implicit.id),
  }));
  return { ...base, items, loadout: items.map((i) => i.uid) };
};

const dps = (s: SaveState) => statsDps(deriveStats(s, CTX)).div(statsDps(deriveStats(base, CTX))).toNumber();
const ehp = (s: SaveState) =>
  effectiveHp(deriveStats(s, CTX)).div(effectiveHp(deriveStats(base, CTX))).toNumber();

const combos = <T,>(xs: T[], k: number): T[][] =>
  k === 0 ? [[]] : xs.flatMap((x, i) => combos(xs.slice(i + 1), k - 1).map((r) => [x, ...r]));

function best(metric: (s: SaveState) => number, extraRow: boolean) {
  const { prefix, suffix } = AFFIX_LIMITS.rare;
  const shapes: [number, number][] = extraRow ? [[prefix + 1, suffix], [prefix, suffix + 1]] : [[prefix, suffix]];
  let out = { value: 0, label: '' };
  for (const baseId of GEAR_BASES.map((b) => b.id)) {
    const ps = eligibleAffixes(PREFIXES, baseId).map((a) => a.id);
    const ss = eligibleAffixes(SUFFIXES, baseId).map((a) => a.id);
    for (const [np, ns] of shapes)
      for (const p of combos(ps, np))
        for (const s of combos(ss, ns)) {
          const ids = [...p, ...s];
          const v = metric(loadoutOf(baseId, ids));
          if (v > out.value) out = { value: v, label: `${baseId}: ${ids.join('+')}` };
        }
  }
  return out;
}

const o = best(dps, false);
const d = best(ehp, false);
const co = best(dps, true);
const cd = best(ehp, true);
console.log(`drop   offence ${o.value.toFixed(3)}  ${o.label}`);
console.log(`drop   defence ${d.value.toFixed(3)}  ${d.label}`);
console.log(`drop   total ${(o.value * d.value).toFixed(2)}  asym ${Math.abs(Math.log(o.value / d.value)).toFixed(3)}`);
console.log(`craft  offence ${co.value.toFixed(3)}  ${co.label}`);
console.log(`craft  defence ${cd.value.toFixed(3)}  ${cd.label}`);
console.log(`craft  total ${(co.value * cd.value).toFixed(2)}  asym ${Math.abs(Math.log(co.value / cd.value)).toFixed(3)}`);
