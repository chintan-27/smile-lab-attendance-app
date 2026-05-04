/**
 * faceService.js
 * Manages the InsightFace Python subprocess with automatic environment setup.
 * On first run: finds the best available Python (>=3.9 preferred), creates a
 * .venv, installs requirements, and optionally installs orbbec-astra-raw for
 * depth+IR liveness if Python >=3.9 is available.
 */

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs   = require('fs');

class FaceService {
    constructor() {
        this._proc  = null;
        this._port  = null;
        this._ready = false;
    }

    // ── Environment setup ────────────────────────────────────────────────────

    /**
     * Find the best available Python executable.
     * Prefers Python 3.9 (needed for orbbec-astra-raw), then newer versions,
     * then any Python 3.x as a last resort.
     */
    _findBestPython() {
        const candidates = process.platform === 'win32'
            ? [
                // Windows: use py launcher with version flags (avoids picking 3.14 which is too new)
                ['py', ['-3.12', '--version'], 'py -3.12'],
                ['py', ['-3.11', '--version'], 'py -3.11'],
                ['py', ['-3.13', '--version'], 'py -3.13'],
                ['py', ['-3.10', '--version'], 'py -3.10'],
                ['py', ['-3.9', '--version'], 'py -3.9'],
                ['python', ['--version'], 'python'],
            ]
            : [
                // macOS/Linux: versioned binaries, Homebrew, then generic
                ['python3.12', ['--version'], 'python3.12'],
                ['python3.11', ['--version'], 'python3.11'],
                ['python3.13', ['--version'], 'python3.13'],
                ['python3.10', ['--version'], 'python3.10'],
                ['python3.9', ['--version'], 'python3.9'],
                ['/opt/homebrew/bin/python3.12', ['--version'], '/opt/homebrew/bin/python3.12'],
                ['/opt/homebrew/bin/python3.11', ['--version'], '/opt/homebrew/bin/python3.11'],
                ['/opt/homebrew/bin/python3.10', ['--version'], '/opt/homebrew/bin/python3.10'],
                ['/opt/homebrew/bin/python3.9', ['--version'], '/opt/homebrew/bin/python3.9'],
                ['/usr/local/bin/python3.11', ['--version'], '/usr/local/bin/python3.11'],
                ['/usr/local/bin/python3.10', ['--version'], '/usr/local/bin/python3.10'],
                ['python3', ['--version'], 'python3'],
                ['python', ['--version'], 'python'],
            ];

        for (const [exe, args, label] of candidates) {
            const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 3000 });
            if (r.status === 0) {
                const ver = (r.stdout || r.stderr || '').trim();
                const minor = parseInt((ver.match(/Python \d+\.(\d+)/) || [])[1] || '0', 10);
                // Skip Python 3.14+ — too new, many packages lack wheels
                if (minor >= 14) {
                    console.log(`[FaceService] skipping ${label}: ${ver} (too new)`);
                    continue;
                }
                console.log(`[FaceService] found ${label}: ${ver}`);
                // For py launcher, return the actual command with version flag
                if (exe === 'py') {
                    const verFlag = args[0]; // e.g. '-3.12'
                    return { exe: 'py', version: ver, args: [verFlag] };
                }
                return { exe, version: ver, args: [] };
            }
        }

        console.warn('[FaceService] no Python found — face service unavailable');
        return null;
    }

    /**
     * Check if a Python executable can import the given modules.
     */
    _canImport(pythonExe, modules) {
        return new Promise((resolve) => {
            const code = modules.map(m => `import ${m}`).join('; ');
            const proc = spawn(pythonExe, ['-c', code], { stdio: 'pipe' });
            const timer = setTimeout(() => { proc.kill(); resolve(false); }, 10_000);
            proc.on('close', (c) => { clearTimeout(timer); resolve(c === 0); });
            proc.on('error', () => { clearTimeout(timer); resolve(false); });
        });
    }

    /**
     * Run a subprocess and stream its output to the console.
     */
    _runSetupStep(exe, args, label) {
        return new Promise((resolve, reject) => {
            console.log(`[FaceService:setup] ${label}...`);
            const proc = spawn(exe, args, { stdio: 'pipe' });
            proc.stdout.on('data', d => {
                d.toString().split('\n').forEach(l => { if (l.trim()) console.log(`[FaceService:setup] ${l.trim()}`); });
            });
            proc.stderr.on('data', d => {
                d.toString().split('\n').forEach(l => {
                    const line = l.trim();
                    if (line && !/WARNING|DEPRECATION|warning/i.test(line)) {
                        console.log(`[FaceService:setup] ${line}`);
                    }
                });
            });
            proc.on('error', (e) => reject(new Error(`${label}: ${e.message}`)));
            proc.on('close', (code) => {
                if (code === 0) { console.log(`[FaceService:setup] ${label} done`); resolve(); }
                else reject(new Error(`${label} exited with code ${code}`));
            });
        });
    }

    /**
     * Ensure a project-local .venv exists with all required packages.
     * Returns the path to the venv's Python executable.
     * Safe to call on every startup — skips setup if already complete.
     */
    async _ensureVenv() {
        const venvDir = path.join(__dirname, '.venv');
        const venvPython = process.platform === 'win32'
            ? path.join(venvDir, 'Scripts', 'python.exe')
            : path.join(venvDir, 'bin', 'python3');
        const reqFile = path.join(__dirname, 'face_service', 'requirements.txt');

        // Fast path: venv exists and has all core packages
        if (fs.existsSync(venvPython)) {
            const ok = await this._canImport(venvPython, ['insightface', 'fastapi', 'uvicorn', 'cv2', 'scipy']);
            if (ok) {
                console.log('[FaceService] .venv ready (skipping setup)');
                return venvPython;
            }
            console.log('[FaceService] .venv exists but missing packages — reinstalling');
        }

        // Find the best system Python for creating the venv
        const bestPy = this._findBestPython();
        if (!bestPy) throw new Error('No Python installation found. Please install Python 3.9+ from python.org');

        const { exe: pyExe, version: pyVer, args: pyArgs = [] } = bestPy;
        const pyMinor = parseInt((pyVer.match(/Python \d+\.(\d+)/) || [])[1] || '0', 10);
        console.log(`[FaceService] creating environment with ${pyExe} ${pyArgs.join(' ')} (${pyVer})`);

        // Create venv
        if (!fs.existsSync(venvPython)) {
            await this._runSetupStep(pyExe, [...pyArgs, '-m', 'venv', venvDir], 'creating .venv');
        }

        // Upgrade pip silently
        await this._runSetupStep(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'],
            'upgrading pip');

        // Install base requirements
        await this._runSetupStep(
            venvPython, ['-m', 'pip', 'install', '--quiet', '-r', reqFile],
            'installing requirements (first run may take a few minutes)'
        );

        // Try orbbec-astra-raw — requires Python 3.9+
        if (pyMinor >= 9) {
            try {
                // On Windows, ensure libusb-package>=1.0.26.3 (older versions can't find the DLL)
                if (process.platform === 'win32') {
                    await this._runSetupStep(
                        venvPython, ['-m', 'pip', 'install', '--quiet', '--no-cache-dir', 'libusb-package>=1.0.26.3'],
                        'installing libusb-package (Windows USB backend)'
                    );
                }
                await this._runSetupStep(
                    venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'orbbec-astra-raw'],
                    'installing orbbec-astra-raw (Astra depth+IR+color)'
                );
            } catch (e) {
                console.log('[FaceService] orbbec-astra-raw not available — depth liveness disabled (standard camera will be used)');
            }
        } else {
            console.log(`[FaceService] Python ${pyVer} < 3.9 — skipping orbbec-astra-raw (needs 3.9+)`);
        }

        return venvPython;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Start the face service. Auto-provisions a .venv with all requirements
     * on first run. Resolves when the Python service prints "READY:<port>".
     * @param {string} [pythonOverride]  Force a specific Python executable.
     * @param {string} [modelDir]        InsightFace model cache dir override.
     */
    async start(pythonOverride = undefined, modelDir = undefined) {
        // Bundled binary: packaged Electron app
        const isPackaged = typeof process !== 'undefined' && process.resourcesPath
            && !process.resourcesPath.includes('node_modules');
        if (isPackaged) {
            const bundled = path.join(process.resourcesPath, 'face_service_dist', 'face_service', 'face_service');
            if (fs.existsSync(bundled)) {
                return this._spawnService(bundled, modelDir ? [modelDir] : [], true);
            }
        }

        // Dev mode: auto-provision .venv
        let exe;
        if (pythonOverride) {
            exe = pythonOverride;
        } else {
            try {
                exe = await this._ensureVenv();
            } catch (err) {
                console.error('[FaceService] environment setup failed:', err.message);
                // Fall back to best available system Python
                const fallback = this._findBestPython();
                exe = fallback ? fallback.exe : 'python3';
                console.log(`[FaceService] falling back to system ${exe}`);
            }
        }

        const script = path.join(__dirname, 'face_service', 'face_service.py');
        const args = modelDir ? [script, modelDir] : [script];
        return this._spawnService(exe, args, false);
    }

    /**
     * Spawn the Python process and wait for the READY signal.
     */
    _spawnService(exe, spawnArgs, isBundled) {
        return new Promise((resolve, reject) => {
            console.log(`[FaceService] starting: ${exe} ${spawnArgs.join(' ')}`);

            this._proc = spawn(exe, spawnArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
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
                chunk.toString().split('\n').forEach(line => {
                    const l = line.trim();
                    if (l && !l.startsWith('READY:') && !/INFO|WARNING|UserWarning|warn|albumentations/.test(l)) {
                        console.log(`[FaceService] ${l}`);
                    }
                });
            });

            this._proc.stderr.on('data', (chunk) => {
                const msg = chunk.toString();
                if (!/INFO|WARNING|UserWarning|warn|albumentations/.test(msg)) {
                    console.error('[FaceService]', msg.trim());
                }
            });

            this._proc.on('error', (err) => {
                reject(new Error(`Failed to start face service: ${err.message}`));
            });

            this._proc.on('exit', (code) => {
                this._ready = false;
                if (code !== 0 && code !== null) {
                    console.error(`[FaceService] process exited with code ${code}`);
                }
            });

            // 90s timeout — first run downloads InsightFace models (~50 MB)
            const timer = setTimeout(() => {
                if (!this._ready) reject(new Error('Face service startup timed out'));
            }, 90_000);
            if (timer.unref) timer.unref();
        });
    }

    // ── Public API ───────────────────────────────────────────────────────────

    analyze(base64jpeg) {
        if (!this._ready) return Promise.reject(new Error('Face service not ready'));
        return this._post('/analyze', { image: base64jpeg });
    }

    resetLiveness() {
        if (!this._ready) return Promise.resolve({ ok: true });
        return this._post('/reset-liveness', {});
    }

    health() {
        if (!this._ready) return Promise.resolve({ ok: false, ready: false });
        return this._get('/health');
    }

    depthStatus() {
        if (!this._ready) return Promise.resolve({ available: false });
        return this._get('/depth-status');
    }

    /** Full camera status: depth_available + color_from_astra */
    cameraStatus() {
        if (!this._ready) return Promise.resolve({ depth_available: false, color_from_astra: false });
        return this._get('/camera-status');
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

    // ── HTTP helpers ─────────────────────────────────────────────────────────

    _post(urlPath, body) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify(body);
            const options = {
                hostname: '127.0.0.1',
                port:     this._port,
                path:     urlPath,
                method:   'POST',
                headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end',  () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
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
                res.on('end',  () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
            }).on('error', reject);
        });
    }
}

module.exports = new FaceService();
