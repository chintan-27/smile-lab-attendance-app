// ==================== FACE ID ====================
// InsightFace ArcFace (512-dim embeddings) via Python IPC
// Passive liveness: rPPG pulse detection + FFT moiré screen detection
// No in-browser ML models — all processing happens in the Python service.

const SUCCESS_DISPLAY_MS = 2000;
// ArcFace cosine-distance threshold — lower = stricter. 0.40 is recommended.
const MATCH_THRESHOLD = 0.40;

// Pulse accumulation: require N consecutive pulse-positive frames (mandatory — no timeout bypass)
const PULSE_CONSECUTIVE_REQUIRED = 3;
const PULSE_ACCUMULATE_MS = 5000; // visual progress ring duration target
// Max time to wait for pulse before giving a helpful message
const PULSE_TIMEOUT_MS = 15000;

let faceStream     = null;
let faceLoopActive = false;
let faceEnrolled   = [];

// State: 'idle' | 'matched' | 'executing' | 'cooldown'
let faceState        = 'idle';
let faceCurrentMatch = null;   // { ufid, name, action }

// rPPG pulse accumulation state
let pulseConsecutive = 0;  // consecutive frames with has_pulse=true
let pulseStartTime   = 0;  // when we first started accumulating pulse for current match
let screenFlagCount  = 0;  // how many frames flagged is_screen during current match attempt

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

function resetLivenessState() {
    pulseConsecutive = 0;
    pulseStartTime = 0;
    screenFlagCount = 0;
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

// ---- Detection loop (InsightFace + rPPG + moiré via Python IPC) ----
async function faceDetectLoop(video, canvas) {
    const ctx       = canvas.getContext('2d');
    const offscreen = document.createElement('canvas');

    // Send frames to Python every ~100ms for rPPG
    let lastIPCTime = 0;
    let pendingIPC = false;
    let lastFaceResult = null; // { embedding, bbox, det_score, has_pulse, pulse_confidence, moire_score, is_screen }
    let faceLostTicks = 0;    // tolerance for momentary detection drops
    const FACE_LOST_TOLERANCE = 5; // ~500ms at 100ms tick before resetting liveness

    const tick = async () => {
        if (!faceLoopActive) return;
        if (faceState === 'executing' || faceState === 'cooldown') {
            setTimeout(tick, 300);
            return;
        }

        const now = performance.now();

        // --- IPC to Python: throttled for ArcFace + rPPG + moiré ---
        if (!pendingIPC && (now - lastIPCTime > 100)) {
            pendingIPC = true;
            lastIPCTime = now;

            offscreen.width  = video.videoWidth;
            offscreen.height = video.videoHeight;
            offscreen.getContext('2d').drawImage(video, 0, 0);
            const base64 = offscreen.toDataURL('image/jpeg', 0.8).split(',')[1];

            window.electronAPI.faceProcessFrame(base64).then(result => {
                pendingIPC = false;
                lastFaceResult = result?.face || null;
            }).catch(() => { pendingIPC = false; });
        }

        // --- Process detections ---
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const face = lastFaceResult;

        if (face) {
            faceLostTicks = 0;
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
                // Track screen flags
                if (face.is_screen) {
                    screenFlagCount++;
                }

                // Instant reject if moiré consistently detects a screen
                if (face.is_screen && screenFlagCount >= 3) {
                    drawFaceBox(ctx, box, false);
                    resetLivenessState();
                    setProgressRing(0, 'verifying');
                    setFaceUI('idle', 'Screen detected — use a real face');
                    if (faceState === 'matched') enterIdleState();
                    setTimeout(tick, 200);
                    return;
                }

                drawFaceBox(ctx, box, true);

                if (faceState === 'idle') {
                    // Depth liveness: instant pass if depth camera confirms 3D face
                    const depthPass = face.has_depth === true;

                    if (!depthPass) {
                        // Fall back to rPPG pulse accumulation
                        if (pulseStartTime === 0) {
                            pulseStartTime = now;
                        }

                        if (face.has_pulse) {
                            pulseConsecutive++;
                        } else {
                            pulseConsecutive = 0;
                        }
                    }

                    const elapsed = pulseStartTime > 0 ? now - pulseStartTime : 0;
                    const pulsePass = pulseConsecutive >= PULSE_CONSECUTIVE_REQUIRED;
                    const livenessPass = depthPass || pulsePass;

                    const progress = depthPass ? 1 : Math.min(1, elapsed / PULSE_ACCUMULATE_MS);
                    setProgressRing(progress, livenessPass ? 'matched' : 'verifying');

                    console.log(`Liveness: depth=${face.has_depth} depth_score=${face.depth_score} has_pulse=${face.has_pulse} bpm=${face.pulse_bpm} consecutive=${pulseConsecutive} screenFlags=${screenFlagCount} → ${livenessPass ? (depthPass ? 'DEPTH_PASS' : 'PULSE_PASS') : 'accumulating'}`);

                    if (livenessPass) {
                        resetLivenessState();
                        setProgressRing(1, 'matched');
                        faceCurrentMatch = { ufid: bestMatch.ufid, name: bestMatch.name, action: null };
                        enterMatchedState(bestMatch.ufid, bestMatch.name);
                    } else if (elapsed > PULSE_TIMEOUT_MS) {
                        setFaceUI('idle', 'No pulse detected — ensure good lighting');
                    } else if (face.has_depth === null) {
                        setFaceUI('idle', 'Verifying pulse…');
                    } else if (elapsed > PULSE_ACCUMULATE_MS) {
                        setFaceUI('idle', 'Hold still — verifying…');
                    } else {
                        setFaceUI('idle', 'Verifying…');
                    }
                }
                // faceState === 'matched': waiting for Enter/click, no change
            } else {
                drawFaceBox(ctx, box, false);
                resetLivenessState();
                setProgressRing(0, 'verifying');
                if (faceState === 'matched') {
                    enterIdleState();
                }
                setFaceUI('idle', 'Face not recognized');
            }
        } else {
            faceLostTicks++;
            // Only reset liveness after sustained face loss (tolerance for flicker)
            if (faceLostTicks >= FACE_LOST_TOLERANCE) {
                resetLivenessState();
                setProgressRing(0, 'verifying');
                if (faceState === 'matched') {
                    enterIdleState();
                }
                setFaceUI('idle', 'Look at the camera to sign in or out');
            }
        }

        setTimeout(tick, 100); // ~10fps tick; IPC is throttled separately at ~7fps
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
    setProgressRing(0, 'verifying');
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
            const faceAction = statusResult.status === 'signin' ? 'signout' : 'signin';
            showFaceSuccess(result.studentName, faceAction === 'signout' ? 'Signed Out' : 'Signed In');
            showStudentSummary(ufid, faceAction);
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

    // Summary modal: dismiss on backdrop click, Enter, or Escape
    const summaryModal = document.getElementById('summaryModal');
    if (summaryModal) {
        summaryModal.addEventListener('click', (e) => {
            if (e.target === summaryModal) closeSummaryModal();
        });
    }
    document.addEventListener('keydown', (e) => {
        if (!summaryIsOpen) return;
        if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeSummaryModal();
            // Re-focus first UFID digit so the next student can start typing
            if (ufidInputs && ufidInputs[0]) ufidInputs[0].focus();
        }
    }, true);

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
                showStudentSummary(ufid, 'signout');
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
                showStudentSummary(ufid, 'signin');
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

// ==================== CONFETTI ====================

function launchConfetti(type) {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    canvas.style.display = 'block';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');

    const colors = type === 'signin'
        ? ['#f4845f','#7ec8a0','#f7b267','#f7d070','#c4a0e8','#7eb8d4','#f28b82','#81c995']
        : ['#8bb4e0','#b5c8e8','#a8b4d4','#c4c8e0','#9eb0b8','#7cb5d0','#a8d4e8'];

    const particles = Array.from({ length: type === 'signin' ? 70 : 40 }, () => {
        const angle = (Math.random() * 160 - 80) * Math.PI / 180; // spread upward
        const speed = 6 + Math.random() * 10;
        return {
            x: canvas.width / 2 + (Math.random() - 0.5) * 200,
            y: canvas.height * 0.45,
            vx: Math.sin(angle) * speed,
            vy: -Math.abs(Math.cos(angle)) * speed,
            rotation: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 12,
            color: colors[Math.floor(Math.random() * colors.length)],
            w: 7 + Math.random() * 7,
            h: 4 + Math.random() * 4,
            alpha: 1,
            gravity: 0.35 + Math.random() * 0.2
        };
    });

    let frame;
    const startTime = Date.now();

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const elapsed = Date.now() - startTime;
        const fadeStart = 2200;
        const fadeDuration = 1000;

        let alive = false;
        particles.forEach(p => {
            p.vy += p.gravity;
            p.x += p.vx;
            p.y += p.vy;
            p.rotation += p.rotSpeed;
            if (elapsed > fadeStart) p.alpha = Math.max(0, 1 - (elapsed - fadeStart) / fadeDuration);
            if (p.alpha > 0 && p.y < canvas.height + 20) {
                alive = true;
                ctx.save();
                ctx.globalAlpha = p.alpha;
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rotation * Math.PI / 180);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            }
        });

        if (alive && elapsed < fadeStart + fadeDuration) {
            frame = requestAnimationFrame(draw);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            canvas.style.display = 'none';
        }
    }
    if (frame) cancelAnimationFrame(frame);
    draw();
}

// ==================== STUDENT SUMMARY MODAL ====================

let summaryDismissTimeout = null;
let summaryIsOpen = false;

function closeSummaryModal() {
    const modal = document.getElementById('summaryModal');
    if (!modal) return;
    modal.classList.remove('show');
    summaryIsOpen = false;
    if (summaryDismissTimeout) { clearTimeout(summaryDismissTimeout); summaryDismissTimeout = null; }
}

async function showStudentSummary(ufid, action) {
    const modal = document.getElementById('summaryModal');
    const progressBar = document.getElementById('summaryProgressBar');
    if (!modal) return;

    closeSummaryModal();
    progressBar.classList.remove('running');
    void progressBar.offsetWidth;

    try {
        const summary = await window.electronAPI.getStudentSummary(ufid);
        if (!summary || summary.error) return;

        const fmtMins = (minutes) => {
            const h = Math.floor(minutes / 60);
            const m = minutes % 60;
            if (h > 0 && m > 0) return `${h}<span>h</span> ${m}<span>m</span>`;
            if (h > 0) return `${h}<span>h</span>`;
            return `${m}<span>m</span>`;
        };

        const fmtTime = (iso) => {
            if (!iso) return '—';
            return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        };

        const fmtDur = (inIso, outIso) => {
            const diff = Math.round((new Date(outIso) - new Date(inIso)) / 60000);
            const h = Math.floor(diff / 60), m = diff % 60;
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
        };

        // Greeting
        const isSignIn = action === 'signin';
        document.getElementById('summaryHeaderBand').className = `summary-header-band ${isSignIn ? 'signin' : 'signout'}`;
        const iconEl = document.getElementById('summaryGreetingIcon');
        const iconI = document.getElementById('summaryGreetingIconEl');
        iconEl.className = `summary-greeting-icon ${isSignIn ? 'signin' : 'signout'}`;
        iconI.className = isSignIn ? 'fas fa-right-to-bracket' : 'fas fa-right-from-bracket';
        document.getElementById('summaryGreetingTitle').textContent =
            isSignIn ? `Welcome, ${summary.name}!` : `Goodbye, ${summary.name}!`;
        document.getElementById('summaryGreetingSubtitle').textContent =
            isSignIn ? 'Signed in successfully.' : 'Signed out successfully. See you next time!';

        const badge = document.getElementById('summaryBadge');
        badge.className = `summary-badge ${isSignIn ? 'signed-in' : 'signed-out'}`;
        document.getElementById('summaryBadgeText').textContent = isSignIn ? 'Now Signed In' : 'Now Signed Out';

        const progressBar = document.getElementById('summaryProgressBar');
        progressBar.className = `summary-progress-bar ${isSignIn ? 'signin' : 'signout'}`;

        // Pending warning
        const pendingEl = document.getElementById('summaryPending');
        if (summary.pendingCount > 0) {
            document.getElementById('summaryPendingText').textContent =
                `You have ${summary.pendingCount} unresolved pending sign-out${summary.pendingCount > 1 ? 's' : ''} — check your email to submit your sign-out time.`;
            pendingEl.style.display = 'flex';
        } else {
            pendingEl.style.display = 'none';
        }

        // Stats
        document.getElementById('summaryTodayHours').innerHTML = fmtMins(summary.todayMinutes);
        document.getElementById('summaryWeekHours').innerHTML = fmtMins(summary.weekMinutes);
        document.getElementById('summarySessionCount').textContent = summary.todaySessionCount;
        document.getElementById('summarySessionSub').textContent =
            summary.todaySessionCount === 1 ? 'session today' : 'sessions today';

        // Weekly day breakdown
        const weekContainer = document.getElementById('summaryWeekDays');
        weekContainer.innerHTML = '';
        const todayStr = new Date().toDateString();
        (summary.weekDays || []).forEach(day => {
            const isToday = new Date(day.date).toDateString() === todayStr;
            const row = document.createElement('div');
            row.className = 'summary-day-row';

            const labelEl = document.createElement('div');
            labelEl.className = `summary-day-label${isToday ? ' today' : ''}`;
            labelEl.textContent = isToday ? 'Today' : day.label;

            const sessionsEl = document.createElement('div');
            sessionsEl.className = 'summary-day-sessions';
            if (day.sessions.length === 0) {
                const none = document.createElement('span');
                none.className = 'summary-day-none';
                none.textContent = 'No activity';
                sessionsEl.appendChild(none);
            } else {
                day.sessions.forEach(s => {
                    const sessEl = document.createElement('div');
                    sessEl.className = `summary-day-session${s.running ? ' running' : ''}`;
                    const timeSpan = document.createElement('span');
                    timeSpan.className = 'sess-time';
                    timeSpan.textContent = s.running
                        ? `${fmtTime(s.in)} → now`
                        : `${fmtTime(s.in)} → ${fmtTime(s.out)}`;
                    const durSpan = document.createElement('span');
                    durSpan.className = 'sess-dur';
                    durSpan.textContent = fmtDur(s.in, s.out);
                    sessEl.appendChild(timeSpan);
                    sessEl.appendChild(durSpan);
                    sessionsEl.appendChild(sessEl);
                });
            }

            const hoursEl = document.createElement('div');
            hoursEl.className = `summary-day-hours${day.minutes > 0 ? ' has-hours' : ''}`;
            hoursEl.textContent = day.minutes > 0
                ? `${Math.floor(day.minutes / 60)}h ${day.minutes % 60}m`
                : '—';

            row.appendChild(labelEl);
            row.appendChild(sessionsEl);
            row.appendChild(hoursEl);
            weekContainer.appendChild(row);
        });

        modal.classList.add('show');
        summaryIsOpen = true;
        progressBar.classList.add('running');
        summaryDismissTimeout = setTimeout(closeSummaryModal, 12000);

        launchConfetti(action);
    } catch (e) {
        console.error('showStudentSummary error:', e);
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
