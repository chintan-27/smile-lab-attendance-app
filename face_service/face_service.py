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
import multiprocessing
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
# Depth camera (Orbbec Astra) — background thread
# ---------------------------------------------------------------------------

_depth_lock = threading.Lock()
_latest_depth: Optional[np.ndarray] = None  # (H, W) uint16 in mm
_depth_available = False
_depth_proc: Optional[multiprocessing.Process] = None

_DEPTH_VARIANCE_THRESHOLD = 150  # real face ~200-2000; flat surface <50
_DEPTH_COVERAGE_MIN = 0.3        # at least 30% of face ROI must have valid depth
_DEPTH_RANGE_MM = (300, 1500)    # plausible face distance in mm

# Shared memory for depth frames (640*480*2 bytes = 614400)
_DEPTH_W, _DEPTH_H = 640, 480
_depth_shm: Optional[multiprocessing.Array] = None
_depth_flag: Optional[multiprocessing.Value] = None  # 1 = new frame ready


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


def _depth_subprocess_v2(shm_array, flag_value, stop_event):
    """pyorbbecsdk2 (OrbbecSDK 2.x) — Pipeline-based depth stream.
    pyorbbecsdk2 installs as the 'pyorbbecsdk' module name.
    """
    import signal
    signal.signal(signal.SIGSEGV, lambda s, f: os._exit(1))

    try:
        from pyorbbecsdk import Pipeline, Config, OBSensorType
        import numpy as np

        pipeline = Pipeline()
        config = Config()
        profile_list = pipeline.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
        if profile_list is None or profile_list.get_count() == 0:
            print("[Depth-proc-v2] no depth profiles found", flush=True)
            return

        profile = None
        for i in range(profile_list.get_count()):
            p = profile_list.get_video_stream_profile(i)
            if p and p.get_width() == 640 and p.get_height() == 480 and p.get_fps() == 30:
                profile = p
                break
        if profile is None:
            profile = profile_list.get_default_video_stream_profile()

        config.enable_stream(profile)
        pipeline.start(config)
        print(f"[Depth-proc-v2] pipeline started {profile.get_width()}x{profile.get_height()}@{profile.get_fps()}fps", flush=True)

        while not stop_event.is_set():
            frames = pipeline.wait_for_frames(timeout_ms=100)
            if frames is None:
                continue
            depth_frame = frames.get_depth_frame()
            if depth_frame is None:
                continue
            w = depth_frame.get_width()
            h = depth_frame.get_height()
            data = np.frombuffer(depth_frame.get_data(), dtype=np.uint16)
            if data.size >= w * h:
                arr = np.frombuffer(shm_array.get_obj(), dtype=np.uint16)
                np.copyto(arr[:w * h], data[:w * h])
                flag_value.value = 1

        pipeline.stop()

    except Exception as e:
        print(f"[Depth-proc-v2] error: {e}", flush=True)


def _depth_subprocess_v1(shm_array, flag_value, stop_event):
    """pyorbbecsdk (OrbbecSDK 1.x) — sensor callback depth stream."""
    import signal
    signal.signal(signal.SIGSEGV, lambda s, f: os._exit(1))

    try:
        from pyorbbecsdk import Context, OBSensorType
        import numpy as np

        ctx = Context()
        dl = ctx.query_devices()
        if dl.get_count() == 0:
            print("[Depth-proc-v1] no camera", flush=True)
            return

        dev = dl.get_device_by_index(0)
        sensor = dev.get_sensor(OBSensorType.DEPTH_SENSOR)
        profile_list = sensor.get_stream_profile_list()

        profile = None
        for i in range(profile_list.get_count()):
            p = profile_list.get_stream_profile_by_index(i)
            vp = p.as_video_stream_profile()
            if vp.get_width() == 640 and vp.get_height() == 480 and vp.get_fps() == 30:
                profile = p
                break
        if profile is None:
            profile = profile_list.get_default_video_stream_profile()

        vp = profile.as_video_stream_profile()
        print(f"[Depth-proc-v1] starting {vp.get_width()}x{vp.get_height()}@{vp.get_fps()}fps", flush=True)

        def on_frame(frame):
            try:
                w, h = frame.get_width(), frame.get_height()
                data = np.frombuffer(frame.get_data(), dtype=np.uint16)
                if data.size >= w * h:
                    arr = np.frombuffer(shm_array.get_obj(), dtype=np.uint16)
                    np.copyto(arr, data[:w * h])
                    flag_value.value = 1
            except Exception:
                pass

        sensor.start(profile, on_frame)
        print("[Depth-proc-v1] sensor started", flush=True)
        stop_event.wait()
        try:
            sensor.stop()
        except Exception:
            pass

    except Exception as e:
        print(f"[Depth-proc-v1] error: {e}", flush=True)


def _start_depth_thread():
    """Spawn depth camera in an isolated subprocess. Supports pyorbbecsdk2 (v2) and pyorbbecsdk (v1)."""
    global _depth_available, _depth_proc, _depth_shm, _depth_flag

    sdk_ver = _detect_depth_sdk()
    if sdk_ver is None:
        print("[Depth] no Orbbec SDK installed — depth liveness disabled", flush=True)
        return

    print(f"[Depth] using SDK {sdk_ver}", flush=True)

    # Quick device detection before spawning subprocess
    try:
        from pyorbbecsdk import Context
        ctx = Context()
        dl = ctx.query_devices()
        if dl.get_count() == 0:
            print("[Depth] no Orbbec camera detected — depth liveness disabled", flush=True)
            return
        info = dl.get_device_by_index(0).get_device_info()
        print(f"[Depth] found {info.get_name()} (SN: {info.get_serial_number()})", flush=True)
        del ctx, dl
    except Exception as e:
        print(f"[Depth] detection failed: {e} — depth liveness disabled", flush=True)
        return

    _depth_shm = multiprocessing.Array('H', _DEPTH_W * _DEPTH_H)
    _depth_flag = multiprocessing.Value('i', 0)
    stop_event = multiprocessing.Event()

    target_fn = _depth_subprocess_v2 if sdk_ver == 'v2' else _depth_subprocess_v1
    _depth_proc = multiprocessing.Process(
        target=target_fn,
        args=(_depth_shm, _depth_flag, stop_event),
        daemon=True,
    )
    _depth_proc.start()
    print(f"[Depth] subprocess started (PID {_depth_proc.pid})", flush=True)

    # Wait up to 15s for first frame
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if _depth_flag.value == 1:
            _depth_available = True
            print("[Depth] receiving depth frames — liveness enabled", flush=True)
            t = threading.Thread(target=_depth_shm_reader, daemon=True)
            t.start()
            return
        if not _depth_proc.is_alive():
            print("[Depth] subprocess exited — depth liveness disabled", flush=True)
            return
        time.sleep(0.5)

    print("[Depth] timeout waiting for frames — depth liveness disabled", flush=True)
    _depth_proc.kill()


def _depth_shm_reader():
    """Copy depth frames from shared memory into _latest_depth."""
    global _latest_depth
    while _depth_available and _depth_proc and _depth_proc.is_alive():
        if _depth_flag.value == 1:
            _depth_flag.value = 0
            arr = np.frombuffer(_depth_shm.get_obj(), dtype=np.uint16).copy()
            with _depth_lock:
                _latest_depth = arr.reshape((_DEPTH_H, _DEPTH_W))
        time.sleep(0.03)  # ~30 Hz polling


def _depth_liveness(bbox) -> dict:
    """Check if the face region has real 3D depth structure."""
    with _depth_lock:
        depth_map = _latest_depth

    if depth_map is None:
        return {"has_depth": None, "depth_score": 0.0, "median_depth_mm": 0}

    x1, y1, x2, y2 = [int(v) for v in bbox]
    h, w = depth_map.shape[:2]

    # Clamp to depth frame bounds
    x1 = max(0, min(x1, w - 1))
    x2 = max(x1 + 1, min(x2, w))
    y1 = max(0, min(y1, h - 1))
    y2 = max(y1 + 1, min(y2, h))

    face_depth = depth_map[y1:y2, x1:x2]
    if face_depth.size == 0:
        return {"has_depth": None, "depth_score": 0.0, "median_depth_mm": 0}

    nonzero = face_depth[face_depth > 0].astype(np.float64)
    coverage = len(nonzero) / max(face_depth.size, 1)

    if coverage < _DEPTH_COVERAGE_MIN:
        print(f"[Depth] coverage={coverage:.2f} < {_DEPTH_COVERAGE_MIN} -> insufficient data", flush=True)
        return {"has_depth": False, "depth_score": 0.0, "median_depth_mm": 0}

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

    return {
        "has_depth": has_depth,
        "depth_score": round(variance, 1),
        "median_depth_mm": median_mm,
    }


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

        # rPPG pulse detection
        rppg = _rppg_analyze(img, face.bbox)
        result["has_pulse"] = rppg["has_pulse"]
        result["pulse_confidence"] = rppg["pulse_confidence"]
        result["pulse_bpm"] = rppg["pulse_bpm"]

        # Moire screen detection
        moire = _moire_analyze(img, face.bbox)
        result["moire_score"] = moire["moire_score"]
        result["is_screen"] = moire["is_screen"]

        # Depth liveness (Orbbec Astra)
        if _depth_available:
            depth = _depth_liveness(face.bbox)
            result["has_depth"] = depth["has_depth"]
            result["depth_score"] = depth["depth_score"]
            result["median_depth_mm"] = depth["median_depth_mm"]
        else:
            result["has_depth"] = None
            result["depth_score"] = 0.0
            result["median_depth_mm"] = 0

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
    multiprocessing.freeze_support()  # required for PyInstaller + multiprocessing on macOS/Win
    model_dir = sys.argv[1] if len(sys.argv) > 1 else None
    _init_model(model_dir)

    # Start depth camera in background (non-blocking — doesn't delay READY signal)
    threading.Thread(target=_start_depth_thread, daemon=True).start()

    port = _find_free_port()
    # Signal to the Node parent that we are ready
    print(f"READY:{port}", flush=True)

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="error")

    if _depth_proc and _depth_proc.is_alive():
        _depth_proc.kill()
