const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class GoogleSheetsService {
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.sheets = null;
        this.auth = null;
    }

    // Initialize Google Sheets API
    async initialize() {
        try {
            const config = this.dataManager.getConfig();
            
            if (!config.googleSheets || !config.googleSheets.enabled) {
                return { success: false, error: 'Google Sheets not configured' };
            }

            // Check if credentials file exists
            const credentialsPath = path.join(this.dataManager.dataDir, 'google-credentials.json');
            if (!fs.existsSync(credentialsPath)) {
                return { success: false, error: 'Google credentials file not found' };
            }

            const credentials = JSON.parse(fs.readFileSync(credentialsPath));
            
            this.auth = new google.auth.GoogleAuth({
                credentials: credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets']
            });

            this.sheets = google.sheets({ version: 'v4', auth: this.auth });
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Create or update the header row
    async setupSheetHeaders(spreadsheetId, sheetName) {
        try {
            const headers = [
                'Timestamp',
                'UF ID', 
                'Name',
                'Action',
                'Date',
                'Time'
            ];

            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!A1:F1`,
                valueInputOption: 'RAW',
                resource: {
                    values: [headers]
                }
            });

            // Format header row
            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [
                        {
                            repeatCell: {
                                range: {
                                    sheetId: 0,
                                    startRowIndex: 0,
                                    endRowIndex: 1,
                                    startColumnIndex: 0,
                                    endColumnIndex: 6
                                },
                                cell: {
                                    userEnteredFormat: {
                                        backgroundColor: {
                                            red: 0.4,
                                            green: 0.49,
                                            blue: 0.91
                                        },
                                        textFormat: {
                                            foregroundColor: {
                                                red: 1.0,
                                                green: 1.0,
                                                blue: 1.0
                                            },
                                            bold: true
                                        }
                                    }
                                },
                                fields: 'userEnteredFormat(backgroundColor,textFormat)'
                            }
                        }
                    ]
                }
            });

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Sync attendance data to Google Sheets
    async syncAttendanceToSheets() {
        try {
            const initResult = await this.initialize();
            if (!initResult.success) {
                return initResult;
            }

            const config = this.dataManager.getConfig();
            const { spreadsheetId, sheetName } = config.googleSheets;

            // Setup headers
            await this.setupSheetHeaders(spreadsheetId, sheetName);

            // Get all attendance data
            const attendance = this.dataManager.getAttendance();
            
            // Prepare data for sheets
            const rows = attendance.map(record => {
                const date = new Date(record.timestamp);
                return [
                    record.timestamp,
                    record.ufid,
                    record.name,
                    record.action,
                    date.toDateString(),
                    date.toLocaleTimeString()
                ];
            });

            if (rows.length === 0) {
                return { success: true, message: 'No attendance data to sync' };
            }

            // Clear existing data (except headers) and add new data
            const range = `${sheetName}!A2:F${rows.length + 1}`;
            
            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range,
                valueInputOption: 'RAW',
                resource: {
                    values: rows
                }
            });

            return { 
                success: true, 
                recordsSynced: rows.length,
                spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Sync only today's attendance
    async syncTodaysAttendance() {
        try {
            const initResult = await this.initialize();
            if (!initResult.success) {
                return initResult;
            }

            const config = this.dataManager.getConfig();
            const { spreadsheetId, sheetName } = config.googleSheets;

            const todaysAttendance = this.dataManager.getTodaysAttendance();
            
            if (todaysAttendance.length === 0) {
                return { success: true, message: 'No attendance data for today' };
            }

            // Get existing data to find where to append
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetName}!A:A`
            });

            const existingRows = response.data.values ? response.data.values.length : 1;
            
            // Prepare today's data
            const rows = todaysAttendance.map(record => {
                const date = new Date(record.timestamp);
                return [
                    record.timestamp,
                    record.ufid,
                    record.name,
                    record.action,
                    date.toDateString(),
                    date.toLocaleTimeString()
                ];
            });

            // Append to sheet
            await this.sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A${existingRows + 1}`,
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: rows
                }
            });

            return { 
                success: true, 
                recordsSynced: rows.length,
                message: 'Today\'s attendance synced successfully'
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Sync single attendance record (for real-time updates)
    async syncSingleRecord(record) {
        try {
            const initResult = await this.initialize();
            if (!initResult.success) {
                return initResult;
            }

            const config = this.dataManager.getConfig();
            const { spreadsheetId, sheetName } = config.googleSheets;

            const date = new Date(record.timestamp);
            const row = [
                record.timestamp,
                record.ufid,
                record.name,
                record.action,
                date.toDateString(),
                date.toLocaleTimeString()
            ];

            // Append single row
            await this.sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A:F`,
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: [row]
                }
            });

            return { success: true, message: 'Record synced to Google Sheets' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Test Google Sheets connection
    async testConnection() {
        try {
            const initResult = await this.initialize();
            if (!initResult.success) {
                return initResult;
            }

            const config = this.dataManager.getConfig();
            const { spreadsheetId } = config.googleSheets;

            // Try to get spreadsheet info
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId
            });

            return { 
                success: true, 
                spreadsheetTitle: response.data.properties.title,
                spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
                sheetCount: response.data.sheets.length
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Create a new spreadsheet (optional helper)
    async createSpreadsheet(title) {
        try {
            const initResult = await this.initialize();
            if (!initResult.success) {
                return initResult;
            }

            const response = await this.sheets.spreadsheets.create({
                resource: {
                    properties: {
                        title: title || 'Lab Attendance Data'
                    },
                    sheets: [{
                        properties: {
                            title: 'Attendance'
                        }
                    }]
                }
            });

            const spreadsheetId = response.data.spreadsheetId;
            
            // Setup headers in the new sheet
            await this.setupSheetHeaders(spreadsheetId, 'Attendance');

            return {
                success: true,
                spreadsheetId,
                spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
                title: response.data.properties.title
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Get sheet data (for verification)
    async getSheetData(maxRows = 100) {
        try {
            const initResult = await this.initialize();
            if (!initResult.success) {
                return initResult;
            }

            const config = this.dataManager.getConfig();
            const { spreadsheetId, sheetName } = config.googleSheets;

            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetName}!A1:F${maxRows}`
            });

            return {
                success: true,
                data: response.data.values || [],
                rowCount: response.data.values ? response.data.values.length : 0
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Save Google credentials
    saveCredentials(credentialsData) {
        try {
            const credentialsPath = path.join(this.dataManager.dataDir, 'google-credentials.json');
            fs.writeFileSync(credentialsPath, JSON.stringify(credentialsData, null, 2));
            return { success: true, path: credentialsPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Check if credentials exist
    hasCredentials() {
        const credentialsPath = path.join(this.dataManager.dataDir, 'google-credentials.json');
        return fs.existsSync(credentialsPath);
    }

    // Enable auto-sync (sync after each attendance record)
    async enableAutoSync() {
        try {
            const config = this.dataManager.getConfig();
            config.googleSheets = config.googleSheets || {};
            config.googleSheets.autoSync = true;
            
            fs.writeFileSync(this.dataManager.configFile, JSON.stringify(config, null, 2));
            return { success: true, message: 'Auto-sync enabled' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Disable auto-sync
    async disableAutoSync() {
        try {
            const config = this.dataManager.getConfig();
            config.googleSheets = config.googleSheets || {};
            config.googleSheets.autoSync = false;
            
            fs.writeFileSync(this.dataManager.configFile, JSON.stringify(config, null, 2));
            return { success: true, message: 'Auto-sync disabled' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Get sync status
    getSyncStatus() {
        const config = this.dataManager.getConfig();
        return {
            enabled: config.googleSheets?.enabled || false,
            autoSync: config.googleSheets?.autoSync || false,
            hasCredentials: this.hasCredentials(),
            spreadsheetId: config.googleSheets?.spreadsheetId || '',
            sheetName: config.googleSheets?.sheetName || 'Attendance'
        };
    }
}

module.exports = GoogleSheetsService;