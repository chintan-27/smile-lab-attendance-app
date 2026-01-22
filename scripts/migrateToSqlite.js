#!/usr/bin/env node
/**
 * Migration Script: JSON to SQLite
 *
 * This script migrates existing JSON data files to SQLite database.
 * It can be run standalone or will be triggered automatically on first startup.
 *
 * Usage:
 *   node scripts/migrateToSqlite.js [--data-dir <path>] [--dry-run] [--verbose]
 *
 * Options:
 *   --data-dir <path>  Specify custom data directory (default: ./data)
 *   --dry-run          Show what would be migrated without making changes
 *   --verbose          Show detailed migration progress
 *   --force            Force migration even if database already has data
 */

const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../databaseManager.js');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
    dataDir: null,
    dryRun: false,
    verbose: false,
    force: false
};

for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
        case '--data-dir':
            options.dataDir = args[++i];
            break;
        case '--dry-run':
            options.dryRun = true;
            break;
        case '--verbose':
            options.verbose = true;
            break;
        case '--force':
            options.force = true;
            break;
        case '--help':
            console.log(`
Migration Script: JSON to SQLite

Usage:
  node scripts/migrateToSqlite.js [options]

Options:
  --data-dir <path>  Specify custom data directory (default: ./data)
  --dry-run          Show what would be migrated without making changes
  --verbose          Show detailed migration progress
  --force            Force migration even if database already has data
  --help             Show this help message
`);
            process.exit(0);
    }
}

// Resolve data directory
const dataDir = options.dataDir || path.join(process.cwd(), 'data');
const studentsFile = path.join(dataDir, 'students.json');
const attendanceFile = path.join(dataDir, 'attendance.json');

function log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = {
        info: '\x1b[34m[INFO]\x1b[0m',
        success: '\x1b[32m[SUCCESS]\x1b[0m',
        warning: '\x1b[33m[WARNING]\x1b[0m',
        error: '\x1b[31m[ERROR]\x1b[0m'
    };
    console.log(`${timestamp} ${prefix[level] || prefix.info} ${message}`);
}

function verboseLog(message) {
    if (options.verbose) {
        log(message, 'info');
    }
}

async function migrate() {
    log('Starting JSON to SQLite migration...');
    log(`Data directory: ${dataDir}`);

    if (options.dryRun) {
        log('DRY RUN MODE - No changes will be made', 'warning');
    }

    // Check if data directory exists
    if (!fs.existsSync(dataDir)) {
        log(`Data directory does not exist: ${dataDir}`, 'error');
        process.exit(1);
    }

    // Initialize database manager
    const dbManager = new DatabaseManager({ dataDir });

    if (!options.dryRun) {
        const initResult = dbManager.initialize();
        if (!initResult) {
            log('Failed to initialize SQLite database', 'error');
            process.exit(1);
        }
        log('SQLite database initialized', 'success');
    }

    // Check if database already has data
    if (!options.dryRun) {
        const stats = dbManager.getStats();
        if ((stats.students > 0 || stats.attendance > 0) && !options.force) {
            log(`Database already contains data (${stats.students} students, ${stats.attendance} attendance records)`, 'warning');
            log('Use --force to override existing data', 'warning');
            process.exit(1);
        }
    }

    let studentsCount = 0;
    let attendanceCount = 0;
    let errors = [];

    // Migrate students
    if (fs.existsSync(studentsFile)) {
        try {
            const studentsJson = fs.readFileSync(studentsFile, 'utf8');
            const students = JSON.parse(studentsJson);

            log(`Found ${students.length} students to migrate`);

            if (!options.dryRun && students.length > 0) {
                // Normalize student data
                const normalizedStudents = students.map(s => ({
                    ufid: s.ufid,
                    name: s.name,
                    email: s.email || null,
                    active: s.active !== false,
                    role: (s.role || 'volunteer').toLowerCase(),
                    expectedHoursPerWeek: Number(s.expectedHoursPerWeek || s.expected_hours_per_week || 0),
                    expectedDaysPerWeek: Number(s.expectedDaysPerWeek || s.expected_days_per_week || 0),
                    addedDate: s.addedDate || s.added_date || new Date().toISOString()
                }));

                const result = dbManager.importStudents(normalizedStudents);
                studentsCount = result.imported;

                if (result.errors.length > 0) {
                    errors.push(...result.errors.map(e => `Student ${e.ufid}: ${e.error}`));
                }

                verboseLog(`Migrated ${studentsCount} students`);
            } else {
                studentsCount = students.length;
            }
        } catch (error) {
            log(`Error reading students file: ${error.message}`, 'error');
            errors.push(`Students file: ${error.message}`);
        }
    } else {
        log('No students.json file found', 'warning');
    }

    // Migrate attendance
    if (fs.existsSync(attendanceFile)) {
        try {
            const attendanceJson = fs.readFileSync(attendanceFile, 'utf8');
            const attendance = JSON.parse(attendanceJson);

            log(`Found ${attendance.length} attendance records to migrate`);

            if (!options.dryRun && attendance.length > 0) {
                // Normalize attendance data
                const normalizedAttendance = attendance.map(r => ({
                    id: r.id,
                    ufid: r.ufid,
                    name: r.name || null,
                    action: r.action,
                    timestamp: r.timestamp,
                    synthetic: Boolean(r.synthetic),
                    pendingTimestamp: Boolean(r.pendingTimestamp || r.pending_timestamp),
                    pendingRecordId: r.pendingRecordId || r.pending_record_id || null,
                    resolvedAt: r.resolvedAt || r.resolved_at || null,
                    autoSignout: Boolean(r.autoSignout || r.auto_signout)
                }));

                const result = dbManager.importAttendance(normalizedAttendance);
                attendanceCount = result.imported;

                if (result.errors.length > 0) {
                    errors.push(...result.errors.map(e => `Attendance ${e.id}: ${e.error}`));
                }

                verboseLog(`Migrated ${attendanceCount} attendance records`);
            } else {
                attendanceCount = attendance.length;
            }
        } catch (error) {
            log(`Error reading attendance file: ${error.message}`, 'error');
            errors.push(`Attendance file: ${error.message}`);
        }
    } else {
        log('No attendance.json file found', 'warning');
    }

    // Summary
    log('');
    log('=== Migration Summary ===');
    log(`Students: ${studentsCount}`);
    log(`Attendance records: ${attendanceCount}`);

    if (errors.length > 0) {
        log(`Errors: ${errors.length}`, 'warning');
        if (options.verbose) {
            errors.forEach(e => log(`  - ${e}`, 'error'));
        }
    }

    if (!options.dryRun) {
        // Verify migration
        const finalStats = dbManager.getStats();
        log('');
        log('=== Database Statistics ===');
        log(`Students in DB: ${finalStats.students}`);
        log(`Attendance in DB: ${finalStats.attendance}`);
        log(`Database size: ${(finalStats.dbSize / 1024).toFixed(2)} KB`);
        log(`Database path: ${finalStats.dbPath}`);

        // Close database
        dbManager.close();
    }

    if (errors.length === 0) {
        log('');
        log('Migration completed successfully!', 'success');
    } else {
        log('');
        log('Migration completed with errors', 'warning');
        process.exit(1);
    }
}

// Run migration
migrate().catch(error => {
    log(`Migration failed: ${error.message}`, 'error');
    console.error(error);
    process.exit(1);
});
