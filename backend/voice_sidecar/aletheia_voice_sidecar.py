#!/usr/bin/env python3
"""Single-request, offline-only sidecar for Aletheia local voice.

The process reads one JSON request from stdin and writes one JSON response to
stdout. It never installs packages or downloads models. Model arguments must be
absolute directories already imported by the operator.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import wave

PROTOCOL_VERSION = "aletheia-local-voice-sidecar-v1"
MAX_REQUEST_BYTES = 64 * 1024
MAX_AUDIO_SECONDS = 120.0


class ProtocolError(Exception):
    def __init__(self, message: str, code: str = "invalid_input") -> None:
        super().__init__(message)
        self.code = code


def disable_network() -> None:
    """Fail closed if imported Python code attempts an outbound connection."""

    def denied(*_args: object, **_kwargs: object) -> None:
        raise OSError("Network access is disabled in Aletheia local voice")

    socket.create_connection = denied  # type: ignore[assignment]
    original_socket = socket.socket

    class OfflineSocket(original_socket):
        def connect(self, _address: object) -> None:
            denied()

        def connect_ex(self, _address: object) -> int:
            denied()
            return 1

    socket.socket = OfflineSocket  # type: ignore[assignment,misc]


def exact_object(value: object, allowed: set[str]) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ProtocolError("Request must be a JSON object")
    unknown = set(value.keys()) - allowed
    if unknown:
        raise ProtocolError(f"Unknown request field: {sorted(unknown)[0]}")
    return value


def local_directory(value: object, label: str, required: bool = False) -> Path | None:
    if value in (None, ""):
        if required:
            raise ProtocolError(f"{label} is required", "runtime_unavailable")
        return None
    if not isinstance(value, str):
        raise ProtocolError(f"{label} must be a string")
    candidate = Path(value)
    if not candidate.is_absolute() or not candidate.is_dir():
        raise ProtocolError(
            f"{label} must be an imported absolute local directory",
            "runtime_unavailable",
        )
    return candidate.resolve(strict=True)


def local_file(value: object, label: str) -> Path:
    if not isinstance(value, str):
        raise ProtocolError(f"{label} must be a string")
    candidate = Path(value)
    if not candidate.is_absolute() or not candidate.is_file():
        raise ProtocolError(f"{label} must be an absolute local file")
    return candidate.resolve(strict=True)


def module_installed(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def health(request: dict[str, object]) -> dict[str, object]:
    stt_model = local_directory(request.get("sttModelPath"), "sttModelPath")
    tts_model = local_directory(request.get("ttsModelPath"), "ttsModelPath")
    faster_whisper_installed = module_installed("faster_whisper")
    neutts_installed = module_installed("neutts") or module_installed("neutts_air")
    stt_healthy = faster_whisper_installed and stt_model is not None
    # NeuTTS APIs and model bundles are platform/version-specific. This sidecar
    # exposes the safe capability contract but makes no synthesis claim until a
    # separately reviewed adapter is packaged.
    tts_reason = (
        "No offline NeuTTS model directory has been imported."
        if tts_model is None
        else "NeuTTS synthesis adapter is not packaged; streaming is unsupported."
    )
    return {
        "ok": True,
        "protocolVersion": PROTOCOL_VERSION,
        "stt": {
            "engine": "faster-whisper",
            "installed": faster_whisper_installed,
            "modelImported": stt_model is not None,
            "healthy": stt_healthy,
            "available": stt_healthy,
            "failureReason": None
            if stt_healthy
            else (
                "faster-whisper is not installed in the configured Python runtime."
                if not faster_whisper_installed
                else "No offline faster-whisper model directory has been imported."
            ),
        },
        "tts": {
            "engine": "neutts",
            "installed": neutts_installed,
            "modelImported": tts_model is not None,
            "healthy": False,
            "available": False,
            "streaming": False,
            "failureReason": tts_reason,
        },
    }


def validate_wav(input_path: Path) -> float:
    try:
        with wave.open(str(input_path), "rb") as source:
            if source.getsampwidth() != 2 or source.getnchannels() not in (1, 2):
                raise ProtocolError("Input must be mono/stereo PCM16 WAV")
            if source.getframerate() < 8000 or source.getframerate() > 48000:
                raise ProtocolError("Input WAV sample rate is outside 8-48 kHz")
            duration = source.getnframes() / float(source.getframerate())
    except (wave.Error, EOFError) as error:
        raise ProtocolError(f"Invalid WAV input: {error}") from error
    if duration <= 0 or duration > MAX_AUDIO_SECONDS:
        raise ProtocolError("Input WAV duration is outside the 0-120s limit")
    return duration


def transcribe(request: dict[str, object]) -> dict[str, object]:
    model_path = local_directory(
        request.get("sttModelPath"), "sttModelPath", required=True
    )
    input_path = local_file(request.get("inputPath"), "inputPath")
    validate_wav(input_path)
    language = request.get("language")
    if language is not None and (
        not isinstance(language, str) or len(language) > 16
    ):
        raise ProtocolError("language is invalid")
    if not module_installed("faster_whisper"):
        raise ProtocolError(
            "faster-whisper is not installed in the configured Python runtime",
            "runtime_unavailable",
        )

    disable_network()
    from faster_whisper import WhisperModel  # type: ignore[import-not-found]

    model = WhisperModel(
        str(model_path),
        device=os.environ.get("ALETHEIA_VOICE_DEVICE", "cpu"),
        compute_type=os.environ.get("ALETHEIA_VOICE_COMPUTE_TYPE", "int8"),
        local_files_only=True,
    )
    segments, info = model.transcribe(
        str(input_path),
        language=language,
        vad_filter=False,
        beam_size=5,
    )
    transcript = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "ok": True,
        "protocolVersion": PROTOCOL_VERSION,
        "transcript": transcript,
        "model": model_path.name,
        "language": getattr(info, "language", language),
        "inputSha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
    }


def tts(_request: dict[str, object]) -> dict[str, object]:
    raise ProtocolError(
        "NeuTTS synthesis adapter is unavailable; streaming is not implemented.",
        "runtime_unavailable",
    )


def main() -> None:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise ProtocolError("Request exceeds the sidecar protocol limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("Request is not valid UTF-8 JSON") from error
    request = exact_object(
        value,
        {
            "protocolVersion",
            "operation",
            "sttModelPath",
            "ttsModelPath",
            "inputPath",
            "language",
            "text",
        },
    )
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolError("Unsupported voice sidecar protocol version")
    operation = request.get("operation")
    if operation == "health":
        response = health(request)
    elif operation == "transcribe":
        response = transcribe(request)
    elif operation == "tts":
        response = tts(request)
    else:
        raise ProtocolError("Unsupported voice sidecar operation")
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except ProtocolError as error:
        sys.stdout.write(
            json.dumps(
                {"ok": False, "code": error.code, "error": str(error)},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    except Exception as error:  # fail closed without a traceback on stdout
        sys.stdout.write(
            json.dumps(
                {"ok": False, "code": "sidecar_failed", "error": str(error)},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
