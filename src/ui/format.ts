/**
 * Presentation helpers shared by the HUD and the character panel.
 *
 * Nothing here computes game values - it only decides how existing ones read.
 * Magnitudes come from the sim so a retuned curve cannot leave the UI quoting
 * a number the sim no longer applies.
 */

import {
  affixEffect,
  displayTier,
  getAffix,
  SKILL_LEVEL_GAIN,
  type CurrencyTier,
  type Effect,
  type Rarity,
  type RolledAffix,
  type Skill,
  type StatKey,
  type Stats,
} from '@/sim';

/** Short human-readable magnitude: 1.23k, 4.56M, 7.89B. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value < 1000) return value.toFixed(value < 10 && value % 1 !== 0 ? 1 : 0);
  const units = ['k', 'M', 'B', 'T', 'q', 'Q'];
  let scaled = value;
  let unit = -1;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit++;
  }
  return `${scaled.toFixed(2)}${units[unit]}`;
}

const percent = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * Label and unit for every stat.
 *
 * Keyed by StatKey rather than written as a list, so a stat added to STAT_KEYS
 * without an entry here is a type error rather than a panel rendering
 * "undefined".
 */
export const STAT_LABELS: Record<StatKey, { label: string; format: (v: number) => string }> = {
  damage: { label: 'Damage', format: compact },
  attackSpeed: { label: 'Attack Speed', format: (v) => `${v.toFixed(2)}/s` },
  area: { label: 'Area', format: (v) => `${v.toFixed(2)} targets` },
  critChance: { label: 'Crit Chance', format: percent },
  critMult: { label: 'Crit Damage', format: (v) => `x${v.toFixed(2)}` },
  maxHp: { label: 'Max HP', format: compact },
  toughness: { label: 'Toughness', format: (v) => `x${v.toFixed(2)}` },
  goldFind: { label: 'Gold Find', format: (v) => `x${v.toFixed(2)}` },
  // Named for the mechanic rather than for stamina or mana, because which one it is
  // depends on the weapon in your hand and the label has to be right for both.
  resourceRegen: { label: 'Resource Regen', format: (v) => `${v.toFixed(2)}/s` },
  // "to" is part of the label so the line reads "+1 to Magical Skill Levels" rather
  // than "+1 Magical Skill Levels", which parses as a count of levels you own
  // instead of a bonus to the skill you are wielding.
  physicalSkillLevel: { label: 'to Physical Skill Levels', format: (v) => `+${v.toFixed(0)}` },
  magicalSkillLevel: { label: 'to Magical Skill Levels', format: (v) => `+${v.toFixed(0)}` },
};

/**
 * Stats the character sheet does not list.
 *
 * The two skill-level stats are modifier *inputs* - they feed the equipped skill's
 * base and are shown on the weapon, where a player can act on them. Listing them
 * beside Damage would imply they are a stat you own rather than a bonus to a skill
 * you might not even be wielding.
 */
const SHEET_HIDDEN: StatKey[] = ['physicalSkillLevel', 'magicalSkillLevel'];

/**
 * Border and text colours per rarity.
 *
 * Follows the Path of Exile convention the item system is modelled on: white,
 * blue, yellow, orange. Players coming from that game read these instantly.
 */
export const RARITY_STYLE: Record<Rarity, { border: string; text: string; label: string }> = {
  common: { border: 'border-neutral-600', text: 'text-neutral-200', label: 'Common' },
  magic: { border: 'border-sky-500/70', text: 'text-sky-300', label: 'Magic' },
  rare: { border: 'border-yellow-500/70', text: 'text-yellow-300', label: 'Rare' },
  unique: { border: 'border-orange-500/80', text: 'text-orange-400', label: 'Unique' },
};

/** Trailing clause for a conditional effect, or '' when it always applies. */
function describeCondition(when: Effect['when']): string {
  if (!when) return '';
  const clauses: string[] = [];
  if (when.enemyHpBelow !== undefined) {
    clauses.push(`to enemies below ${(when.enemyHpBelow * 100).toFixed(0)}% HP`);
  }
  if (when.isBoss !== undefined) clauses.push(when.isBoss ? 'against bosses' : 'against trash');
  if (when.stageAtLeast !== undefined) clauses.push(`from stage ${when.stageAtLeast}`);
  return clauses.length > 0 ? ` ${clauses.join(', ')}` : '';
}

/**
 * Render an item effect as a sentence.
 *
 * This is the return on choosing data over closures for content: an effect
 * that is a discriminated union can be displayed, diffed and validated. A
 * closure could only be run.
 */
export function describeEffect(effect: Effect): string {
  const suffix = describeCondition(effect.when);

  if (effect.kind === 'goldOnKill') {
    return `+${(effect.multiplier * 100).toFixed(0)}% gold per kill${suffix}`;
  }

  // Stated as a multiplier on the chance, not as a percentage point: the base chance
  // is not shown anywhere, so "+20% key chance" would be unreadable while "x2.0" says
  // exactly what it does to whatever the base happens to be.
  if (effect.kind === 'keyDrop') {
    return `x${effect.multiplier.toFixed(2)} dungeon key drop chance${suffix}`;
  }

  const { label } = STAT_LABELS[effect.stat];

  // The three layers must be visibly different, because they are priced
  // differently and stack differently. "more" is the rare compounding layer and
  // says so in words; "increased" is the common percentage that sums with its
  // peers; "flat" is a raw amount. A player comparing two items cannot make a
  // sensible choice if all three render as a bare percentage.
  if (effect.op === 'more') {
    // A multiplier below 1 is a real design tool - Swarm Lens trades damage for
    // area - and must not read as a bonus.
    const delta = (effect.value - 1) * 100;
    const digits = Math.abs(delta) < 10 ? 1 : 0;
    return delta >= 0
      ? `${delta.toFixed(digits)}% more ${label}${suffix}`
      : `${Math.abs(delta).toFixed(digits)}% less ${label}${suffix}`;
  }

  if (effect.op === 'increased') {
    const delta = effect.value * 100;
    // Implicits live in the 1-3% range, where whole percents collapse distinct
    // tiers onto the same number and two different affixes render as the same
    // line. One decimal below 10% is enough to keep them apart.
    const digits = Math.abs(delta) < 10 ? 1 : 0;
    const word = delta >= 0 ? 'increased' : 'reduced';
    return `${Math.abs(delta).toFixed(digits)}% ${word} ${label}${suffix}`;
  }

  // "increased" rather than a bare sign is load-bearing on the percentage
  // layers. Crit chance is the case that proves it: of-Focus grants 20% of a 5%
  // base and of-Precision grants 3 percentage points, and rendered as "+20%" and
  // "+3%" the weaker one looks like the stronger one.
  const sign = effect.value >= 0 ? '+' : '';
  // Crit chance and crit damage are fractions of a whole the player never sees as
  // a raw number - the sheet quotes crit damage as "x2.00", so a flat roll shown
  // as "+0.04 Crit Damage" reads like a rounding error rather than +4%.
  const asPercent = effect.stat === 'critChance' || effect.stat === 'critMult';
  const shown = asPercent ? percent(effect.value) : String(Number(effect.value.toFixed(2)));
  return `${sign}${shown} ${label}${suffix}`;
}

/** Stamina or Mana. Which word is right depends on the weapon in your hand. */
export function resourceName(skill: Skill): string {
  return skill.kind === 'magical' ? 'Mana' : 'Stamina';
}

/**
 * A skill as the player reads it before equipping the weapon that grants it.
 *
 * `regenToSustain` is the number that carries this: a cost of 3.0 means nothing on
 * its own, and only becomes actionable stated as the regen needed to use the skill
 * at its own base speed. That is the whole answer to "why does my Staff swing
 * slower than my Axe" - deriveStats caps attackSpeed at regen/cost silently, so
 * without this line the cap is a number the player cannot trace to a cause.
 *
 * Damage is quoted at the weapon's own item level because that is what equipping it
 * would give. The other three bases are the skill's identity and do not scale.
 */
export function skillSummary(skill: Skill, itemLevel: number) {
  return {
    resource: resourceName(skill),
    damage: compact(skill.baseDamage * Math.pow(SKILL_LEVEL_GAIN, itemLevel)),
    speed: `${skill.baseSpeed.toFixed(2)}/s`,
    area: `${skill.baseArea} target${skill.baseArea === 1 ? '' : 's'}`,
    crit: percent(skill.baseCritChance),
    cost: skill.resourceCost.toFixed(1),
    regenToSustain: skill.baseSpeed * skill.resourceCost,
  };
}

/** Which half of the item a line belongs to. Implicits belong to neither. */
export type AffixSlot = 'prefix' | 'suffix' | 'implicit';

export interface AffixLine {
  text: string;
  tier: string;
  slot: AffixSlot;
  /** One letter for the badge: P, S, or a dash for an implicit. */
  badge: string;
}

/**
 * A rolled affix as one line: the effect, its tier, and which half it occupies.
 *
 * The tier matters once a player has a full loadout - two items can carry the
 * same affix and be worth very different amounts. The prefix/suffix marker
 * matters as soon as currency exists: a Sacred Idol rerolls one half and leaves
 * the other alone, and without the marker there is no way to tell which lines a
 * given currency is about to replace.
 *
 * `implicit` is passed by the caller rather than read off the affix, because an
 * implicit's `kind` is inert - it is neither prefix nor suffix for row counting.
 */
export function describeRolledAffix(rolled: RolledAffix, implicit = false): AffixLine {
  const affix = getAffix(rolled.affixId);
  if (!affix) {
    return { text: 'unknown modifier', tier: '', slot: 'implicit', badge: '-' };
  }

  const effect = affixEffect(rolled);
  const slot: AffixSlot = implicit ? 'implicit' : affix.kind;
  return {
    text: effect ? describeEffect(effect) : 'unknown modifier',
    tier: `T${displayTier(affix, rolled.tier)}`,
    slot,
    badge: slot === 'implicit' ? '-' : slot === 'prefix' ? 'P' : 'S',
  };
}

/** Badge colour per half, so the two are separable at a glance. */
export const AFFIX_SLOT_STYLE: Record<AffixSlot, string> = {
  prefix: 'text-sky-400',
  suffix: 'text-emerald-400',
  implicit: 'text-neutral-600',
};

/**
 * Colour per currency tier.
 *
 * Tiers mean different things to a player: basics are the working stock,
 * fragments are progress toward one, spirits are the once-per-item decision,
 * and the key is not a crafting item at all. Colour is how that reads without
 * a legend.
 */
export const CURRENCY_TIER_STYLE: Record<CurrencyTier, { border: string; text: string }> = {
  basic: { border: 'border-neutral-700', text: 'text-neutral-200' },
  spirit: { border: 'border-fuchsia-500/70', text: 'text-fuchsia-300' },
  fragment: { border: 'border-neutral-800', text: 'text-neutral-400' },
  key: { border: 'border-amber-500/70', text: 'text-amber-300' },
};

/** Ordered stat list for the character sheet. */
export function statEntries(stats: Stats): { key: StatKey; label: string; value: string }[] {
  return (Object.keys(STAT_LABELS) as StatKey[])
    .filter((key) => !SHEET_HIDDEN.includes(key))
    .map((key) => ({
      key,
      label: STAT_LABELS[key].label,
      value: STAT_LABELS[key].format(stats[key]),
    }));
}
