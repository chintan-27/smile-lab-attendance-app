#!/usr/bin/env python3
"""
InsightFace recognition service for SMILE Lab Attendance.
Runs as a local FastAPI server. Prints READY:<port> to stdout when ready.
Main process communicates via HTTP on localhost.

Liveness:
  - Depth (Orbbec Astra): 3D face structure verification — flat photos/screens
    have no depth variance, real faces do.  Primary liveness signal when camera
    is connected.
  - rPPG (remote photoplethysmography): detects blood pulse from subtle skin
    colour changes — physically unforgeable since screens cannot produce cardiac
    pulse signals.  Uses the POS (Plane Orthogonal to Skin) algorithm with
    bandpass filtering and FFT peak detection.
  - Moire FFT: identifies phone-screen pixel-grid artefacts in the 2D frequency
    domain — provides an instant per-frame signal.
"""
import sys
import os
import base64
import socket
import time
import traceback
import threading
from typing import Optional, List, Dict

import numpy as np
import cv2
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from scipy.signal import butter, filtfilt

# ---------------------------------------------------------------------------
# Model initialisation
# ---------------------------------------------------------------------------
from insightface.app import FaceAnalysis

_fa = None


def _init_model(model_dir: Optional[str] = None):
    global _fa
    kwargs = {
        "name": "buffalo_sc",           # ~50 MB; swap to "buffalo_l" for higher accuracy
        "providers": ["CPUExecutionProvider"],
    }
    if model_dir:
        kwargs["root"] = model_dir
    _fa = FaceAnalysis(**kwargs)
    _fa.prepare(ctx_id=0, det_size=(320, 320))


# ---------------------------------------------------------------------------
# Depth + IR camera (Orbbec Astra via orbbec-astra-raw) — background thread
# ---------------------------------------------------------------------------

_depth_lock = threading.Lock()
_latest_depth: Optional[np.ndarray] = None  # (480, 640) float32 in mm
_latest_ir: Optional[np.ndarray] = None     # (480, 640) uint16 structured-light IR
_depth_available = False
_astra_cam = None  # AstraIRCamera instance

_DEPTH_VARIANCE_THRESHOLD = 150  # real face ~200-2000; flat surface <50
_DEPTH_COVERAGE_MIN = 0.25       # at least 25% of face ROI must have valid depth
_DEPTH_RANGE_MM = (150, 2000)    # 15cm–2m — widened from 300-1500 to handle close-up use
_IR_TEXTURE_VAR_THRESHOLD = 500  # uint16 std dev; real faces distort structured dots


def _start_astra_thread():
    """Non-blocking: try to open AstraIRCamera, probe for frames, start poll loop."""
    global _depth_available, _astra_cam

    try:
        from astra_raw import AstraIRCamera
    except ImportError:
        print("[Astra] orbbec-astra-raw not installed — depth+IR liveness disabled", flush=True)
        return

    try:
        cam = AstraIRCamera(color_index=None)
        cam.open()  # must call open() to start the background USB streaming thread
        print("[Astra] camera opened, waiting for first frames…", flush=True)
    except Exception as e:
        print(f"[Astra] camera init failed: {e} — depth+IR liveness disabled", flush=True)
        return

    # Probe: read_depth_mm blocks up to `timeout` seconds waiting for first frame
    try:
        d  = cam.read_depth_mm(timeout=8.0)
        ir = cam.read_ir(timeout=8.0)
    except Exception as e:
        print(f"[Astra] probe read failed: {e} — depth+IR liveness disabled", flush=True)
        try: cam.close()
        except Exception: pass
        return

    if d is None or ir is None:
        print("[Astra] no frames received in 8s — camera connected but not streaming; depth+IR disabled", flush=True)
        try: cam.close()
        except Exception: pass
        return

    _astra_cam = cam
    _depth_available = True
    print(f"[Astra] camera ready — depth shape={d.shape} IR shape={ir.shape} — depth+IR liveness enabled", flush=True)
    threading.Thread(target=_astra_poll_loop, args=(cam,), daemon=True).start()


def _astra_poll_loop(cam):
    """Background thread: polls AstraIRCamera at ~30fps, stores latest depth+IR frames.
    Color is NOT read here — on Windows, OpenCV holds the camera exclusively which
    blocks getUserMedia in the browser. Frames come from the renderer instead."""
    global _latest_depth, _latest_ir
    while True:
        try:
            depth = cam.read_depth_mm(timeout=0.5)
            ir    = cam.read_ir(timeout=0.5)
            if depth is not None and ir is not None:
                with _depth_lock:
                    _latest_depth = depth.astype(np.float32)
                    _latest_ir    = ir
        except Exception as e:
            print(f"[Astra] poll error: {e}", flush=True)
            time.sleep(1.0)
            continue
        time.sleep(1 / 30)


def _center_region(frame_h: int, frame_w: int):
    """Return (y1, y2, x1, x2) for the central 50% of the frame."""
    return frame_h // 4, 3 * frame_h // 4, frame_w // 4, 3 * frame_w // 4


def _ir_liveness(bbox) -> dict:
    """
    Structured-light IR texture variance check.
    Uses the center region of the IR frame rather than the color-camera bbox
    to avoid coordinate-space misalignment between the Mac camera and Astra sensor.
    Real 3D faces distort the projected dot pattern → high spatial std.
    Flat photos/screens reflect dots uniformly → low std.
    """
    with _depth_lock:
        ir_map = _latest_ir

    if ir_map is None:
        return {"has_ir": None, "ir_score": 0.0}

    h, w = ir_map.shape[:2]
    y1, y2, x1, x2 = _center_region(h, w)
    region_ir = ir_map[y1:y2, x1:x2].astype(np.float32)

    if region_ir.size == 0:
        return {"has_ir": None, "ir_score": 0.0}

    valid = region_ir[(region_ir > 10) & (region_ir < 65000)]
    if valid.size < region_ir.size * 0.1:
        return {"has_ir": None, "ir_score": 0.0}

    score = float(np.std(valid))
    has_ir = score > _IR_TEXTURE_VAR_THRESHOLD

    print(
        f"[IR] score={score:.1f} threshold={_IR_TEXTURE_VAR_THRESHOLD} "
        f"-> {'REAL_FACE' if has_ir else 'FLAT'}",
        flush=True,
    )
    return {"has_ir": has_ir, "ir_score": round(score, 1)}


# Keep legacy stub so any leftover pyorbbecsdk detection code doesn't break at import
def _detect_depth_sdk():
    """Returns 'v2', 'v1', or None.
    pyorbbecsdk2 (PyPI) installs its module as 'pyorbbecsdk', so we distinguish
    v1 vs v2 by checking for the Pipeline class (v2 API) vs Context-only (v1 API).
    """
    try:
        from pyorbbecsdk import Pipeline  # noqa — v2 API
        return 'v2'
    except (ImportError, AttributeError):
        pass
    try:
        from pyorbbecsdk import Context  # noqa — v1 API
        return 'v1'
    except ImportError:
        pass
    return None




def _depth_liveness(bbox) -> dict:
    """
    Check if the face region has real 3D depth structure.
    When using an external color camera (not Astra), the face bbox may not align
    with the depth sensor — in that case falls back to the center region of the frame.
    """
    with _depth_lock:
        depth_map = _latest_depth

    if depth_map is None:
        return {"has_depth": None, "depth_score": 0.0, "median_depth_mm": 0}

    h, w = depth_map.shape[:2]

    # Try the face bbox first (works correctly when color comes from Astra)
    x1, y1, x2, y2 = [int(v) for v in bbox]
    x1 = max(0, min(x1, w - 1)); x2 = max(x1 + 1, min(x2, w))
    y1 = max(0, min(y1, h - 1)); y2 = max(y1 + 1, min(y2, h))
    region = depth_map[y1:y2, x1:x2]
    nonzero = region[region > 0.0].astype(np.float64)
    coverage = len(nonzero) / max(region.size, 1)

    if coverage < _DEPTH_COVERAGE_MIN:
        # Bbox misaligned (non-Astra color camera) — fall back to center 50% of frame
        cy1, cy2, cx1, cx2 = _center_region(h, w)
        center = depth_map[cy1:cy2, cx1:cx2]
        nonzero = center[center > 0.0].astype(np.float64)
        coverage = len(nonzero) / max(center.size, 1)
        if coverage < _DEPTH_COVERAGE_MIN:
            print(f"[Depth] coverage={coverage:.2f} < {_DEPTH_COVERAGE_MIN} -> insufficient data", flush=True)
            return {"has_depth": None, "depth_score": 0.0, "median_depth_mm": 0}

    variance = float(np.var(nonzero))
    median_mm = int(np.median(nonzero))
    has_depth = (
        variance > _DEPTH_VARIANCE_THRESHOLD
        and _DEPTH_RANGE_MM[0] < median_mm < _DEPTH_RANGE_MM[1]
    )

    print(
        f"[Depth] coverage={coverage:.2f} var={variance:.0f} median={median_mm}mm "
        f"-> {'3D_FACE' if has_depth else 'FLAT'}",
        flush=True,
    )
    return {"has_depth": has_depth, "depth_score": round(variance, 1), "median_depth_mm": median_mm}


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    image: str  # base64-encoded JPEG


@app.get("/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------------------
# rPPG — remote photoplethysmography (POS algorithm)
# ---------------------------------------------------------------------------

_rppg_buffer: List[Dict] = []   # [{ mean_rgb: [R,G,B], timestamp: float }, …]
_RPPG_MAX_FRAMES = 120          # ~4 seconds at 30fps (or ~40s at 3fps; trimmed by time)
_RPPG_MIN_FRAMES = 9            # minimum frames before attempting analysis (~1s at 10fps)
_RPPG_WINDOW_SEC = 6.0          # keep at most this many seconds of history
_RPPG_SNR_THRESHOLD = 3.5       # SNR above which we declare a pulse found
_RPPG_BPM_LOW = 45.0            # reject pulse below this (not physiological)
_RPPG_BPM_HIGH = 180.0          # reject pulse above this (not physiological)


def _butterworth_bandpass(lowcut: float, highcut: float, fs: float, order: int = 3):
    """Design a Butterworth bandpass filter."""
    nyq = 0.5 * fs
    low = max(lowcut / nyq, 0.01)
    high = min(highcut / nyq, 0.80)   # cap well below Nyquist for stability
    if high <= low:
        high = low + 0.01
    return butter(order, [low, high], btype="band")


def _rppg_analyze(img_bgr: np.ndarray, bbox) -> dict:
    """
    Extract forehead ROI mean RGB, append to buffer, run POS algorithm.
    Returns { has_pulse, pulse_confidence, pulse_bpm }.
    """
    global _rppg_buffer

    x1, y1, x2, y2 = [int(v) for v in bbox]
    h, w = img_bgr.shape[:2]
    face_h = y2 - y1
    face_w = x2 - x1

    # Forehead ROI: upper 30% of face bbox, inner 60% width
    roi_x1 = max(0, x1 + int(face_w * 0.2))
    roi_x2 = min(w, x2 - int(face_w * 0.2))
    roi_y1 = max(0, y1)
    roi_y2 = max(roi_y1 + 1, y1 + int(face_h * 0.3))
    roi_y2 = min(h, roi_y2)

    roi = img_bgr[roi_y1:roi_y2, roi_x1:roi_x2]
    if roi.size == 0:
        return {"has_pulse": False, "pulse_confidence": 0.0, "pulse_bpm": 0.0}

    # Mean RGB (BGR->RGB)
    mean_bgr = roi.mean(axis=(0, 1))
    mean_rgb = [float(mean_bgr[2]), float(mean_bgr[1]), float(mean_bgr[0])]

    now = time.monotonic()
    _rppg_buffer.append({"mean_rgb": mean_rgb, "timestamp": now})

    # Trim buffer by time window
    cutoff = now - _RPPG_WINDOW_SEC
    _rppg_buffer = [f for f in _rppg_buffer if f["timestamp"] >= cutoff]

    if len(_rppg_buffer) < _RPPG_MIN_FRAMES:
        return {"has_pulse": False, "pulse_confidence": 0.0, "pulse_bpm": 0.0}

    # Build signal arrays
    timestamps = np.array([f["timestamp"] for f in _rppg_buffer])
    rgb = np.array([f["mean_rgb"] for f in _rppg_buffer])  # (N, 3)

    # Estimate sample rate from timestamps
    dt = np.diff(timestamps)
    if len(dt) == 0 or dt.mean() < 1e-6:
        return {"has_pulse": False, "pulse_confidence": 0.0, "pulse_bpm": 0.0}
    fs = 1.0 / dt.mean()

    # Need at least ~1 second of data for meaningful FFT
    duration = timestamps[-1] - timestamps[0]
    if duration < 1.0:
        return {"has_pulse": False, "pulse_confidence": 0.0, "pulse_bpm": 0.0}

    n = len(timestamps)

    # Check temporal variance of green channel — static photos have near-zero variance
    # (only JPEG compression noise ~0.1-0.5), while real skin shows ~1-5+ from blood flow
    green_vals = rgb[:, 1]
    green_var = float(np.var(green_vals))
    if green_var < 0.3:
        print(f"[rPPG] frames={n} green_var={green_var:.3f} -> STATIC (no temporal change)", flush=True)
        return {"has_pulse": False, "pulse_confidence": 0.0, "pulse_bpm": 0.0}

    # Detrend: subtract rolling mean (window = 15 frames or n//3)
    win = min(15, max(3, n // 3))
    R = rgb[:, 0].copy()
    G = rgb[:, 1].copy()
    B = rgb[:, 2].copy()
    for ch in (R, G, B):
        kernel = np.ones(win) / win
        smooth = np.convolve(ch, kernel, mode="same")
        ch -= smooth

    # POS algorithm: Plane Orthogonal to Skin
    S1 = G - B
    S2 = G + B - 2 * R

    std_s1 = np.std(S1)
    std_s2 = np.std(S2)
    if std_s2 < 1e-8:
        return {"has_pulse": False, "pulse_confidence": 0.0, "pulse_bpm": 0.0}

    H = S1 + (std_s1 / std_s2) * S2

    # Bandpass filter: 0.7 Hz – min(3.0, 0.8*Nyquist) Hz
    # At ~7fps Nyquist is ~3.5Hz; capping at 0.8*Nyq keeps the filter stable
    highcut_actual = min(3.0, 0.8 * 0.5 * fs)
    try:
        b_coeff, a_coeff = _butterworth_bandpass(0.7, highcut_actual, fs, order=3)
        # Need enough samples for filtfilt (3 * max(len(a), len(b)) - 1)
        min_padlen = 3 * max(len(a_coeff), len(b_coeff)) - 1
        if len(H) <= min_padlen:
            return {"has_pulse": False, "pulse_confidence": 0.0, "pulse_bpm": 0.0}
        H_filtered = filtfilt(b_coeff, a_coeff, H)
    except Exception:
        return {"has_pulse": False, "pulse_confidence": 0.0, "pulse_bpm": 0.0}

    # FFT
    N = len(H_filtered)
    fft_vals = np.fft.rfft(H_filtered)
    fft_mag = np.abs(fft_vals)
    freqs = np.fft.rfftfreq(N, d=1.0 / fs)

    # Restrict to pulse-plausible range
    mask = (freqs >= 0.7) & (freqs <= highcut_actual)
    if not np.any(mask):
        return {"has_pulse": False, "pulse_confidence": 0.0, "pulse_bpm": 0.0}

    pulse_freqs = freqs[mask]
    pulse_mag = fft_mag[mask]

    peak_idx = np.argmax(pulse_mag)
    peak_power = pulse_mag[peak_idx] ** 2
    peak_freq = pulse_freqs[peak_idx]

    # SNR: peak power vs mean power outside a ±0.2 Hz band around peak
    band_mask = np.abs(pulse_freqs - peak_freq) > 0.2
    if np.any(band_mask):
        noise_power = np.mean(pulse_mag[band_mask] ** 2)
    else:
        noise_power = np.mean(pulse_mag ** 2)

    snr = peak_power / max(noise_power, 1e-10)
    pulse_bpm = float(peak_freq * 60.0)

    # Require both sufficient SNR AND physiologically plausible BPM
    bpm_ok = _RPPG_BPM_LOW <= pulse_bpm <= _RPPG_BPM_HIGH
    has_pulse = bool(snr > _RPPG_SNR_THRESHOLD and bpm_ok)
    pulse_confidence = min(1.0, snr / 6.0) if bpm_ok else 0.0

    print(f"[rPPG] frames={n} fs={fs:.1f} snr={snr:.2f} bpm={pulse_bpm:.0f} bpm_ok={bpm_ok} -> {'PULSE' if has_pulse else 'no pulse'}", flush=True)

    return {
        "has_pulse": has_pulse,
        "pulse_confidence": round(pulse_confidence, 3),
        "pulse_bpm": round(pulse_bpm, 1),
    }


# ---------------------------------------------------------------------------
# Moire FFT — screen pixel-grid detection
# ---------------------------------------------------------------------------

_MOIRE_THRESHOLD = 80.0   # real faces score 28-50; screens with pixel-grid moiré score 100+


def _moire_analyze(img_bgr: np.ndarray, bbox) -> dict:
    """
    2D FFT on face crop to detect periodic moiré patterns from phone screens.
    Returns { moire_score, is_screen }.
    """
    x1, y1, x2, y2 = [int(v) for v in bbox]
    h, w = img_bgr.shape[:2]
    cx1 = max(0, x1)
    cy1 = max(0, y1)
    cx2 = min(w, x2)
    cy2 = min(h, y2)

    crop = img_bgr[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return {"moire_score": 0.0, "is_screen": False}

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray, (256, 256)).astype(np.float32)

    # Apply 2D Hanning window to reduce edge artefacts
    hanning = np.outer(np.hanning(256), np.hanning(256)).astype(np.float32)
    windowed = resized * hanning

    # 2D FFT -> magnitude spectrum
    fft2 = np.fft.fft2(windowed)
    fft_shift = np.fft.fftshift(fft2)
    magnitude = np.abs(fft_shift) + 1e-8  # avoid log(0)

    # Mask out low-frequency center (radius ~30 pixels)
    cy_f, cx_f = 128, 128
    Y, X = np.ogrid[:256, :256]
    dist = np.sqrt((X - cx_f) ** 2 + (Y - cy_f) ** 2)
    high_freq_mask = dist > 30

    high_mag = magnitude[high_freq_mask]
    if high_mag.size == 0:
        return {"moire_score": 0.0, "is_screen": False}

    moire_score = float(np.max(high_mag) / np.mean(high_mag))
    is_screen = moire_score > _MOIRE_THRESHOLD

    print(f"[Moire] score={moire_score:.1f} threshold={_MOIRE_THRESHOLD} -> {'SCREEN' if is_screen else 'ok'}", flush=True)

    return {
        "moire_score": round(moire_score, 2),
        "is_screen": bool(is_screen),
    }


# ---------------------------------------------------------------------------
# /analyze endpoint
# ---------------------------------------------------------------------------

@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    """
    Detect the largest face in the image.
    Returns:
      { face: { bbox, embedding, kps, det_score,
                 has_pulse, pulse_confidence, pulse_bpm,
                 moire_score, is_screen } }
      or  { face: null }
    """
    try:
        img = _b64_to_bgr(req.image)

        faces = _fa.get(img)
        if not faces:
            return {"face": None}

        # largest face by bounding-box area
        face = max(
            faces,
            key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
        )
        result: dict = {
            "bbox": face.bbox.tolist(),          # [x1, y1, x2, y2]
            "det_score": float(face.det_score),
            "embedding": face.embedding.tolist(), # 512-dim ArcFace vector
        }
        if face.kps is not None:
            result["kps"] = face.kps.tolist()

        # Moire screen detection (always run — instant per-frame signal)
        moire = _moire_analyze(img, face.bbox)
        result["moire_score"] = moire["moire_score"]
        result["is_screen"] = moire["is_screen"]

        # Depth + IR liveness (Orbbec Astra via orbbec-astra-raw)
        if _depth_available:
            depth_r = _depth_liveness(face.bbox)
            ir_r = _ir_liveness(face.bbox)
            d_ok, i_ok = depth_r["has_depth"], ir_r["has_ir"]
            # IR alone is sufficient (structured-light is highly reliable).
            # Depth adds extra confidence but its range/coverage can be marginal.
            # Reject only when BOTH signals say flat, or when we have no data yet.
            if i_ok is True:
                combined = True   # IR confirms 3D face — pass regardless of depth
            elif i_ok is False and d_ok is False:
                combined = False  # both say flat → reject
            elif d_ok is True:
                combined = True   # depth confirms 3D face (IR still warming up)
            elif d_ok is False:
                combined = False  # depth says flat, IR uncertain → reject
            else:
                combined = None   # waiting for data
            result["has_depth"] = combined
            result["depth_score"] = depth_r["depth_score"]
            result["median_depth_mm"] = depth_r["median_depth_mm"]
            result["ir_score"] = ir_r["ir_score"]
            # rPPG not needed when depth+IR is present; set neutral values
            result["has_pulse"] = False
            result["pulse_confidence"] = 0.0
            result["pulse_bpm"] = 0.0
        else:
            # No Astra camera: fall back to rPPG pulse accumulation
            rppg = _rppg_analyze(img, face.bbox)
            result["has_pulse"] = rppg["has_pulse"]
            result["pulse_confidence"] = rppg["pulse_confidence"]
            result["pulse_bpm"] = rppg["pulse_bpm"]
            result["has_depth"] = None
            result["depth_score"] = 0.0
            result["median_depth_mm"] = 0
            result["ir_score"] = 0.0

        return {"face": result}

    except Exception:
        traceback.print_exc()
        return {"face": None, "error": traceback.format_exc(limit=3)}


@app.post("/reset-liveness")
def reset_liveness():
    """Clear the rPPG frame buffer (e.g. after sign-in/out or camera restart)."""
    global _rppg_buffer
    _rppg_buffer = []
    return {"ok": True}


@app.get("/camera-status")
def camera_status():
    """Full camera status: depth/IR availability."""
    return {
        "depth_available": _depth_available,
        "color_from_astra": False,
    }


@app.get("/depth-status")
def depth_status():
    """Check if depth camera is available."""
    return {"available": _depth_available}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _b64_to_bgr(b64: str):
    data = base64.b64decode(b64)
    arr = np.frombuffer(data, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    model_dir = sys.argv[1] if len(sys.argv) > 1 else None
    _init_model(model_dir)

    # Start Astra camera in background (non-blocking — doesn't delay READY signal)
    threading.Thread(target=_start_astra_thread, daemon=True).start()

    port = _find_free_port()
    # Signal to the Node parent that we are ready
    print(f"READY:{port}", flush=True)

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="error")

    # Clean up: stop Astra camera streaming
    if _astra_cam is not None:
        try: _astra_cam.close()
        except Exception: pass
