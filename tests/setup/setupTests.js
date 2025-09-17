const fs = require('fs');
const path = require('path');

// Create test data directory
const testDataDir = path.join(__dirname, '../../test-data');
if (!fs.existsSync(testDataDir)) {
  fs.mkdirSync(testDataDir, { recursive: true });
}

// Mock electron modules for testing
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => testDataDir),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
    on: jest.fn()
  },
  BrowserWindow: jest.fn(() => ({
    loadFile: jest.fn(),
    show: jest.fn(),
    webContents: { on: jest.fn() }
  })),
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn()
  }
}));

// Global test timeout
jest.setTimeout(10000);

console.log('Test environment setup complete');
