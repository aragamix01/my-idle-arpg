/**
 * Content registry entry point.
 *
 * CONTENT_VERSION is stamped into every save. The server recomputes offline
 * progress from saves that may be weeks old — without the stamp, a balance
 * patch silently corrupts those numbers.
 *
 * Bump it whenever ARTIFACTS, the effect schema, or TUNING changes in a way
 * that alters outcomes.
 */

import { ARTIFACTS } from './artifacts';
import { ArtifactSchema, type Artifact } from './schema';

export const CONTENT_VERSION = 1;

export * from './schema';
export { ARTIFACTS } from './artifacts';
export type { ArtifactId } from './artifacts';

const byId = new Map<string, Artifact>(ARTIFACTS.map((a) => [a.id, a]));

export function getArtifact(id: string): Artifact | undefined {
  return byId.get(id);
}

export function artifactExists(id: string): boolean {
  return byId.has(id);
}

/**
 * Validates the whole registry against the schema. Called by a test, not at
 * runtime — the `satisfies` clause in artifacts.ts already type-checks shape,
 * this catches the things types cannot (duplicate ids, out-of-range numbers).
 */
export function validateRegistry(): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const artifact of ARTIFACTS) {
    const parsed = ArtifactSchema.safeParse(artifact);
    if (!parsed.success) {
      errors.push(`${artifact.id}: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }
    if (seen.has(artifact.id)) errors.push(`duplicate id: ${artifact.id}`);
    seen.add(artifact.id);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
