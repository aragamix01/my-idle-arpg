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
  ARMOUR_BASES,
  ARMOUR_SLOT_KINDS,
  BASE_AFFIXES,
  deriveStats,
  effectiveHp,
  eligibleAffixes,
  getAffix,
  ITEM_SLOTS,
  newSave,
  PREFIXES,
  statsDps,
  SUFFIXES,
  type ItemInstance,
  type SaveState,
} from '../src/sim';

const CTX = { stage: 100, isBoss: false, enemyHpFraction: 1 };
const base: SaveState = { ...newSave(1, 0), bestStage: 100, currentStage: 100 };

const topRoll = (id: string) => {
  const affix = getAffix(id)!;
  const top = affix.tiers.length - 1;
  return { affixId: id, tier: top, value: affix.tiers[top].value };
};

const piece = (slot: number, baseId: string, ids: string[]): ItemInstance => ({
  uid: `best-${slot}`,
  baseId,
  rarity: 'rare',
  itemLevel: 100,
  rerolls: 0,
  crafts: 0,
  affixes: ids.map(topRoll),
  baseAffix: topRoll(BASE_AFFIXES[baseId].id),
});

const wearing = (pieces: (ItemInstance | null)[]): SaveState => {
  const items = pieces.filter((p): p is ItemInstance => p !== null);
  return { ...base, items, loadout: pieces.map((p) => p?.uid ?? null) };
};

const dps = (s: SaveState) => statsDps(deriveStats(s, CTX)).div(statsDps(deriveStats(base, CTX))).toNumber();
const ehp = (s: SaveState) =>
  effectiveHp(deriveStats(s, CTX)).div(effectiveHp(deriveStats(base, CTX))).toNumber();

const combos = <T,>(xs: T[], k: number): T[][] =>
  k === 0 ? [[]] : xs.flatMap((x, i) => combos(xs.slice(i + 1), k - 1).map((r) => [x, ...r]));

/**
 * The best five-piece armour loadout for a metric. Coordinate ascent: each slot in turn
 * takes its best base-and-affix combination given the other four, twice round. Exact per
 * slot; the passes are what let the slots agree with each other.
 */
function best(metric: (s: SaveState) => number) {
  const { prefix, suffix } = AFFIX_LIMITS.rare;
  const shapes: [number, number][] = [[prefix, suffix]];
  const pieces: (ItemInstance | null)[] = Array(ITEM_SLOTS).fill(null);
  const labels: string[] = Array(ITEM_SLOTS).fill('');
  let value = metric(wearing(pieces));
  for (let pass = 0; pass < 2; pass++) {
    for (const [slot, kind] of ARMOUR_SLOT_KINDS.entries()) {
      for (const b of ARMOUR_BASES.filter((x) => x.armour === kind)) {
        const ps = eligibleAffixes(PREFIXES, b.id).map((a) => a.id);
        const ss = eligibleAffixes(SUFFIXES, b.id).map((a) => a.id);
        for (const [np, ns] of shapes)
          for (const p of combos(ps, np))
            for (const s of combos(ss, ns)) {
              const trial = [...pieces];
              trial[slot] = piece(slot, b.id, [...p, ...s]);
              const v = metric(wearing(trial));
              if (v > value) {
                value = v;
                pieces[slot] = trial[slot];
                labels[slot] = `${b.id}: ${[...p, ...s].join('+')}`;
              }
            }
      }
    }
  }
  return { value, save: wearing(pieces), label: labels.join(' | ') };
}

/**
 * The crafted ceiling: the drop ceiling plus the seventh row a dune spirit grants, on
 * whichever piece and with whichever eligible affix is worth most. Searched as "take
 * the best drop loadout and add a row", which is what crafting it would be - and it is
 * what kept this suite inside its time budget once five slots each had a pool.
 */
const withExtraRow = (
  drop: { save: SaveState; label: string },
  metric: (s: SaveState) => number,
) => {
  const pieces = ARMOUR_SLOT_KINDS.map((_, i) => {
    const uid = drop.save.loadout[i];
    return uid ? drop.save.items.find((item) => item.uid === uid)! : null;
  });
  let value = metric(drop.save);
  let label = drop.label;
  for (let pass = 0; pass < 2; pass++) {
    for (const [slot, current] of pieces.entries()) {
      if (!current || current.affixes.length > AFFIX_LIMITS.rare.prefix + AFFIX_LIMITS.rare.suffix) continue;
      const owned = new Set(current.affixes.map((a) => a.affixId));
      const pool = [...eligibleAffixes(PREFIXES, current.baseId), ...eligibleAffixes(SUFFIXES, current.baseId)];
      let bestPiece: ItemInstance | null = null;
      for (const affix of pool) {
        if (owned.has(affix.id)) continue;
        const trial = [...pieces];
        trial[slot] = { ...current, affixes: [...current.affixes, topRoll(affix.id)] };
        const v = metric(wearing(trial));
        if (v > value) {
          value = v;
          bestPiece = trial[slot];
          label = `${drop.label} + ${affix.id} on ${current.baseId}`;
        }
      }
      if (bestPiece) pieces[slot] = bestPiece;
    }
  }
  return { value, save: wearing(pieces), label };
};


const o = best(dps);
const d = best(ehp);
console.log(`drop   offence ${o.value.toFixed(3)}  ${o.label}`);
console.log(`drop   defence ${d.value.toFixed(3)}  ${d.label}`);
console.log(`drop   total ${(o.value * d.value).toFixed(2)}  asym ${Math.abs(Math.log(o.value / d.value)).toFixed(3)}`);
{
  const co = withExtraRow(o, dps);
  const cd = withExtraRow(d, ehp);
  console.log(`craft  offence ${co.value.toFixed(3)}  ${co.label}`);
  console.log(`craft  defence ${cd.value.toFixed(3)}  ${cd.label}`);
  console.log(`craft  total ${(co.value * cd.value).toFixed(2)}  asym ${Math.abs(Math.log(co.value / cd.value)).toFixed(3)}`);
}
