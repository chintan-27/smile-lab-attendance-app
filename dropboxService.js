const { Dropbox, DropboxAuth } = require('dropbox');
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const querystring = require('querystring');
const crypto = require('crypto');

let shellOpenExternal = null;
try {
    // If running inside Electron main, prefer shell.openExternal
    shellOpenExternal = require('electron').shell.openExternal;
} catch { }

function sha256(buf) {
    const h = crypto.createHash('sha256');
    h.update(buf);
    return h.digest('hex');
}

function readJsonSafe(p) {
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return null; }
}

function writeJsonAtomic(p, obj) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p); // atomic on most platforms
}

const DPX_ROOT = '/UF-Lab-Attendance';
const DPX_DATA = `${DPX_ROOT}/data`;
const DPX_BACKUPS = `${DPX_ROOT}/backups`;

// Only these files are team-shared (skip config.json)
const SYNC_FILES = ['students.json', 'attendance.json'];

class DropboxService {
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.dropbox = null;
    }

    // -------------------------
    // Config persistence helper
    // -------------------------
    _saveDropboxConfig(partial) {
        const config = this.dataManager.getConfig() || {};
        config.dropbox = Object.assign({}, config.dropbox || {}, partial);

        if (typeof this.dataManager.updateConfig === 'function') {
            this.dataManager.updateConfig(config);
        } else if (typeof this.dataManager.setConfig === 'function') {
            this.dataManager.setConfig(config);
        } else if (typeof this.dataManager.saveConfig === 'function') {
            this.dataManager.saveConfig(config);
        } else {
            console.warn('DropboxService: could not persist config (no updateConfig/setConfig/saveConfig)');
        }
        return config.dropbox;
    }

    // -----------
    // Initialize
    // -----------
    initializeWithAccessToken(accessToken) {
        if (accessToken) {
            this.dropbox = new Dropbox({ accessToken });
            return true;
        }
        return false;
    }

    initializeWithOAuth(appKey, appSecret, refreshToken) {
        if (appKey && appSecret && refreshToken) {
            this.dropbox = new Dropbox({
                clientId: appKey,
                clientSecret: appSecret,
                refreshToken
            });
            return true;
        }
        return false;
    }

    initializeFromConfig() {
        const config = this.dataManager.getConfig();
        const d = config?.dropbox || {};

        // Prefer OAuth (refresh token)
        if (this.initializeWithOAuth(d.appKey, d.appSecret, d.refreshToken)) {
            return { success: true, mode: 'oauth' };
        }

        // Fallback: old access token
        if (this.initializeWithAccessToken(d.accessToken)) {
            return { success: true, mode: 'token' };
        }

        return { success: false, error: 'Dropbox not configured' };
    }

    // ---------------------------------------------------------
    // One-time OAuth flow to obtain & save a REFRESH TOKEN
    // ---------------------------------------------------------
    /**
     * Launch browser -> approve -> save refresh token to config.
     * Make sure the Dropbox App Console has Redirect URI: http://localhost:53682/auth
     */
    async generateAndSaveRefreshToken(opts = {}) {
        const config = this.dataManager.getConfig() || {};
        const d = config.dropbox || {};

        const appKey = opts.appKey || d.appKey;
        const appSecret = opts.appSecret || d.appSecret;
        if (!appKey || !appSecret) {
            return { success: false, error: 'Missing appKey/appSecret. Enter them first.' };
        }

        // You can change the port/redirect if you like; must match the Dropbox App Console
        const port = opts.port || 53682;
        const redirectUri = `http://localhost:${port}/auth`;

        // Scopes needed for your features
        const scopes = (opts.scopes && Array.isArray(opts.scopes) ? opts.scopes : [
            'account_info.read',
            'files.metadata.read',
            'files.content.write',
            // 'files.content.read', // uncomment if you need download
        ]).join(' ');

        // Build authorize URL
        const authorize = new URL('https://www.dropbox.com/oauth2/authorize');
        authorize.searchParams.set('client_id', appKey);
        authorize.searchParams.set('response_type', 'code');
        authorize.searchParams.set('token_access_type', 'offline'); // get refresh_token
        authorize.searchParams.set('redirect_uri', redirectUri);
        authorize.searchParams.set('scope', scopes);

        // Local server to receive the ?code
        const code = await new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                try {
                    const url = new URL(req.url, `http://localhost:${port}`);
                    if (url.pathname === '/auth') {
                        const code = url.searchParams.get('code');
                        if (!code) {
                            res.statusCode = 400;
                            res.end('Missing ?code');
                            server.close();
                            return reject(new Error('Missing code in callback'));
                        }
                        res.statusCode = 200;
                        res.end('Success! You can close this tab.');
                        server.close();
                        return resolve(code);
                    }
                    res.statusCode = 404;
                    res.end('Not found');
                } catch (e) {
                    res.statusCode = 500;
                    res.end('Server error');
                    server.close();
                    reject(e);
                }
            });

            server.listen(port, () => {
                const url = authorize.toString();
                if (typeof shellOpenExternal === 'function') {
                    shellOpenExternal(url).catch(() => { });
                } else {
                    try { require('open')(url); } catch { }
                    console.log('[Dropbox OAuth] Visit this URL to authorize:', url);
                }
            });

            // Optional timeout
            setTimeout(() => {
                try { server.close(); } catch { }
                reject(new Error('OAuth timeout waiting for user authorization'));
            }, 5 * 60 * 1000);
        });

        // Exchange code -> tokens
        const body = querystring.stringify({
            code,
            grant_type: 'authorization_code',
            client_id: appKey,
            client_secret: appSecret,
            redirect_uri: redirectUri
        });

        const tokenJson = await new Promise((resolve, reject) => {
            const req = require('https').request(
                'https://api.dropbox.com/oauth2/token',
                { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
                (res) => {
                    let data = '';
                    res.on('data', (c) => (data += c));
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data || '{}');
                            if (res.statusCode !== 200) {
                                return reject(new Error(`Token exchange failed [${res.statusCode}]: ${json.error_description || json.error || data}`));
                            }
                            resolve(json);
                        } catch (e) {
                            reject(e);
                        }
                    });
                }
            );
            req.on('error', reject);
            req.write(body);
            req.end();
        });

        const refreshToken = tokenJson.refresh_token;
        if (!refreshToken) {
            return { success: false, error: 'No refresh_token returned. Check scopes, redirect URI, and app settings.' };
        }

        // Save to config
        this._saveDropboxConfig({
            enabled: true,
            appKey,
            appSecret,
            refreshToken
        });

        return {
            success: true,
            refreshToken,
            scope: tokenJson.scope,
            tokenType: tokenJson.token_type
        };
    }

    // Quick wrapper that uses currently saved appKey/secret
    async interactiveConnect() {
        const cfg = this.dataManager.getConfig() || {};
        const d = cfg.dropbox || {};
        const appKey = d.appKey || process.env.DROPBOX_APP_KEY || '';
        const appSecret = d.appSecret || process.env.DROPBOX_APP_SECRET || '';

        if (!appKey || !appSecret) {
            return { success: false, error: 'App Key and App Secret are required before connecting.' };
        }

        // You must whitelist this exact URI in the Dropbox App Console
        const PORT = 53682;
        const redirectUri = `http://127.0.0.1:${PORT}/callback`;

        const state = String(Date.now()); // simple state value
        const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
        authUrl.searchParams.set('client_id', appKey);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('token_access_type', 'offline'); // ensures refresh_token
        authUrl.searchParams.set('state', state);

        // Fire up a tiny local server to catch the redirect
        return await new Promise((resolve) => {
            const server = http.createServer(async (req, res) => {
                try {
                    const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
                    if (urlObj.pathname !== '/callback') {
                        res.statusCode = 404;
                        res.end('Not found');
                        return;
                    }

                    const code = urlObj.searchParams.get('code');
                    const rcvdState = urlObj.searchParams.get('state');
                    const err = urlObj.searchParams.get('error');
                    const errDesc = urlObj.searchParams.get('error_description');

                    if (err) {
                        res.statusCode = 400;
                        res.end(`Dropbox error: ${err} ${errDesc ? '- ' + errDesc : ''}`);
                        server.close();
                        return resolve({ success: false, error: `${err}: ${errDesc || 'OAuth error'}` });
                    }
                    if (!code) {
                        res.statusCode = 400;
                        res.end('Missing "code" in callback.');
                        server.close();
                        return resolve({ success: false, error: 'Missing authorization code' });
                    }
                    if (rcvdState !== state) {
                        res.statusCode = 400;
                        res.end('State mismatch.');
                        server.close();
                        return resolve({ success: false, error: 'State mismatch' });
                    }

                    // Exchange code -> tokens via SDK (no PKCE; we use app secret)
                    const dbxAuth = new DropboxAuth({ clientId: appKey, clientSecret: appSecret });
                    let tokenResponse;
                    try {
                        tokenResponse = await dbxAuth.getAccessTokenFromCode(redirectUri, code);
                    } catch (ex) {
                        // Surface HTTP body for 400s
                        const message = ex?.error?.error_description || ex?.message || 'Token exchange failed';
                        res.statusCode = 400;
                        res.end(`Token exchange failed (400). ${message}`);
                        server.close();
                        return resolve({ success: false, error: `Token exchange failed: ${message}` });
                    }

                    const result = tokenResponse?.result || {};
                    const refreshToken = result.refresh_token;
                    const accessToken = result.access_token;

                    if (!refreshToken) {
                        res.statusCode = 400;
                        res.end('No refresh_token returned; ensure token_access_type=offline and redirect URI matches.');
                        server.close();
                        return resolve({ success: false, error: 'Dropbox did not return a refresh_token' });
                    }

                    // Persist to config.json
                    const save = this.dataManager.updateDropboxConfig({
                        enabled: true,
                        appKey,
                        appSecret,
                        refreshToken,           // long-lived
                        accessToken: accessToken || '' // optional, short-lived
                    });

                    if (!save?.success) {
                        res.statusCode = 500;
                        res.end('Connected, but failed to save credentials to config.json.');
                        server.close();
                        return resolve({ success: false, error: save?.error || 'Failed to save credentials' });
                    }

                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    res.end('<html><body style="font-family:system-ui;margin:2rem;">Dropbox connected. You can close this window.</body></html>');

                    server.close();
                    return resolve({ success: true });
                } catch (e) {
                    res.statusCode = 500;
                    res.end('Internal error: ' + e.message);
                    server.close();
                    return resolve({ success: false, error: e.message });
                }
            });

            server.listen(PORT, '127.0.0.1', () => {
                // Open the system browser to Dropbox’s consent screen
                try {
                    shell.openExternal(authUrl.toString());
                } catch (e) {
                    // Fallback logging; but normally this is available from electron
                    // User can manually paste the URL if needed
                    console.log('Open this URL:', authUrl.toString());
                }
            });
        });
    }



    // -------------
    // API methods
    // -------------
    async testConnection() {
        if (!this.dropbox) {
            const init = this.initializeFromConfig();
            if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
        }

        try {
            const response = await this.dropbox.usersGetCurrentAccount();
            return {
                success: true,
                user: response.result.name?.display_name,
                email: response.result.email
            };
        } catch (error) {
            const summary = error?.error?.error_summary || error?.message || JSON.stringify(error);
            return { success: false, error: summary };
        }
    }

    async ensureFolder(folderPath) {
        if (!this.dropbox) {
            const init = this.initializeFromConfig();
            if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
        }

        const pathArg = (!folderPath || folderPath === '/') ? '' : folderPath;
        if (pathArg === '') return { success: true, created: false };

        try {
            await this.dropbox.filesGetMetadata({ path: pathArg });
            return { success: true, created: false };
        } catch (err) {
            const summary = err?.error?.error_summary || '';
            if (summary.includes('path/not_found')) {
                await this.dropbox.filesCreateFolderV2({ path: pathArg, autorename: false });
                return { success: true, created: true };
            }
            return { success: false, error: summary || String(err) };
        }
    }

    async createDefaultFolders() {
        const a = await this.ensureFolder('/UF_Lab_Reports');
        if (!a.success) return a;
        const b = await this.ensureFolder('/UF_Lab_Backups');
        if (!b.success) return b;
        return { success: true, created: (a.created || b.created) };
    }

    async uploadFile(localPath, dropboxPath) {
        if (!this.dropbox) {
            const init = this.initializeFromConfig();
            if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
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
            const status = error?.status || error?.response?.status;
            const summary = error?.error?.error_summary || error?.message || JSON.stringify(error);
            if (String(summary).includes('path/not_found')) {
                return { success: false, error: 'Parent folder not found. Create it first or call ensureFolder().' };
            }
            if (status === 401) {
                return { success: false, error: `Unauthorized (401). Token invalid/expired or missing scope. ${summary}` };
            }
            if (status === 403) {
                return { success: false, error: `Forbidden (403). Missing scope (need files.content.write) or access issue. ${summary}` };
            }
            return { success: false, error: summary };
        }
    }

    async uploadWeeklyReport() {
        try {
            const config = this.dataManager.getConfig();
            if (!config.dropbox || !config.dropbox.enabled) {
                return { success: false, error: 'Dropbox not enabled' };
            }

            const init = this.initializeFromConfig();
            if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };

            const reportResult = this.dataManager.saveWeeklyReportToFile();
            if (!reportResult.success) {
                return { success: false, error: 'Failed to generate report' };
            }

            const parent = '/UF_Lab_Reports';
            const ensured = await this.ensureFolder(parent);
            if (!ensured.success) return { success: false, error: `Cannot ensure ${parent}: ${ensured.error}` };

            const fileName = path.basename(reportResult.filePath);
            const dropboxPath = `${parent}/${fileName}`;

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

    async backupToDropbox() {
        try {
            const config = this.dataManager.getConfig();
            if (!config.dropbox || !config.dropbox.enabled) {
                return { success: false, error: 'Dropbox not enabled' };
            }

            const init = this.initializeFromConfig();
            if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };

            const backupResult = this.dataManager.backupData();
            if (!backupResult.success) {
                return { success: false, error: 'Failed to create backup' };
            }

            const parent = '/UF_Lab_Backups';
            const ensured = await this.ensureFolder(parent);
            if (!ensured.success) return { success: false, error: `Cannot ensure ${parent}: ${ensured.error}` };

            const fileName = path.basename(backupResult.backupFile);
            const dropboxPath = `${parent}/${fileName}`;

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

    async listFiles(folderPath = '') {
        if (!this.dropbox) {
            const init = this.initializeFromConfig();
            if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
        }

        try {
            const pathArg = (!folderPath || folderPath === '/') ? '' : folderPath;
            const response = await this.dropbox.filesListFolder({ path: pathArg });

            const files = response.result.entries.map(entry => ({
                name: entry.name,
                path: entry.path_display,
                size: entry.size,
                modified: entry.server_modified,
                type: entry['.tag']
            }));

            return { success: true, files };
        } catch (error) {
            const status = error?.status || error?.response?.status;
            const summary = error?.error?.error_summary || error?.message || JSON.stringify(error);
            if (String(summary).includes('path/not_found')) {
                return { success: true, files: [], note: 'Folder does not exist yet' };
            }
            return { success: false, error: `filesListFolder failed [${status ?? 'n/a'}]: ${summary}` };
        }
    }

    async downloadFile(dropboxPath, localPath) {
        if (!this.dropbox) {
            const init = this.initializeFromConfig();
            if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
        }

        try {
            const response = await this.dropbox.filesDownload({ path: dropboxPath });
            fs.writeFileSync(localPath, response.result.fileBinary);
            return { success: true, localPath, size: response.result.fileBinary.length };
        } catch (error) {
            const summary = error?.error?.error_summary || error?.message || JSON.stringify(error);
            return { success: false, error: summary };
        }
    }

    async getSpaceUsage() {
        if (!this.dropbox) {
            const init = this.initializeFromConfig();
            if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
        }

        try {
            const response = await this.dropbox.usersGetSpaceUsage();
            const used = response.result.used;
            const allocated = response.result.allocation.allocated;

            return {
                success: true,
                used,
                allocated,
                available: allocated - used,
                usedPercent: ((used / allocated) * 100).toFixed(2)
            };
        } catch (error) {
            const summary = error?.error?.error_summary || error?.message || JSON.stringify(error);
            return { success: false, error: summary };
        }
    }

    // -------------
    // Live Syncing
    // -------------
    async ensureDefaultFolders() {
        if (!this.dropbox) return { success: false, error: 'not initialized' };
        const mk = async (path) => {
            try { await this.dropbox.filesCreateFolderV2({ path }); }
            catch (e) {
                if (String(e?.error?.error_summary || '').includes('conflict/folder')) return;
                throw e;
            }
        };
        await mk(DPX_ROOT); await mk(DPX_DATA); await mk(DPX_BACKUPS);
        return { success: true };
    }

    async getMeta(pathLower) {
        try { return await this.dropbox.filesGetMetadata({ path: pathLower }); }
        catch (e) {
            if (String(e?.error)?.includes('path/not_found')) return null;
            throw e;
        }
    }

    async downloadBuffer(dropboxPath) {
        const r = await this.dropbox.filesDownload({ path: dropboxPath });
        const file = r.result;
        // SDKs vary; normalize to Buffer
        const buf =
            file.fileBinary ?? file.fileBlob ?? file.fileBuffer ?? Buffer.from(file.fileBinary ?? '');
        return { buf: Buffer.isBuffer(buf) ? buf : Buffer.from(buf), serverModified: file.server_modified, meta: file };
    }

    async uploadBuffer(dropboxPath, buf) {
        await this.dropbox.filesUpload({
            path: dropboxPath,
            contents: buf,
            mode: { '.tag': 'overwrite' },
            mute: true
        });
    }

    async backupRemoteBeforeOverwrite(fileName, remoteMeta) {
        try {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = `${DPX_BACKUPS}/${fileName}.${ts}.json`;
            const { buf } = await this.downloadBuffer(`${DPX_DATA}/${fileName}`);
            await this.uploadBuffer(backupPath, buf);
        } catch {
            // best-effort; do not fail sync because backup failed
        }
    }

    // Merge attendance: append-safe dedupe
    mergeAttendance(localArr, remoteArr) {
        const key = (r) => (r.id != null ? `id:${r.id}` : `k:${r.ufid}|${r.timestamp}|${r.action}`);
        const map = new Map();
        (remoteArr || []).forEach(r => map.set(key(r), r));
        (localArr || []).forEach(r => map.set(key(r), r)); // local wins on same key
        // Stable-ish order by timestamp
        return Array.from(map.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }

    // Students: newest file wins (mtime), simple replace
    chooseStudents(localArr, remoteArr, newerSide) {
        return newerSide === 'remote' ? (remoteArr || []) : (localArr || []);
    }

    async syncOne(fileName, localPath) {
        const dropboxPath = `${DPX_DATA}/${fileName}`;
        const remoteMeta = await this.getMeta(dropboxPath);
        const localExists = fs.existsSync(localPath);
        const remoteExists = !!remoteMeta;

        if (!localExists && !remoteExists) return { file: fileName, action: 'skip-none' };

        if (remoteExists && !localExists) {
            // pull
            const { buf } = await this.downloadBuffer(dropboxPath);
            writeJsonAtomic(localPath, JSON.parse(buf.toString('utf8')));
            return { file: fileName, action: 'pull-new' };
        }

        if (!remoteExists && localExists) {
            // push
            const buf = fs.readFileSync(localPath);
            await this.uploadBuffer(dropboxPath, buf);
            return { file: fileName, action: 'push-new' };
        }

        // both exist: decide by mtime/hash; attendance gets merge
        const localBuf = fs.readFileSync(localPath);
        const localHash = sha256(localBuf);
        const { buf: remoteBuf, serverModified } = await this.downloadBuffer(dropboxPath);
        const remoteHash = sha256(remoteBuf);

        if (localHash === remoteHash) return { file: fileName, action: 'noop' };

        const localMtime = fs.statSync(localPath).mtimeMs;
        const remoteMtime = new Date(serverModified).getTime();
        const newer = remoteMtime >= localMtime ? 'remote' : 'local';

        if (fileName === 'attendance.json') {
            // merge arrays
            const merged = this.mergeAttendance(
                JSON.parse(localBuf.toString('utf8') || '[]'),
                JSON.parse(remoteBuf.toString('utf8') || '[]')
            );
            // backup remote copy (optional safety) before overwriting either side
            if (newer === 'remote') await this.backupRemoteBeforeOverwrite(fileName, remoteMeta);
            writeJsonAtomic(localPath, merged);
            await this.uploadBuffer(dropboxPath, Buffer.from(JSON.stringify(merged, null, 2)));
            return { file: fileName, action: 'merge-attendance' };
        } else if (fileName === 'students.json') {
            const localArr = JSON.parse(localBuf.toString('utf8') || '[]');
            const remoteArr = JSON.parse(remoteBuf.toString('utf8') || '[]');
            const chosen = this.chooseStudents(localArr, remoteArr, newer);
            if (newer === 'remote') await this.backupRemoteBeforeOverwrite(fileName, remoteMeta);
            writeJsonAtomic(localPath, chosen);
            await this.uploadBuffer(dropboxPath, Buffer.from(JSON.stringify(chosen, null, 2)));
            return { file: fileName, action: `replace-students-${newer}` };
        } else {
            return { file: fileName, action: 'skip-unknown' };
        }
    }

    // Public: full reconcile for shared files
    async syncAll(dataDir) {
        if (!this.dropbox && !this.initializeFromConfig().success) {
            return { success: false, error: 'Dropbox not configured' };
        }
        await this.ensureDefaultFolders();
        const results = [];
        for (const f of SYNC_FILES) {
            try {
                const local = path.join(dataDir, f);
                results.push(await this.syncOne(f, local));
            } catch (e) {
                results.push({ file: f, action: 'error', error: e.message });
            }
        }
        return { success: true, results };
    }

    // For app-close: push local copies up (no pulling/merging)
    async pushAll(dataDir) {
        if (!this.dropbox && !this.initializeFromConfig().success) {
            return { success: false, error: 'Dropbox not configured' };
        }
        await this.ensureDefaultFolders();
        const results = [];
        for (const f of SYNC_FILES) {
            const local = path.join(dataDir, f);
            if (!fs.existsSync(local)) { results.push({ file: f, action: 'skip-missing' }); continue; }
            const buf = fs.readFileSync(local);
            try {
                await this.uploadBuffer(`${DPX_DATA}/${f}`, buf);
                results.push({ file: f, action: 'push' });
            } catch (e) {
                results.push({ file: f, action: 'error', error: e.message });
            }
        }
        return { success: true, results };
    }
}

module.exports = DropboxService;
