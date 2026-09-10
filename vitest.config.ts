import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      // `*.test-d.ts` holds type-level assertions that tsc checks and vitest
      // never runs, so counting it as source understates coverage.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.test-d.ts', 'src/index.ts'],
    },
  },
});
