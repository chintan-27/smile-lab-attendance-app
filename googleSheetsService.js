const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class GoogleSheetsService {
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.sheets = null;
        this.auth = null;

    }
    static prepareCreds(raw) {
        if (!raw || !raw.client_email || !raw.private_key) {
            return { ok: false, error: 'Missing client_email or private_key in credentials JSON' };
        }
        const creds = { ...raw, private_key: raw.private_key.replace(/\\n/g, '\n') };
        return { ok: true, creds };
    }

    async getSheetMeta(spreadsheetId) {
        const res = await this.sheets.spreadsheets.get({ spreadsheetId });
        return res.data.sheets || [];
    }

    async getSheetIdByName(spreadsheetId, sheetName) {
        const sheets = await this.getSheetMeta(spreadsheetId);
        const found = sheets.find(s => s.properties?.title === sheetName);
        return found ? found.properties.sheetId : null;
    }

    async ensureSheetExists(spreadsheetId, sheetName) {
        let sheetId = await this.getSheetIdByName(spreadsheetId, sheetName);
        if (sheetId != null) return sheetId;

        // create it
        const res = await this.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
                requests: [{ addSheet: { properties: { title: sheetName } } }]
            }
        });
        sheetId = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
        return sheetId;
    }

    // Initialize Google Sheets API
    async initialize() {
        try {
            const config = this.dataManager.getConfig();
            const gs = config.googleSheets || {};
            if (!gs.enabled) {
                return { success: false, error: 'Google Sheets not configured' };
            }

            // must have spreadsheet ID and a sheet name
            if (!gs.spreadsheetId) {
                return { success: false, error: 'Spreadsheet ID is not set' };
            }
            const sheetName = gs.sheetName || 'Attendance';

            // load service account json from data/google-credentials.json
            const credentialsPath = path.join(this.dataManager.dataDir, 'google-credentials.json');
            if (!fs.existsSync(credentialsPath)) {
                return { success: false, error: 'Google credentials file not found (data/google-credentials.json)' };
            }
            const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
            if (raw.private_key && raw.private_key.includes('\\n')) {
                raw.private_key = raw.private_key.replace(/\\n/g, '\n');
            }

            const auth = new google.auth.GoogleAuth({
                credentials: raw,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            await (await auth.getClient()).getAccessToken(); // optional probe
            this.auth = auth;
            this.sheets = google.sheets({ version: 'v4', auth });
            this.clientEmail = raw.client_email;
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }


    // Create or update the header row
    async setupSheetHeaders(spreadsheetId, sheetName) {
        try {
            // make sure the tab exists and get its id
            const sheetId = await this.ensureSheetExists(spreadsheetId, sheetName);

            // write headers
            const headers = ['Timestamp', 'UF ID', 'Name', 'Action', 'Date', 'Time'];
            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!A1:F1`,
                valueInputOption: 'RAW',
                resource: { values: [headers] }
            });

            // format header row for THIS sheetId (not 0!)
            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [{
                        repeatCell: {
                            range: {
                                sheetId,
                                startRowIndex: 0, endRowIndex: 1,
                                startColumnIndex: 0, endColumnIndex: 6
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.4, green: 0.49, blue: 0.91 },
                                    textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    }]
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
        const cfg = this.dataManager.getConfig();
        const gs = cfg.googleSheets || {};
        const missing = [];
        if (!gs.enabled) missing.push('googleSheets.enabled');
        if (!gs.spreadsheetId) missing.push('googleSheets.spreadsheetId');
        if (!gs.sheetName) missing.push('googleSheets.sheetName');

        const credentialsPath = path.join(this.dataManager.dataDir, 'google-credentials.json');
        if (!fs.existsSync(credentialsPath)) missing.push('google-credentials.json');

        if (missing.length) {
            return { success: false, error: 'Not configured: ' + missing.join(', ') };
        }

        // Build auth & client the same way as everywhere else
        const init = await this.initialize();
        if (!init.success) return init;

        try {
            await this.sheets.spreadsheets.values.get({
                spreadsheetId: gs.spreadsheetId,
                range: `${gs.sheetName}!A1:A1`,
            });
            return { success: true };
        } catch (e) {
            const msg = e?.errors?.[0]?.message || e?.message || String(e);
            let helpful = msg;
            if (/The caller does not have permission|403/i.test(msg)) {
                helpful = 'Permission denied: share the spreadsheet with the service account (Editor).';
            } else if (/Requested entity was not found|404/i.test(msg)) {
                helpful = 'Spreadsheet not found: check the Spreadsheet ID.';
            } else if (/Unable to parse range|sheet.*not found|invalid range/i.test(msg)) {
                helpful = 'Sheet tab not found: verify the sheetName (tab title).';
            } else if (/invalid_grant|private key|malformed/i.test(msg)) {
                helpful = 'Credential error: verify client_email/private_key in google-credentials.json.';
            }
            return { success: false, error: helpful };
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
            if (credentialsData?.private_key &&
                credentialsData.private_key.includes('\\n') &&
                !credentialsData.private_key.includes('\n')) {
                credentialsData.private_key = credentialsData.private_key.replace(/\\n/g, '\n');
            }
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