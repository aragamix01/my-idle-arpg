/**
 * Abyssal tablets.
 *
 * A tablet is one run: spent on entry, spent on a loss. It is an `ItemInstance` like any
 * other, and every field means something specific:
 *
 *     rarity      common/magic/rare - how many explicit rows, via AFFIX_LIMITS
 *     itemLevel   the TIER, 1..MAX_TABLET_TIER - difficulty and wave count
 *     baseAffix   the implicit - which reward it pays, and how much
 *     affixes     the explicits - monster buffs, and nothing else
 *
 * ## Why it is an item after all
 *
 * The first cut gave tablets their own type, reasoning that an `ItemInstance.affixes`
 * are ids into the affix registry so `rerollAffixes` would hand a tablet increased crit
 * chance. That was right about the POOL and wrong about the SHAPE - and the shape is
 * what the design needs, because "explicit modifiers are prefix/suffix like an item" and
 * "most crafting currency works on a tablet" are one requirement stated twice.
 *
 * The pool is partitioned instead, by `rollsOn: 'tablet'` in `eligibleAffixes` and by two
 * assertions in `validateRegistry`. A tablet modifier also produces no `Effect` at all -
 * `affixEffect` returns null for `monsterBuff` - so it cannot reach `deriveStats` even in
 * principle. That is a stronger guarantee than the separate type gave, because it is a
 * missing code path rather than a rule someone has to remember.
 *
 * ## Danger and reward are ONE knob
 *
 *     danger = tier baseline x (1 + Σ explicit values)
 *     reward = implicit value x (1 + Σ explicit values)
 *
 * An explicit is pure downside on its own; the implicit is what turns that downside into
 * a payout. So a heavily modified tablet is a bigger gamble AND a bigger prize, and the
 * two cannot be separated - which is what makes crafting one a decision about how much
 * risk to buy rather than a strict upgrade.
 *
 * The previous cut gave each modifier its own reward, which made them interchangeable:
 * every mod was "some danger, some reward" and there was no reason to prefer one.
 */

import { affixDanger } from './affixes';
import { MAX_TABLET_TIER } from '../types';
import { getBase } from './bases';
import type { ItemInstance, MonsterAxis, TabletPays } from './schema';

/**
 * How many waves a tier throws at you before the boss.
 *
 * Rising with tier, because "higher tablet tier needs more waves cleared" is what makes
 * a deep tablet a longer commitment rather than only a bigger number. Sub-linear: waves
 * multiply exposure against a health pool that never refills, so a linear count would
 * make the deep tiers unsurvivable on stacked exposure alone, long before their own
 * difficulty said anything.
 */
export function wavesForTier(tier: number): number {
  const clamped = Math.max(1, Math.min(MAX_TABLET_TIER, Math.round(tier)));
  return 1 + Math.floor(clamped / 2);
}

/** Danger contributed by a tablet's explicits, summed per axis. */
export type DangerByAxis = Record<MonsterAxis, number>;

/**
 * What a tablet's modifiers add up to.
 *
 * Per axis rather than one total, because they land on different things inside the run -
 * see MONSTER_AXES. The reward coupling uses the SUM of all of them, so a tablet that
 * buys its danger in health pays exactly as well as one that buys it in damage.
 */
export function tabletDanger(tablet: ItemInstance): DangerByAxis {
  const totals: DangerByAxis = { hp: 0, damage: 0, count: 0, waves: 0 };
  for (const rolled of tablet.affixes) {
    // A retired affix id resolves to nothing rather than breaking the tablet, the same
    // tolerance itemEffects gives one.
    const danger = affixDanger(rolled);
    if (danger) totals[danger.axis] += danger.value;
  }
  return totals;
}

/** The single number the reward scales on: every axis, summed. */
export function totalDanger(tablet: ItemInstance): number {
  const totals = tabletDanger(tablet);
  return totals.hp + totals.damage + totals.count + totals.waves;
}

/**
 * What this tablet pays, and how much.
 *
 * The axis comes from the BASE - picking a Gilded Tablet over a Hoarding one is the same
 * decision as picking a Whetstone over a Purse. The magnitude is the implicit's rolled
 * value amplified by every explicit on the tablet, which is the coupling.
 *
 * Returns null for an item that is not a tablet, so a caller cannot accidentally read a
 * reward off a Whetstone.
 */
export function tabletReward(tablet: ItemInstance): { pays: TabletPays; amount: number } | null {
  const pays = getBase(tablet.baseId)?.pays;
  if (!pays) return null;
  // A tablet whose implicit somehow failed to roll still pays its base rate rather than
  // nothing - a run that rewards zero is indistinguishable from a bug.
  const implicit = tablet.baseAffix?.value ?? 0;
  return { pays, amount: implicit * (1 + totalDanger(tablet)) };
}
