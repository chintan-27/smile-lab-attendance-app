const fs = require('fs');
const path = require('path');

class Logger {
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.logFile = path.join(dataManager.dataDir, 'system.log');
        this.maxLogSize = 10 * 1024 * 1024; // 10MB
        this.maxBackups = 5;
    }

    // Log levels: info, warning, error, debug
    log(level, category, message, user = 'system', metadata = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            category,
            message,
            user,
            metadata,
            pid: process.pid
        };

        // Write to file
        this.writeToFile(logEntry);
        
        // Console output in development
        if (process.env.NODE_ENV === 'development') {
            console.log(`[${timestamp}] ${level.toUpperCase()} [${category}] ${message}`);
        }

        return logEntry;
    }

    info(category, message, user = 'system', metadata = {}) {
        return this.log('info', category, message, user, metadata);
    }

    warning(category, message, user = 'system', metadata = {}) {
        return this.log('warning', category, message, user, metadata);
    }

    error(category, message, user = 'system', metadata = {}) {
        return this.log('error', category, message, user, metadata);
    }

    debug(category, message, user = 'system', metadata = {}) {
        if (process.env.NODE_ENV === 'development') {
            return this.log('debug', category, message, user, metadata);
        }
    }

    writeToFile(logEntry) {
        try {
            const logLine = JSON.stringify(logEntry) + '\n';
            
            // Check file size and rotate if necessary
            if (fs.existsSync(this.logFile)) {
                const stats = fs.statSync(this.logFile);
                if (stats.size > this.maxLogSize) {
                    this.rotateLog();
                }
            }
            
            fs.appendFileSync(this.logFile, logLine);
        } catch (error) {
            console.error('Failed to write log:', error);
        }
    }

    rotateLog() {
        try {
            // Rotate existing backups
            for (let i = this.maxBackups - 1; i > 0; i--) {
                const oldFile = `${this.logFile}.${i}`;
                const newFile = `${this.logFile}.${i + 1}`;
                
                if (fs.existsSync(oldFile)) {
                    if (i === this.maxBackups - 1) {
                        fs.unlinkSync(oldFile); // Delete oldest
                    } else {
                        fs.renameSync(oldFile, newFile);
                    }
                }
            }
            
            // Move current log to .1
            if (fs.existsSync(this.logFile)) {
                fs.renameSync(this.logFile, `${this.logFile}.1`);
            }
        } catch (error) {
            console.error('Failed to rotate log:', error);
        }
    }

    // Get recent logs
    getRecentLogs(limit = 100, level = null, category = null) {
        try {
            if (!fs.existsSync(this.logFile)) {
                return [];
            }

            const content = fs.readFileSync(this.logFile, 'utf8');
            const lines = content.trim().split('\n').filter(line => line);
            
            let logs = lines.map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            }).filter(log => log !== null);

            // Filter by level and category if specified
            if (level) {
                logs = logs.filter(log => log.level === level);
            }
            if (category) {
                logs = logs.filter(log => log.category === category);
            }

            // Return most recent first
            return logs.reverse().slice(0, limit);
        } catch (error) {
            console.error('Failed to read logs:', error);
            return [];
        }
    }

    // Clear all logs
    clearLogs() {
        try {
            if (fs.existsSync(this.logFile)) {
                fs.unlinkSync(this.logFile);
            }
            
            // Also clear backup files
            for (let i = 1; i <= this.maxBackups; i++) {
                const backupFile = `${this.logFile}.${i}`;
                if (fs.existsSync(backupFile)) {
                    fs.unlinkSync(backupFile);
                }
            }
            
            this.info('system', 'All logs cleared');
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Export logs to file
    exportLogs(outputPath, days = 30) {
        try {
            const logs = this.getRecentLogs(10000); // Get many logs
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - days);
            
            const filteredLogs = logs.filter(log => 
                new Date(log.timestamp) >= cutoffDate
            );
            
            const csvContent = 'Timestamp,Level,Category,Message,User,Metadata\n' +
                filteredLogs.map(log => 
                    `"${log.timestamp}","${log.level}","${log.category}","${log.message}","${log.user}","${JSON.stringify(log.metadata).replace(/"/g, '""')}"`
                ).join('\n');
            
            fs.writeFileSync(outputPath, csvContent);
            return { success: true, exportedCount: filteredLogs.length };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = Logger;