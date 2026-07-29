/**
 * Pure simulation. No DOM, no Pixi, no React, no Next.
 *
 * Enforced by the `no-restricted-imports` boundary in eslint.config.mjs. If you
 * find yourself wanting to import a browser API here, the code belongs in
 * src/render/ or src/ui/ instead.
 */

export * from './types';
export * from './rng';
export * from './curves';
export * from './content';
export * from './items';
export * from './migrate';
export * from './stats';
export * from './combat';
export * from './offline';
export * from './commands';
export * from './hud';
