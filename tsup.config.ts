import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['react'],
  // Marks the bundle as client-only so Next.js App Router imports work without a wrapper.
  banner: { js: "'use client';" },
});
