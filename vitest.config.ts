import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The same `@/` alias tsconfig and Next use. Without it, a test importing
  // from src/ui/ - as the affix-rendering one does - fails to *resolve* rather
  // than fails to assert, and the run reports a green suite with most of its
  // tests silently missing.
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    // Vitest's default glob also matches *.spec.ts, which would drag the
    // Playwright suite into the unit run and fail on its imports.
    include: ['tests/**/*.test.ts'],
  },
});
