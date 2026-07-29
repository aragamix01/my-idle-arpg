/**
 * Content registry entry point.
 *
 * CONTENT_VERSION is stamped into every save. The server recomputes offline
 * progress from saves that may be weeks old — without the stamp, a balance
 * patch silently corrupts those numbers.
 *
 * Bump it whenever the affix pool, the effect schema, or TUNING changes in a
 * way that alters outcomes. A bump that also changes the *shape* of a save
 * needs a matching step in src/sim/migrate.ts.
 */

import { AFFIXES, IMPLICIT_AFFIXES } from './affixes';
import { BASE_AFFIXES, BASES } from './bases';
import { UNIQUES } from './uniques';
import { EffectSchema, UniqueSchema } from './schema';

/** 2: artifacts became rolled item instances with prefixes and suffixes. */
/** 3: bases carry implicits, drops come in threes, and "artifact" became "item". */
export const CONTENT_VERSION = 3;

export * from './schema';
export * from './affixes';
export * from './bases';
export * from './uniques';

/**
 * Validates the whole registry.
 *
 * Called by a test rather than at runtime. Types already cover shape; this
 * catches what they cannot - duplicate ids, tier tables that are not ascending,
 * and affix templates that produce effects the interpreter would reject.
 */
export function validateRegistry(): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const seenAffix = new Set<string>();
  // Implicits go through the identical checks - they share the definition
  // shape precisely so they cannot drift into a second, unvalidated format.
  for (const affix of [...AFFIXES, ...IMPLICIT_AFFIXES]) {
    if (seenAffix.has(affix.id)) errors.push(`duplicate affix id: ${affix.id}`);
    seenAffix.add(affix.id);

    if (affix.tiers.length === 0) errors.push(`${affix.id}: no tiers`);
    for (let i = 1; i < affix.tiers.length; i++) {
      if (affix.tiers[i].minStage < affix.tiers[i - 1].minStage) {
        errors.push(`${affix.id}: tier ${i} unlocks before tier ${i - 1}`);
      }
    }
    // Tier 0 must be reachable at stage 1 or nothing can roll the affix.
    if (affix.tiers[0]?.minStage > 1) errors.push(`${affix.id}: lowest tier is gated above stage 1`);

    // Every template must produce an effect the interpreter accepts.
    const sample =
      affix.effect.kind === 'goldOnKill'
        ? { kind: 'goldOnKill' as const, multiplier: affix.tiers[0].value }
        : {
            kind: 'statMod' as const,
            stat: affix.effect.stat,
            op: affix.effect.op,
            value: affix.tiers[0].value,
          };
    const parsed = EffectSchema.safeParse(sample);
    if (!parsed.success) errors.push(`${affix.id}: produces an invalid effect`);
  }

  const seenBase = new Set<string>();
  for (const base of BASES) {
    if (seenBase.has(base.id)) errors.push(`duplicate base id: ${base.id}`);
    seenBase.add(base.id);
    // A base with no implicit is strictly worse than every other base, which
    // makes it dead content rather than a choice.
    if (!BASE_AFFIXES[base.id]) errors.push(`${base.id}: no implicit affix`);
  }

  const seenUnique = new Set<string>();
  for (const unique of UNIQUES) {
    if (seenUnique.has(unique.id)) errors.push(`duplicate unique id: ${unique.id}`);
    seenUnique.add(unique.id);
    const parsed = UniqueSchema.safeParse(unique);
    if (!parsed.success) {
      errors.push(`${unique.id}: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
