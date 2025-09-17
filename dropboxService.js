const { Dropbox } = require('dropbox');
const fs = require('fs');
const path = require('path');

class DropboxService {
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.dropbox = null;
    }

    // Initialize Dropbox with access token
    initialize(accessToken) {
        if (accessToken) {
            this.dropbox = new Dropbox({ accessToken });
            return true;
        }
        return false;
    }

    // Test Dropbox connection
    async testConnection() {
        if (!this.dropbox) {
            return { success: false, error: 'Dropbox not configured' };
        }

        try {
            const response = await this.dropbox.usersGetCurrentAccount();
            return { 
                success: true, 
                user: response.result.name,
                email: response.result.email
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Upload file to Dropbox
    async uploadFile(localPath, dropboxPath) {
        if (!this.dropbox) {
            return { success: false, error: 'Dropbox not configured' };
        }

        try {
            const fileBuffer = fs.readFileSync(localPath);
            
            const response = await this.dropbox.filesUpload({
                path: dropboxPath,
                contents: fileBuffer,
                mode: 'overwrite',
                autorename: true
            });

            return { 
                success: true, 
                path: response.result.path_display,
                size: response.result.size
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Upload weekly report
    async uploadWeeklyReport() {
        try {
            const config = this.dataManager.getConfig();
            if (!config.dropbox || !config.dropbox.enabled) {
                return { success: false, error: 'Dropbox not enabled' };
            }

            this.initialize(config.dropbox.accessToken);

            // Generate report
            const reportResult = this.dataManager.saveWeeklyReportToFile();
            if (!reportResult.success) {
                return { success: false, error: 'Failed to generate report' };
            }

            // Upload to Dropbox
            const fileName = path.basename(reportResult.filePath);
            const dropboxPath = `/UF_Lab_Reports/${fileName}`;
            
            const uploadResult = await this.uploadFile(reportResult.filePath, dropboxPath);
            
            if (uploadResult.success) {
                return {
                    success: true,
                    message: 'Weekly report uploaded to Dropbox',
                    path: uploadResult.path,
                    localPath: reportResult.filePath
                };
            } else {
                return uploadResult;
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Backup all data to Dropbox
    async backupToDropbox() {
        try {
            const config = this.dataManager.getConfig();
            if (!config.dropbox || !config.dropbox.enabled) {
                return { success: false, error: 'Dropbox not enabled' };
            }

            this.initialize(config.dropbox.accessToken);

            // Create backup
            const backupResult = this.dataManager.backupData();
            if (!backupResult.success) {
                return { success: false, error: 'Failed to create backup' };
            }

            // Upload backup to Dropbox
            const fileName = path.basename(backupResult.backupFile);
            const dropboxPath = `/UF_Lab_Backups/${fileName}`;
            
            const uploadResult = await this.uploadFile(backupResult.backupFile, dropboxPath);
            
            if (uploadResult.success) {
                return {
                    success: true,
                    message: 'Data backup uploaded to Dropbox',
                    path: uploadResult.path,
                    localPath: backupResult.backupFile
                };
            } else {
                return uploadResult;
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // List files in Dropbox folder
    async listFiles(folderPath = '') {
        if (!this.dropbox) {
            return { success: false, error: 'Dropbox not configured' };
        }

        try {
            const response = await this.dropbox.filesListFolder({
                path: folderPath
            });

            const files = response.result.entries.map(entry => ({
                name: entry.name,
                path: entry.path_display,
                size: entry.size,
                modified: entry.server_modified,
                type: entry['.tag']
            }));

            return { success: true, files };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Download file from Dropbox
    async downloadFile(dropboxPath, localPath) {
        if (!this.dropbox) {
            return { success: false, error: 'Dropbox not configured' };
        }

        try {
            const response = await this.dropbox.filesDownload({ path: dropboxPath });
            fs.writeFileSync(localPath, response.result.fileBinary);
            
            return { 
                success: true, 
                localPath,
                size: response.result.fileBinary.length
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Get Dropbox space usage
    async getSpaceUsage() {
        if (!this.dropbox) {
            return { success: false, error: 'Dropbox not configured' };
        }

        try {
            const response = await this.dropbox.usersGetSpaceUsage();
            const used = response.result.used;
            const allocated = response.result.allocation.allocated;
            
            return {
                success: true,
                used: used,
                allocated: allocated,
                available: allocated - used,
                usedPercent: ((used / allocated) * 100).toFixed(2)
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = DropboxService;