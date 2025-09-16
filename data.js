const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DataManager {
    constructor() {
        this.dataDir = path.join(__dirname, 'data');
        this.attendanceFile = path.join(this.dataDir, 'attendance.json');
        this.studentsFile = path.join(this.dataDir, 'students.json');
        this.configFile = path.join(this.dataDir, 'config.json');

        this.initializeData();
    }

    initializeData() {
        // Create data directory if it doesn't exist
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir);
        }

        // Initialize attendance file
        if (!fs.existsSync(this.attendanceFile)) {
            fs.writeFileSync(this.attendanceFile, JSON.stringify([], null, 2));
        }

        // Initialize students file
        if (!fs.existsSync(this.studentsFile)) {
            fs.writeFileSync(this.studentsFile, JSON.stringify([], null, 2));
        }

        // Initialize config file with default admin password
        if (!fs.existsSync(this.configFile)) {
            const defaultConfig = {
                adminPassword: this.hashPassword('admin123'), // Default password
                labName: 'University of Florida Lab',
                emailSettings: {
                    enabled: false,
                    smtp: '',
                    email: '',
                    password: ''
                }
            };
            fs.writeFileSync(this.configFile, JSON.stringify(defaultConfig, null, 2));
        }
    }

    hashPassword(password) {
        return crypto.createHash('sha256').update(password).digest('hex');
    }

    // Authentication
    verifyAdmin(password) {
        try {
            const config = this.getConfig();
            return this.hashPassword(password) === config.adminPassword;
        } catch (error) {
            return false;
        }
    }

    getConfig() {
        try {
            const data = fs.readFileSync(this.configFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return {};
        }
    }

    // Student management methods
    addStudent(ufid, name, email = '') {
        try {
            const students = this.getStudents();
            const student = {
                ufid,
                name,
                email,
                active: true,
                addedDate: new Date().toISOString()
            };

            // Check if student already exists
            const existingIndex = students.findIndex(s => s.ufid === ufid);
            if (existingIndex !== -1) {
                students[existingIndex] = student;
            } else {
                students.push(student);
            }

            fs.writeFileSync(this.studentsFile, JSON.stringify(students, null, 2));
            return { success: true, student };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    getStudents() {
        try {
            const data = fs.readFileSync(this.studentsFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return [];
        }
    }

    removeStudent(ufid) {
        try {
            const students = this.getStudents();
            const filteredStudents = students.filter(s => s.ufid !== ufid);
            fs.writeFileSync(this.studentsFile, JSON.stringify(filteredStudents, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Student validation
    isStudentAuthorized(ufid) {
        const students = this.getStudents();
        const student = students.find(s => s.ufid === ufid && s.active);
        return student || null;
    }

    // Attendance methods
    getAttendance() {
        try {
            const data = fs.readFileSync(this.attendanceFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return [];
        }
    }

    // Get current status of a student (signed in or out)
    getCurrentStatus(ufid) {
        const attendance = this.getAttendance();
        const userRecords = attendance.filter(record => record.ufid === ufid);

        if (userRecords.length === 0) {
            return 'never_signed_in';
        }

        const lastRecord = userRecords[userRecords.length - 1];
        return lastRecord.action; // 'signin' or 'signout'
    }

    // Basic attendance method (deprecated - use addAttendanceWithValidation)
    addAttendance(ufid, name, action) {
        try {
            // Check if student is authorized
            const authorizedStudent = this.isStudentAuthorized(ufid);
            if (!authorizedStudent) {
                return {
                    success: false,
                    error: 'Student not authorized. Please contact admin to be added to the system.',
                    unauthorized: true
                };
            }

            const attendance = this.getAttendance();
            const record = {
                id: Date.now(),
                ufid: ufid,
                name: authorizedStudent.name, // Use the name from authorized students
                action: action,
                timestamp: new Date().toISOString()
            };

            attendance.push(record);
            fs.writeFileSync(this.attendanceFile, JSON.stringify(attendance, null, 2));
            return { success: true, record, studentName: authorizedStudent.name };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Enhanced attendance method with better validation
    addAttendanceWithValidation(ufid, name, action) {
        try {
            // Check if student is authorized
            const authorizedStudent = this.isStudentAuthorized(ufid);
            if (!authorizedStudent) {
                return {
                    success: false,
                    error: 'Student not authorized. Please contact admin to be added to the system.',
                    unauthorized: true
                };
            }

            // Check current status
            const currentStatus = this.getCurrentStatus(ufid);

            // Validation logic
            if (action === 'signin') {
                if (currentStatus === 'signin') {
                    return {
                        success: false,
                        error: `${authorizedStudent.name} is already signed in. Please sign out first.`,
                        duplicate: true
                    };
                }
            } else if (action === 'signout') {
                if (currentStatus === 'signout') {
                    return {
                        success: false,
                        error: `${authorizedStudent.name} is already signed out. Please sign in first.`,
                        duplicate: true
                    };
                } else if (currentStatus === 'never_signed_in') {
                    return {
                        success: false,
                        error: `${authorizedStudent.name} has never signed in today. Please sign in first.`,
                        noSignIn: true
                    };
                }
            }

            // Add the record
            const attendance = this.getAttendance();
            const record = {
                id: Date.now(),
                ufid: ufid,
                name: authorizedStudent.name,
                action: action,
                timestamp: new Date().toISOString()
            };

            attendance.push(record);
            fs.writeFileSync(this.attendanceFile, JSON.stringify(attendance, null, 2));
            return { success: true, record, studentName: authorizedStudent.name };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Delete a specific attendance record
    deleteAttendanceRecord(recordId) {
        try {
            const attendance = this.getAttendance();
            const filteredAttendance = attendance.filter(record => record.id !== recordId);

            if (attendance.length === filteredAttendance.length) {
                return { success: false, error: 'Record not found' };
            }

            fs.writeFileSync(this.attendanceFile, JSON.stringify(filteredAttendance, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Get last action for a student
    getLastAction(ufid) {
        const attendance = this.getAttendance();
        const userRecords = attendance.filter(record => record.ufid === ufid);
        if (userRecords.length === 0) return null;

        return userRecords[userRecords.length - 1];
    }

    // Get currently signed in students
    getCurrentlySignedIn() {
        const students = this.getStudents();
        const signedInStudents = [];

        students.forEach(student => {
            const status = this.getCurrentStatus(student.ufid);
            if (status === 'signin') {
                const attendance = this.getAttendance();
                const userRecords = attendance.filter(record => record.ufid === student.ufid);
                const lastRecord = userRecords[userRecords.length - 1];

                signedInStudents.push({
                    ...student,
                    signInTime: lastRecord.timestamp
                });
            }
        });

        return signedInStudents;
    }

    // Get today's attendance records
    getTodaysAttendance() {
        const attendance = this.getAttendance();
        const today = new Date().toDateString();

        return attendance.filter(record =>
            new Date(record.timestamp).toDateString() === today
        );
    }

    // Basic stats methods
    getStats() {
        const attendance = this.getAttendance();
        const students = this.getStudents();

        const today = new Date().toDateString();
        const todayAttendance = attendance.filter(record =>
            new Date(record.timestamp).toDateString() === today
        );

        const signIns = todayAttendance.filter(r => r.action === 'signin').length;
        const signOuts = todayAttendance.filter(r => r.action === 'signout').length;

        return {
            totalStudents: students.length,
            activeStudents: students.filter(s => s.active).length,
            todaySignIns: signIns,
            todaySignOuts: signOuts,
            totalRecords: attendance.length,
            lastActivity: attendance.length > 0 ? attendance[attendance.length - 1].timestamp : null
        };
    }

    // Enhanced stats with more details
    getEnhancedStats() {
        const attendance = this.getAttendance();
        const students = this.getStudents();
        const currentlySignedIn = this.getCurrentlySignedIn();
        const todaysAttendance = this.getTodaysAttendance();

        const today = new Date().toDateString();
        const signIns = todaysAttendance.filter(r => r.action === 'signin').length;
        const signOuts = todaysAttendance.filter(r => r.action === 'signout').length;

        return {
            totalStudents: students.length,
            activeStudents: students.filter(s => s.active).length,
            currentlySignedIn: currentlySignedIn.length,
            todaySignIns: signIns,
            todaySignOuts: signOuts,
            totalRecords: attendance.length,
            todaysRecords: todaysAttendance.length,
            lastActivity: attendance.length > 0 ? attendance[attendance.length - 1].timestamp : null,
            signedInStudents: currentlySignedIn
        };
    }

    // Get attendance records by date range
    getAttendanceByDateRange(startDate, endDate) {
        const attendance = this.getAttendance();
        const start = new Date(startDate);
        const end = new Date(endDate);

        return attendance.filter(record => {
            const recordDate = new Date(record.timestamp);
            return recordDate >= start && recordDate <= end;
        });
    }

    // Get student attendance summary
    getStudentAttendanceSummary(ufid) {
        const attendance = this.getAttendance();
        const userRecords = attendance.filter(record => record.ufid === ufid);

        const signIns = userRecords.filter(r => r.action === 'signin').length;
        const signOuts = userRecords.filter(r => r.action === 'signout').length;
        const currentStatus = this.getCurrentStatus(ufid);

        return {
            totalSignIns: signIns,
            totalSignOuts: signOuts,
            currentStatus: currentStatus,
            records: userRecords
        };
    }

    // Backup data
    backupData() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupDir = path.join(this.dataDir, 'backups');

            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir);
            }

            const backupFile = path.join(backupDir, `backup-${timestamp}.json`);
            const backupData = {
                attendance: this.getAttendance(),
                students: this.getStudents(),
                config: this.getConfig(),
                backupDate: new Date().toISOString()
            };

            fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
            return { success: true, backupFile };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    // Email configuration methods
    updateEmailConfig(emailConfig) {
        try {
            const config = this.getConfig();
            config.emailSettings = {
                enabled: emailConfig.enabled || false,
                smtp: emailConfig.smtp || '',
                port: emailConfig.port || 587,
                secure: emailConfig.secure || false,
                email: emailConfig.email || '',
                password: emailConfig.password || '',
                recipientEmail: emailConfig.recipientEmail || '',
                recipientName: emailConfig.recipientName || ''
            };
            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Google Sheets configuration methods
    updateSheetsConfig(sheetsConfig) {
        try {
            const config = this.getConfig();
            config.googleSheets = {
                enabled: sheetsConfig.enabled || false,
                spreadsheetId: sheetsConfig.spreadsheetId || '',
                sheetName: sheetsConfig.sheetName || 'Attendance',
                credentialsPath: sheetsConfig.credentialsPath || ''
            };
            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Generate weekly report data
    generateWeeklyReport() {
        const endDate = new Date();
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 7);

        const weeklyAttendance = this.getAttendanceByDateRange(startDate, endDate);
        const students = this.getStudents();

        // Group by student
        const studentReports = {};
        students.forEach(student => {
            studentReports[student.ufid] = {
                name: student.name,
                email: student.email,
                signIns: 0,
                signOuts: 0,
                totalHours: 0,
                sessions: []
            };
        });

        // Process attendance records
        weeklyAttendance.forEach(record => {
            if (studentReports[record.ufid]) {
                if (record.action === 'signin') {
                    studentReports[record.ufid].signIns++;
                } else {
                    studentReports[record.ufid].signOuts++;
                }
                studentReports[record.ufid].sessions.push(record);
            }
        });

        // Calculate hours (basic calculation)
        Object.keys(studentReports).forEach(ufid => {
            const sessions = studentReports[ufid].sessions.sort((a, b) =>
                new Date(a.timestamp) - new Date(b.timestamp)
            );

            let totalMinutes = 0;
            for (let i = 0; i < sessions.length - 1; i += 2) {
                const signIn = sessions[i];
                const signOut = sessions[i + 1];

                if (signIn.action === 'signin' && signOut && signOut.action === 'signout') {
                    const duration = new Date(signOut.timestamp) - new Date(signIn.timestamp);
                    totalMinutes += duration / (1000 * 60);
                }
            }

            studentReports[ufid].totalHours = Math.round((totalMinutes / 60) * 100) / 100;
        });

        return {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            totalRecords: weeklyAttendance.length,
            studentsWithActivity: Object.values(studentReports).filter(s => s.signIns > 0).length,
            studentReports: studentReports,
            rawAttendance: weeklyAttendance
        };
    }

    // Generate CSV content for reports
    generateCSVReport(reportData) {
        const headers = ['UF ID', 'Name', 'Sign Ins', 'Sign Outs', 'Total Hours', 'Email'];
        const rows = [headers];

        Object.keys(reportData.studentReports).forEach(ufid => {
            const student = reportData.studentReports[ufid];
            if (student.signIns > 0 || student.signOuts > 0) {
                rows.push([
                    ufid,
                    student.name,
                    student.signIns,
                    student.signOuts,
                    student.totalHours,
                    student.email || ''
                ]);
            }
        });

        return rows.map(row => row.join(',')).join('\n');
    }

    // Save weekly report to file
    saveWeeklyReportToFile() {
        try {
            const reportData = this.generateWeeklyReport();
            const csvContent = this.generateCSVReport(reportData);

            const reportsDir = path.join(this.dataDir, 'reports');
            if (!fs.existsSync(reportsDir)) {
                fs.mkdirSync(reportsDir);
            }

            const fileName = `weekly-report-${new Date().toISOString().split('T')[0]}.csv`;
            const filePath = path.join(reportsDir, fileName);

            fs.writeFileSync(filePath, csvContent);

            return {
                success: true,
                filePath,
                reportData,
                csvContent
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Change admin password
    changeAdminPassword(newPassword) {
        try {
            const config = this.getConfig();
            config.adminPassword = this.hashPassword(newPassword);
            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = DataManager;