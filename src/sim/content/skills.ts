/**
 * Skills.
 *
 * A skill comes from the equipped weapon and supplies the `base` the three modifier
 * layers build on. Nothing else about the item system changes: a weapon is an
 * ordinary item with a rarity, affix rows and an implicit, and every currency works
 * on it. Only where four of the eight stats get their base value moves.
 *
 * ## The two playstyles, and why they are not two sets of numbers
 *
 * The difference is AREA against SINGLE-TARGET, and the combat layer already had it
 * before skills existed. resolveStage runs a trash phase where damage is multiplied
 * by min(area, enemyCount), then a boss phase where area does nothing at all - and
 * STAGE_TIME_LIMIT_SECONDS applies to the sum of the two.
 *
 * So a wide skill shreds waves and grinds bosses; a narrow one does the reverse.
 * Each has a real way to fail rather than being strictly better or worse, which is
 * what makes picking a weapon a decision.
 *
 * The values below are sized so that at a mid-ladder stage the two clear a whole
 * stage in within about 1% of each other, while Fireball is ~1.3x faster through
 * trash and Sunder is ~3.7x faster on the boss. Parity in the total, divergence in
 * the halves - that is the target, and there is a test for both halves of it. The
 * second half matters as much as the first: matching totals with matching phases
 * would mean the two skills were the same skill.
 *
 * ## Element
 *
 * Each skill also names the ELEMENT its damage is, which is a separate axis from
 * `kind` - kind decides the resource and which skill-level affixes apply, element
 * decides what mitigates the hit. Two of the four are physical, one fire, one cold;
 * lightning and darkness have no skill yet and are reachable through "gain X% as
 * extra" modifiers, which is what stops your element being fixed by your weapon.
 *
 * ## Crit
 *
 * Physical skills carry a real base crit chance and spells carry almost none. That
 * is the whole of "magic does not crit" - a value, not a removed mechanic. Every
 * crit affix still works on a caster, which it has to: four of the nine suffixes are
 * crit affixes and making them dead would halve a caster's suffix pool.
 */

import type { Skill } from './schema';

/**
 * What you fight with when the weapon slot is empty.
 *
 * Its bases are deliberately identical to the pre-weapon BASE_STATS, which is what
 * makes the migration power-neutral: an existing save loads with no weapon and
 * derives exactly the stats it derived before this release, to the bit.
 *
 * It does not scale with skill level, so it is a fallback and not a build. A player
 * who has migrated keeps their gear, their upgrades and their stage, and needs a
 * weapon drop to start progressing again - which is why weapons take a healthy share
 * of drops rather than being a rare base among many.
 */
export const UNARMED: Skill = {
  id: 'unarmed',
  name: 'Unarmed',
  kind: 'physical',
  element: 'physical',
  baseDamage: 60,
  baseSpeed: 1.5,
  baseCritChance: 0.05,
  baseArea: 2,
  // Below base regen of 2, so min(1.5, 2/1) is 1.5 and the resource does not bind.
  // Unarmed has to derive exactly the pre-resource numbers or the migration stops
  // being power-neutral.
  resourceCost: 1,
};

export const SKILLS = [
  {
    /**
     * The duellist. One target, hard, and the highest base crit in the pool - crit
     * is the physical identity, and a single-target skill is where a crit multiplier
     * is worth the most.
     */
    id: 'sunder',
    name: 'Sunder',
    kind: 'physical',
    element: 'physical',
    baseDamage: 110,
    baseSpeed: 1.5,
    baseCritChance: 0.1,
    baseArea: 1,
    // Cheap against a base regen of 2, so stamina sits well above 1.5 and is
    // invisible. It only starts to bind once attack speed has been stacked past
    // 2.0 - which is exactly the intended arc: you buy speed for a long time, then
    // one day discover you are not swinging any faster and go looking for regen.
    resourceCost: 1,
  },
  {
    /**
     * The physical wave option, and the per-hit is low ON PURPOSE.
     *
     * Area multiplies straight into wave damage, so a three-target skill with a
     * respectable hit beats a five-target spell on trash AND on the boss. The first
     * cut did exactly that - Cleave dominated Fireball on both halves, which is one
     * playstyle being strictly better - and the parity test caught it. A wide
     * physical skill has to pay for its area in per-hit damage like everything else.
     */
    id: 'cleave',
    name: 'Cleave',
    kind: 'physical',
    element: 'physical',
    baseDamage: 54,
    baseSpeed: 1.3,
    baseCritChance: 0.07,
    baseArea: 3,
    resourceCost: 1.4,
  },
  {
    /**
     * The wave clearer. Five targets at a little over a third of Sunder's per-hit
     * damage and a slower cast, so it wins trash comfortably and duels badly.
     *
     * Base crit of 1% rather than 0%. Zero would make every crit affix on a caster's
     * gear literally worthless rather than merely weak, and an affix that reads as a
     * bonus while doing nothing at all is worse than one that is a poor pick.
     */
    id: 'fireball',
    name: 'Fireball',
    kind: 'magical',
    element: 'fire',
    baseDamage: 48,
    baseSpeed: 1,
    baseCritChance: 0.01,
    baseArea: 5,
    // Expensive against a base regen of 3: 3/3 is exactly Fireball's base speed, so a
    // caster is not taxed at rest but binds the instant they buy any attack speed.
    // Sunder at cost 1 has headroom to 3.0 and binds only at double base speed. That
    // gap in WHEN it binds is the entire difference between mana and stamina.
    resourceCost: 3,
  },
  {
    /**
     * The widest skill in the game and the weakest per hit. Eight targets erases a
     * wave; against a boss it is close to useless, which is the trade stated as
     * plainly as the numbers allow.
     */
    id: 'frost-nova',
    name: 'Frost Nova',
    kind: 'magical',
    element: 'cold',
    baseDamage: 38,
    baseSpeed: 0.9,
    baseCritChance: 0.01,
    baseArea: 8,
    resourceCost: 3.3,
  },
] as const satisfies readonly Skill[];

export type SkillId = (typeof SKILLS)[number]['id'];

const byId = new Map<string, Skill>([...SKILLS, UNARMED].map((s) => [s.id, s]));

export function getSkill(id: string): Skill | undefined {
  return byId.get(id);
}
