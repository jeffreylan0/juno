import { defineConfig } from '@playwright/test';

export const FIXTURE_PORT = 5174;
export const FIXTURE_ORIGIN = `http://localhost:${FIXTURE_PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  // Fixtures are served over http: an extension cannot touch file:// URLs
  // unless the user ticks "Allow access to file URLs".
  webServer: {
    command: `pnpm exec http-server tests/fixtures/pages -p ${FIXTURE_PORT} --silent`,
    url: FIXTURE_ORIGIN,
    reuseExistingServer: !process.env.CI,
  },
});
