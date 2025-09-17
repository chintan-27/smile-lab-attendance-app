import { _electron as electron, test, expect } from '@playwright/test';
import path from 'path';

test('Full workflow (smoke)', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '../../')], env: { NODE_ENV: 'test' } });
  const page = await app.firstWindow();

  // Enter UFID digits
  for (let i = 0; i < 8; i++) {
    await page.locator(`.ufid-digit[data-index="${i}"]`).fill('1');
  }
  await page.waitForTimeout(100);

  // Attempt sign-in/out buttons exist
  await expect(page.locator('#signInBtn')).toBeVisible();
  await expect(page.locator('#signOutBtn')).toBeVisible();

  await app.close();
});
