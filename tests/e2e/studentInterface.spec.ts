import { _electron as electron, test, expect } from '@playwright/test';
import path from 'path';

test.describe('Student Interface (Electron E2E)', () => {
  test('loads UI and has disabled buttons initially', async () => {
    const app = await electron.launch({
      args: [path.join(__dirname, '../../')],
      env: { NODE_ENV: 'test' }
    });
    const page = await app.firstWindow();

    await expect(page).toHaveTitle('UF SMILE Lab Attendance');
    await expect(page.locator('.ufid-inputs')).toBeVisible();
    await expect(page.locator('#signInBtn')).toBeVisible();
    await expect(page.locator('#signOutBtn')).toBeVisible();

    await expect(page.locator('#signInBtn')).toBeDisabled();
    await expect(page.locator('#signOutBtn')).toBeDisabled();

    await app.close();
  });

  test('UFID inputs enable buttons after 8 digits and Escape clears', async () => {
    const app = await electron.launch({
      args: [path.join(__dirname, '../../')],
      env: { NODE_ENV: 'test' }
    });
    const page = await app.firstWindow();

    for (let i = 0; i < 8; i++) {
      const input = page.locator(`.ufid-digit[data-index="${i}"]`);
      await input.fill(String((i + 1) % 10));
    }
    await page.waitForTimeout(100);

    await expect(page.locator('#signInBtn')).toBeEnabled();
    await expect(page.locator('#signOutBtn')).toBeEnabled();

    await page.keyboard.press('Escape');
    for (let i = 0; i < 8; i++) {
      const input = page.locator(`.ufid-digit[data-index="${i}"]`);
      await expect(input).toHaveValue('');
    }

    await app.close();
  });

  test('Admin modal shows error on invalid password', async () => {
    const app = await electron.launch({
      args: [path.join(__dirname, '../../')],
      env: { NODE_ENV: 'test' }
    });
    const page = await app.firstWindow();

    await page.click('#adminLink');
    await expect(page.locator('.admin-modal')).toBeVisible();

    await page.fill('#adminPassword', 'wrongpassword');
    await page.click('#adminLoginBtn');

    await expect(page.locator('#adminError')).toBeVisible();
    await expect(page.locator('#adminError')).toContainText(/Invalid/i);

    await app.close();
  });

  test('Responsive layout toggles gracefully', async () => {
    const app = await electron.launch({
      args: [path.join(__dirname, '../../')],
      env: { NODE_ENV: 'test' }
    });
    const page = await app.firstWindow();

    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('.ufid-inputs')).toBeVisible();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.locator('.ufid-inputs')).toBeVisible();

    await app.close();
  });
});
