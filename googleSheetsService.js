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
            const headers = ['Timestamp', 'UF ID', 'Name', 'Action', 'Date', 'Time', 'Source'];
            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!A1:G1`,
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
                                startColumnIndex: 0, endColumnIndex: 7
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
                const source = record.synthetic ? 'auto' : 'manual';
                return [
                    record.timestamp,
                    record.ufid,
                    record.name,
                    record.action,
                    date.toDateString(),
                    date.toLocaleTimeString(),
                    source
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
                const source = record.synthetic ? 'auto' : 'manual';

                return [
                    record.timestamp,
                    record.ufid,
                    record.name,
                    record.action,
                    date.toDateString(),
                    date.toLocaleTimeString(),
                    source
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
            const source = record.synthetic ? 'auto' : 'manual';
            const row = [
                record.timestamp,
                record.ufid,
                record.name,
                record.action,
                date.toDateString(),
                date.toLocaleTimeString(),
                source
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

    // helper: 0 -> A, 1 -> B, ...
    colLetterFromIndex(idx) {
        let s = '';
        while (idx >= 0) {
            s = String.fromCharCode((idx % 26) + 65) + s;
            idx = Math.floor(idx / 26) - 1;
        }
        return s;
    }


    // Generate daily summary data
    async upsertDailyHours({ dateLike, summaries, summarySheetName = 'Daily Summary', colorAbsences = true }) {
        const init = await this.initialize();
        if (!init.success) return init;

        const { spreadsheetId } = this.dataManager.getConfig().googleSheets;
        const sheets = this.sheets;

        // 1) Ensure the summary sheet exists (headers in A1:B1)
        const meta = await sheets.spreadsheets.get({ spreadsheetId });
        let sheet = meta.data.sheets.find(s => s.properties.title === summarySheetName);
        let sheetId;
        if (!sheet) {
            const addRes = await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [{ addSheet: { properties: { title: summarySheetName } } }]
                }
            });
            sheetId = addRes.data.replies[0].addSheet.properties.sheetId;
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${summarySheetName}!A1:B1`,
                valueInputOption: 'RAW',
                resource: { values: [['UF ID', 'Name']] }
            });
        } else {
            sheetId = sheet.properties.sheetId;
        }

        // 2) Column header "MM/DD" for this date
        const d = new Date(dateLike);
        const label = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;

        // 3) Read header row, add date column if missing
        const headerResp = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${summarySheetName}!1:1`
        });
        const header = headerResp.data.values?.[0] || [];
        let dateColIdx = header.indexOf(label);
        if (dateColIdx === -1) {
            const newIdx = header.length; // zero-based
            const colLetter = this.colLetterFromIndex(newIdx);
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${summarySheetName}!${colLetter}1:${colLetter}1`,
                valueInputOption: 'RAW',
                resource: { values: [[label]] }
            });
            dateColIdx = newIdx;
        }

        // 4) Map UFID -> existing row
        const tableResp = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${summarySheetName}!A:B`
        });
        const rows = tableResp.data.values || []; // includes header at [0]
        const mapUFIDtoRow = new Map();
        for (let r = 1; r < rows.length; r++) {
            const ufid = rows[r][0];
            if (ufid) mapUFIDtoRow.set(String(ufid), r + 1); // 1-based row
        }

        // 5) Ensure rows exist for each student; collect values for the date column
        const appendRows = [];
        for (const s of summaries) {
            const ufid = String(s.ufid || '');
            const name = s.name || 'Unknown';
            if (!mapUFIDtoRow.get(ufid)) appendRows.push([ufid, name]);
        }
        if (appendRows.length) {
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${summarySheetName}!A:B`,
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: { values: appendRows }
            });
            // refresh mapping
            const refresh = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${summarySheetName}!A:B`
            });
            const refreshed = refresh.data.values || [];
            mapUFIDtoRow.clear();
            for (let r = 1; r < refreshed.length; r++) {
                const ufid = refreshed[r][0];
                if (ufid) mapUFIDtoRow.set(String(ufid), r + 1);
            }
        }

        // Build values for this date column
        const valuesByRow = [];
        for (const s of summaries) {
            const ufid = String(s.ufid || '');
            const rowNumber = mapUFIDtoRow.get(ufid);
            if (!rowNumber) continue;

            const hadAuto = s.sessions?.some(x => x.syntheticOut);
            const isAbsent = !!s.absent;
            // hours text with [auto] only when there was a synthetic sign-out
            const cellVal = isAbsent ? 'A' : (hadAuto ? `${s.totalHours} [auto]` : String(s.totalHours ?? 0));
            valuesByRow.push({ rowNumber, val: cellVal });
        }

        // 6) Write contiguous block (Caution: sparse -> fill blanks with '')
        const colLetter = this.colLetterFromIndex(dateColIdx);
        const maxRow = Math.max(...valuesByRow.map(v => v.rowNumber), 2);
        const bucket = Array.from({ length: maxRow - 1 }, () => ['']); // rows 2..maxRow
        for (const { rowNumber, val } of valuesByRow) {
            const zero = rowNumber - 2;
            if (zero >= 0 && zero < bucket.length) bucket[zero] = [val];
        }

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${summarySheetName}!${colLetter}2:${colLetter}${maxRow}`,
            valueInputOption: 'RAW',
            resource: { values: bucket }
        });

        // 7) (Optional) Color all "A" in THIS date column red with white text
        if (colorAbsences) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [{
                        addConditionalFormatRule: {
                            rule: {
                                ranges: [{
                                    sheetId,
                                    startRowIndex: 1,                // from row 2
                                    endRowIndex: maxRow,
                                    startColumnIndex: dateColIdx,    // this date column only
                                    endColumnIndex: dateColIdx + 1
                                }],
                                booleanRule: {
                                    condition: {
                                        type: 'TEXT_EQ',
                                        values: [{ userEnteredValue: 'A' }]
                                    },
                                    format: {
                                        backgroundColor: { red: 0.94, green: 0.26, blue: 0.26 }, // ~#ef4444
                                        textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true }
                                    }
                                }
                            },
                            index: 0
                        }
                    }]
                }
            });
        }

        return { success: true, sheet: summarySheetName, date: label, rowsUpdated: valuesByRow.length };
    }

    // Append ALL rows for a specific calendar day
    async syncAttendanceForDate(dateLike, sheetNameOpt) {
        const init = await this.initialize();
        if (!init.success) return init;

        const cfg = this.dataManager.getConfig();
        const spreadsheetId = cfg.googleSheets.spreadsheetId;
        const sheetName = sheetNameOpt || (cfg.googleSheets.sheetName || 'Attendance');

        // Pull just that day’s records
        const dayRecords = this.dataManager.getAttendanceForDate(dateLike);
        if (!dayRecords.length) {
            return { success: true, message: 'No attendance data for that date' };
        }

        // Find where to append by checking current height of column A
        const resp = await this.sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:A`
        });
        const existingRows = resp.data.values ? resp.data.values.length : 1;

        // Convert to rows
        const rows = dayRecords.map(r => {
            const d = new Date(r.timestamp);
            return [
                r.timestamp,
                r.ufid,
                r.name,
                r.action,
                d.toDateString(),
                d.toLocaleTimeString()
            ];
        });

        // Append
        await this.sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A${existingRows + 1}`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: { values: rows }
        });

        return { success: true, appended: rows.length };
    }

}

module.exports = GoogleSheetsService;