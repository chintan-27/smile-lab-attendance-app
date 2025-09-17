import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: __dirname, // tests/e2e
  timeout: 30_000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report' }]],
  use: { headless: true }
});
