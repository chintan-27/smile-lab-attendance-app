import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Only run E2E specs
  testDir: 'tests/e2e',
  testMatch: ['**/*.spec.ts', '**/*.spec.js'],
  // (extra safety) ignore other test trees if someone changes testDir later
  testIgnore: ['**/tests/unit/**', '**/tests/integration/**'],
  reporter: [['list'], ['html', { outputFolder: 'playwright-report' }]],
  timeout: 30_000,
  use: { headless: true }
});
