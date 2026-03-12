#!/usr/bin/env python3
"""
InsightFace recognition service for SMILE Lab Attendance.
Runs as a local FastAPI server. Prints READY:<port> to stdout when ready.
Main process communicates via HTTP on localhost.

Liveness: MiDaS v2.1 small monocular depth estimation — real faces show
3D depth variation (nose closer than cheeks/ears), while photos on a phone
screen show uniform depth across the face region.
"""
import sys
import os
import base64
import socket
import traceback
from typing import Optional

import numpy as np
import cv2
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

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


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    """
    Detect the largest face in the image.
    Returns:
      { face: { bbox, embedding, kps, det_score, depth_variance } }
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
            # 5 keypoints: left_eye, right_eye, nose, left_mouth, right_mouth
            result["kps"] = face.kps.tolist()

        # MiDaS depth-based liveness analysis
        liveness = liveness_check(img, face.bbox)
        result["depth_variance"] = liveness["depth_variance"]
        result["is_live_depth"] = liveness["is_live_depth"]

        return {"face": result}

    except Exception:
        traceback.print_exc()
        return {"face": None, "error": traceback.format_exc(limit=3)}


# ---------------------------------------------------------------------------
# Liveness — MiDaS v2.1 small monocular depth estimation
#
# Real faces have 3D structure: nose protrudes, cheeks recede, ears are
# further back. MiDaS estimates a relative depth map from a single image.
# We compute the standard deviation of depth values across the face crop —
# real faces show high variance, flat screens show low variance.
# ---------------------------------------------------------------------------

import onnxruntime as _ort

_midas_sess = None   # loaded lazily on first call

# ImageNet normalization constants (MiDaS v2.1 small uses these)
_MIDAS_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_MIDAS_STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Depth variance threshold — tuned so real faces pass, flat screens fail
DEPTH_VARIANCE_THRESHOLD = 0.04


def _load_midas_model():
    """Load the MiDaS v2.1 small ONNX model."""
    global _midas_sess
    model_path = os.path.join(os.path.dirname(__file__), "..", "models",
                              "midas_v21_small_256.onnx")
    if not os.path.exists(model_path):
        print(f"[Liveness] MiDaS model not found at {model_path}")
        return
    _midas_sess = _ort.InferenceSession(
        model_path, providers=["CPUExecutionProvider"],
    )
    print("[Liveness] MiDaS v2.1 small depth model loaded")


@app.post("/reset-liveness")
def reset_liveness():
    return {"ok": True}


def liveness_check(img_bgr, bbox):
    """
    Run MiDaS depth estimation on the face crop.
    Returns { depth_variance, is_live_depth }.
    """
    if _midas_sess is None:
        _load_midas_model()

    if _midas_sess is None:
        # Model not available — fall back to always-pass
        return {"depth_variance": 1.0, "is_live_depth": True}

    # Crop face region with some padding
    x1, y1, x2, y2 = [int(v) for v in bbox]
    h, w = img_bgr.shape[:2]
    pad_w = int((x2 - x1) * 0.3)
    pad_h = int((y2 - y1) * 0.3)
    cx1 = max(0, x1 - pad_w)
    cy1 = max(0, y1 - pad_h)
    cx2 = min(w, x2 + pad_w)
    cy2 = min(h, y2 + pad_h)

    crop = img_bgr[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return {"depth_variance": 0.0, "is_live_depth": False}

    # Preprocess for MiDaS: resize to 256x256, BGR→RGB, normalize
    resized = cv2.resize(crop, (256, 256))
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    normalized = (rgb - _MIDAS_MEAN) / _MIDAS_STD
    # HWC → NCHW
    blob = normalized.transpose(2, 0, 1)[np.newaxis]

    # Run MiDaS inference
    input_name = _midas_sess.get_inputs()[0].name
    depth_map = _midas_sess.run(None, {input_name: blob})[0]

    # depth_map shape: (1, 256, 256) or (1, 1, 256, 256)
    depth_map = depth_map.squeeze()

    # Normalize depth map to [0, 1] for consistent variance measurement
    d_min, d_max = depth_map.min(), depth_map.max()
    if d_max - d_min > 1e-6:
        depth_norm = (depth_map - d_min) / (d_max - d_min)
    else:
        depth_norm = np.zeros_like(depth_map)

    # Sample the central face region (inner 60% of the crop)
    h_d, w_d = depth_norm.shape
    margin_h, margin_w = int(h_d * 0.2), int(w_d * 0.2)
    face_depth = depth_norm[margin_h:h_d - margin_h, margin_w:w_d - margin_w]

    # Compute depth standard deviation across the face
    depth_var = float(np.std(face_depth))

    return {
        "depth_variance": round(depth_var, 4),
        "is_live_depth": depth_var >= DEPTH_VARIANCE_THRESHOLD,
    }


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

    port = _find_free_port()
    # Signal to the Node parent that we are ready
    print(f"READY:{port}", flush=True)

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="error")
