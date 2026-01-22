/**
 * SQLite Database Connection and Schema Management
 * Uses sql.js (WebAssembly) - no native module rebuilding required
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

let electronApp = null;
try {
    const { app } = require('electron');
    electronApp = app;
} catch (_) {
    // Not running inside Electron main (e.g., jest or a plain node script)
}

/**
 * Resolve the data directory for database storage
 * @returns {string} Path to data directory
 */
function resolveDataDir() {
    if (electronApp && electronApp.isPackaged) {
        return path.join(electronApp.getPath('userData'), 'data');
    }
    if (electronApp) {
        return path.join(electronApp.getPath('userData'), 'data');
    }
    return path.join(process.cwd(), 'data');
}

/**
 * SQLite Database class for managing connections and schema
 * Uses sql.js (WebAssembly-based SQLite)
 */
class SQLiteDatabase {
    constructor(options = {}) {
        this.dataDir = options.dataDir || resolveDataDir();
        this.dbPath = path.join(this.dataDir, 'attendance.db');
        this.db = null;
        this.SQL = null;
        this.initialized = false;
    }

    /**
     * Initialize the database connection and create schema
     * @returns {Promise<boolean>} True if initialization successful
     */
    async initialize() {
        try {
            // Ensure data directory exists
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
            }

            // Initialize sql.js
            this.SQL = await initSqlJs();

            // Load existing database or create new one
            if (fs.existsSync(this.dbPath)) {
                const fileBuffer = fs.readFileSync(this.dbPath);
                this.db = new this.SQL.Database(fileBuffer);
            } else {
                this.db = new this.SQL.Database();
            }

            // Create schema if it doesn't exist
            this.createSchema();

            // Save database to ensure file exists
            this.save();

            this.initialized = true;
            return true;
        } catch (error) {
            console.error('Failed to initialize SQLite database:', error);
            return false;
        }
    }

    /**
     * Initialize synchronously (for compatibility)
     * @returns {boolean} True if initialization successful
     */
    initializeSync() {
        // For sql.js, we need async init, but we can make it appear sync
        // by blocking. This is a workaround for the existing sync API.
        // In practice, call initialize() and await it.
        console.warn('SQLiteDatabase.initializeSync() called - use initialize() for async init');
        return false;
    }

    /**
     * Create database schema with tables and indexes
     */
    createSchema() {
        // Students table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS students (
                ufid TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT,
                active INTEGER DEFAULT 1,
                role TEXT DEFAULT 'volunteer',
                expected_hours_per_week REAL DEFAULT 0,
                expected_days_per_week INTEGER DEFAULT 0,
                added_date TEXT
            )
        `);

        // Attendance table with optimized schema
        this.db.run(`
            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY,
                ufid TEXT NOT NULL,
                name TEXT,
                action TEXT NOT NULL CHECK(action IN ('signin', 'signout')),
                timestamp TEXT NOT NULL,
                synthetic INTEGER DEFAULT 0,
                pending_timestamp INTEGER DEFAULT 0,
                pending_record_id TEXT,
                resolved_at TEXT,
                auto_signout INTEGER DEFAULT 0,
                FOREIGN KEY (ufid) REFERENCES students(ufid) ON DELETE CASCADE
            )
        `);

        // Config table for key-value storage
        this.db.run(`
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

        // Create indexes for performance
        this.createIndexes();

        // Run any pending migrations
        this.runMigrations();
    }

    /**
     * Create indexes for optimized queries
     */
    createIndexes() {
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_attendance_ufid ON attendance(ufid)',
            'CREATE INDEX IF NOT EXISTS idx_attendance_timestamp ON attendance(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_attendance_ufid_timestamp ON attendance(ufid, timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_attendance_action ON attendance(action)',
            'CREATE INDEX IF NOT EXISTS idx_students_active ON students(active)',
            'CREATE INDEX IF NOT EXISTS idx_students_name ON students(name)'
        ];

        for (const indexSql of indexes) {
            try {
                this.db.run(indexSql);
            } catch (error) {
                // Index might already exist, continue
                console.warn('Index creation warning:', error.message);
            }
        }
    }

    /**
     * Run database migrations for schema updates
     */
    runMigrations() {
        // Get current schema version
        let currentVersion = 0;
        try {
            const result = this.db.exec("SELECT value FROM config WHERE key = 'schema_version'");
            if (result.length > 0 && result[0].values.length > 0) {
                currentVersion = parseInt(result[0].values[0][0], 10);
            }
        } catch (e) {
            // Table might not exist yet
        }

        const migrations = [
            // Migration 1: Initial schema (already created above)
            {
                version: 1,
                up: () => {
                    // Schema created in createSchema, just mark as done
                }
            },
            // Migration 2: Ensure auto_signout column exists
            {
                version: 2,
                up: () => {
                    // Column already in schema definition
                }
            }
        ];

        // Run pending migrations
        for (const migration of migrations) {
            if (migration.version > currentVersion) {
                try {
                    migration.up();
                    this.db.run(
                        "INSERT OR REPLACE INTO config (key, value) VALUES ('schema_version', ?)",
                        [String(migration.version)]
                    );
                    currentVersion = migration.version;
                    console.log(`Migration ${migration.version} completed`);
                } catch (error) {
                    console.error(`Migration ${migration.version} failed:`, error);
                    throw error;
                }
            }
        }
    }

    /**
     * Save database to file
     */
    save() {
        if (this.db && this.initialized !== false) {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
        }
    }

    /**
     * Check if database is initialized
     * @returns {boolean}
     */
    isInitialized() {
        return this.initialized && this.db !== null;
    }

    /**
     * Get the database instance
     * @returns {Database}
     */
    getDb() {
        if (!this.isInitialized()) {
            throw new Error('Database not initialized. Call initialize() first.');
        }
        return this.db;
    }

    /**
     * Execute a SQL statement and return results
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Array} Results
     */
    exec(sql, params = []) {
        return this.db.exec(sql, params);
    }

    /**
     * Run a SQL statement (no return)
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     */
    run(sql, params = []) {
        this.db.run(sql, params);
        this.save();
    }

    /**
     * Prepare and run a statement, returning all results
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Array} Array of row objects
     */
    all(sql, params = []) {
        const stmt = this.db.prepare(sql);
        stmt.bind(params);

        const results = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(row);
        }
        stmt.free();
        return results;
    }

    /**
     * Prepare and run a statement, returning first result
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Object|null} Row object or null
     */
    get(sql, params = []) {
        const results = this.all(sql, params);
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Close the database connection
     */
    close() {
        if (this.db) {
            this.save();
            this.db.close();
            this.db = null;
            this.initialized = false;
        }
    }

    /**
     * Get database statistics
     * @returns {Object} Database stats including table counts
     */
    getStats() {
        if (!this.isInitialized()) {
            return { error: 'Database not initialized' };
        }

        const studentCount = this.get('SELECT COUNT(*) as count FROM students');
        const attendanceCount = this.get('SELECT COUNT(*) as count FROM attendance');
        const configCount = this.get('SELECT COUNT(*) as count FROM config');

        return {
            students: studentCount ? studentCount.count : 0,
            attendance: attendanceCount ? attendanceCount.count : 0,
            config: configCount ? configCount.count : 0,
            dbPath: this.dbPath,
            dbSize: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0
        };
    }

    /**
     * Perform a database vacuum to optimize storage
     */
    vacuum() {
        if (this.isInitialized()) {
            this.db.run('VACUUM');
            this.save();
        }
    }

    /**
     * Check database integrity
     * @returns {Object} Integrity check results
     */
    checkIntegrity() {
        if (!this.isInitialized()) {
            return { success: false, error: 'Database not initialized' };
        }

        const result = this.get('PRAGMA integrity_check');
        return {
            success: result && result.integrity_check === 'ok',
            result: result ? result.integrity_check : 'unknown'
        };
    }
}

module.exports = SQLiteDatabase;
