const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DataManager {
    constructor() {
        this.dataDir = path.join(__dirname, 'data');
        this.attendanceFile = path.join(this.dataDir, 'attendance.json');
        this.studentsFile = path.join(this.dataDir, 'students.json');
        this.configFile = path.join(this.dataDir, 'config.json');
        
        this.encryptionEnabled = false;
        this.encryptionPassword = null;
        
        this.initializeData();
        this.loadEncryptionSettings();
    }

    initializeData() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir);
        }

        if (!fs.existsSync(this.attendanceFile)) {
            fs.writeFileSync(this.attendanceFile, JSON.stringify([], null, 2));
        }

        if (!fs.existsSync(this.studentsFile)) {
            fs.writeFileSync(this.studentsFile, JSON.stringify([], null, 2));
        }

        if (!fs.existsSync(this.configFile)) {
            const defaultConfig = {
                adminPassword: this.hashPassword('admin123'),
                labName: 'University of Florida Lab',
                emailSettings: {
                    enabled: false,
                    smtp: '',
                    port: 587,
                    secure: false,
                    email: '',
                    password: '',
                    recipientEmail: '',
                    recipientName: ''
                },
                googleSheets: {
                    enabled: false,
                    spreadsheetId: '',
                    sheetName: 'Attendance',
                    autoSync: false
                },
                dropbox: {
                    enabled: false,
                    accessToken: '',
                    autoBackup: false,
                    autoReports: false
                },
                encryption: {
                    enabled: false,
                    algorithm: 'AES-256'
                }
            };
            fs.writeFileSync(this.configFile, JSON.stringify(defaultConfig, null, 2));
        }
    }

    loadEncryptionSettings() {
        try {
            const config = this.getConfig();
            this.encryptionEnabled = config.encryption?.enabled || false;
        } catch (error) {
            console.error('Error loading encryption settings:', error);
        }
    }

    hashPassword(password) {
        return crypto.createHash('sha256').update(password).digest('hex');
    }

    verifyAdmin(password) {
        try {
            const config = this.getConfig();
            return this.hashPassword(password) === config.adminPassword;
        } catch (error) {
            return false;
        }
    }

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

    getConfig() {
        try {
            const data = fs.readFileSync(this.configFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return {};
        }
    }

    // Encryption methods
    encrypt(data, password) {
        try {
            const algorithm = 'aes-256-cbc';
            const key = crypto.scryptSync(password, 'salt', 32);
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipher(algorithm, key);
            
            let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
            encrypted += cipher.final('hex');
            
            return { success: true, data: iv.toString('hex') + ':' + encrypted };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    decrypt(encryptedData, password) {
        try {
            const algorithm = 'aes-256-cbc';
            const key = crypto.scryptSync(password, 'salt', 32);
            const textParts = encryptedData.split(':');
            const iv = Buffer.from(textParts.shift(), 'hex');
            const encryptedText = textParts.join(':');
            const decipher = crypto.createDecipher(algorithm, key);
            
            let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            
            return { success: true, data: JSON.parse(decrypted) };
        } catch (error) {
            return { success: false, error: 'Invalid password or corrupted data' };
        }
    }

    updateEncryptionSettings(enabled, password = null) {
        try {
            const config = this.getConfig();
            config.encryption = {
                enabled: enabled,
                algorithm: 'AES-256',
                lastUpdated: new Date().toISOString()
            };
            
            if (enabled && password) {
                config.encryption.passwordHash = this.hashPassword(password);
                this.encryptionPassword = password;
            }
            
            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
            this.encryptionEnabled = enabled;
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    verifyEncryptionPassword(password) {
        try {
            const config = this.getConfig();
            if (!config.encryption?.passwordHash) {
                return false;
            }
            return this.hashPassword(password) === config.encryption.passwordHash;
        } catch (error) {
            return false;
        }
    }

    encryptSensitiveFields(data, fields = ['name', 'email']) {
        if (!this.encryptionEnabled || !this.encryptionPassword) {
            return data;
        }

        if (Array.isArray(data)) {
            return data.map(item => {
                const encrypted = { ...item };
                fields.forEach(field => {
                    if (encrypted[field]) {
                        const result = this.encrypt(encrypted[field], this.encryptionPassword);
                        if (result.success) {
                            encrypted[field] = result.data;
                            encrypted[field + '_encrypted'] = true;
                        }
                    }
                });
                return encrypted;
            });
        } else {
            const encrypted = { ...data };
            fields.forEach(field => {
                if (encrypted[field]) {
                    const result = this.encrypt(encrypted[field], this.encryptionPassword);
                    if (result.success) {
                        encrypted[field] = result.data;
                        encrypted[field + '_encrypted'] = true;
                    }
                }
            });
            return encrypted;
        }
    }

    decryptSensitiveFields(data, fields = ['name', 'email']) {
        if (!this.encryptionEnabled || !this.encryptionPassword) {
            return data;
        }

        if (Array.isArray(data)) {
            return data.map(item => {
                const decrypted = { ...item };
                fields.forEach(field => {
                    if (decrypted[field] && decrypted[field + '_encrypted']) {
                        const result = this.decrypt(decrypted[field], this.encryptionPassword);
                        if (result.success) {
                            decrypted[field] = result.data;
                            delete decrypted[field + '_encrypted'];
                        }
                    }
                });
                return decrypted;
            });
        } else {
            const decrypted = { ...data };
            fields.forEach(field => {
                if (decrypted[field] && decrypted[field + '_encrypted']) {
                    const result = this.decrypt(decrypted[field], this.encryptionPassword);
                    if (result.success) {
                        decrypted[field] = result.data;
                        delete decrypted[field + '_encrypted'];
                    }
                }
            });
            return decrypted;
        }
    }

    addStudent(ufid, name, email = '') {
        try {
            const students = this.getStudents();
            let student = {
                ufid,
                name,
                email,
                active: true,
                addedDate: new Date().toISOString()
            };
            
            const existingIndex = students.findIndex(s => s.ufid === ufid);
            if (existingIndex !== -1) {
                students[existingIndex] = student;
            } else {
                students.push(student);
            }
            
            let dataToSave = this.encryptSensitiveFields(students, ['name', 'email']);
            fs.writeFileSync(this.studentsFile, JSON.stringify(dataToSave, null, 2));
            return { success: true, student };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    getStudents() {
        try {
            const data = fs.readFileSync(this.studentsFile, 'utf8');
            let students = JSON.parse(data);
            return this.decryptSensitiveFields(students, ['name', 'email']);
        } catch (error) {
            return [];
        }
    }

    removeStudent(ufid) {
        try {
            const students = this.getStudents();
            const filteredStudents = students.filter(s => s.ufid !== ufid);
            let dataToSave = this.encryptSensitiveFields(filteredStudents, ['name', 'email']);
            fs.writeFileSync(this.studentsFile, JSON.stringify(dataToSave, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    isStudentAuthorized(ufid) {
        const students = this.getStudents();
        const student = students.find(s => s.ufid === ufid && s.active);
        return student || null;
    }

    getAttendance() {
        try {
            const data = fs.readFileSync(this.attendanceFile, 'utf8');
            let attendance = JSON.parse(data);
            return this.decryptSensitiveFields(attendance, ['name']);
        } catch (error) {
            return [];
        }
    }

    getCurrentStatus(ufid) {
        const attendance = this.getAttendance();
        const userRecords = attendance.filter(record => record.ufid === ufid);
        
        if (userRecords.length === 0) {
            return 'never_signed_in';
        }
        
        const lastRecord = userRecords[userRecords.length - 1];
        return lastRecord.action;
    }

    addAttendanceWithValidation(ufid, name, action) {
        try {
            const authorizedStudent = this.isStudentAuthorized(ufid);
            if (!authorizedStudent) {
                return { 
                    success: false, 
                    error: 'Student not authorized. Please contact admin to be added to the system.',
                    unauthorized: true
                };
            }

            const currentStatus = this.getCurrentStatus(ufid);
            
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

            const attendance = this.getAttendance();
            const record = {
                id: Date.now(),
                ufid: ufid,
                name: authorizedStudent.name,
                action: action,
                timestamp: new Date().toISOString()
            };
            
            attendance.push(record);
            let dataToSave = this.encryptSensitiveFields(attendance, ['name']);
            fs.writeFileSync(this.attendanceFile, JSON.stringify(dataToSave, null, 2));
            return { success: true, record, studentName: authorizedStudent.name };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    deleteAttendanceRecord(recordId) {
        try {
            const attendance = this.getAttendance();
            const filteredAttendance = attendance.filter(record => record.id !== recordId);
            
            if (attendance.length === filteredAttendance.length) {
                return { success: false, error: 'Record not found' };
            }
            
            let dataToSave = this.encryptSensitiveFields(filteredAttendance, ['name']);
            fs.writeFileSync(this.attendanceFile, JSON.stringify(dataToSave, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

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

    getTodaysAttendance() {
        const attendance = this.getAttendance();
        const today = new Date().toDateString();
        
        return attendance.filter(record => 
            new Date(record.timestamp).toDateString() === today
        );
    }

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

    getEnhancedStats() {
        const attendance = this.getAttendance();
        const students = this.getStudents();
        const currentlySignedIn = this.getCurrentlySignedIn();
        const todaysAttendance = this.getTodaysAttendance();
        
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

    getAttendanceByDateRange(startDate, endDate) {
        const attendance = this.getAttendance();
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        return attendance.filter(record => {
            const recordDate = new Date(record.timestamp);
            return recordDate >= start && recordDate <= end;
        });
    }

    generateWeeklyReport() {
        const endDate = new Date();
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 7);

        const weeklyAttendance = this.getAttendanceByDateRange(startDate, endDate);
        const students = this.getStudents();
        
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

    updateSheetsConfig(sheetsConfig) {
        try {
            const config = this.getConfig();
            config.googleSheets = {
                enabled: sheetsConfig.enabled || false,
                spreadsheetId: sheetsConfig.spreadsheetId || '',
                sheetName: sheetsConfig.sheetName || 'Attendance',
                autoSync: sheetsConfig.autoSync || false
            };
            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    updateDropboxConfig(dropboxConfig) {
        try {
            const config = this.getConfig();
            config.dropbox = {
                enabled: dropboxConfig.enabled || false,
                accessToken: dropboxConfig.accessToken || '',
                autoBackup: dropboxConfig.autoBackup || false,
                autoReports: dropboxConfig.autoReports || false
            };
            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    backupData() {
        try {
            const backupData = {
                attendance: this.getAttendance(),
                students: this.getStudents(),
                config: this.getConfig(),
                backupDate: new Date().toISOString()
            };
            
            const backupDir = path.join(this.dataDir, 'backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir);
            }
            
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(backupDir, `backup-${timestamp}.json`);
            
            fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
            return { success: true, backupFile };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    createEncryptedBackup(password) {
        try {
            const backupData = {
                attendance: this.getAttendance(),
                students: this.getStudents(),
                config: this.getConfig(),
                backupDate: new Date().toISOString(),
                encrypted: true
            };
            
            const encrypted = this.encrypt(backupData, password);
            if (!encrypted.success) {
                return encrypted;
            }
            
            const backupDir = path.join(this.dataDir, 'backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir);
            }
            
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(backupDir, `encrypted-backup-${timestamp}.enc`);
            
            fs.writeFileSync(backupFile, encrypted.data);
            
            return { success: true, backupFile, encrypted: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = DataManager;