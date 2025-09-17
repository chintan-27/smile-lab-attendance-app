const fs = require('fs');
const path = require('path');

class TestUtils {
  constructor() {
    this.testDataDir =
      process.env.TEST_DATA_ROOT || path.join(__dirname, '../../test-data');
  }

  // Setup clean test environment
  setupCleanEnvironment() {
    if (fs.existsSync(this.testDataDir)) {
      fs.rmSync(this.testDataDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.testDataDir, { recursive: true });
  }

  // Wait for async operations
  async waitFor(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Create test files
  createTestFile(filename, data) {
    const filePath = path.join(this.testDataDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
  }

  // Read test file
  readTestFile(filename) {
    const filePath = path.join(this.testDataDir, filename);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return null;
  }

  // Validate UFID format
  isValidUfid(ufid) {
    return /^\d{8}$/.test(ufid);
  }

  // Mock console methods for testing
  mockConsole() {
    const originalConsole = { ...console };
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
    return originalConsole;
  }

  // Restore console
  restoreConsole(originalConsole) {
    Object.assign(console, originalConsole);
  }

  // Generate test performance metrics
  measurePerformance(fn) {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    return {
      result,
      duration: end - start
    };
  }
}

module.exports = new TestUtils();
