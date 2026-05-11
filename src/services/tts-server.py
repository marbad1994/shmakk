#!/usr/bin/env python3.11
"""
shmakk TTS/STT server — Flask process that handles:
  - TTS  via Kokoro ONNX  (KPipeline)
  - STT  via faster-whisper (WhisperModel)

No external API calls — everything runs locally on CPU.

Endpoints:
  GET  /health       → {status, voices_count}
  GET  /voices       → [{id, name, language, gender}]
  POST /tts          → {text, voice, speed?}  → audio/wav
  POST /stt          → multipart audio + language  → {text}
  GET  /cache-status → {tts, stt}
"""

import os
import sys
import json
import time
import tempfile
import signal
import atexit
import argparse
from pathlib import Path

import numpy as np
import soundfile as sf
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MODEL_REPO = os.environ.get("SHMAKK_KOKORO_REPO", "hexgrad/Kokoro-82M")
WHISPER_MODEL = os.environ.get("SHMAKK_WHISPER_MODEL", "tiny")
DEFAULT_VOICE = os.environ.get("SHMAKK_TTS_VOICE", "af_heart")
DEFAULT_SPEED = float(os.environ.get("SHMAKK_TTS_SPEED", "1.0"))
DEVICE = "cpu"

# Language code mapping for Kokoro (single-char → full)
LANG_MAP = {
    "a": "en-us",
    "b": "en-gb",
    "e": "es",
    "f": "fr-fr",
    "h": "hi",
    "i": "it",
    "j": "ja",
    "p": "pt-br",
    "z": "zh",
}

# Voice metadata (name → {language, gender}) for known Kokoro voices
_VOICE_META = {
    "af_heart":    {"language": "en-us", "gender": "female"},
    "af_bella":    {"language": "en-us", "gender": "female"},
    "af_sarah":    {"language": "en-us", "gender": "female"},
    "af_sky":      {"language": "en-us", "gender": "female"},
    "af_nicole":   {"language": "en-us", "gender": "female"},
    "am_adam":     {"language": "en-us", "gender": "male"},
    "am_michael":  {"language": "en-us", "gender": "male"},
    "bf_emma":     {"language": "en-gb", "gender": "female"},
    "bf_isabella": {"language": "en-gb", "gender": "female"},
    "bm_george":   {"language": "en-gb", "gender": "male"},
    "bm_lewis":    {"language": "en-gb", "gender": "male"},
    "jf_alpha":    {"language": "ja",    "gender": "female"},
    "jf_gongitsune": {"language": "ja",  "gender": "female"},
    "jf_nezumi":   {"language": "ja",    "gender": "female"},
    "jf_tebukuro": {"language": "ja",    "gender": "female"},
    "jm_kumo":     {"language": "ja",    "gender": "male"},
    "zf_xiaobei":  {"language": "zh",    "gender": "female"},
    "zf_xiaoni":   {"language": "zh",    "gender": "female"},
    "zf_xiaoxiao": {"language": "zh",    "gender": "female"},
    "zf_xiaoyi":   {"language": "zh",    "gender": "female"},
    "zm_yunjian":  {"language": "zh",    "gender": "male"},
    "zm_yunxia":   {"language": "zh",    "gender": "male"},
}

# ---------------------------------------------------------------------------
# Globals (lazy loaded)
# ---------------------------------------------------------------------------
_pipeline = None
_whisper_model = None
_app = None

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _voice_lang_code(voice_id: str) -> str:
    """Map a voice ID to its Kokoro lang_code single char."""
    meta = _VOICE_META.get(voice_id)
    if not meta:
        return "a"  # default American English
    full = meta["language"]
    for single, f in LANG_MAP.items():
        if f == full:
            return single
    return "a"


def _get_pipeline(voice: str | None = None):
    """Get or create a KPipeline for the given voice's language."""
    global _pipeline
    lang = _voice_lang_code(voice or DEFAULT_VOICE)
    if _pipeline is None or getattr(_pipeline, "_shmakk_lang", None) != lang:
        from kokoro import KPipeline
        _pipeline = KPipeline(lang_code=lang, repo_id=MODEL_REPO)
        _pipeline._shmakk_lang = lang
    return _pipeline


def _get_whisper():
    """Get or create a faster-whisper model."""
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(
            WHISPER_MODEL,
            device=DEVICE,
            compute_type="int8",
        )
    return _whisper_model


def _voice_list():
    """List all known Kokoro voices with metadata."""
    voices = []
    for vid, meta in _VOICE_META.items():
        voices.append({
            "id": vid,
            "name": vid.replace("_", " ").title(),
            "language": meta["language"],
            "gender": meta["gender"],
        })
    return voices


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------

def create_app():
    app = Flask(__name__)
    CORS(app)

    # Suppress Flask startup banner
    import logging
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    # ── Health ────────────────────────────────────────────────────────
    @app.route("/health")
    def health():
        voices = _voice_list()
        return jsonify({
            "status": "ok",
            "voices_count": len(voices),
            "stt_model": WHISPER_MODEL,
            "device": DEVICE,
        })

    # ── List voices ───────────────────────────────────────────────────
    @app.route("/voices")
    def voices():
        return jsonify({"voices": _voice_list()})

    # ── TTS ───────────────────────────────────────────────────────────
    @app.route("/tts", methods=["POST"])
    def tts():
        data = request.get_json(force=True)
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "empty text"}), 400

        voice = data.get("voice", DEFAULT_VOICE)
        speed = float(data.get("speed", DEFAULT_SPEED))

        pipeline = _get_pipeline(voice)

        try:
            # Load the voice style
            voicepack = pipeline.load_voice(voice)
            if voicepack is None:
                # Try case-insensitive
                for v in _VOICE_META:
                    if v.lower() == voice.lower():
                        voicepack = pipeline.load_voice(v)
                        voice = v
                        break
            if voicepack is None:
                return jsonify({
                    "error": f"Unknown voice: {voice}",
                    "available": [v["id"] for v in _voice_list()],
                }), 400

            # Generate audio
            results = list(pipeline(
                text,
                voice=voice,
                speed=speed,
                split_pattern=r"\n+|(?<=[.!?])\s+",
            ))

            if not results:
                return jsonify({"error": "no audio generated"}), 500

            # Concatenate all result chunks
            chunks = []
            for r in results:
                a = r.audio
                if a is not None:
                    chunks.append(a.numpy() if hasattr(a, "numpy") else np.array(a))

            if not chunks:
                return jsonify({"error": "no audio samples"}), 500

            audio = np.concatenate(chunks)

            # Write to temp WAV file
            fd, tmp_path = tempfile.mkstemp(suffix=".wav", prefix="shmakk-tts-")
            os.close(fd)
            sf.write(tmp_path, audio, 24000)

            response = send_file(
                tmp_path,
                mimetype="audio/wav",
                as_attachment=True,
                download_name="speech.wav",
            )
            # Clean up after send
            @response.call_on_close
            def _cleanup():
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            return response

        except Exception as exc:
            return jsonify({"error": f"TTS failed: {exc}"}), 500

    # ── STT ───────────────────────────────────────────────────────────
    @app.route("/stt", methods=["POST"])
    def stt():
        if "audio" not in request.files:
            return jsonify({"error": "missing audio file"}), 400

        audio_file = request.files["audio"]
        language = request.form.get("language") or None

        # Save to temp file
        fd, tmp_path = tempfile.mkstemp(suffix=".wav", prefix="shmakk-stt-")
        os.close(fd)
        try:
            audio_file.save(tmp_path)
            model = _get_whisper()
            segments, info = model.transcribe(tmp_path, language=language, beam_size=5)
            text = " ".join(seg.text.strip() for seg in segments).strip()
            return jsonify({"text": text, "language": info.language})
        except Exception as exc:
            return jsonify({"error": f"STT failed: {exc}"}), 500
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    # ── Cache status ──────────────────────────────────────────────────
    @app.route("/cache-status")
    def cache_status():
        hf_home = os.environ.get("HF_HOME") or os.environ.get("XDG_CACHE_HOME") or \
            os.path.join(os.path.expanduser("~"), ".cache", "huggingface")

        kokoro_dir = Path(hf_home) / "hub" / f"models--{MODEL_REPO.replace('/', '--')}"
        whisper_dir = Path(hf_home) / "hub" / f"models--Systran--faster-whisper-{WHISPER_MODEL}"

        return jsonify({
            "tts_cached": kokoro_dir.exists(),
            "stt_cached": whisper_dir.exists(),
        })

    return app


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="shmakk TTS/STT server")
    parser.add_argument("--port", type=int, default=0,
                        help="Port to listen on (0 = random)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Host to bind to")
    parser.add_argument("--pid-file", default=None,
                        help="Write PID to this file")
    parser.add_argument("--port-file", default=None,
                        help="Write chosen port to this file")
    args = parser.parse_args()

    app = create_app()

    import socket

    # Bind early so we can report the port
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    actual_port = sock.getsockname()[1]
    sock.close()

    # Write port file BEFORE loading models (so client can poll)
    if args.port_file:
        Path(args.port_file).write_text(str(actual_port) + "\n")
    if args.pid_file:
        Path(args.pid_file).write_text(str(os.getpid()) + "\n")

    # Cleanup on exit
    def _cleanup():
        for f in [args.pid_file, args.port_file]:
            if f:
                try:
                    os.unlink(f)
                except OSError:
                    pass

    atexit.register(_cleanup)
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *a: sys.exit(0))

    # Eager-load models on startup to avoid first-request latency
    print(f"[shmakk-tts-server] loading kokoro model ({MODEL_REPO})...",
          file=sys.stderr)
    _get_pipeline(DEFAULT_VOICE)
    print("[shmakk-tts-server] kokoro model ready", file=sys.stderr)

    print(f"[shmakk-tts-server] loading whisper model ({WHISPER_MODEL})...",
          file=sys.stderr)
    _get_whisper()
    print("[shmakk-tts-server] whisper model ready", file=sys.stderr)

    print(f"[shmakk-tts-server] listening on {args.host}:{actual_port}",
          file=sys.stderr)

    # Use the werkzeug server directly (no need for waitress/gevent)
    from werkzeug.serving import run_simple
    run_simple(args.host, actual_port, app,
               threaded=True,
               use_reloader=False,
               use_debugger=False)


if __name__ == "__main__":
    main()
