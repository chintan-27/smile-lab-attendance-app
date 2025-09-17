const DataManager = require('../../data.js');
const testData = require('../helpers/testData');
const testUtils = require('../helpers/testUtils');
const path = require('path');

describe('DataManager Unit Tests', () => {
  let dataManager;

  beforeEach(() => {
    testUtils.setupCleanEnvironment();
    // Create DataManager with test directory
    dataManager = new DataManager();
    dataManager.dataDir = testUtils.testDataDir;
    dataManager.studentsFile = path.join(testUtils.testDataDir, 'students.json');
    dataManager.attendanceFile = path.join(testUtils.testDataDir, 'attendance.json');
    dataManager.configFile = path.join(testUtils.testDataDir, 'config.json');
    dataManager.initializeData();
  });

  describe('Student Management', () => {
    test('should add a new student successfully', () => {
      const student = testData.createTestStudent();
      const result = dataManager.addStudent(student.ufid, student.name, student.email);
      
      expect(result.success).toBe(true);
      
      const students = dataManager.getStudents();
      expect(students).toHaveLength(1);
      expect(students[0].ufid).toBe(student.ufid);
      expect(students[0].name).toBe(student.name);
    });

    test('should handle duplicate UFID', () => {
      const student = testData.createTestStudent();
      
      // Add student twice
      dataManager.addStudent(student.ufid, student.name, student.email);
      const result = dataManager.addStudent(student.ufid, 'Different Name', student.email);
      
      expect(result.success).toBe(true);
      
      const students = dataManager.getStudents();
      expect(students).toHaveLength(1);
      expect(students[0].name).toBe('Different Name'); // Should update
    });

    test('should remove student successfully', () => {
      const student = testData.createTestStudent();
      dataManager.addStudent(student.ufid, student.name, student.email);
      
      const result = dataManager.removeStudent(student.ufid);
      expect(result.success).toBe(true);
      
      const students = dataManager.getStudents();
      expect(students).toHaveLength(0);
    });

    test('should handle removing non-existent student', () => {
      const result = dataManager.removeStudent('99999999');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Student not found');
    });

    test('should authorize valid student', () => {
      const student = testData.createTestStudent();
      dataManager.addStudent(student.ufid, student.name, student.email);
      
      const authorized = dataManager.isStudentAuthorized(student.ufid);
      expect(authorized).not.toBeNull();
      expect(authorized.ufid).toBe(student.ufid);
    });

    test('should reject unauthorized student', () => {
      const authorized = dataManager.isStudentAuthorized('99999999');
      expect(authorized).toBeNull();
    });
  });

  describe('Attendance Management', () => {
    let testStudent;

    beforeEach(() => {
      testStudent = testData.createTestStudent();
      dataManager.addStudent(testStudent.ufid, testStudent.name, testStudent.email);
    });

    test('should handle first sign-in successfully', () => {
      const result = dataManager.addAttendanceWithValidation(
        testStudent.ufid, 
        testStudent.name, 
        'signin'
      );
      
      expect(result.success).toBe(true);
      expect(result.studentName).toBe(testStudent.name);
      
      const attendance = dataManager.getAttendance();
      expect(attendance).toHaveLength(1);
      expect(attendance[0].action).toBe('signin');
    });

    test('should prevent duplicate sign-in', () => {
      // First sign-in
      dataManager.addAttendanceWithValidation(testStudent.ufid, testStudent.name, 'signin');
      
      // Attempt duplicate sign-in
      const result = dataManager.addAttendanceWithValidation(
        testStudent.ufid, 
        testStudent.name, 
        'signin'
      );
      
      expect(result.success).toBe(false);
      expect(result.duplicate).toBe(true);
      expect(result.error).toContain('already signed in');
    });

    test('should handle sign-out after sign-in', () => {
      // Sign in first
      dataManager.addAttendanceWithValidation(testStudent.ufid, testStudent.name, 'signin');
      
      // Then sign out
      const result = dataManager.addAttendanceWithValidation(
        testStudent.ufid, 
        testStudent.name, 
        'signout'
      );
      
      expect(result.success).toBe(true);
      
      const attendance = dataManager.getAttendance();
      expect(attendance).toHaveLength(2);
      expect(attendance[1].action).toBe('signout');
    });

    test('should prevent sign-out without sign-in', () => {
      const result = dataManager.addAttendanceWithValidation(
        testStudent.ufid, 
        testStudent.name, 
        'signout'
      );
      
      expect(result.success).toBe(false);
      expect(result.noSignIn).toBe(true);
      expect(result.error).toContain('never signed in');
    });

    test('should get current status correctly', () => {
      // Initially never signed in
      expect(dataManager.getCurrentStatus(testStudent.ufid)).toBe('never_signed_in');
      
      // After sign in
      dataManager.addAttendanceWithValidation(testStudent.ufid, testStudent.name, 'signin');
      expect(dataManager.getCurrentStatus(testStudent.ufid)).toBe('signin');
      
      // After sign out
      dataManager.addAttendanceWithValidation(testStudent.ufid, testStudent.name, 'signout');
      expect(dataManager.getCurrentStatus(testStudent.ufid)).toBe('signout');
    });
  });

  describe('Statistics and Reports', () => {
    beforeEach(() => {
      // Add test students
      testData.sampleStudents.forEach(student => {
        dataManager.addStudent(student.ufid, student.name, student.email);
      });
      
      // Add test attendance
      testData.sampleAttendance.forEach(record => {
        dataManager.addAttendanceWithValidation(record.ufid, record.name, record.action);
      });
    });

    test('should generate basic stats', () => {
      const stats = dataManager.getStats();
      
      expect(stats.totalStudents).toBe(4);
      expect(stats.activeStudents).toBe(3); // One inactive in sample data
      expect(stats.totalRecords).toBeGreaterThan(0);
    });

    test('should generate enhanced stats', () => {
      const stats = dataManager.getEnhancedStats();
      
      expect(stats.totalStudents).toBe(4);
      expect(stats.currentlySignedIn).toBe(2); // From sample attendance
      expect(stats.signedInStudents).toHaveLength(2);
    });

    test("should get today's attendance", () => {
      const todaysAttendance = dataManager.getTodaysAttendance();
      expect(Array.isArray(todaysAttendance)).toBe(true);
    });
  });

  describe('Admin Functions', () => {
    test('should verify correct admin password', () => {
      const isValid = dataManager.verifyAdmin('admin123');
      expect(isValid).toBe(true);
    });

    test('should reject incorrect admin password', () => {
      const isValid = dataManager.verifyAdmin('wrongpassword');
      expect(isValid).toBe(false);
    });

    test('should change admin password', () => {
      const result = dataManager.changeAdminPassword('newpassword123');
      expect(result.success).toBe(true);
      
      // Old password should not work
      expect(dataManager.verifyAdmin('admin123')).toBe(false);
      
      // New password should work
      expect(dataManager.verifyAdmin('newpassword123')).toBe(true);
    });
  });

  describe('Data Persistence', () => {
    test('should persist student data', () => {
      const student = testData.createTestStudent();
      dataManager.addStudent(student.ufid, student.name, student.email);
      
      // Create new instance to test persistence
      const newDataManager = new DataManager();
      newDataManager.dataDir = testUtils.testDataDir;
      newDataManager.studentsFile = dataManager.studentsFile;
      newDataManager.attendanceFile = dataManager.attendanceFile;
      newDataManager.configFile = dataManager.configFile;
      
      const students = newDataManager.getStudents();
      expect(students).toHaveLength(1);
      expect(students[0].ufid).toBe(student.ufid);
    });

    test('should create backup successfully', () => {
      const student = testData.createTestStudent();
      dataManager.addStudent(student.ufid, student.name, student.email);
      
      const result = dataManager.backupData();
      expect(result.success).toBe(true);
      expect(result.backupFile).toBeDefined();
      
      // Verify backup file exists
      const fs = require('fs');
      expect(fs.existsSync(result.backupFile)).toBe(true);
    });
  });
});
