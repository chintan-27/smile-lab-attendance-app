/**
 * Database Manager - SQLite Operations Layer
 * Provides optimized database operations for students and attendance
 * Uses sql.js (WebAssembly-based SQLite)
 */

const SQLiteDatabase = require('./database.js');

/**
 * DatabaseManager class for efficient data operations
 */
class DatabaseManager {
    constructor(options = {}) {
        this.sqliteDb = new SQLiteDatabase(options);
        this.initialized = false;
    }

    /**
     * Initialize the database manager (async)
     * @returns {Promise<boolean>} True if successful
     */
    async initialize() {
        const result = await this.sqliteDb.initialize();
        this.initialized = result;
        return result;
    }

    /**
     * Check if database is ready
     * @returns {boolean}
     */
    isReady() {
        return this.initialized && this.sqliteDb.isInitialized();
    }

    /**
     * Get the raw database instance for direct queries
     * @returns {Database}
     */
    getDb() {
        return this.sqliteDb.getDb();
    }

    // ==================== STUDENT OPERATIONS ====================

    /**
     * Get student by UFID - O(1) primary key lookup
     * @param {string} ufid - Student UFID
     * @returns {Object|null} Student object or null
     */
    getStudentByUfid(ufid) {
        if (!this.isReady()) return null;

        const row = this.sqliteDb.get(`
            SELECT ufid, name, email, active, role,
                   expected_hours_per_week as expectedHoursPerWeek,
                   expected_days_per_week as expectedDaysPerWeek,
                   added_date as addedDate
            FROM students WHERE ufid = ?
        `, [ufid]);

        if (!row) return null;

        return {
            ...row,
            active: Boolean(row.active),
            role: (row.role || 'volunteer').toLowerCase(),
            expectedHoursPerWeek: Number(row.expectedHoursPerWeek || 0),
            expectedDaysPerWeek: Number(row.expectedDaysPerWeek || 0)
        };
    }

    /**
     * Get all students with optional pagination
     * @param {Object} options - { offset, limit, activeOnly }
     * @returns {Array} Array of student objects
     */
    getStudents(options = {}) {
        if (!this.isReady()) return [];

        const { offset = 0, limit = null, activeOnly = false } = options;

        let sql = `
            SELECT ufid, name, email, active, role,
                   expected_hours_per_week as expectedHoursPerWeek,
                   expected_days_per_week as expectedDaysPerWeek,
                   added_date as addedDate
            FROM students
        `;

        if (activeOnly) {
            sql += ' WHERE active = 1';
        }

        sql += ' ORDER BY name ASC';

        if (limit !== null) {
            sql += ` LIMIT ${limit} OFFSET ${offset}`;
        }

        const rows = this.sqliteDb.all(sql);

        return rows.map(row => ({
            ...row,
            active: Boolean(row.active),
            role: (row.role || 'volunteer').toLowerCase(),
            expectedHoursPerWeek: Number(row.expectedHoursPerWeek || 0),
            expectedDaysPerWeek: Number(row.expectedDaysPerWeek || 0)
        }));
    }

    /**
     * Get students with pagination and filtering
     * @param {number} offset - Offset for pagination
     * @param {number} limit - Number of records to return
     * @param {Object} filters - { search, status }
     * @returns {Object} { students, totalCount }
     */
    getStudentsPaginated(offset, limit, filters = {}) {
        if (!this.isReady()) return { students: [], totalCount: 0 };

        const { search = '', status = '' } = filters;
        let whereClause = '';
        const conditions = [];

        if (search) {
            conditions.push(`(name LIKE '%${search.replace(/'/g, "''")}%' OR ufid LIKE '%${search.replace(/'/g, "''")}%' OR email LIKE '%${search.replace(/'/g, "''")}%')`);
        }

        if (status === 'active') {
            conditions.push('active = 1');
        } else if (status === 'inactive') {
            conditions.push('active = 0');
        }

        if (conditions.length > 0) {
            whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        // Get total count
        const countResult = this.sqliteDb.get(`SELECT COUNT(*) as count FROM students ${whereClause}`);
        const totalCount = countResult ? countResult.count : 0;

        // Get paginated results
        const sql = `
            SELECT ufid, name, email, active, role,
                   expected_hours_per_week as expectedHoursPerWeek,
                   expected_days_per_week as expectedDaysPerWeek,
                   added_date as addedDate
            FROM students
            ${whereClause}
            ORDER BY name ASC
            LIMIT ${limit} OFFSET ${offset}
        `;

        const rows = this.sqliteDb.all(sql);

        const students = rows.map(row => ({
            ...row,
            active: Boolean(row.active),
            role: (row.role || 'volunteer').toLowerCase(),
            expectedHoursPerWeek: Number(row.expectedHoursPerWeek || 0),
            expectedDaysPerWeek: Number(row.expectedDaysPerWeek || 0)
        }));

        return { students, totalCount };
    }

    /**
     * Get total student count
     * @param {boolean} activeOnly - Count only active students
     * @returns {number}
     */
    getStudentCount(activeOnly = false) {
        if (!this.isReady()) return 0;

        const sql = activeOnly
            ? 'SELECT COUNT(*) as count FROM students WHERE active = 1'
            : 'SELECT COUNT(*) as count FROM students';

        const result = this.sqliteDb.get(sql);
        return result ? result.count : 0;
    }

    /**
     * Add or update a student
     * @param {Object} student - Student object
     * @returns {Object} { success, student }
     */
    upsertStudent(student) {
        if (!this.isReady()) return { success: false, error: 'Database not ready' };

        try {
            this.sqliteDb.run(`
                INSERT OR REPLACE INTO students (ufid, name, email, active, role,
                                     expected_hours_per_week, expected_days_per_week, added_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                student.ufid,
                student.name,
                student.email || null,
                student.active !== false ? 1 : 0,
                (student.role || 'volunteer').toLowerCase(),
                Number(student.expectedHoursPerWeek || 0),
                Number(student.expectedDaysPerWeek || 0),
                student.addedDate || new Date().toISOString()
            ]);

            return { success: true, student: this.getStudentByUfid(student.ufid) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Update student fields
     * @param {string} ufid - Student UFID
     * @param {Object} updates - Fields to update
     * @returns {Object} { success, student }
     */
    updateStudent(ufid, updates) {
        if (!this.isReady()) return { success: false, error: 'Database not ready' };

        const existing = this.getStudentByUfid(ufid);
        if (!existing) return { success: false, error: 'Student not found' };

        const merged = {
            ...existing,
            ...updates,
            ufid // Ensure UFID doesn't change
        };

        return this.upsertStudent(merged);
    }

    /**
     * Remove a student
     * @param {string} ufid - Student UFID
     * @returns {Object} { success }
     */
    removeStudent(ufid) {
        if (!this.isReady()) return { success: false, error: 'Database not ready' };

        try {
            const existing = this.getStudentByUfid(ufid);
            if (!existing) {
                return { success: false, error: 'Student not found' };
            }

            this.sqliteDb.run('DELETE FROM students WHERE ufid = ?', [ufid]);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if student is authorized (exists and is active)
     * @param {string} ufid - Student UFID
     * @returns {Object|null} Student object if authorized, null otherwise
     */
    isStudentAuthorized(ufid) {
        const student = this.getStudentByUfid(ufid);
        return (student && student.active) ? student : null;
    }

    // ==================== ATTENDANCE OPERATIONS ====================

    /**
     * Get current status for a student - O(1) with index
     * @param {string} ufid - Student UFID
     * @returns {string} 'signin', 'signout', or 'never_signed_in'
     */
    getCurrentStatus(ufid) {
        if (!this.isReady()) return 'never_signed_in';

        const row = this.sqliteDb.get(`
            SELECT action FROM attendance
            WHERE ufid = ?
            ORDER BY timestamp DESC, id DESC
            LIMIT 1
        `, [ufid]);

        return row ? row.action : 'never_signed_in';
    }

    /**
     * Get attendance records for a date range
     * @param {Date|string} start - Start date
     * @param {Date|string} end - End date
     * @returns {Array} Attendance records
     */
    getAttendanceForDateRange(start, end) {
        if (!this.isReady()) return [];

        const startDate = new Date(start);
        const endDate = new Date(end);

        // Set time boundaries
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);

        const rows = this.sqliteDb.all(`
            SELECT id, ufid, name, action, timestamp, synthetic,
                   pending_timestamp as pendingTimestamp,
                   pending_record_id as pendingRecordId,
                   resolved_at as resolvedAt,
                   auto_signout as autoSignout
            FROM attendance
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC, id ASC
        `, [startDate.toISOString(), endDate.toISOString()]);

        return rows.map(row => ({
            ...row,
            synthetic: Boolean(row.synthetic),
            pendingTimestamp: Boolean(row.pendingTimestamp),
            autoSignout: Boolean(row.autoSignout)
        }));
    }

    /**
     * Get attendance for a specific date
     * @param {Date|string} dateLike - The date
     * @returns {Array} Attendance records for that day
     */
    getAttendanceForDate(dateLike) {
        const target = new Date(dateLike);
        const dayStart = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0, 0);
        const dayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59, 999);
        return this.getAttendanceForDateRange(dayStart, dayEnd);
    }

    /**
     * Get all attendance records with optional pagination
     * @param {Object} options - { offset, limit }
     * @returns {Array} Attendance records
     */
    getAttendance(options = {}) {
        if (!this.isReady()) return [];

        const { offset = 0, limit = null } = options;

        let sql = `
            SELECT id, ufid, name, action, timestamp, synthetic,
                   pending_timestamp as pendingTimestamp,
                   pending_record_id as pendingRecordId,
                   resolved_at as resolvedAt,
                   auto_signout as autoSignout
            FROM attendance
            ORDER BY timestamp ASC, id ASC
        `;

        if (limit !== null) {
            sql += ` LIMIT ${limit} OFFSET ${offset}`;
        }

        const rows = this.sqliteDb.all(sql);

        return rows.map(row => ({
            ...row,
            synthetic: Boolean(row.synthetic),
            pendingTimestamp: Boolean(row.pendingTimestamp),
            autoSignout: Boolean(row.autoSignout)
        }));
    }

    /**
     * Get attendance records with pagination and filtering
     * @param {number} offset - Offset for pagination
     * @param {number} limit - Number of records to return
     * @param {Object} filters - { ufid, date, action }
     * @returns {Object} { records, totalCount }
     */
    getAttendancePaginated(offset, limit, filters = {}) {
        if (!this.isReady()) return { records: [], totalCount: 0 };

        const { ufid = '', date = null, action = '' } = filters;
        const conditions = [];

        if (ufid) {
            conditions.push(`ufid = '${ufid.replace(/'/g, "''")}'`);
        }

        if (date) {
            const targetDate = new Date(date);
            const dayStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
            const dayEnd = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
            conditions.push(`timestamp >= '${dayStart.toISOString()}' AND timestamp <= '${dayEnd.toISOString()}'`);
        }

        if (action && ['signin', 'signout'].includes(action)) {
            conditions.push(`action = '${action}'`);
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        // Get total count
        const countResult = this.sqliteDb.get(`SELECT COUNT(*) as count FROM attendance ${whereClause}`);
        const totalCount = countResult ? countResult.count : 0;

        // Get paginated results
        const sql = `
            SELECT id, ufid, name, action, timestamp, synthetic,
                   pending_timestamp as pendingTimestamp,
                   pending_record_id as pendingRecordId,
                   resolved_at as resolvedAt,
                   auto_signout as autoSignout
            FROM attendance
            ${whereClause}
            ORDER BY timestamp DESC, id DESC
            LIMIT ${limit} OFFSET ${offset}
        `;

        const rows = this.sqliteDb.all(sql);

        const records = rows.map(row => ({
            ...row,
            synthetic: Boolean(row.synthetic),
            pendingTimestamp: Boolean(row.pendingTimestamp),
            autoSignout: Boolean(row.autoSignout)
        }));

        return { records, totalCount };
    }

    /**
     * Get total attendance count
     * @returns {number}
     */
    getAttendanceCount() {
        if (!this.isReady()) return 0;

        const result = this.sqliteDb.get('SELECT COUNT(*) as count FROM attendance');
        return result ? result.count : 0;
    }

    /**
     * Add an attendance record
     * @param {Object} record - Attendance record
     * @returns {Object} { success, record }
     */
    addAttendanceRecord(record) {
        if (!this.isReady()) return { success: false, error: 'Database not ready' };

        try {
            const id = record.id || Date.now();

            this.sqliteDb.run(`
                INSERT INTO attendance (id, ufid, name, action, timestamp, synthetic,
                                        pending_timestamp, pending_record_id, resolved_at, auto_signout)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                id,
                record.ufid,
                record.name || null,
                record.action,
                record.timestamp || new Date().toISOString(),
                record.synthetic ? 1 : 0,
                record.pendingTimestamp ? 1 : 0,
                record.pendingRecordId || null,
                record.resolvedAt || null,
                record.autoSignout ? 1 : 0
            ]);

            return { success: true, record: { ...record, id } };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Delete an attendance record
     * @param {number} recordId - Record ID
     * @returns {Object} { success }
     */
    deleteAttendanceRecord(recordId) {
        if (!this.isReady()) return { success: false, error: 'Database not ready' };

        try {
            const existing = this.getAttendanceById(recordId);
            if (!existing) {
                return { success: false, error: 'Record not found' };
            }

            this.sqliteDb.run('DELETE FROM attendance WHERE id = ?', [recordId]);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Update attendance record by pending ID
     * @param {string} pendingRecordId - Pending record ID
     * @param {Object} updates - Fields to update
     * @returns {Object} { success, record }
     */
    updateAttendanceByPendingId(pendingRecordId, updates) {
        if (!this.isReady()) return { success: false, error: 'Database not ready' };

        try {
            // Find the record
            const existing = this.sqliteDb.get(`
                SELECT * FROM attendance WHERE pending_record_id = ?
            `, [pendingRecordId]);

            if (!existing) {
                return { success: false, error: 'Record not found' };
            }

            // Update the record
            this.sqliteDb.run(`
                UPDATE attendance
                SET timestamp = ?,
                    pending_timestamp = 0,
                    resolved_at = ?
                WHERE pending_record_id = ?
            `, [
                updates.timestamp || existing.timestamp,
                updates.resolvedAt || new Date().toISOString(),
                pendingRecordId
            ]);

            return {
                success: true,
                record: this.getAttendanceById(existing.id)
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Get attendance record by ID
     * @param {number} id - Record ID
     * @returns {Object|null} Record or null
     */
    getAttendanceById(id) {
        if (!this.isReady()) return null;

        const row = this.sqliteDb.get(`
            SELECT id, ufid, name, action, timestamp, synthetic,
                   pending_timestamp as pendingTimestamp,
                   pending_record_id as pendingRecordId,
                   resolved_at as resolvedAt,
                   auto_signout as autoSignout
            FROM attendance WHERE id = ?
        `, [id]);

        if (!row) return null;

        return {
            ...row,
            synthetic: Boolean(row.synthetic),
            pendingTimestamp: Boolean(row.pendingTimestamp),
            autoSignout: Boolean(row.autoSignout)
        };
    }

    /**
     * Get students with open sessions (signed in without sign out) for a date
     * @param {Date|string} dateLike - The date
     * @returns {Array} Sign-in records without matching sign-outs
     */
    getOpenSessionsForDate(dateLike) {
        if (!this.isReady()) return [];

        const target = new Date(dateLike);
        const dayStart = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0, 0);
        const dayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59, 999);

        // Use a subquery to find open sessions efficiently
        return this.sqliteDb.all(`
            SELECT a.id, a.ufid, a.name, a.action, a.timestamp
            FROM attendance a
            WHERE a.action = 'signin'
              AND a.timestamp >= ?
              AND a.timestamp <= ?
              AND NOT EXISTS (
                  SELECT 1 FROM attendance b
                  WHERE b.ufid = a.ufid
                    AND b.action = 'signout'
                    AND b.timestamp >= a.timestamp
                    AND b.timestamp <= ?
              )
            ORDER BY a.timestamp DESC
        `, [dayStart.toISOString(), dayEnd.toISOString(), dayEnd.toISOString()]);
    }

    /**
     * Get currently signed-in students
     * @returns {Array} Students currently signed in
     */
    getCurrentlySignedIn() {
        if (!this.isReady()) return [];

        // Get all students and check their last action
        const students = this.getStudents({ activeOnly: true });
        const signedIn = [];

        for (const student of students) {
            const lastAction = this.sqliteDb.get(`
                SELECT action, timestamp FROM attendance
                WHERE ufid = ?
                ORDER BY timestamp DESC, id DESC
                LIMIT 1
            `, [student.ufid]);

            if (lastAction && lastAction.action === 'signin') {
                signedIn.push({
                    ...student,
                    signInTime: lastAction.timestamp
                });
            }
        }

        return signedIn;
    }

    /**
     * Get today's attendance records
     * @returns {Array} Today's attendance records
     */
    getTodaysAttendance() {
        const today = new Date();
        return this.getAttendanceForDate(today);
    }

    /**
     * Sort attendance by timestamp (useful for consistency)
     * @returns {Object} { success, count }
     */
    sortAttendanceByTimestamp() {
        // SQLite doesn't need explicit sorting since we query with ORDER BY
        // This is a no-op for SQLite but kept for API compatibility
        const count = this.getAttendanceCount();
        return { success: true, count };
    }

    // ==================== BULK OPERATIONS ====================

    /**
     * Import students from array (for migration)
     * @param {Array} students - Array of student objects
     * @returns {Object} { success, imported, errors }
     */
    importStudents(students) {
        if (!this.isReady()) return { success: false, error: 'Database not ready' };

        let imported = 0;
        const errors = [];

        for (const s of students) {
            try {
                this.sqliteDb.run(`
                    INSERT OR REPLACE INTO students (ufid, name, email, active, role,
                                                    expected_hours_per_week, expected_days_per_week, added_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    s.ufid,
                    s.name,
                    s.email || null,
                    s.active !== false ? 1 : 0,
                    (s.role || 'volunteer').toLowerCase(),
                    Number(s.expectedHoursPerWeek || 0),
                    Number(s.expectedDaysPerWeek || 0),
                    s.addedDate || new Date().toISOString()
                ]);
                imported++;
            } catch (error) {
                errors.push({ ufid: s.ufid, error: error.message });
            }
        }

        return { success: errors.length === 0, imported, errors };
    }

    /**
     * Import attendance records from array (for migration)
     * @param {Array} records - Array of attendance records
     * @returns {Object} { success, imported, errors }
     */
    importAttendance(records) {
        if (!this.isReady()) return { success: false, error: 'Database not ready' };

        let imported = 0;
        const errors = [];

        for (const r of records) {
            try {
                this.sqliteDb.run(`
                    INSERT OR REPLACE INTO attendance (id, ufid, name, action, timestamp, synthetic,
                                                       pending_timestamp, pending_record_id, resolved_at, auto_signout)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    r.id,
                    r.ufid,
                    r.name || null,
                    r.action,
                    r.timestamp,
                    r.synthetic ? 1 : 0,
                    r.pendingTimestamp ? 1 : 0,
                    r.pendingRecordId || null,
                    r.resolvedAt || null,
                    r.autoSignout ? 1 : 0
                ]);
                imported++;
            } catch (error) {
                errors.push({ id: r.id, error: error.message });
            }
        }

        return { success: errors.length === 0, imported, errors };
    }

    /**
     * Export all students to JSON-compatible format
     * @returns {Array} Students array
     */
    exportStudents() {
        return this.getStudents();
    }

    /**
     * Export all attendance to JSON-compatible format
     * @returns {Array} Attendance array
     */
    exportAttendance() {
        return this.getAttendance();
    }

    /**
     * Clear all data from students and attendance tables
     * Used for reloading data from JSON files
     * @returns {Object} { success, cleared }
     */
    clearAllTables() {
        if (!this.isReady()) return { success: false, error: 'Database not ready' };

        try {
            this.sqliteDb.run('DELETE FROM attendance');
            this.sqliteDb.run('DELETE FROM students');
            return { success: true, cleared: { students: true, attendance: true } };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Close the database connection
     */
    close() {
        this.sqliteDb.close();
        this.initialized = false;
    }

    /**
     * Get database statistics
     * @returns {Object}
     */
    getStats() {
        return this.sqliteDb.getStats();
    }
}

module.exports = DatabaseManager;
