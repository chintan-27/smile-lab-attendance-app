// Test data generators
const testData = {
  // Sample students for testing
  sampleStudents: [
    { ufid: '12345678', name: 'John Doe', email: 'john.doe@ufl.edu', active: true },
    { ufid: '87654321', name: 'Jane Smith', email: 'jane.smith@ufl.edu', active: true },
    { ufid: '11111111', name: 'Bob Johnson', email: 'bob.johnson@ufl.edu', active: false },
    { ufid: '22222222', name: 'Alice Brown', email: 'alice.brown@ufl.edu', active: true }
  ],

  // Sample attendance records
  sampleAttendance: [
    {
      id: 1,
      ufid: '12345678',
      name: 'John Doe',
      action: 'signin',
      timestamp: new Date(Date.now() - 3600000).toISOString() // 1 hour ago
    },
    {
      id: 2,
      ufid: '87654321', 
      name: 'Jane Smith',
      action: 'signin',
      timestamp: new Date(Date.now() - 1800000).toISOString() // 30 min ago
    }
  ],

  // Test configuration
  testConfig: {
    adminPassword: 'test123',
    labName: 'Test Lab',
    emailSettings: {
      enabled: false,
      smtp: 'smtp.test.com',
      email: 'test@test.com'
    }
  },

  // Generate random UFID
  randomUfid: () => {
    return Math.floor(10000000 + Math.random() * 90000000).toString();
  },

  // Generate test student
  createTestStudent: (overrides = {}) => {
    return {
      ufid: testData.randomUfid(),
      name: 'Test Student',
      email: 'test@ufl.edu',
      active: true,
      addedDate: new Date().toISOString(),
      ...overrides
    };
  },

  // Generate attendance record
  createAttendanceRecord: (ufid, action = 'signin', overrides = {}) => {
    return {
      id: Date.now(),
      ufid,
      name: 'Test Student',
      action,
      timestamp: new Date().toISOString(),
      ...overrides
    };
  }
};

module.exports = testData;
