const DataManager = require('../../data.js');
const testData = require('../helpers/testData');
const testUtils = require('../helpers/testUtils');
const path = require('path');

describe('Admin Workflow Integration Tests', () => {
  let dataManager;

  beforeEach(() => {
    testUtils.setupCleanEnvironment();
    dataManager = new DataManager();
    dataManager.dataDir = testUtils.testDataDir;
    dataManager.studentsFile = path.join(testUtils.testDataDir, 'students.json');
    dataManager.attendanceFile = path.join(testUtils.testDataDir, 'attendance.json');
    dataManager.configFile = path.join(testUtils.testDataDir, 'config.json');
    dataManager.initializeData();
  });

  test('bulk student operations', () => {
    const students = [];
    for (let i = 0; i < 10; i++) {
      const s = testData.createTestStudent({ ufid: (12000000 + i).toString(), name: `Bulk ${i}` });
      students.push(s);
      expect(dataManager.addStudent(s.ufid, s.name, s.email).success).toBe(true);
    }
    expect(dataManager.getStudents()).toHaveLength(10);
    for (let i = 0; i < students.length; i += 2) {
      expect(dataManager.removeStudent(students[i].ufid).success).toBe(true);
    }
    expect(dataManager.getStudents()).toHaveLength(5);
  });
});
