import { _electron as electron, test, expect } from '@playwright/test';
import path from 'path';

test('Admin dashboard loads (smoke)', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '../../')], env: { NODE_ENV: 'test' } });
  const page = await app.firstWindow();
  // Navigate to admin (implementation-specific; update if your app uses routes)
  await page.click('#adminLink');
  await expect(page.locator('.admin-modal')).toBeVisible();
  await app.close();
});
