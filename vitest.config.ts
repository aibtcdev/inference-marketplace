import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // test/d1.ts backs D1 with node:sqlite, which Node 22 < 22.13 gates behind a flag.
    poolOptions: { forks: { execArgv: ['--experimental-sqlite', '--no-warnings'] } },
  },
});
