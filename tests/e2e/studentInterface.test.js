const { Application } = require('spectron');
const path = require('path');
const testUtils = require('../helpers/testUtils');

describe('Student Interface E2E Tests', () => {
  let app;

  beforeEach(async () => {
    testUtils.setupCleanEnvironment();
    
    app = new Application({
      path: require('electron'),
      args: [path.join(__dirname, '../../')],
      env: { NODE_ENV: 'test' }
    });
    
    await app.start();
  });

  afterEach(async () => {
    if (app && app.isRunning()) {
      await app.stop();
    }
  });

  describe('Initial Load', () => {
    test('should load student interface without errors', async () => {
      expect(await app.client.getTitle()).toBe('UF Lab Attendance');
      
      // Check main elements exist
      expect(await app.client.isExisting('.ufid-inputs')).toBe(true);
      expect(await app.client.isExisting('#signInBtn')).toBe(true);
      expect(await app.client.isExisting('#signOutBtn')).toBe(true);
    });

    test('should have sign-in and sign-out buttons disabled initially', async () => {
      const signInBtn = await app.client.$('#signInBtn');
      const signOutBtn = await app.client.$('#signOutBtn');
      
      expect(await signInBtn.isEnabled()).toBe(false);
      expect(await signOutBtn.isEnabled()).toBe(false);
    });

    test('should display UF branding correctly', async () => {
      const logo = await app.client.$('.logo');
      expect(await logo.isDisplayed()).toBe(true);
      
      const logoText = await logo.getText();
      expect(logoText).toContain('UF Lab');
    });
  });

  describe('UFID Input Functionality', () => {
    test('should accept numeric input in UFID fields', async () => {
      const firstInput = await app.client.$('.ufid-digit[data-index="0"]');
      await firstInput.setValue('1');
      
      expect(await firstInput.getValue()).toBe('1');
      expect(await firstInput.getAttribute('class')).toContain('filled');
    });

    test('should filter out non-numeric characters', async () => {
      const firstInput = await app.client.$('.ufid-digit[data-index="0"]');
      await firstInput.setValue('a');
      
      expect(await firstInput.getValue()).toBe('');
    });

    test('should auto-advance to next input on valid digit', async () => {
      const firstInput = await app.client.$('.ufid-digit[data-index="0"]');
      const secondInput = await app.client.$('.ufid-digit[data-index="1"]');
      
      await firstInput.setValue('1');
      
      const activeElement = await app.client.getActiveElement();
      const secondInputId = await secondInput.getAttribute('data-index');
      const activeInputId = await activeElement.getAttribute('data-index');
      
      expect(activeInputId).toBe(secondInputId);
    });

    test('should enable buttons when all 8 digits entered', async () => {
      for (let i = 0; i < 8; i++) {
        const input = await app.client.$(`.ufid-digit[data-index="${i}"]`);
        await input.setValue((i + 1).toString());
      }

      const signInBtn = await app.client.$('#signInBtn');
      const signOutBtn = await app.client.$('#signOutBtn');
      
      await app.client.pause(100);
      
      expect(await signInBtn.isEnabled()).toBe(true);
      expect(await signOutBtn.isEnabled()).toBe(true);
    });

    test('should clear all inputs with escape key', async () => {
      const firstInput = await app.client.$('.ufid-digit[data-index="0"]');
      await firstInput.setValue('1');
      
      await app.client.keys('Escape');
      
      for (let i = 0; i < 8; i++) {
        const input = await app.client.$(`.ufid-digit[data-index="${i}"]`);
        expect(await input.getValue()).toBe('');
      }
    });
  });

  describe('Admin Modal', () => {
    test('should open admin modal when clicking admin link', async () => {
      const adminLink = await app.client.$('#adminLink');
      await adminLink.click();
      
      const modal = await app.client.$('.admin-modal');
      expect(await modal.isDisplayed()).toBe(true);
    });

    test('should close admin modal with cancel button', async () => {
      const adminLink = await app.client.$('#adminLink');
      await adminLink.click();
      
      const cancelBtn = await app.client.$('#adminCancelBtn');
      await cancelBtn.click();
      
      const modal = await app.client.$('.admin-modal');
      expect(await modal.isExisting()).toBe(false);
    });

    test('should show error for invalid admin password', async () => {
      const adminLink = await app.client.$('#adminLink');
      await adminLink.click();
      
      const passwordInput = await app.client.$('#adminPassword');
      await passwordInput.setValue('wrongpassword');
      
      const loginBtn = await app.client.$('#adminLoginBtn');
      await loginBtn.click();
      
      const errorDiv = await app.client.$('#adminError');
      expect(await errorDiv.isDisplayed()).toBe(true);
      expect(await errorDiv.getText()).toContain('Invalid');
    });
  });

  describe('Error Handling', () => {
    test('should show error for unauthorized student sign-in', async () => {
      for (let i = 0; i < 8; i++) {
        const input = await app.client.$(`.ufid-digit[data-index="${i}"]`);
        await input.setValue('9');
      }

      const signInBtn = await app.client.$('#signInBtn');
      await signInBtn.click();
      
      await app.client.pause(1000);
      
      const statusMessage = await app.client.$('#statusMessage');
      expect(await statusMessage.isDisplayed()).toBe(true);
      expect(await statusMessage.getAttribute('class')).toContain('error');
    });

    test('should handle network/backend errors gracefully (structure exists)', async () => {
      const statusMessage = await app.client.$('#statusMessage');
      expect(await statusMessage.isExisting()).toBe(true);
    });
  });

  describe('Responsive Design', () => {
    test('should adapt to different window sizes', async () => {
      await app.browserWindow.setSize(375, 667);
      await app.client.pause(500);
      
      const ufidInputs = await app.client.$('.ufid-inputs');
      expect(await ufidInputs.isDisplayed()).toBe(true);
      
      await app.browserWindow.setSize(1920, 1080);
      await app.client.pause(500);
      
      expect(await ufidInputs.isDisplayed()).toBe(true);
    });
  });
});
