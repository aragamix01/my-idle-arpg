import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest's default glob also matches *.spec.ts, which would drag the
    // Playwright suite into the unit run and fail on its imports.
    include: ['tests/**/*.test.ts'],
  },
});
