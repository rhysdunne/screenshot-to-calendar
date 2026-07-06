import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000, // Template.fromStack bundles 14 Lambdas with esbuild
    hookTimeout: 300_000,
  },
});
