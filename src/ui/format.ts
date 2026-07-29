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
  type CurrencyTier,
  type Effect,
  type Rarity,
  type RolledAffix,
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
};

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

  const { label } = STAT_LABELS[effect.stat];
  if (effect.op === 'mul') {
    // A multiplier below 1 is a real design tool - Swarm Lens trades damage for
    // area - and must not read as a bonus.
    const delta = (effect.value - 1) * 100;
    const sign = delta >= 0 ? '+' : '';
    // Toughness mods live in the 1.5-4% range, where whole percents collapse
    // distinct tiers onto the same number and two different affixes render as
    // the same line. One decimal below 10% is enough to keep them apart.
    const digits = Math.abs(delta) < 10 ? 1 : 0;
    return `${sign}${delta.toFixed(digits)}% ${label}${suffix}`;
  }

  const sign = effect.value >= 0 ? '+' : '';
  const shown =
    effect.stat === 'critChance' ? percent(effect.value) : effect.value.toFixed(2).replace(/\.00$/, '');
  return `${sign}${shown} ${label}${suffix}`;
}

/**
 * A rolled affix as one line: the effect, plus which tier it landed on.
 *
 * The tier is the part that matters once a player has a full loadout - two
 * items can carry the same affix and be worth very different amounts, and
 * without the tier shown there is no way to see that at a glance.
 */
export function describeRolledAffix(rolled: RolledAffix): { text: string; tier: string } {
  const affix = getAffix(rolled.affixId);
  if (!affix) return { text: 'unknown modifier', tier: '' };

  const effect = affixEffect(rolled);
  return {
    text: effect ? describeEffect(effect) : 'unknown modifier',
    tier: `T${displayTier(affix, rolled.tier)}`,
  };
}

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
  return (Object.keys(STAT_LABELS) as StatKey[]).map((key) => ({
    key,
    label: STAT_LABELS[key].label,
    value: STAT_LABELS[key].format(stats[key]),
  }));
}
