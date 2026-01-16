const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Logger = require('./logger.js');


let electronApp = null;
try {
    // This require will work only in Electron's main process.
    const { app } = require('electron');
    electronApp = app;
} catch (_) {
    // Not running inside Electron main (e.g., jest or a plain node script)
}

function resolveDataDir() {
    // Packaged app: use OS-specific userData folder
    if (electronApp && electronApp.isPackaged) {
        return path.join(electronApp.getPath('userData'), 'data');
    }
    // Dev run under Electron: still okay to use userData (keeps dev data out of repo)
    if (electronApp) {
        return path.join(electronApp.getPath('userData'), 'data');
    }
    // Fallback (tests / node): use project-local data folder
    return path.join(process.cwd(), 'data');
}

function ymdLocal(dt) {
    const d = new Date(dt);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addOneDay(d) {
    const x = new Date(d);
    x.setDate(x.getDate() + 1);
    return x;
}
function computeTotalHoursFromEvents(dayEvents) {
    // dayEvents: [{action:'signin'|'signout', timestamp:...}, ...] ONLY for that day and that student
    const events = [...dayEvents].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let totalMs = 0;
    let openIn = null;

    for (const e of events) {
        const t = new Date(e.timestamp);
        if (Number.isNaN(t.getTime())) continue;

        if (e.action === 'signin') {
            // take the first signin if none open; ignore repeated signins
            if (!openIn) openIn = t;
        } else if (e.action === 'signout') {
            if (openIn && t > openIn) {
                totalMs += (t - openIn);
            }
            openIn = null;
        }
    }

    return totalMs / (1000 * 60 * 60);
}


// Count days where there was >0 work time.
// If a session crosses midnight, it counts both days (usually correct).
function computeDaysAttendedFromPairs(records) {
    const days = new Set();

    const sessions = [...records].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    for (let i = 0; i < sessions.length; i++) {
        const r = sessions[i];
        if (r.action !== 'signin') continue;

        // find the next signout after this signin
        let j = i + 1;
        while (j < sessions.length && sessions[j].action !== 'signout') j++;
        if (j >= sessions.length) continue;

        const start = new Date(r.timestamp);
        const end = new Date(sessions[j].timestamp);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        if (end <= start) continue;

        // add each calendar day covered by the session
        let cur = new Date(start);
        cur.setHours(0, 0, 0, 0);

        const endDay = new Date(end);
        endDay.setHours(0, 0, 0, 0);

        while (cur <= endDay) {
            days.add(ymdLocal(cur));
            cur = addOneDay(cur);
            cur.setHours(0, 0, 0, 0);
        }

        i = j; // skip forward to the signout we used
    }

    return days.size;
}


class DataManager {
    constructor() {
        // const baseDataDir = app?.getPath('userData') || path.join(__dirname, 'data');
        this.dataDir = resolveDataDir();
        // this.dataDir = path.join(baseDataDir, 'data');
        this.attendanceFile = path.join(this.dataDir, 'attendance.json');
        this.studentsFile = path.join(this.dataDir, 'students.json');
        this.configFile = path.join(this.dataDir, 'config.json');
        this.encryptionEnabled = false;
        this.encryptionPassword = null;

        // Initialize data directory and files first
        this.initializeData();
        this.loadEncryptionSettings();

        // Initialize logger after data directory exists
        this.logger = new Logger(this);

        // Log initialization
        this.logger.info('system', 'DataManager initialized successfully', 'system');
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
                    enabled: true,
                    smtp: '',
                    port: 587,
                    secure: false,
                    email: '',
                    password: '',
                    recipientEmail: '',
                    recipientName: ''
                },
                googleSheets: {
                    enabled: true,
                    spreadsheetId: '',
                    // NEW per-tab fields (match the rest of your app)
                    attendanceSheet: 'Attendance',
                    studentsSheet: 'Students',
                    autoSync: false
                },
                dropbox: {
                    enabled: false,

                    // NEW OAuth fields
                    appKey: '',
                    appSecret: '',
                    refreshToken: '',

                    // Legacy (keep for backward-compat)
                    accessToken: '',

                    autoBackup: false,
                    autoReports: false,
                    masterMode: true,
                    syncIntervalMinutes: 10
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

            if (this.logger) {
                this.logger.info('encryption', `Encryption settings loaded: ${this.encryptionEnabled ? 'enabled' : 'disabled'}`, 'system');
            }
        } catch (error) {
            console.error('Error loading encryption settings:', error);
            if (this.logger) {
                this.logger.error('encryption', `Error loading encryption settings: ${error.message}`, 'system');
            }
        }
    }
    normalizeConfigShape(cfg) {
        cfg = cfg || {};
        cfg.dropbox = cfg.dropbox || {};
        cfg.googleSheets = cfg.googleSheets || {};

        // Dropbox defaults (your existing code)…
        if (typeof cfg.dropbox.enabled !== 'boolean') cfg.dropbox.enabled = false;
        if (typeof cfg.dropbox.autoBackup !== 'boolean') cfg.dropbox.autoBackup = false;
        if (typeof cfg.dropbox.autoReports !== 'boolean') cfg.dropbox.autoReports = false;
        if (typeof cfg.dropbox.appKey !== 'string') cfg.dropbox.appKey = '';
        if (typeof cfg.dropbox.appSecret !== 'string') cfg.dropbox.appSecret = '';
        if (typeof cfg.dropbox.refreshToken !== 'string') cfg.dropbox.refreshToken = '';
        if (typeof cfg.dropbox.accessToken !== 'string') cfg.dropbox.accessToken = '';

        // Prefer new sheetName; fall back to legacy attendanceSheet
        if (!cfg.googleSheets.sheetName && cfg.googleSheets.attendanceSheet) {
            cfg.googleSheets.sheetName = cfg.googleSheets.attendanceSheet;
        }
        // If you plan to use a separate roster tab later, keep studentsSheet as-is;
        // otherwise it's harmless to leave it unused.

        // Defaults
        if (typeof cfg.googleSheets.enabled !== 'boolean') cfg.googleSheets.enabled = false;
        if (typeof cfg.googleSheets.autoSync !== 'boolean') cfg.googleSheets.autoSync = false;
        if (typeof cfg.googleSheets.spreadsheetId !== 'string') cfg.googleSheets.spreadsheetId = '';
        if (typeof cfg.googleSheets.sheetName !== 'string') cfg.googleSheets.sheetName = 'Attendance';

        return cfg;
    }




    hashPassword(password) {
        return crypto.createHash('sha256').update(password).digest('hex');
    }

    verifyAdmin(password) {
        try {
            if (this.logger) {
                this.logger.info('auth', 'Admin password verification attempt', 'system');
            }

            const config = this.getConfig();
            const storedHash = config.adminPassword;

            if (!storedHash) {
                if (this.logger) {
                    this.logger.warning('auth', 'No admin password set, using default', 'system');
                }
                return this.hashPassword(password) === this.hashPassword('admin123');
            }

            const inputHash = this.hashPassword(password);
            const isValid = inputHash === storedHash;

            // console.log('Password verification:', {
            //     inputHash: inputHash.substring(0, 10) + '...',
            //     storedHash: storedHash.substring(0, 10) + '...',
            //     isValid
            // });

            if (this.logger) {
                if (isValid) {
                    this.logger.info('auth', 'Admin password verification successful', 'admin');
                } else {
                    this.logger.warning('auth', 'Admin password verification failed', 'system');
                }
            }

            return isValid;
        } catch (error) {
            console.error('Error verifying admin password:', error);
            if (this.logger) {
                this.logger.error('auth', `Admin password verification error: ${error.message}`, 'system');
            }
            return false;
        }
    }

    changeAdminPassword(newPassword) {
        try {
            if (this.logger) {
                this.logger.info('admin', 'Admin password change initiated', 'admin');
            }

            const config = this.getConfig();
            config.adminPassword = this.hashPassword(newPassword);
            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));

            if (this.logger) {
                this.logger.info('admin', 'Admin password changed successfully', 'admin');
            }

            return { success: true };
        } catch (error) {
            if (this.logger) {
                this.logger.error('admin', `Admin password change failed: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }

    getConfig() {
        try {
            const data = fs.readFileSync(this.configFile, 'utf8');
            const cfg = JSON.parse(data);
            return this.normalizeConfigShape(cfg);  // ensure shape on read
        } catch (error) {
            if (this.logger) {
                this.logger.error('config', `Error reading config: ${error.message}`, 'system');
            }
            return this.normalizeConfigShape({});   // always return normalized shape
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

            if (this.logger) {
                this.logger.info('encryption', 'Data encrypted successfully', 'system');
            }

            return { success: true, data: iv.toString('hex') + ':' + encrypted };
        } catch (error) {
            if (this.logger) {
                this.logger.error('encryption', `Encryption failed: ${error.message}`, 'system');
            }
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

            if (this.logger) {
                this.logger.info('encryption', 'Data decrypted successfully', 'system');
            }

            return { success: true, data: JSON.parse(decrypted) };
        } catch (error) {
            if (this.logger) {
                this.logger.error('encryption', 'Decryption failed - invalid password or corrupted data', 'system');
            }
            return { success: false, error: 'Invalid password or corrupted data' };
        }
    }

    updateEncryptionSettings(enabled, password = null) {
        try {
            if (this.logger) {
                this.logger.info('encryption', `Updating encryption settings: ${enabled ? 'enabling' : 'disabling'}`, 'admin');
            }

            const config = this.getConfig();
            config.encryption = {
                enabled: enabled,
                algorithm: 'AES-256',
                lastUpdated: new Date().toISOString()
            };

            if (enabled && password) {
                config.encryption.passwordHash = this.hashPassword(password);
                this.encryptionPassword = password;
                if (this.logger) {
                    this.logger.info('encryption', 'Encryption password set and stored', 'admin');
                }
            }

            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
            this.encryptionEnabled = enabled;

            if (this.logger) {
                this.logger.info('encryption', `Encryption settings updated successfully: ${enabled ? 'enabled' : 'disabled'}`, 'admin');
            }

            return { success: true };
        } catch (error) {
            if (this.logger) {
                this.logger.error('encryption', `Encryption settings update failed: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }

    verifyEncryptionPassword(password) {
        try {
            const config = this.getConfig();
            if (!config.encryption?.passwordHash) {
                if (this.logger) {
                    this.logger.warning('encryption', 'No encryption password set for verification', 'admin');
                }
                return false;
            }

            const isValid = this.hashPassword(password) === config.encryption.passwordHash;

            if (this.logger) {
                if (isValid) {
                    this.logger.info('encryption', 'Encryption password verification successful', 'admin');
                } else {
                    this.logger.warning('encryption', 'Encryption password verification failed', 'admin');
                }
            }

            return isValid;
        } catch (error) {
            if (this.logger) {
                this.logger.error('encryption', `Encryption password verification error: ${error.message}`, 'admin');
            }
            return false;
        }
    }

    encryptSensitiveFields(data, fields = ['name', 'email']) {
        if (!this.encryptionEnabled || !this.encryptionPassword) {
            return data;
        }

        try {
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
        } catch (error) {
            if (this.logger) {
                this.logger.error('encryption', `Field encryption error: ${error.message}`, 'system');
            }
            return data;
        }
    }

    decryptSensitiveFields(data, fields = ['name', 'email']) {
        if (!this.encryptionEnabled || !this.encryptionPassword) {
            return data;
        }

        try {
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
        } catch (error) {
            if (this.logger) {
                this.logger.error('encryption', `Field decryption error: ${error.message}`, 'system');
            }
            return data;
        }
    }

    addStudent(ufid, name, email = '', meta = {}) {
        try {
            if (this.logger) {
                this.logger.info('student', `Adding student: ${name} (${ufid})`, 'admin');
            }

            const students = this.getStudents();
            let student = {
                ufid,
                name,
                email,
                active: true,
                addedDate: new Date().toISOString(),

                // NEW
                role: meta.role || 'volunteer',
                expectedHoursPerWeek: Number(meta.expectedHoursPerWeek ?? 0),
                expectedDaysPerWeek: Number(meta.expectedDaysPerWeek ?? 0),
            };

            const existingIndex = students.findIndex(s => s.ufid === ufid);
            if (existingIndex !== -1) {
                if (this.logger) {
                    this.logger.info('student', `Updating existing student: ${name} (${ufid})`, 'admin');
                }
                students[existingIndex] = student;
            } else {
                students.push(student);
            }

            let dataToSave = this.encryptSensitiveFields(students, ['name', 'email']);
            fs.writeFileSync(this.studentsFile, JSON.stringify(dataToSave, null, 2));

            if (this.logger) {
                this.logger.info('student', `Student ${existingIndex !== -1 ? 'updated' : 'added'} successfully: ${name} (${ufid})`, 'admin');
            }

            return { success: true, student };
        } catch (error) {
            if (this.logger) {
                this.logger.error('student', `Error adding student ${ufid}: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }

    getStudents() {
        try {
            if (!fs.existsSync(this.studentsFile)) return [];

            const encrypted = JSON.parse(fs.readFileSync(this.studentsFile, 'utf8'));
            const students = this.decryptSensitiveFields(encrypted, ['name', 'email']);

            // Normalize old records (backwards compatible)
            return students.map(s => ({
                ...s,
                role: (s.role || 'volunteer').toLowerCase(),
                expectedHoursPerWeek: Number(s.expectedHoursPerWeek ?? 0),
                expectedDaysPerWeek: Number(s.expectedDaysPerWeek ?? 0),
            }));
        } catch (error) {
            console.error('Error loading students:', error);
            return [];
        }
    }


    updateStudent(ufid, updates = {}) {
        try {
            const students = this.getStudents();
            const idx = students.findIndex(s => s.ufid === ufid);
            if (idx === -1) return { success: false, error: 'Student not found' };

            const prev = students[idx];

            students[idx] = {
                ...prev,
                name: updates.name ?? prev.name,
                email: updates.email ?? prev.email,
                active: (typeof updates.active === 'boolean') ? updates.active : prev.active,

                role: (updates.role ?? prev.role ?? 'volunteer').toLowerCase(),
                expectedHoursPerWeek: Number(updates.expectedHoursPerWeek ?? prev.expectedHoursPerWeek ?? 0),
                expectedDaysPerWeek: Number(updates.expectedDaysPerWeek ?? prev.expectedDaysPerWeek ?? 0),
            };

            const dataToSave = this.encryptSensitiveFields(students, ['name', 'email']);
            fs.writeFileSync(this.studentsFile, JSON.stringify(dataToSave, null, 2));

            return { success: true, student: students[idx] };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }


    removeStudent(ufid) {
        try {
            if (this.logger) {
                this.logger.info('student', `Removing student with UFID: ${ufid}`, 'admin');
            }

            const students = this.getStudents();
            const studentToRemove = students.find(s => s.ufid === ufid);
            const filteredStudents = students.filter(s => s.ufid !== ufid);

            if (students.length === filteredStudents.length) {
                if (this.logger) {
                    this.logger.warning('student', `Student not found for removal: ${ufid}`, 'admin');
                }
                return { success: false, error: 'Student not found' };
            }

            let dataToSave = this.encryptSensitiveFields(filteredStudents, ['name', 'email']);
            fs.writeFileSync(this.studentsFile, JSON.stringify(dataToSave, null, 2));

            if (this.logger) {
                this.logger.info('student', `Student removed successfully: ${studentToRemove?.name || 'Unknown'} (${ufid})`, 'admin');
            }

            return { success: true };
        } catch (error) {
            if (this.logger) {
                this.logger.error('student', `Error removing student ${ufid}: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }

    isStudentAuthorized(ufid) {
        try {
            const students = this.getStudents();
            const student = students.find(s => s.ufid === ufid && s.active);

            if (this.logger) {
                if (student) {
                    this.logger.info('auth', `Student authorization check passed: ${student.name} (${ufid})`, 'system');
                } else {
                    this.logger.warning('auth', `Student authorization check failed: ${ufid}`, 'system');
                }
            }

            return student || null;
        } catch (error) {
            if (this.logger) {
                this.logger.error('auth', `Error checking student authorization for ${ufid}: ${error.message}`, 'system');
            }
            return null;
        }
    }

    getAttendance() {
        try {
            const data = fs.readFileSync(this.attendanceFile, 'utf8');
            let attendance = JSON.parse(data);
            const decryptedAttendance = this.decryptSensitiveFields(attendance, ['name']);

            if (this.logger) {
                this.logger.info('attendance', `Retrieved ${decryptedAttendance.length} attendance records`, 'system');
            }

            return decryptedAttendance;
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `Error retrieving attendance: ${error.message}`, 'system');
            }
            return [];
        }
    }

    getCurrentStatus(ufid) {
        try {
            const attendance = this.getAttendance();
            const userRecords = attendance.filter(record => record.ufid === ufid);

            if (userRecords.length === 0) {
                if (this.logger) {
                    this.logger.info('attendance', `No attendance records found for UFID: ${ufid}`, 'system');
                }
                return 'never_signed_in';
            }

            const lastRecord = userRecords[userRecords.length - 1];

            if (this.logger) {
                this.logger.info('attendance', `Current status for ${ufid}: ${lastRecord.action}`, 'system');
            }

            return lastRecord.action;
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `Error getting current status for ${ufid}: ${error.message}`, 'system');
            }
            return 'never_signed_in';
        }
    }

    addAttendanceWithValidation(ufid, name, action) {
        try {
            if (this.logger) {
                this.logger.info('attendance', `Processing ${action} for UFID: ${ufid}`, 'system');
            }

            const authorizedStudent = this.isStudentAuthorized(ufid);
            if (!authorizedStudent) {
                if (this.logger) {
                    this.logger.warning('attendance', `Unauthorized ${action} attempt for UFID: ${ufid}`, 'system');
                }
                return {
                    success: false,
                    error: 'Student not authorized. Please contact admin to be added to the system.',
                    unauthorized: true
                };
            }

            const currentStatus = this.getCurrentStatus(ufid);

            if (action === 'signin') {
                if (currentStatus === 'signin') {
                    if (this.logger) {
                        this.logger.warning('attendance', `Duplicate sign-in attempt for ${authorizedStudent.name} (${ufid})`, 'system');
                    }
                    return {
                        success: false,
                        error: `${authorizedStudent.name} is already signed in. Please sign out first.`,
                        duplicate: true
                    };
                }
            } else if (action === 'signout') {
                if (currentStatus === 'signout') {
                    if (this.logger) {
                        this.logger.warning('attendance', `Duplicate sign-out attempt for ${authorizedStudent.name} (${ufid})`, 'system');
                    }
                    return {
                        success: false,
                        error: `${authorizedStudent.name} is already signed out. Please sign in first.`,
                        duplicate: true
                    };
                } else if (currentStatus === 'never_signed_in') {
                    if (this.logger) {
                        this.logger.warning('attendance', `Sign-out attempt without sign-in for ${authorizedStudent.name} (${ufid})`, 'system');
                    }
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

            if (this.logger) {
                this.logger.info('attendance', `${action} successful for ${authorizedStudent.name} (${ufid})`, 'system');
            }

            return { success: true, record, studentName: authorizedStudent.name };
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `${action} error for ${ufid}: ${error.message}`, 'system');
            }
            return { success: false, error: error.message };
        }
    }

    deleteAttendanceRecord(recordId) {
        try {
            if (this.logger) {
                this.logger.info('attendance', `Deleting attendance record: ${recordId}`, 'admin');
            }

            const attendance = this.getAttendance();
            const recordToDelete = attendance.find(record => record.id === recordId);
            const filteredAttendance = attendance.filter(record => record.id !== recordId);

            if (attendance.length === filteredAttendance.length) {
                if (this.logger) {
                    this.logger.warning('attendance', `Attendance record not found for deletion: ${recordId}`, 'admin');
                }
                return { success: false, error: 'Record not found' };
            }

            let dataToSave = this.encryptSensitiveFields(filteredAttendance, ['name']);
            fs.writeFileSync(this.attendanceFile, JSON.stringify(dataToSave, null, 2));

            if (this.logger) {
                const studentInfo = recordToDelete ? `${recordToDelete.name} (${recordToDelete.ufid})` : 'Unknown student';
                this.logger.info('attendance', `Attendance record deleted: ${studentInfo} - ${recordToDelete?.action} at ${recordToDelete?.timestamp}`, 'admin');
            }

            return { success: true };
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `Error deleting attendance record ${recordId}: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * Update an attendance record by its pendingRecordId
     * Used when a pending signout is resolved to update the temporary record
     * @param {string} pendingRecordId - The pending record ID to find
     * @param {Object} updates - The fields to update (e.g., timestamp)
     * @returns {Object} - { success, record?, error? }
     */
    updateAttendanceByPendingId(pendingRecordId, updates) {
        try {
            const attendance = this.getAttendance();
            const idx = attendance.findIndex(r => r.pendingRecordId === pendingRecordId);

            if (idx === -1) {
                if (this.logger) {
                    this.logger.warning('attendance', `No attendance record found with pendingRecordId: ${pendingRecordId}`, 'system');
                }
                return { success: false, error: 'Record not found' };
            }

            const oldRecord = attendance[idx];
            attendance[idx] = {
                ...oldRecord,
                ...updates,
                pendingTimestamp: false, // Clear the pending flag
                resolvedAt: new Date().toISOString()
            };

            const dataToSave = this.encryptSensitiveFields(attendance, ['name']);
            fs.writeFileSync(this.attendanceFile, JSON.stringify(dataToSave, null, 2));

            if (this.logger) {
                this.logger.info('attendance',
                    `Updated pending attendance record for ${oldRecord.name}: ${oldRecord.timestamp} -> ${attendance[idx].timestamp}`, 'system');
            }

            return { success: true, record: attendance[idx] };
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `Error updating attendance by pendingId: ${error.message}`, 'system');
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * Find a signout record that matches a signin for a given UFID
     * @param {string} ufid - Student UFID
     * @param {string} signInTimestamp - The signin timestamp to match
     * @returns {Object|null} - The signout record or null if not found
     */
    findSignoutForSignin(ufid, signInTimestamp) {
        try {
            const attendance = this.getAttendance();
            const signInDate = new Date(signInTimestamp).toDateString();

            // Find signout records for this UFID on the same day as the signin
            const signouts = attendance.filter(r =>
                r.ufid === ufid &&
                r.action === 'signout' &&
                new Date(r.timestamp).toDateString() === signInDate
            );

            // Return the first matching signout (there should typically be one)
            return signouts.length > 0 ? signouts[0] : null;
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `Error finding signout for signin: ${error.message}`, 'system');
            }
            return null;
        }
    }

    /**
     * Add a new attendance record directly (used by pending signout service)
     * @param {Object} record - The attendance record to add
     * @returns {Object} - { success, record?, error? }
     */
    addAttendanceRecord(record) {
        try {
            const attendance = this.getAttendance();
            attendance.push(record);
            const dataToSave = this.encryptSensitiveFields(attendance, ['name']);
            fs.writeFileSync(this.attendanceFile, JSON.stringify(dataToSave, null, 2));

            if (this.logger) {
                this.logger.info('attendance',
                    `Added attendance record: ${record.name || record.ufid} - ${record.action} at ${record.timestamp}`, 'system');
            }

            return { success: true, record };
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `Error adding attendance record: ${error.message}`, 'system');
            }
            return { success: false, error: error.message };
        }
    }

    getCurrentlySignedIn() {
        try {
            if (this.logger) {
                this.logger.info('attendance', 'Retrieving currently signed-in students', 'system');
            }

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

            if (this.logger) {
                this.logger.info('attendance', `Found ${signedInStudents.length} currently signed-in students`, 'system');
            }

            return signedInStudents;
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `Error getting currently signed-in students: ${error.message}`, 'system');
            }
            return [];
        }
    }

    getTodaysAttendance() {
        try {
            const attendance = this.getAttendance();
            const today = new Date().toDateString();
            const todaysAttendance = attendance.filter(record =>
                new Date(record.timestamp).toDateString() === today
            );

            if (this.logger) {
                this.logger.info('attendance', `Retrieved ${todaysAttendance.length} attendance records for today`, 'system');
            }

            return todaysAttendance;
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `Error getting today's attendance: ${error.message}`, 'system');
            }
            return [];
        }
    }

    getAttendanceForDate(dateLike) {
        const target = new Date(dateLike);
        const dayStart = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0, 0);
        const dayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59, 999);

        return this.getAttendance().filter(r => {
            const t = new Date(r.timestamp);
            return t >= dayStart && t <= dayEnd;
        });
    }

    getAttendanceForDate(dateLike) {
        const target = new Date(dateLike);
        const dayStart = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0, 0);
        const dayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59, 999);
        return this.getAttendance().filter(r => {
            const t = new Date(r.timestamp);
            return t >= dayStart && t <= dayEnd;
        });
    }

    /**
     * Get students who have open sessions (signed in but not signed out) for a given date.
     * Used by the pending sign-out feature to identify students who need reminder emails.
     * @param {string|Date} dateLike - The date to check
     * @returns {Array} - Array of sign-in records that don't have matching sign-outs
     */
    getOpenSessionsForDate(dateLike) {
        const records = this.getAttendanceForDate(dateLike);
        const byStudent = new Map();

        // Group by student
        for (const r of records) {
            if (!byStudent.has(r.ufid)) {
                byStudent.set(r.ufid, []);
            }
            byStudent.get(r.ufid).push(r);
        }

        const openSessions = [];

        for (const [ufid, events] of byStudent) {
            // Sort by timestamp, with signin before signout for same timestamp
            events.sort((a, b) => {
                const timeDiff = new Date(a.timestamp) - new Date(b.timestamp);
                if (timeDiff !== 0) return timeDiff;
                // Same timestamp: signin comes before signout
                if (a.action === 'signin' && b.action === 'signout') return -1;
                if (a.action === 'signout' && b.action === 'signin') return 1;
                return 0;
            });

            // Find the last sign-in without a matching sign-out
            let lastSignIn = null;
            for (const e of events) {
                if (e.action === 'signin') {
                    lastSignIn = e;
                } else if (e.action === 'signout') {
                    lastSignIn = null; // Session closed
                }
            }

            if (lastSignIn) {
                openSessions.push(lastSignIn);
            }
        }

        return openSessions;
    }

    /**
     * Hybrid policy:
     * - If a student never logs out -> treat sign-out as 5:00 PM for the *daily summary* (no record is written)
     * - If they do log out after 5 PM -> respect their actual sign-out (no cap)
     * Pass options.closeOpenAtHour = 17 to cap, or options.autoWriteSignOutAtHour = 17 to also persist a synthetic row.
     */
    computeDailySummary(dateLike, options = {}) {
        const {
            closeOpenAtHour = 17,
            autoWriteSignOutAtHour = null,
            // NEW: hybrid policy options (optional)
            autoPolicy = null // { cutoffHour: 17, eodHour: 23, eodMinute: 59, after5Minutes: 60 }
        } = options;

        const records = this.getAttendanceForDate(dateLike)
            .slice()
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        const students = this.getStudents();
        const nameOf = (ufid) => (students.find(s => s.ufid === ufid)?.name || 'Unknown');

        // bucket per student
        const byStudent = new Map();
        for (const r of records) {
            if (!byStudent.has(r.ufid)) {
                byStudent.set(r.ufid, { ufid: r.ufid, name: nameOf(r.ufid), events: [] });
            }
            byStudent.get(r.ufid).events.push(r);
        }

        // mk cutoff ISO for this calendar day
        const day = new Date(dateLike);
        const cutoffISO = (h, m = 0) =>
            new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).toISOString();


        const summaries = [];

        for (const [, entry] of byStudent) {
            const evs = entry.events;
            const sessions = [];
            let open = null;

            // pair ALL sessions in order
            for (const ev of evs) {
                if (ev.action === 'signin') {
                    // if double signin without signout in between, keep latest as the start
                    open = ev;
                } else if (ev.action === 'signout') {
                    if (open) {
                        sessions.push({ in: open.timestamp, out: ev.timestamp, closed: true });
                        open = null;
                    }
                }
            }

            let autoclosed = false;

            // handle one remaining open session (no signout that day)
            // in the block that handles a remaining open session:
            if (open) {
                // --- NEW HYBRID BEHAVIOR ---
                if (autoPolicy) {
                    const cutoff = new Date(cutoffISO(autoPolicy.cutoffHour ?? 17, 0)); // 5:00 PM default
                    const eod = new Date(cutoffISO(autoPolicy.eodHour ?? 23, autoPolicy.eodMinute ?? 59)); // 11:59 PM default
                    const openedAt = new Date(open.timestamp);

                    let effectiveOut;
                    if (openedAt < cutoff) {
                        // signed in before 5 PM -> synthetic out at 5 PM
                        effectiveOut = cutoff;
                    } else {
                        // signed in at/after 5 PM -> synthetic out at min(open + after5Minutes, eod)
                        const afterMins = (autoPolicy.after5Minutes ?? 60);
                        const plusOneHour = new Date(openedAt.getTime() + afterMins * 60000);
                        effectiveOut = plusOneHour < eod ? plusOneHour : eod;
                    }

                    const syntheticOut = {
                        id: Date.now() + Math.floor(Math.random() * 1000),
                        ufid: entry.ufid,
                        name: entry.name,
                        action: 'signout',
                        timestamp: effectiveOut.toISOString(),
                        synthetic: true
                    };

                    const all = this.getAttendance();
                    all.push(syntheticOut);
                    const dataToSave = this.encryptSensitiveFields(all, ['name']);
                    fs.writeFileSync(this.attendanceFile, JSON.stringify(dataToSave, null, 2));

                    sessions.push({ in: open.timestamp, out: syntheticOut.timestamp, closed: true, syntheticOut: true });
                    autoclosed = true;

                } else if (autoWriteSignOutAtHour != null) {
                    // existing behavior (single cutoff hour)
                    const cutoff = new Date(cutoffISO(autoWriteSignOutAtHour));
                    const openedAt = new Date(open.timestamp);
                    const effectiveOut = (openedAt > cutoff ? openedAt : cutoff).toISOString(); // small safety

                    const syntheticOut = {
                        id: Date.now() + Math.floor(Math.random() * 1000),
                        ufid: entry.ufid,
                        name: entry.name,
                        action: 'signout',
                        timestamp: effectiveOut,
                        synthetic: true
                    };
                    const all = this.getAttendance();
                    all.push(syntheticOut);
                    const dataToSave = this.encryptSensitiveFields(all, ['name']);
                    fs.writeFileSync(this.attendanceFile, JSON.stringify(dataToSave, null, 2));

                    sessions.push({ in: open.timestamp, out: syntheticOut.timestamp, closed: true, syntheticOut: true });
                    autoclosed = true;

                } else if (closeOpenAtHour != null) {
                    // existing cap-only mode (no write)
                    const cutoff = new Date(cutoffISO(closeOpenAtHour));
                    const openedAt = new Date(open.timestamp);
                    const effectiveOut = (openedAt > cutoff ? openedAt : cutoff).toISOString();

                    sessions.push({ in: open.timestamp, out: effectiveOut, closed: false, cappedAtHour: closeOpenAtHour });
                } else {
                    sessions.push({ in: open.timestamp, out: null, closed: false });
                }
            }


            // sum minutes across ALL sessions for the day
            let totalMin = 0;
            for (const s of sessions) {
                if (s.in && s.out) {
                    totalMin += (new Date(s.out) - new Date(s.in)) / 60000;
                }
            }

            const totalHours = Math.round((totalMin / 60) * 100) / 100;

            summaries.push({
                ufid: entry.ufid,
                name: entry.name,
                sessions,
                totalMinutes: Math.round(totalMin),
                totalHours,
                autoclosed,
                absent: totalMin === 0 // mark absent if no minutes today
            });
        }

        // include zero-activity students
        for (const s of students) {
            if (!summaries.find(x => x.ufid === s.ufid)) {
                summaries.push({
                    ufid: s.ufid,
                    name: s.name,
                    sessions: [],
                    totalMinutes: 0,
                    totalHours: 0,
                    autoclosed: false,
                    absent: true
                });
            }
        }

        summaries.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const dateOnly = new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString();

        return { date: dateOnly, summaries };
    }

    computeHoursWorkedToday(dateLike) {
        // let options;
        // const {
        //     // Optional: useful for tests or "as of" reporting
        const now = new Date();
        // Optional: clamp totals so you don't count beyond a certain hour on that day
        const closeOpenAtHour = null;
        // } = options;

        const records = this.getAttendanceForDate(dateLike)
            .slice()
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        const students = this.getStudents();
        const nameOf = (ufid) => (students.find(s => s.ufid === ufid)?.name || 'Unknown');

        // Bucket events by student
        const byStudent = new Map();
        for (const r of records) {
            if (!byStudent.has(r.ufid)) {
                byStudent.set(r.ufid, { ufid: r.ufid, name: nameOf(r.ufid), events: [] });
            }
            byStudent.get(r.ufid).events.push(r);
        }

        // Day boundaries/cutoffs (same day as dateLike)
        const day = new Date(dateLike);
        const startOfDay = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
        const endOfDay = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);

        const cutoffAtHour = (h) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0, 0);

        // "Now" should not exceed end of the target day
        let effectiveNow = new Date(now);
        if (effectiveNow > endOfDay) effectiveNow = endOfDay;
        if (effectiveNow < startOfDay) effectiveNow = startOfDay;

        // Optional clamp for open sessions (and only open sessions) — e.g., cap at 17:00
        const openSessionCap = (closeOpenAtHour != null) ? cutoffAtHour(closeOpenAtHour) : null;

        const summaries = [];

        for (const [, entry] of byStudent) {
            const evs = entry.events;

            const sessions = [];
            let open = null;

            // Pair sessions in order (same as your daily summary logic)
            for (const ev of evs) {
                if (ev.action === 'signin') {
                    // double signin replaces open start
                    open = ev;
                } else if (ev.action === 'signout') {
                    if (open) {
                        sessions.push({ in: open.timestamp, out: ev.timestamp, closed: true });
                        open = null;
                    }
                }
            }

            // If still signed in, count until current time (optionally capped)
            if (open) {
                let out = effectiveNow;

                if (openSessionCap) {
                    // If cap is earlier than now, cap it (but don't go before the signin time)
                    if (out > openSessionCap) out = openSessionCap;
                }

                // Prevent negative durations if something weird happens
                const openedAt = new Date(open.timestamp);
                if (out < openedAt) out = openedAt;

                sessions.push({ in: open.timestamp, out: out.toISOString(), closed: false, running: true });
            }

            // Sum minutes across sessions
            let totalMin = 0;
            for (const s of sessions) {
                if (s.in && s.out) {
                    totalMin += (new Date(s.out) - new Date(s.in)) / 60000;
                }
            }

            const totalMinutes = Math.round(totalMin);
            const totalHours = Math.round((totalMin / 60) * 100) / 100;

            summaries.push({
                ufid: entry.ufid,
                name: entry.name,
                sessions,
                totalMinutes,
                totalHours,
                absent: totalMin === 0
            });
        }

        // Include zero-activity students
        for (const s of students) {
            if (!summaries.find(x => x.ufid === s.ufid)) {
                summaries.push({
                    ufid: s.ufid,
                    name: s.name,
                    sessions: [],
                    totalMinutes: 0,
                    totalHours: 0,
                    absent: true
                });
            }
        }

        summaries.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const totalMinutesAll = summaries.reduce((acc, x) => acc + (x.totalMinutes || 0), 0);
        const totalHoursAll = Math.round((totalMinutesAll / 60) * 100) / 100;

        const dateOnly = new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString();

        return {
            date: dateOnly,
            asOf: effectiveNow.toISOString(),
            totalMinutesAll,
            totalHoursAll,
            summaries
        };
    }



    saveDailySummaryCSV(dateLike, options = {}) {
        try {
            const { summaries } = this.computeDailySummary(dateLike, options);
            const rows = [
                ['UF ID', 'Name', 'Total Hours', 'Total Minutes', 'Sessions', 'Notes']
            ];

            summaries.forEach(s => {
                let notes = '';
                if (s.absent || s.totalMinutes === 0) {
                    notes = 'A'; // Absent marker
                } else if (s.sessions.some(x => !x.closed)) {
                    notes = 'Open session';
                } else if (s.autoclosed) {
                    notes = 'Auto-closed at cutoff';
                }

                const sessionStr = s.sessions.map(x => {
                    if (!x.out) return `${x.in} → (open)`;
                    return `${x.in} → ${x.out}${x.syntheticOut ? ' [auto]' : ''}`;
                }).join(' | ');

                rows.push([
                    s.ufid,
                    s.name,
                    s.totalHours,
                    s.totalMinutes,
                    sessionStr,
                    notes
                ]);
            });

            const csv = rows.map(r => r.join(',')).join('\n');
            const reportsDir = path.join(this.dataDir, 'reports');
            if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

            const d = new Date(dateLike);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const filePath = path.join(reportsDir, `daily-${yyyy}-${mm}-${dd}.csv`);
            fs.writeFileSync(filePath, csv);

            if (this.logger) this.logger.info('report', `Daily summary saved: ${path.basename(filePath)}`, 'admin');
            return { success: true, filePath };
        } catch (e) {
            if (this.logger) this.logger.error('report', `Daily summary save failed: ${e.message}`, 'admin');
            return { success: false, error: e.message };
        }
    }

    sortAttendanceByTimestamp() {
        try {
            const attendance = this.getAttendance(); // decrypted array
            const sorted = attendance.slice().sort((a, b) => {
                const ta = new Date(a.timestamp).getTime() || 0;
                const tb = new Date(b.timestamp).getTime() || 0;
                if (ta !== tb) return ta - tb;
                // tie-breaker for identical timestamps (keeps order deterministic)
                const ia = typeof a.id === 'number' ? a.id : 0;
                const ib = typeof b.id === 'number' ? b.id : 0;
                return ia - ib;
            });

            const dataToSave = this.encryptSensitiveFields(sorted, ['name']);
            fs.writeFileSync(this.attendanceFile, JSON.stringify(dataToSave, null, 2));
            if (this.logger) this.logger.info('attendance', `Attendance sorted by timestamp (${sorted.length} records)`, 'system');
            return { success: true, count: sorted.length };
        } catch (e) {
            if (this.logger) this.logger.error('attendance', `Sort attendance failed: ${e.message}`, 'system');
            return { success: false, error: e.message };
        }
    }

    getStats() {
        try {
            if (this.logger) {
                this.logger.info('stats', 'Generating basic statistics', 'admin');
            }

            const attendance = this.getAttendance();
            const students = this.getStudents();
            const today = new Date().toDateString();
            const todayAttendance = attendance.filter(record =>
                new Date(record.timestamp).toDateString() === today
            );

            const signIns = todayAttendance.filter(r => r.action === 'signin').length;
            const signOuts = todayAttendance.filter(r => r.action === 'signout').length;

            const stats = {
                totalStudents: students.length,
                activeStudents: students.filter(s => s.active).length,
                todaySignIns: signIns,
                todaySignOuts: signOuts,
                totalRecords: attendance.length,
                lastActivity: attendance.length > 0 ? attendance[attendance.length - 1].timestamp : null
            };

            if (this.logger) {
                this.logger.info('stats', `Basic stats generated - Students: ${stats.totalStudents}, Today's records: ${todayAttendance.length}`, 'admin');
            }

            return stats;
        } catch (error) {
            if (this.logger) {
                this.logger.error('stats', `Error generating basic stats: ${error.message}`, 'admin');
            }
            return {};
        }
    }

    getEnhancedStats() {
        try {
            if (this.logger) {
                this.logger.info('stats', 'Generating enhanced statistics', 'admin');
            }

            const attendance = this.getAttendance();
            const students = this.getStudents();
            const currentlySignedIn = this.getCurrentlySignedIn();
            const todaysAttendance = this.getTodaysAttendance();

            const signIns = todaysAttendance.filter(r => r.action === 'signin').length;
            const signOuts = todaysAttendance.filter(r => r.action === 'signout').length;

            const stats = {
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

            if (this.logger) {
                this.logger.info('stats', `Enhanced stats generated - Currently present: ${stats.currentlySignedIn}, Today's activity: ${stats.todaysRecords}`, 'admin');
            }

            return stats;
        } catch (error) {
            if (this.logger) {
                this.logger.error('stats', `Error generating enhanced stats: ${error.message}`, 'admin');
            }
            return {};
        }
    }

    getAttendanceByDateRange(startDate, endDate) {
        try {
            if (this.logger) {
                this.logger.info('attendance', `Retrieving attendance records from ${startDate} to ${endDate}`, 'admin');
            }

            const attendance = this.getAttendance();
            const start = new Date(startDate);
            const end = new Date(endDate);

            const filteredAttendance = attendance.filter(record => {
                const recordDate = new Date(record.timestamp);
                return recordDate >= start && recordDate <= end;
            });

            if (this.logger) {
                this.logger.info('attendance', `Found ${filteredAttendance.length} records in date range`, 'admin');
            }

            return filteredAttendance;
        } catch (error) {
            if (this.logger) {
                this.logger.error('attendance', `Error getting attendance by date range: ${error.message}`, 'admin');
            }
            return [];
        }
    }

    generateWeeklyReport() {
        try {
            if (this.logger) {
                this.logger.info('report', 'Generating weekly report data', 'admin');
            }

            // ---------- Helpers (local, consistent with UI-like week logic) ----------
            const startOfWeek = (d) => {
                const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                const day = (x.getDay() + 6) % 7; // Monday = 0
                x.setDate(x.getDate() - day);
                x.setHours(0, 0, 0, 0);
                return x;
            };

            const addDays = (d, n) => {
                const x = new Date(d);
                x.setDate(x.getDate() + n);
                return x;
            };

            const startOfDayLocal = (d) => {
                const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                x.setHours(0, 0, 0, 0);
                return x;
            };

            // Pair signins->signouts within ONE DAY for ONE STUDENT
            // Ignores extra signins/signouts safely.
            const computeTotalHoursFromEvents = (events) => {
                const sorted = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                let totalMs = 0;
                let openIn = null;

                for (const e of sorted) {
                    const t = new Date(e.timestamp);
                    if (Number.isNaN(t.getTime())) continue;

                    if (e.action === 'signin') {
                        if (!openIn) openIn = t; // keep first open signin
                    } else if (e.action === 'signout') {
                        if (openIn && t > openIn) {
                            totalMs += (t - openIn);
                        }
                        openIn = null; // close even if invalid ordering
                    }
                }

                return totalMs / (1000 * 60 * 60);
            };

            // ---------- Define week range: Mon 00:00 → next Mon 00:00 ----------
            const now = new Date();
            const weekStart = startOfWeek(now);
            const weekEndExclusive = startOfDayLocal(addDays(weekStart, 7)); // next Monday 00:00

            // Return metadata: startDate/endDate (inclusive-ish) like before
            const startDate = new Date(weekStart);
            const endDate = new Date(weekEndExclusive);

            // Fetch attendance for that exact week
            const weeklyAttendance = this.getAttendanceByDateRange(startDate, endDate);

            // Students (ensure getStudents() already normalizes role/expected fields)
            const students = this.getStudents();

            // ---------- Initialize reports ----------
            const studentReports = {};
            students.forEach(student => {
                studentReports[student.ufid] = {
                    name: student.name,
                    email: student.email,

                    role: (student.role || 'volunteer').toLowerCase(),
                    expectedHoursPerWeek: Number(student.expectedHoursPerWeek ?? 0),
                    expectedDaysPerWeek: Number(student.expectedDaysPerWeek ?? 0),

                    signIns: 0,
                    signOuts: 0,

                    // week totals
                    totalHours: 0,
                    daysAttended: 0,

                    // keep raw records for debugging / optional email details
                    sessions: []
                };
            });

            // Put records into sessions + count signins/outs
            weeklyAttendance.forEach(record => {
                const rep = studentReports[record.ufid];
                if (!rep) return;

                if (record.action === 'signin') rep.signIns++;
                else if (record.action === 'signout') rep.signOuts++;

                rep.sessions.push(record);
            });

            // ---------- Compute hours/day-attended by summing daily totals ----------
            // Build list of 7 local day windows (Mon..Sun)
            const days = Array.from({ length: 7 }, (_, i) => startOfDayLocal(addDays(weekStart, i)));

            Object.keys(studentReports).forEach(ufid => {
                const rep = studentReports[ufid];
                if (!rep.sessions.length) return;

                let weekHours = 0;
                let daysAttended = 0;

                // For each day, filter that student's events into the day's window
                for (const dayStart of days) {
                    const dayEnd = startOfDayLocal(addDays(dayStart, 1));

                    const dayEvents = rep.sessions.filter(r => {
                        const t = new Date(r.timestamp);
                        return !Number.isNaN(t.getTime()) && t >= dayStart && t < dayEnd;
                    });

                    const dailyHours = computeTotalHoursFromEvents(dayEvents);

                    weekHours += dailyHours;
                    if (dailyHours > 0) daysAttended += 1; // non-zero days only (no strict threshold)
                }

                rep.totalHours = Math.round(weekHours * 100) / 100;
                rep.daysAttended = daysAttended;
            });

            // Students with activity: any signins OR any hours
            const activeStudents = Object.values(studentReports)
                .filter(s => (s.signIns > 0) || (s.totalHours > 0))
                .length;

            if (this.logger) {
                this.logger.info(
                    'report',
                    `Weekly report generated - ${weeklyAttendance.length} records, ${activeStudents} active students`,
                    'admin'
                );
            }

            return {
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
                totalRecords: weeklyAttendance.length,
                studentsWithActivity: activeStudents,
                studentReports: studentReports,
                rawAttendance: weeklyAttendance
            };
        } catch (error) {
            if (this.logger) {
                this.logger.error('report', `Error generating weekly report: ${error.message}`, 'admin');
            }
            return null;
        }
    }


    generateCSVReport(reportData) {
        try {
            if (this.logger) {
                this.logger.info('report', 'Converting report data to CSV format', 'admin');
            }

            const headers = ['UF ID', 'Name', 'Sign Ins', 'Sign Outs', 'Total Hours', 'Email'];
            const rows = [headers];

            let activeRecords = 0;
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
                    activeRecords++;
                }
            });

            if (this.logger) {
                this.logger.info('report', `CSV report generated with ${activeRecords} active student records`, 'admin');
            }

            return rows.map(row => row.join(',')).join('\n');
        } catch (error) {
            if (this.logger) {
                this.logger.error('report', `Error generating CSV report: ${error.message}`, 'admin');
            }
            return '';
        }
    }

    saveWeeklyReportToFile() {
        try {
            if (this.logger) {
                this.logger.info('report', 'Saving weekly report to file', 'admin');
            }

            const reportData = this.generateWeeklyReport();
            if (!reportData) {
                return { success: false, error: 'Failed to generate report data' };
            }

            const csvContent = this.generateCSVReport(reportData);
            const reportsDir = path.join(this.dataDir, 'reports');

            if (!fs.existsSync(reportsDir)) {
                fs.mkdirSync(reportsDir);
                if (this.logger) {
                    this.logger.info('report', 'Created reports directory', 'admin');
                }
            }

            const fileName = `weekly-report-${new Date().toISOString().split('T')[0]}.csv`;
            const filePath = path.join(reportsDir, fileName);

            fs.writeFileSync(filePath, csvContent);

            if (this.logger) {
                this.logger.info('report', `Weekly report saved to file: ${fileName}`, 'admin');
            }

            return {
                success: true,
                filePath,
                reportData,
                csvContent
            };
        } catch (error) {
            if (this.logger) {
                this.logger.error('report', `Error saving weekly report to file: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }

    updateEmailConfig(emailConfig) {
        try {
            if (this.logger) {
                this.logger.info('config', `Updating email configuration - SMTP: ${emailConfig.smtp}`, 'admin');
            }

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

            if (this.logger) {
                this.logger.info('config', 'Email configuration updated successfully', 'admin');
            }

            return { success: true };
        } catch (error) {
            if (this.logger) {
                this.logger.error('config', `Error updating email config: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }
    updateSheetsConfig(sheetsConfig) {
        try {
            const config = this.getConfig();
            const prev = config.googleSheets || {};

            const sheetName =
                sheetsConfig.sheetName ||
                sheetsConfig.attendanceSheet ||   // legacy input
                prev.sheetName || 'Attendance';

            config.googleSheets = {
                enabled: !!(sheetsConfig.enabled ?? prev.enabled),
                spreadsheetId: sheetsConfig.spreadsheetId || prev.spreadsheetId || '',
                sheetName,
                autoSync: !!(sheetsConfig.autoSync ?? prev.autoSync),
                // Keep legacy fields if you still show them in UI (optional)
                attendanceSheet: sheetsConfig.attendanceSheet || prev.attendanceSheet || undefined,
                studentsSheet: sheetsConfig.studentsSheet || prev.studentsSheet || undefined
            };

            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
            if (this.logger) this.logger.info('config', 'Google Sheets configuration updated successfully', 'admin');
            return { success: true };
        } catch (error) {
            if (this.logger) this.logger.error('config', `Error updating Google Sheets config: ${error.message}`, 'admin');
            return { success: false, error: error.message };
        }
    }




    getConfigPath() {
        return this.configFile;
    }


    updateDropboxConfig(dropboxConfig) {
        try {
            if (this.logger) {
                this.logger.info(
                    'config',
                    `Updating Dropbox configuration (merge)`,
                    'admin'
                );
            }

            const config = this.getConfig(); // already normalized
            const prev = config.dropbox || {};

            // Merge new fields into existing dropbox block
            const merged = {
                ...prev,
                ...dropboxConfig
            };

            // Auto-enable when user provides credentials unless explicitly disabled
            const hasCreds =
                (merged.appKey && merged.appSecret && (merged.refreshToken || prev.refreshToken)) ||
                merged.accessToken; // legacy

            if (dropboxConfig.enabled === undefined && hasCreds) {
                merged.enabled = true;
            } else if (dropboxConfig.enabled !== undefined) {
                merged.enabled = !!dropboxConfig.enabled;
            }

            // Write back
            config.dropbox = this.normalizeConfigShape({ dropbox: merged }).dropbox;
            fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));

            if (this.logger) {
                this.logger.info('config', 'Dropbox configuration updated successfully', 'admin');
            }

            return { success: true };
        } catch (error) {
            if (this.logger) {
                this.logger.error('config', `Error updating Dropbox config: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }


    backupData() {
        try {
            if (this.logger) {
                this.logger.info('backup', 'Creating data backup', 'admin');
            }

            const backupData = {
                attendance: this.getAttendance(),
                students: this.getStudents(),
                config: this.getConfig(),
                backupDate: new Date().toISOString()
            };

            const backupDir = path.join(this.dataDir, 'backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir);
                if (this.logger) {
                    this.logger.info('backup', 'Created backups directory', 'admin');
                }
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(backupDir, `backup-${timestamp}.json`);

            fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));

            if (this.logger) {
                this.logger.info('backup', `Data backup created successfully: ${path.basename(backupFile)}`, 'admin');
            }

            return { success: true, backupFile };
        } catch (error) {
            if (this.logger) {
                this.logger.error('backup', `Error creating data backup: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }

    createEncryptedBackup(password) {
        try {
            if (this.logger) {
                this.logger.info('backup', 'Creating encrypted data backup', 'admin');
            }

            const backupData = {
                attendance: this.getAttendance(),
                students: this.getStudents(),
                config: this.getConfig(),
                backupDate: new Date().toISOString(),
                encrypted: true
            };

            const encrypted = this.encrypt(backupData, password);
            if (!encrypted.success) {
                if (this.logger) {
                    this.logger.error('backup', 'Failed to encrypt backup data', 'admin');
                }
                return encrypted;
            }

            const backupDir = path.join(this.dataDir, 'backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir);
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(backupDir, `encrypted-backup-${timestamp}.enc`);

            fs.writeFileSync(backupFile, encrypted.data);

            if (this.logger) {
                this.logger.info('backup', `Encrypted backup created successfully: ${path.basename(backupFile)}`, 'admin');
            }

            return { success: true, backupFile, encrypted: true };
        } catch (error) {
            if (this.logger) {
                this.logger.error('backup', `Error creating encrypted backup: ${error.message}`, 'admin');
            }
            return { success: false, error: error.message };
        }
    }

    ensureDataDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    initializeFiles() {
        // Initialize your data files here
        if (!fs.existsSync(this.studentsFile)) {
            fs.writeFileSync(this.studentsFile, JSON.stringify([], null, 2));
        }
        if (!fs.existsSync(this.attendanceFile)) {
            fs.writeFileSync(this.attendanceFile, JSON.stringify([], null, 2));
        }
        if (!fs.existsSync(this.configFile)) {
            fs.writeFileSync(this.configFile, JSON.stringify({}, null, 2));
        }
    }
}

module.exports = DataManager;