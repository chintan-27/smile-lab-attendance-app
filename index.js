// ==================== FACE ID ====================
// MediaPipe FaceMesh (468 landmarks) + InsightFace ArcFace (512-dim embeddings)
// Passive liveness: non-rigid motion analysis + micro-motion variance + MiDaS depth

const { FaceLandmarker, FilesetResolver } = require('@mediapipe/tasks-vision');

const SUCCESS_DISPLAY_MS = 2000;
// ArcFace cosine-distance threshold — lower = stricter. 0.40 is recommended.
const MATCH_THRESHOLD = 0.40;

// MediaPipe FaceLandmarker instance (initialized async)
let faceLandmarker = null;
let mediapipeReady = false;

// Liveness configuration
const LANDMARK_HISTORY_LEN = 20;     // ~2 seconds at 10fps
const LIVENESS_ACCUMULATE_MS = 1800; // 1.8s of liveness before allowing match
const RIGID_RESIDUAL_THRESHOLD = 0.3;
const RIGID_RESIDUAL_STRONG    = 0.6;
const MICRO_MOTION_THRESHOLD   = 0.15;
const DEPTH_VARIANCE_THRESHOLD = 0.04;

let faceStream     = null;
let faceLoopActive = false;
let faceEnrolled   = [];

// State: 'idle' | 'matched' | 'executing' | 'cooldown'
let faceState        = 'idle';
let faceCurrentMatch = null;   // { ufid, name, action }

// Liveness engine state
let landmarkHistory = [];  // array of { landmarks: Float32Array[], timestamp: number }
let livenessStartTime = 0;
let lastDepthVariance = 0;
let livenessAccumulator = { rigidPass: 0, motionPass: 0, depthPass: 0, total: 0 };

// ---- MediaPipe Initialization ----

async function initMediaPipe() {
    try {
        const vision = await FilesetResolver.forVisionTasks(
            // In Electron, resolve from node_modules
            require('path').join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
        );
        faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: require('path').join(
                    __dirname, 'models', 'face_landmarker.task'
                ),
                delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numFaces: 1,
            outputFacialTransformationMatrixes: false,
            outputFaceBlendshapes: false,
        });
        mediapipeReady = true;
        console.log('[MediaPipe] FaceLandmarker initialized');
    } catch (err) {
        console.error('[MediaPipe] Failed to initialize:', err);
        // Fallback: try CPU delegate
        try {
            const vision = await FilesetResolver.forVisionTasks(
                require('path').join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
            );
            faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: require('path').join(
                        __dirname, 'node_modules', '@mediapipe', 'tasks-vision',
                        'models', 'face_landmarker.task'
                    ),
                    delegate: 'CPU',
                },
                runningMode: 'VIDEO',
                numFaces: 1,
                outputFacialTransformationMatrixes: false,
                outputFaceBlendshapes: false,
            });
            mediapipeReady = true;
            console.log('[MediaPipe] FaceLandmarker initialized (CPU fallback)');
        } catch (err2) {
            console.error('[MediaPipe] CPU fallback also failed:', err2);
        }
    }
}

// Start initialization immediately
initMediaPipe();

// ---- Helpers ----

/** Cosine distance between two plain number arrays (not pre-normalised). */
function cosineDistance(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 1 : 1 - dot / denom;
}

// ---- Liveness Engine ----

/**
 * Fit a 2D affine transform (rotation, translation, scale) from src to dst points
 * using least squares. Returns the mean residual (pixels) after fitting.
 *
 * src, dst: arrays of [x, y] pairs (same length)
 */
function computeAffineResidual(src, dst) {
    const n = src.length;
    if (n < 3) return 0;

    // Build system: for each point (x,y) → (x',y')
    // x' = a*x + b*y + tx
    // y' = c*x + d*y + ty
    // Using simplified approach: compute centroid, then fit rotation+scale
    let sx1 = 0, sy1 = 0, sx2 = 0, sy2 = 0;
    for (let i = 0; i < n; i++) {
        sx1 += src[i][0]; sy1 += src[i][1];
        sx2 += dst[i][0]; sy2 += dst[i][1];
    }
    const cx1 = sx1 / n, cy1 = sy1 / n;
    const cx2 = sx2 / n, cy2 = sy2 / n;

    // Centered coordinates
    let num1 = 0, den1 = 0, num2 = 0, den2 = 0;
    for (let i = 0; i < n; i++) {
        const dx1 = src[i][0] - cx1, dy1 = src[i][1] - cy1;
        const dx2 = dst[i][0] - cx2, dy2 = dst[i][1] - cy2;
        // For rotation+scale: a = (sum(dx1*dx2+dy1*dy2)) / (sum(dx1^2+dy1^2))
        //                     b = (sum(dx1*dy2-dy1*dx2)) / (sum(dx1^2+dy1^2))
        num1 += dx1 * dx2 + dy1 * dy2;
        num2 += dx1 * dy2 - dy1 * dx2;
        den1 += dx1 * dx1 + dy1 * dy1;
    }

    if (den1 < 1e-10) return 0;

    const a = num1 / den1;
    const b = num2 / den1;

    // Compute residuals
    let totalResidual = 0;
    for (let i = 0; i < n; i++) {
        const dx1 = src[i][0] - cx1, dy1 = src[i][1] - cy1;
        const px = a * dx1 - b * dy1 + cx2;
        const py = b * dx1 + a * dy1 + cy2;
        const ex = px - dst[i][0];
        const ey = py - dst[i][1];
        totalResidual += Math.sqrt(ex * ex + ey * ey);
    }

    return totalResidual / n;
}

/**
 * Signal 1: Non-Rigid Motion
 * Compare consecutive frames — fit affine, compute residual.
 * Real face: residual > threshold (independent feature motion).
 * Photo: residual ≈ 0 (all points move rigidly).
 */
function analyzeRigidity() {
    if (landmarkHistory.length < 2) return 0;

    let totalResidual = 0;
    let pairs = 0;

    // Compare recent consecutive frame pairs
    const start = Math.max(0, landmarkHistory.length - 6);
    for (let i = start; i < landmarkHistory.length - 1; i++) {
        const src = landmarkHistory[i].landmarks;
        const dst = landmarkHistory[i + 1].landmarks;
        totalResidual += computeAffineResidual(src, dst);
        pairs++;
    }

    return pairs > 0 ? totalResidual / pairs : 0;
}

/**
 * Signal 2: Micro-Motion Variance
 * Track position variance of key landmarks over the sliding window.
 * Real face: variance > threshold (natural drift, breathing).
 * Photo: near-zero variance.
 *
 * Key landmarks (indices into MediaPipe 468):
 *   1 = nose tip, 33 = left eye outer, 263 = right eye outer,
 *   61 = left mouth corner, 291 = right mouth corner,
 *   10 = forehead center, 152 = chin, 234 = left cheek, 454 = right cheek
 */
const KEY_LANDMARK_INDICES = [1, 33, 263, 61, 291, 10, 152, 234, 454];

function analyzeMicroMotion() {
    if (landmarkHistory.length < 8) return 0;

    let totalVariance = 0;

    for (const idx of KEY_LANDMARK_INDICES) {
        let sx = 0, sy = 0, sx2 = 0, sy2 = 0;
        let count = 0;

        for (const frame of landmarkHistory) {
            if (idx < frame.landmarks.length) {
                const [x, y] = frame.landmarks[idx];
                sx += x; sy += y;
                sx2 += x * x; sy2 += y * y;
                count++;
            }
        }

        if (count > 1) {
            const mx = sx / count, my = sy / count;
            const vx = sx2 / count - mx * mx;
            const vy = sy2 / count - my * my;
            totalVariance += vx + vy;
        }
    }

    return totalVariance / KEY_LANDMARK_INDICES.length;
}

/**
 * Combined liveness decision.
 * is_live = (non_rigid_residual > 0.3) AND (micro_motion_var > threshold)
 *           AND ((depth_var > threshold) OR (non_rigid_residual > 0.6))
 */
function computeLivenessScore() {
    const rigidResidual = analyzeRigidity();
    const microMotion = analyzeMicroMotion();
    const depthVar = lastDepthVariance;

    const rigidPass = rigidResidual > RIGID_RESIDUAL_THRESHOLD;
    const motionPass = microMotion > MICRO_MOTION_THRESHOLD;
    const depthPass = depthVar > DEPTH_VARIANCE_THRESHOLD;
    const rigidStrong = rigidResidual > RIGID_RESIDUAL_STRONG;

    const isLive = rigidPass && motionPass && (depthPass || rigidStrong);

    return { isLive, rigidResidual, microMotion, depthVar, rigidPass, motionPass, depthPass };
}

/** Extract 2D landmark positions from MediaPipe result for our liveness analysis. */
function extractLandmarks(faceLandmarks) {
    // faceLandmarks is array of {x, y, z} normalized [0,1] — scale to pixel-like coords
    return faceLandmarks.map(lm => [lm.x * 640, lm.y * 480]);
}

function resetLivenessState() {
    landmarkHistory = [];
    livenessStartTime = 0;
    lastDepthVariance = 0;
    livenessAccumulator = { rigidPass: 0, motionPass: 0, depthPass: 0, total: 0 };
}

// ---- UI Helpers for new elements ----

function setPhaseLabel(phase, text) {
    const el = document.getElementById('facePhaseLabel');
    if (!el) return;
    el.className = 'face-phase-label show ' + phase;
    el.textContent = text;
}

function hidePhaseLabel() {
    const el = document.getElementById('facePhaseLabel');
    if (el) el.className = 'face-phase-label';
}

function setScanCircle(active) {
    const el = document.getElementById('faceScanCircle');
    if (el) el.classList.toggle('active', active);
}

/** Set liveness progress ring (0..1). */
function setProgressRing(progress, state) {
    const ring = document.getElementById('faceProgressRing');
    const fg = document.getElementById('faceProgressFg');
    if (!fg || !ring) return;
    const circumference = 2 * Math.PI * 95; // r=95
    fg.setAttribute('stroke-dashoffset', circumference * (1 - Math.min(1, progress)));
    ring.className = 'face-progress-ring ' + (state || 'verifying');
}

/** Draw subtle landmark mesh on the mesh canvas. */
function drawLandmarkMesh(meshCanvas, landmarks, videoWidth, videoHeight) {
    if (!meshCanvas) return;
    const ctx = meshCanvas.getContext('2d');
    meshCanvas.width = videoWidth;
    meshCanvas.height = videoHeight;
    ctx.clearRect(0, 0, meshCanvas.width, meshCanvas.height);

    if (!landmarks || landmarks.length === 0) return;

    // Draw dots at key landmark positions (subtle, semi-transparent)
    ctx.fillStyle = 'rgba(96, 165, 250, 0.25)';
    // Draw a subset of landmarks for performance (every 3rd)
    for (let i = 0; i < landmarks.length; i += 3) {
        const lm = landmarks[i];
        const x = lm.x * videoWidth;
        const y = lm.y * videoHeight;
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
    }

    // Draw connections for face outline (jawline + face oval subset)
    const faceOval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
                      397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
                      172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10];
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.12)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 0; i < faceOval.length; i++) {
        const lm = landmarks[faceOval[i]];
        if (!lm) continue;
        const x = lm.x * videoWidth;
        const y = lm.y * videoHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

// ---- Dormant / on-demand camera ----

let inactivityTimer = null;
let cameraDormant = true; // starts dormant; CSS shows dormant state by default

function enterDormantState(autoRestart = false) {
    clearTimeout(inactivityTimer);
    resetLivenessState();
    window.electronAPI.faceResetLiveness().catch(() => {});
    stopFaceCamera();
    cameraDormant = true;
    document.getElementById('faceDormant').style.opacity        = '1';
    document.getElementById('faceDormant').style.pointerEvents  = 'auto';
    document.getElementById('faceCameraSection').style.opacity       = '0';
    document.getElementById('faceCameraSection').style.pointerEvents = 'none';
    if (autoRestart) setTimeout(activateFaceCamera, 1400);
}

function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        if (faceState === 'idle') enterDormantState();
    }, 20000);
}

async function activateFaceCamera() {
    if (!cameraDormant) return;
    cameraDormant = false;
    document.getElementById('faceDormant').style.opacity        = '0';
    document.getElementById('faceDormant').style.pointerEvents  = 'none';
    document.getElementById('faceCameraSection').style.opacity       = '1';
    document.getElementById('faceCameraSection').style.pointerEvents = 'auto';
    await startFaceIdPanel();
    resetInactivityTimer();
}

// ---- Start panel ----
async function startFaceIdPanel() {
    setFaceUI('idle', 'Loading Face ID…');
    showFaceLoading(true);
    setConfirmBar(0);
    hideFaceNameBadge();
    hideFaceConfirmPrompt();

    try {
        const res = await window.electronAPI.getAllFaceDescriptors();
        faceEnrolled = (res.success && res.descriptors) ? res.descriptors : [];
    } catch (e) { faceEnrolled = []; }

    if (faceEnrolled.length === 0) {
        showFaceLoading(false);
        setFaceUI('error', 'No faces enrolled — use Admin panel to enroll');
        return;
    }

    const video  = document.getElementById('faceVideo');
    const canvas = document.getElementById('faceCanvas');
    try {
        faceStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        video.srcObject = faceStream;
        await new Promise(res => { video.onloadedmetadata = res; });
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
    } catch (e) {
        showFaceLoading(false);
        setFaceUI('error', 'Camera access denied');
        return;
    }

    showFaceLoading(false);
    enterIdleState();
    faceLoopActive = true;
    faceDetectLoop(video, canvas);

    const viewport = document.getElementById('faceViewport');
    if (viewport) {
        viewport.style.cursor = 'default';
        viewport.addEventListener('click', () => {
            if (faceState === 'matched') confirmFaceAction();
        });
    }
}

// ---- Detection loop (MediaPipe landmarks in-browser + InsightFace via IPC) ----
async function faceDetectLoop(video, canvas) {
    const ctx       = canvas.getContext('2d');
    const meshCanvas = document.getElementById('faceMeshCanvas');
    const offscreen = document.createElement('canvas');

    // Throttle IPC calls to Python (every ~300ms) — MediaPipe runs every frame
    let lastIPCTime = 0;
    let pendingIPC = false;
    let lastEmbeddingResult = null; // { embedding, bbox, det_score, depth_variance, is_live_depth }

    const tick = async () => {
        if (!faceLoopActive) return;
        if (faceState === 'executing' || faceState === 'cooldown') {
            setTimeout(tick, 300);
            return;
        }

        const now = performance.now();

        // --- MediaPipe: run on every frame for landmarks ---
        let mpResult = null;
        if (mediapipeReady && faceLandmarker) {
            try {
                mpResult = faceLandmarker.detectForVideo(video, now);
            } catch (_) {}
        }

        const hasMediaPipeFace = mpResult && mpResult.faceLandmarks && mpResult.faceLandmarks.length > 0;

        // Draw mesh overlay
        if (hasMediaPipeFace) {
            drawLandmarkMesh(meshCanvas, mpResult.faceLandmarks[0], video.videoWidth, video.videoHeight);

            // Add to landmark history for liveness analysis
            const landmarks2D = extractLandmarks(mpResult.faceLandmarks[0]);
            landmarkHistory.push({ landmarks: landmarks2D, timestamp: now });
            if (landmarkHistory.length > LANDMARK_HISTORY_LEN) landmarkHistory.shift();
        } else {
            // Clear mesh
            if (meshCanvas) {
                const mCtx = meshCanvas.getContext('2d');
                mCtx.clearRect(0, 0, meshCanvas.width, meshCanvas.height);
            }
        }

        // --- IPC to Python: throttled for ArcFace embedding + MiDaS depth ---
        if (!pendingIPC && (now - lastIPCTime > 300)) {
            pendingIPC = true;
            lastIPCTime = now;

            offscreen.width  = video.videoWidth;
            offscreen.height = video.videoHeight;
            offscreen.getContext('2d').drawImage(video, 0, 0);
            const base64 = offscreen.toDataURL('image/jpeg', 0.8).split(',')[1];

            window.electronAPI.faceProcessFrame(base64).then(result => {
                pendingIPC = false;
                if (result?.face) {
                    lastEmbeddingResult = result.face;
                    if (result.face.depth_variance !== undefined) {
                        lastDepthVariance = result.face.depth_variance;
                    }
                } else {
                    lastEmbeddingResult = null;
                }
            }).catch(() => { pendingIPC = false; });
        }

        // --- Process detections ---
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const face = lastEmbeddingResult;
        const hasFace = hasMediaPipeFace && face;

        if (hasFace) {
            resetInactivityTimer();
            const [fx1, fy1, fx2, fy2] = face.bbox;
            const box = { x: fx1, y: fy1, width: fx2 - fx1, height: fy2 - fy1 };
            const q   = face.embedding;

            // Match against enrolled descriptors using cosine distance
            let bestMatch = null, bestDist = Infinity;
            for (const e of faceEnrolled) {
                const stored  = e.descriptor;
                const isMulti = stored.length > 0 && Array.isArray(stored[0]);
                let d;
                if (isMulti) {
                    if (stored[0].length !== q.length) continue; // skip wrong-dim legacy
                    d = Math.min(...stored.map(s => cosineDistance(q, s)));
                } else {
                    if (stored.length !== q.length) continue;
                    d = cosineDistance(q, stored);
                }
                if (d < bestDist) { bestDist = d; bestMatch = e; }
            }

            if (bestMatch && bestDist <= MATCH_THRESHOLD) {
                drawFaceBox(ctx, box, true);

                if (faceState === 'idle') {
                    // Start liveness accumulation timer
                    if (livenessStartTime === 0) {
                        livenessStartTime = now;
                    }

                    // Compute liveness signals
                    const liveness = computeLivenessScore();

                    // Update accumulator
                    livenessAccumulator.total++;
                    if (liveness.rigidPass) livenessAccumulator.rigidPass++;
                    if (liveness.motionPass) livenessAccumulator.motionPass++;
                    if (liveness.depthPass) livenessAccumulator.depthPass++;

                    const elapsed = now - livenessStartTime;
                    const progress = Math.min(1, elapsed / LIVENESS_ACCUMULATE_MS);

                    // Update progress ring
                    setProgressRing(progress, 'verifying');

                    // Phase labels
                    if (elapsed < 400) {
                        setPhaseLabel('detecting', 'Detecting');
                        setScanCircle(true);
                    } else if (elapsed < 1000) {
                        setPhaseLabel('analyzing', 'Analyzing');
                        setScanCircle(true);
                    } else {
                        setPhaseLabel('verifying', 'Verifying');
                        setScanCircle(false);
                    }

                    console.log(`Liveness: rigid_residual=${liveness.rigidResidual.toFixed(2)} micro_motion=${liveness.microMotion.toFixed(3)} depth_var=${liveness.depthVar.toFixed(4)} → ${liveness.isLive ? 'PASS' : 'FAIL'} (${elapsed.toFixed(0)}ms)`);

                    if (elapsed >= LIVENESS_ACCUMULATE_MS && liveness.isLive) {
                        // Enough time and liveness confirmed — proceed to matched
                        resetLivenessState();
                        hidePhaseLabel();
                        setScanCircle(false);
                        setProgressRing(1, 'matched');
                        faceCurrentMatch = { ufid: bestMatch.ufid, name: bestMatch.name, action: null };
                        enterMatchedState(bestMatch.ufid, bestMatch.name);
                    } else if (elapsed >= LIVENESS_ACCUMULATE_MS && !liveness.isLive) {
                        // Time elapsed but liveness failed — keep trying, show hint
                        setFaceUI('idle', 'Move naturally — verifying…');
                    } else {
                        setFaceUI('idle', 'Verifying identity…');
                    }
                }
                // faceState === 'matched': waiting for Enter/click, no change
            } else {
                drawFaceBox(ctx, box, false);
                resetLivenessState();
                setProgressRing(0, 'verifying');
                hidePhaseLabel();
                setScanCircle(true);
                if (faceState === 'matched') {
                    enterIdleState();
                }
                setFaceUI('idle', 'Face not recognized');
            }
        } else if (hasMediaPipeFace && !face) {
            // MediaPipe sees a face but Python hasn't returned embeddings yet
            resetInactivityTimer();
            setPhaseLabel('detecting', 'Detecting');
            setScanCircle(true);
            setFaceUI('idle', 'Searching for face…');
        } else {
            resetLivenessState();
            setProgressRing(0, 'verifying');
            hidePhaseLabel();
            setScanCircle(false);
            if (faceState === 'matched') {
                enterIdleState();
            }
            setFaceUI('idle', 'Look at the camera to sign in or out');

            // Clear mesh canvas
            if (meshCanvas) {
                const mCtx = meshCanvas.getContext('2d');
                mCtx.clearRect(0, 0, meshCanvas.width, meshCanvas.height);
            }
        }

        setTimeout(tick, 50); // ~20fps for MediaPipe; IPC is throttled separately
    };

    tick();
}

function drawFaceBox(ctx, box, matched) {
    const { x, y, width, height } = box;
    ctx.strokeStyle = matched ? '#34d399' : 'rgba(96,165,250,0.7)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    const arm = Math.min(width, height) * 0.18;
    const corners = [
        [x+arm,y,  x,y,  x,y+arm],
        [x+width-arm,y,  x+width,y,  x+width,y+arm],
        [x,y+height-arm,  x,y+height,  x+arm,y+height],
        [x+width,y+height-arm,  x+width,y+height,  x+width-arm,y+height]
    ];
    for (const [x1,y1,xc,yc,x2,y2] of corners) {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(xc,yc); ctx.lineTo(x2,y2); ctx.stroke();
    }
}

// ---- State transitions ----
function enterIdleState() {
    faceState        = 'idle';
    faceCurrentMatch = null;
    resetLivenessState();
    window.electronAPI.faceResetLiveness().catch(() => {});
    setScanRing('detecting');
    setScanCircle(true);
    setProgressRing(0, 'verifying');
    hidePhaseLabel();
    hideFaceNameBadge();
    hideFaceConfirmPrompt();
    setConfirmBar(0);
    setFaceUI('idle', 'Look at the camera to sign in or out');
    const vp = document.getElementById('faceViewport');
    if (vp) vp.style.cursor = 'default';
}

async function enterMatchedState(ufid, name) {
    faceState = 'matched';
    setScanRing('matched');
    setScanCircle(false);
    setPhaseLabel('matched', 'Matched');
    showFaceNameBadge(name, null);
    showFaceConfirmPrompt();
    setConfirmBar(100);
    setFaceUI('matched', 'Checking…');
    const vp = document.getElementById('faceViewport');
    if (vp) vp.style.cursor = 'pointer';
    try {
        const st = await window.electronAPI.getStudentStatus(ufid);
        if (faceState !== 'matched' || faceCurrentMatch?.ufid !== ufid) return;
        const action = (st.authorized && st.status === 'signin') ? 'signOut' : 'signIn';
        faceCurrentMatch.action = action;
        updateNameBadgeAction(action);
        setFaceUI('matched', action === 'signOut' ? 'Will Sign Out · Press ↵' : 'Will Sign In · Press ↵');
    } catch (_) {
        if (faceState === 'matched' && faceCurrentMatch?.ufid === ufid) {
            setFaceUI('matched', 'Press ↵ or click to confirm');
        }
    }
}

// ---- Confirm (triggered by Enter or click) ----
async function confirmFaceAction() {
    if (faceState !== 'matched' || !faceCurrentMatch) return;
    faceState = 'executing';
    hideFaceConfirmPrompt();
    setFaceUI('matched', 'Signing in/out…');

    const { ufid, name } = faceCurrentMatch;
    try {
        const statusResult = await window.electronAPI.getStudentStatus(ufid);
        if (!statusResult.authorized) {
            setFaceUI('error', 'Student not found in system');
            setTimeout(enterIdleState, 2500);
            return;
        }
        const result = statusResult.status === 'signin'
            ? await window.electronAPI.signOut({ ufid, name })
            : await window.electronAPI.signIn({ ufid, name });

        if (result.success) {
            const action = statusResult.status === 'signin' ? 'Signed Out' : 'Signed In';
            showFaceSuccess(result.studentName, action);
            startCooldown();
        } else {
            setFaceUI('error', result.message || 'Action failed');
            setTimeout(enterIdleState, 2500);
        }
    } catch (e) {
        setFaceUI('error', 'Error: ' + e.message);
        setTimeout(enterIdleState, 2500);
    }
}

// ---- Cooldown ----
function startCooldown() {
    faceState = 'cooldown';
    setScanRing('idle');
    setScanCircle(false);
    hidePhaseLabel();
    setProgressRing(0, 'verifying');
    hideFaceNameBadge();
    setConfirmBar(0);
    setTimeout(() => {
        hideFaceSuccessOverlay();
        enterDormantState(true); // auto-restart camera after success
    }, SUCCESS_DISPLAY_MS);
}

// ---- UI helpers ----
function setFaceUI(type, msg) {
    const el = document.getElementById('faceStatusText');
    if (!el) return;
    el.className = 'face-status-text ' + type;
    el.textContent = msg;
}

function setScanRing(state) {
    const el = document.getElementById('faceScanRing');
    if (el) el.className = 'face-scan-ring ' + (state === 'error' ? 'error-ring' : state);
}

function setConfirmBar(pct) {
    const bar = document.getElementById('faceConfirmBar');
    if (bar) bar.style.width = pct + '%';
}

function showFaceLoading(show) {
    const el = document.getElementById('faceLoading');
    if (el) el.classList.toggle('hidden', !show);
}

function showFaceNameBadge(name, action) {
    const badge = document.getElementById('faceNameBadge');
    const text = document.getElementById('faceNameText');
    if (text) text.textContent = name;
    if (badge) {
        badge.classList.remove('signin', 'signout');
        badge.classList.add('show');
    }
    if (action) updateNameBadgeAction(action);
}

function updateNameBadgeAction(action) {
    const badge = document.getElementById('faceNameBadge');
    if (!badge) return;
    badge.classList.remove('signin', 'signout');
    badge.classList.add(action === 'signOut' ? 'signout' : 'signin');
}

function hideFaceNameBadge() {
    const el = document.getElementById('faceNameBadge');
    if (el) el.classList.remove('show', 'signin', 'signout');
}

function showFaceConfirmPrompt() {
    const el = document.getElementById('faceConfirmPrompt');
    if (el) el.classList.add('show');
}

function hideFaceConfirmPrompt() {
    const el = document.getElementById('faceConfirmPrompt');
    if (el) el.classList.remove('show');
}

function showFaceSuccess(name, action) {
    const overlay = document.getElementById('faceSuccessOverlay');
    const nameEl  = document.getElementById('faceSuccessName');
    const actEl   = document.getElementById('faceSuccessAction');
    const isSignOut = action === 'Signed Out';
    if (nameEl) nameEl.textContent = name;
    if (actEl) {
        actEl.textContent = action;
        actEl.className = 'face-success-action-label ' + (isSignOut ? 'signout' : 'signin');
    }
    if (overlay) overlay.classList.add('show');
    setScanRing('matched');
}

function hideFaceSuccessOverlay() {
    const overlay = document.getElementById('faceSuccessOverlay');
    if (overlay) overlay.classList.remove('show');
}

function stopFaceCamera() {
    faceLoopActive = false;
    if (faceStream) {
        faceStream.getTracks().forEach(t => t.stop());
        faceStream = null;
    }
    hideFaceSuccessOverlay();
    setScanRing('idle');
    setScanCircle(false);
    hidePhaseLabel();
    setProgressRing(0, 'verifying');
    faceState = 'idle';
    faceCurrentMatch = null;
    resetLivenessState();
    window.electronAPI.faceResetLiveness().catch(() => {});
}

// ==================== DOM Elements - initialized after DOM ready ====================

let ufidInputs;
let actionBtn;
let actionBtnText;
let actionBtnIcon;
let statusMessage;
let userHint;
let adminLink;
let clockElement;

// Track current mode and student status
let currentMode = 'signin'; // 'signin' or 'signout'
let currentStudent = null;
let checkStatusTimeout = null;

// ==================== INITIALIZATION ====================

document.addEventListener('DOMContentLoaded', () => {
    // Initialize DOM references
    ufidInputs = document.querySelectorAll('.ufid-digit');
    actionBtn = document.getElementById('actionBtn');
    actionBtnText = document.getElementById('actionBtnText');
    actionBtnIcon = actionBtn ? actionBtn.querySelector('.btn-content i') : null;
    statusMessage = document.getElementById('statusMessage');
    userHint = document.getElementById('userHint');
    adminLink = document.getElementById('adminLink');
    clockElement = document.getElementById('clock');

    // Start clock
    updateClock();
    setInterval(updateClock, 1000);

    // Setup UFID inputs
    setupUfidInputs();

    // Setup event listeners
    setupEventListeners();

    // Focus on first input
    if (ufidInputs && ufidInputs[0]) {
        ufidInputs[0].focus();
    }

    // Initial validation
    validateUfid();

    // Cancel stops camera; any activity wakes it (screensaver behaviour)
    document.getElementById('faceCancelBtn').addEventListener('click', () => enterDormantState(false));
    ['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach(evt =>
        document.addEventListener(evt, () => { if (cameraDormant) activateFaceCamera(); }, { passive: true })
    );

    // Auto-start: dormant is already shown via CSS; activate immediately
    activateFaceCamera();

    console.log('UF Lab Attendance System initialized');
});

// ==================== CLOCK ====================

function updateClock() {
    if (!clockElement) return;

    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    const displayMinutes = minutes.toString().padStart(2, '0');

    clockElement.textContent = `${displayHours}:${displayMinutes} ${ampm}`;
}

// ==================== EVENT LISTENERS ====================

function setupEventListeners() {
    // Action button click
    if (actionBtn) {
        actionBtn.addEventListener('click', handleActionClick);
    }

    // Admin link
    if (adminLink) {
        adminLink.addEventListener('click', (e) => {
            e.preventDefault();
            showAdminModal();
        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Enter confirms Face ID when a face is matched
        if (e.key === 'Enter' && faceState === 'matched') {
            e.preventDefault();
            confirmFaceAction();
            return;
        }

        if (e.key === 'Escape') {
            clearUfid();
            if (statusMessage) statusMessage.classList.remove('show');
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
            e.preventDefault();
            clearUfid();
        }
    });

    // Window focus
    window.addEventListener('focus', () => {
        if (!isUfidComplete()) {
            focusFirstEmptyInput();
        }
    });
}

// ==================== UFID INPUT HANDLING ====================

function setupUfidInputs() {
    if (!ufidInputs) return;

    ufidInputs.forEach((input, index) => {
        // Only allow numbers
        input.addEventListener('input', function (e) {
            const value = e.target.value.replace(/\D/g, '');
            e.target.value = value;

            if (value) {
                e.target.classList.add('filled');
                // Auto-focus next input
                if (index < ufidInputs.length - 1) {
                    ufidInputs[index + 1].focus();
                }
            } else {
                e.target.classList.remove('filled');
            }

            validateUfid();

            // Check student status when UFID is complete
            if (isUfidComplete()) {
                checkStudentStatus();
            } else {
                resetButtonState();
            }
        });

        // Handle backspace
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Backspace' && !e.target.value && index > 0) {
                ufidInputs[index - 1].focus();
            }

            if (e.key === 'Enter' && isUfidComplete() && actionBtn) {
                actionBtn.click();
            }
        });

        // Handle paste
        input.addEventListener('paste', function (e) {
            e.preventDefault();
            const paste = (e.clipboardData || window.clipboardData).getData('text');
            const numbers = paste.replace(/\D/g, '').slice(0, 8);

            numbers.split('').forEach((digit, i) => {
                if (ufidInputs[i]) {
                    ufidInputs[i].value = digit;
                    ufidInputs[i].classList.add('filled');
                }
            });

            validateUfid();

            // Check student status when UFID is complete after paste
            if (isUfidComplete()) {
                checkStudentStatus();
            }
        });
    });
}

function getUfidValue() {
    if (!ufidInputs) return '';
    return Array.from(ufidInputs).map(input => input.value).join('');
}

function isUfidComplete() {
    return getUfidValue().length === 8;
}

function clearUfid() {
    if (!ufidInputs) return;

    ufidInputs.forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
    ufidInputs[0].focus();
    resetButtonState();
}

function validateUfid() {
    const ufid = getUfidValue();
    const isComplete = ufid.length === 8;

    if (actionBtn) {
        actionBtn.disabled = !isComplete;
    }

    // Remove error state when user starts typing again
    if (ufidInputs) {
        ufidInputs.forEach(input => {
            input.classList.remove('error');
        });
    }
}

function showUfidError() {
    if (!ufidInputs) return;

    ufidInputs.forEach(input => {
        if (input.value) {
            input.classList.add('error');
        }
    });
}

function focusFirstEmptyInput() {
    if (!ufidInputs) return;

    for (let i = 0; i < ufidInputs.length; i++) {
        if (!ufidInputs[i].value) {
            ufidInputs[i].focus();
            break;
        }
    }
}

// ==================== BUTTON STATE MANAGEMENT ====================

function resetButtonState() {
    currentMode = 'signin';
    currentStudent = null;

    if (actionBtn) {
        actionBtn.classList.remove('signout-mode', 'signin-mode');
    }
    if (actionBtnText) {
        actionBtnText.textContent = 'Sign In/Out';
    }
    if (actionBtnIcon) {
        actionBtnIcon.className = 'fas fa-right-to-bracket';
    }
    if (userHint) {
        userHint.textContent = '';
        userHint.className = 'user-hint';
    }
}

function setSignOutMode(studentName) {
    currentMode = 'signout';

    if (actionBtn) {
        actionBtn.classList.remove('signin-mode');
        actionBtn.classList.add('signout-mode');
    }
    if (actionBtnText) {
        actionBtnText.textContent = 'Sign Out';
    }
    if (actionBtnIcon) {
        actionBtnIcon.className = 'fas fa-arrow-right-from-bracket';
    }
    if (userHint) {
        userHint.innerHTML = `<i class="fas fa-user-check"></i> ${studentName} is currently signed in`;
        userHint.className = 'user-hint signed-in';
    }

    console.log('Button set to SIGN OUT mode for:', studentName);
}

function setSignInMode(studentName) {
    currentMode = 'signin';

    if (actionBtn) {
        actionBtn.classList.remove('signout-mode');
        actionBtn.classList.add('signin-mode');
    }
    if (actionBtnText) {
        actionBtnText.textContent = 'Sign In';
    }
    if (actionBtnIcon) {
        actionBtnIcon.className = 'fas fa-arrow-right-to-bracket';
    }
    if (userHint && studentName) {
        userHint.innerHTML = `<i class="fas fa-user"></i> Welcome, ${studentName}`;
        userHint.className = 'user-hint active';
    }

    console.log('Button set to SIGN IN mode for:', studentName);
}

// ==================== STATUS CHECK ====================

async function checkStudentStatus() {
    const ufid = getUfidValue();

    if (!isUfidComplete()) {
        resetButtonState();
        return;
    }

    // Clear any pending check
    if (checkStatusTimeout) {
        clearTimeout(checkStatusTimeout);
    }

    // Debounce the status check
    checkStatusTimeout = setTimeout(async () => {
        try {
            if (userHint) {
                userHint.textContent = 'Checking...';
                userHint.className = 'user-hint active';
            }

            console.log('Checking status for UFID:', ufid);
            const result = await window.electronAPI.getStudentStatus(ufid);
            console.log('Status result:', result);

            if (result.authorized) {
                currentStudent = result;

                // Check if status indicates signed in (status is 'signin' when currently in lab)
                const isSignedIn = result.status === 'signin';
                console.log('Is signed in:', isSignedIn, 'Status:', result.status);

                if (isSignedIn) {
                    setSignOutMode(result.name);
                } else {
                    setSignInMode(result.name);
                }
            } else {
                // Student not found/not authorized
                resetButtonState();
                if (userHint) {
                    userHint.textContent = 'Student not found';
                    userHint.className = 'user-hint';
                }
            }
        } catch (error) {
            console.error('Error checking student status:', error);
            resetButtonState();
        }
    }, 200);
}

// ==================== ACTION HANDLER ====================

async function handleActionClick() {
    const ufid = getUfidValue();

    if (!isUfidComplete()) {
        showStatus('Please enter a complete 8-digit UF ID', 'error');
        showUfidError();
        return;
    }

    try {
        if (actionBtn) {
            actionBtn.disabled = true;
            actionBtn.classList.add('loading');
        }

        let result;
        console.log('Action click - Current mode:', currentMode);

        if (currentMode === 'signout') {
            console.log('Attempting sign OUT for:', ufid);
            result = await window.electronAPI.signOut({ ufid, name: '' });

            if (result.success) {
                showStatus(`Goodbye, ${result.studentName}! You've signed out successfully.`, 'success');
                clearUfid();
            } else {
                showStatus(result.message || 'Sign out failed', 'error');
                if (result.unauthorized) {
                    showUfidError();
                }
            }
        } else {
            console.log('Attempting sign IN for:', ufid);
            result = await window.electronAPI.signIn({ ufid, name: '' });

            if (result.success) {
                showStatus(`Welcome, ${result.studentName}! You've signed in successfully.`, 'success');
                clearUfid();
            } else {
                showStatus(result.message || 'Sign in failed', 'error');
                if (result.unauthorized) {
                    showUfidError();
                }
            }
        }
    } catch (error) {
        console.error('Action error:', error);
        showStatus('Error: ' + error.message, 'error');
        showUfidError();
    } finally {
        if (actionBtn) {
            actionBtn.disabled = false;
            actionBtn.classList.remove('loading');
        }
        validateUfid();
    }
}

// ==================== STATUS MESSAGE ====================

function showStatus(message, type) {
    if (!statusMessage) return;

    const icon = type === 'success'
        ? '<i class="fas fa-check-circle"></i>'
        : '<i class="fas fa-exclamation-circle"></i>';

    statusMessage.innerHTML = `${icon} ${message}`;
    statusMessage.className = `status ${type} show`;

    // Auto-hide after 5 seconds
    setTimeout(() => {
        statusMessage.classList.remove('show');
        setTimeout(() => {
            statusMessage.className = 'status';
        }, 300);
    }, 5000);
}

// ==================== ADMIN MODAL ====================

function showAdminModal() {
    const modal = document.createElement('div');
    modal.className = 'admin-modal';
    modal.innerHTML = `
        <div class="admin-modal-content">
            <div class="admin-modal-header">
                <h3>Admin Access</h3>
                <button class="admin-modal-close" id="adminModalClose">×</button>
            </div>
            <div class="admin-modal-body">
                <label for="adminPassword">Enter admin password:</label>
                <input type="password" id="adminPassword" class="admin-password-input" placeholder="Password">
                <div id="adminError" class="admin-error"></div>
            </div>
            <div class="admin-modal-footer">
                <button class="admin-cancel-btn" id="adminCancelBtn">Cancel</button>
                <button class="admin-login-btn" id="adminLoginBtn">Login</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Add event listeners
    const closeBtn = document.getElementById('adminModalClose');
    const cancelBtn = document.getElementById('adminCancelBtn');
    const loginBtn = document.getElementById('adminLoginBtn');
    const passwordInput = document.getElementById('adminPassword');

    if (closeBtn) closeBtn.addEventListener('click', closeAdminModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeAdminModal);
    if (loginBtn) loginBtn.addEventListener('click', verifyAdminPassword);

    // Handle Enter key
    if (passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                verifyAdminPassword();
            }
        });
    }

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeAdminModal();
        }
    });

    // Focus on password input
    setTimeout(() => {
        if (passwordInput) passwordInput.focus();
    }, 100);
}

function closeAdminModal() {
    const modal = document.querySelector('.admin-modal');
    if (modal) {
        modal.remove();
    }
}

async function verifyAdminPassword() {
    const passwordInput = document.getElementById('adminPassword');
    const loginBtn = document.getElementById('adminLoginBtn');
    const password = passwordInput ? passwordInput.value.trim() : '';

    if (!password) {
        showAdminError('Please enter a password');
        return;
    }

    try {
        if (loginBtn) {
            loginBtn.disabled = true;
            loginBtn.textContent = 'Verifying...';
        }

        const result = await window.electronAPI.verifyAdmin(password);

        if (result && result.success) {
            closeAdminModal();
            window.location.href = 'admin.html';
        } else {
            showAdminError('Invalid admin password');
        }
    } catch (error) {
        console.error('Admin verification error:', error);
        showAdminError('Error verifying password. Please try again.');
    } finally {
        if (loginBtn) {
            loginBtn.disabled = false;
            loginBtn.textContent = 'Login';
        }
    }
}

function showAdminError(message) {
    const errorDiv = document.getElementById('adminError');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';

        setTimeout(() => {
            errorDiv.style.display = 'none';
        }, 3000);
    }
}
