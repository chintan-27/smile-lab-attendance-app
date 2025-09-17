const DataManager = require('../../data.js');
const testData = require('../helpers/testData');
const testUtils = require('../helpers/testUtils');
const path = require('path');

describe('Student Workflow Integration Tests', () => {
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

  describe('Complete Student Lifecycle', () => {
    test('should handle full student day workflow', async () => {
      // Admin adds student
      const student = testData.createTestStudent();
      const addResult = dataManager.addStudent(student.ufid, student.name, student.email);
      expect(addResult.success).toBe(true);

      // Student signs in
      const signInResult = dataManager.addAttendanceWithValidation(
        student.ufid, 
        student.name, 
        'signin'
      );
      expect(signInResult.success).toBe(true);
      expect(signInResult.studentName).toBe(student.name);

      // Verify student is currently signed in
      const currentlySignedIn = dataManager.getCurrentlySignedIn();
      expect(currentlySignedIn).toHaveLength(1);
      expect(currentlySignedIn[0].ufid).toBe(student.ufid);

      // Wait a moment (simulate time passage)
      await testUtils.waitFor(100);

      // Student signs out
      const signOutResult = dataManager.addAttendanceWithValidation(
        student.ufid, 
        student.name, 
        'signout'
      );
      expect(signOutResult.success).toBe(true);

      // Verify student is no longer signed in
      const afterSignOut = dataManager.getCurrentlySignedIn();
      expect(afterSignOut).toHaveLength(0);

      // Verify attendance records
      const attendance = dataManager.getAttendance();
      expect(attendance).toHaveLength(2);
      expect(attendance[0].action).toBe('signin');
      expect(attendance[1].action).toBe('signout');
    });

    test('should handle multiple students simultaneously', () => {
      // Add multiple students
      const students = [
        testData.createTestStudent({ name: 'Student 1' }),
        testData.createTestStudent({ name: 'Student 2' }),
        testData.createTestStudent({ name: 'Student 3' })
      ];

      students.forEach(student => {
        dataManager.addStudent(student.ufid, student.name, student.email);
      });

      // All students sign in
      students.forEach(student => {
        const result = dataManager.addAttendanceWithValidation(
          student.ufid, 
          student.name, 
          'signin'
        );
        expect(result.success).toBe(true);
      });

      // Verify all are signed in
      const signedIn = dataManager.getCurrentlySignedIn();
      expect(signedIn).toHaveLength(3);

      // First student signs out
      const signOutResult = dataManager.addAttendanceWithValidation(
        students[0].ufid, 
        students[0].name, 
        'signout'
      );
      expect(signOutResult.success).toBe(true);

      // Verify only 2 still signed in
      const stillSignedIn = dataManager.getCurrentlySignedIn();
      expect(stillSignedIn).toHaveLength(2);
      expect(stillSignedIn.find(s => s.ufid === students[0].ufid)).toBeUndefined();
    });

    test('should prevent invalid workflows', () => {
      const student = testData.createTestStudent();
      dataManager.addStudent(student.ufid, student.name, student.email);

      // Try to sign out without signing in
      const signOutFirst = dataManager.addAttendanceWithValidation(
        student.ufid, 
        student.name, 
        'signout'
      );
      expect(signOutFirst.success).toBe(false);
      expect(signOutFirst.noSignIn).toBe(true);

      // Sign in successfully
      const signIn = dataManager.addAttendanceWithValidation(
        student.ufid, 
        student.name, 
        'signin'
      );
      expect(signIn.success).toBe(true);

      // Try duplicate sign in
      const duplicateSignIn = dataManager.addAttendanceWithValidation(
        student.ufid, 
        student.name, 
        'signin'
      );
      expect(duplicateSignIn.success).toBe(false);
      expect(duplicateSignIn.duplicate).toBe(true);

      // Sign out successfully
      const signOut = dataManager.addAttendanceWithValidation(
        student.ufid, 
        student.name, 
        'signout'
      );
      expect(signOut.success).toBe(true);

      // Try duplicate sign out
      const duplicateSignOut = dataManager.addAttendanceWithValidation(
        student.ufid, 
        student.name, 
        'signout'
      );
      expect(duplicateSignOut.success).toBe(false);
      expect(duplicateSignOut.duplicate).toBe(true);
    });
  });

  describe('Performance Under Load', () => {
    test('should handle rapid sequential operations', () => {
      const student = testData.createTestStudent();
      dataManager.addStudent(student.ufid, student.name, student.email);

      // Perform rapid sign-in/out cycles
      for (let i = 0; i < 10; i++) {
        const signIn = dataManager.addAttendanceWithValidation(
          student.ufid, 
          student.name, 
          'signin'
        );
        expect(signIn.success).toBe(true);

        const signOut = dataManager.addAttendanceWithValidation(
          student.ufid, 
          student.name, 
          'signout'
        );
        expect(signOut.success).toBe(true);
      }

      const attendance = dataManager.getAttendance();
      expect(attendance).toHaveLength(20); // 10 sign-ins + 10 sign-outs
    });

    test('should maintain data integrity with large datasets', () => {
      // Add 100 students
      const students = [];
      for (let i = 0; i < 100; i++) {
        const student = testData.createTestStudent({ 
          name: `Student ${i}`,
          ufid: (10000000 + i).toString()
        });
        students.push(student);
        dataManager.addStudent(student.ufid, student.name, student.email);
      }

      // All students sign in
      students.forEach(student => {
        const result = dataManager.addAttendanceWithValidation(
          student.ufid, 
          student.name, 
          'signin'
        );
        expect(result.success).toBe(true);
      });

      // Verify stats
      const stats = dataManager.getEnhancedStats();
      expect(stats.totalStudents).toBe(100);
      expect(stats.currentlySignedIn).toBe(100);
      expect(stats.todaySignIns).toBe(100);
    });
  });
});
