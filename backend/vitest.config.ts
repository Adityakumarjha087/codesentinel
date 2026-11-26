import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/worker.ts', 'src/db/migrate-cli.ts', 'src/db/seed.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'text', 'json-summary', 'lcov'],
      thresholds: { lines: 70, statements: 70, functions: 70, branches: 60 },
    },
  },
});
