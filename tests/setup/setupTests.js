const fs = require('fs');
const path = require('path');
const workerId = process.env.JEST_WORKER_ID || '1';
process.env.TEST_DATA_ROOT = path.join(__dirname, '../../test-data', `w${workerId}`);

// Use JSON-only storage mode for tests to avoid SQLite persistence issues
process.env.STORAGE_MODE = 'json';


// Always OK: create test-data directory (works in Node pretest and in Jest)
const mockTestDataDir = path.join(__dirname, '../../test-data'); // <-- name starts with "mock"
if (!fs.existsSync(mockTestDataDir)) {
  fs.mkdirSync(mockTestDataDir, { recursive: true });
}

// Detect if we're running under Jest (so we can call jest.* APIs)
const isJest =
  typeof jest !== 'undefined' &&
  typeof global !== 'undefined' &&
  typeof global.expect === 'function' &&
  typeof global.test === 'function';

if (isJest) {
  // IMPORTANT: All non-globals required inside the factory;
  // the only captured variable is mockTestDataDir (allowed).
  jest.mock('electron', () => {
    const { fn } = jest;
    return {
      app: {
        getPath: fn(() => mockTestDataDir),
        whenReady: fn(() => Promise.resolve()),
        quit: fn(),
        on: fn()
      },
      BrowserWindow: fn(() => ({
        loadFile: fn(),
        show: fn(),
        webContents: { on: fn() }
      })),
      ipcMain: {
        handle: fn(),
        on: fn()
      }
    };
  });

  jest.setTimeout(10000);
} else {
  // Running via "pretest": keep side effects minimal.
  console.log('Pretest env setup complete (no Jest)');
}
