/**
 * faceService.js
 * Manages the InsightFace Python subprocess and provides a simple HTTP client.
 * Usage:
 *   const faceService = require('./faceService');
 *   await faceService.start();
 *   const result = await faceService.analyze(base64jpeg);  // { face: {...} | null }
 *   faceService.stop();
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

class FaceService {
    constructor() {
        this._proc  = null;
        this._port  = null;
        this._ready = false;
    }

    /**
     * Spawn the Python service.  Resolves when the process prints "READY:<port>".
     * @param {string} [python='python3']  Python executable name / path.
     * @param {string} [modelDir]          Optional override for InsightFace model cache dir.
     * @returns {Promise<void>}
     */
    start(python = 'python3', modelDir = undefined) {
        return new Promise((resolve, reject) => {
            const script = path.join(__dirname, 'face_service', 'face_service.py');
            const args   = modelDir ? [script, modelDir] : [script];

            this._proc = spawn(python, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
            });

            let stdout = '';

            this._proc.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
                const m = stdout.match(/READY:(\d+)/);
                if (m && !this._ready) {
                    this._port  = parseInt(m[1], 10);
                    this._ready = true;
                    console.log(`[FaceService] ready on port ${this._port}`);
                    resolve();
                }
            });

            this._proc.stderr.on('data', (chunk) => {
                const msg = chunk.toString();
                // Suppress expected noise; log actual errors
                if (!/INFO|WARNING|UserWarning|warn|albumentations/.test(msg)) {
                    console.error('[FaceService]', msg.trim());
                }
            });

            this._proc.on('error', (err) => {
                reject(new Error(`Failed to start face service (is python3 installed?): ${err.message}`));
            });

            this._proc.on('exit', (code) => {
                this._ready = false;
                if (code !== 0 && code !== null) {
                    console.error(`[FaceService] process exited with code ${code}`);
                }
            });

            // 90-second timeout — first run downloads InsightFace models (~50 MB)
            const timer = setTimeout(() => {
                if (!this._ready) reject(new Error('Face service startup timed out'));
            }, 90_000);

            // Don't hold the Node process open waiting for the timer
            if (timer.unref) timer.unref();
        });
    }

    /**
     * Detect the largest face in a JPEG frame.
     * @param {string} base64jpeg  Base64-encoded JPEG (no data-URI prefix).
     * @returns {Promise<{ face: object|null, error?: string }>}
     */
    analyze(base64jpeg) {
        if (!this._ready) return Promise.reject(new Error('Face service not ready'));
        return this._post('/analyze', { image: base64jpeg });
    }

    /** Clear the temporal liveness buffer in the Python service. */
    resetLiveness() {
        if (!this._ready) return Promise.resolve({ ok: true });
        return this._post('/reset-liveness', {});
    }

    /** @returns {Promise<{ ok: boolean }>} */
    health() {
        if (!this._ready) return Promise.reject(new Error('Face service not ready'));
        return this._get('/health');
    }

    stop() {
        if (this._proc) {
            this._proc.kill();
            this._proc  = null;
            this._ready = false;
            this._port  = null;
        }
    }

    get ready() { return this._ready; }

    // ---- private helpers ----

    _post(urlPath, body) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify(body);
            const options = {
                hostname: '127.0.0.1',
                port:     this._port,
                path:     urlPath,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end',  () => {
                    try   { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(6_000, () => { req.destroy(); reject(new Error('Face service request timed out')); });
            req.write(payload);
            req.end();
        });
    }

    _get(urlPath) {
        return new Promise((resolve, reject) => {
            http.get({ hostname: '127.0.0.1', port: this._port, path: urlPath }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end',  () => {
                    try   { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            }).on('error', reject);
        });
    }
}

module.exports = new FaceService();
