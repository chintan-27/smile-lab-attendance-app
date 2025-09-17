const fs = require('fs');
const path = require('path');

// Cleanup test data
const testDataDir = path.join(__dirname, '../../test-data');
if (fs.existsSync(testDataDir)) {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('Test data cleaned up');
}
