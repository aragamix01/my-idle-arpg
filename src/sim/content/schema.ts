/**
 * Content is DATA, not closures.
 *
 * Effects are a discriminated union the sim interprets. This costs expressive
 * power — a novel effect needs a new `kind` plus interpreter support — and buys
 * serialisability, diffability, schema validation, and the option to move the
 * registry into the database later without rewriting anything.
 */

import { z } from 'zod';
import { STAT_KEYS } from '../types';

export const StatKeySchema = z.enum(STAT_KEYS);

/** Conditions are evaluated against EffectContext at stat-derivation time. */
export const ConditionSchema = z
  .object({
    /** Applies only when the target is at or below this HP fraction. */
    enemyHpBelow: z.number().min(0).max(1).optional(),
    /** Applies only against bosses (true) or only against trash (false). */
    isBoss: z.boolean().optional(),
    /** Applies only from this stage onward. */
    stageAtLeast: z.number().int().min(1).optional(),
  })
  .strict();

export const EffectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('statMod'),
      stat: StatKeySchema,
      /** `add` applies before all `mul`. Order within a phase does not matter. */
      op: z.enum(['add', 'mul']),
      value: z.number(),
      when: ConditionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goldOnKill'),
      /** Flat gold added per kill, scaled by stage gold value. */
      multiplier: z.number(),
      when: ConditionSchema.optional(),
    })
    .strict(),
]);

export type Effect = z.infer<typeof EffectSchema>;
export type Condition = z.infer<typeof ConditionSchema>;

export const RaritySchema = z.enum(['common', 'rare', 'epic', 'legendary']);
export type Rarity = z.infer<typeof RaritySchema>;

export const ArtifactSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Logical sprite ID — never a filename. Resolved via the atlas sprite map. */
    sprite: z.string().min(1),
    rarity: RaritySchema,
    /** Earliest stage this can drop from. */
    dropStage: z.number().int().min(1),
    effects: z.array(EffectSchema).min(1),
  })
  .strict();

export type Artifact = z.infer<typeof ArtifactSchema>;
