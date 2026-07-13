# Local voice runtime

Aletheia local voice is an offline-only Python sidecar. It never uses browser
speech recognition, hosted STT/TTS APIs, or automatic model downloads.

## Operator installation

Install Python and `faster-whisper` outside the application, then import a
compatible faster-whisper model directory through an offline media/process.
Set only absolute local paths:

```text
ALETHEIA_VOICE_PYTHON_PATH=/absolute/path/to/python3
ALETHEIA_VOICE_STT_MODEL_PATH=/absolute/path/to/imported-whisper-model
```

Optional NeuTTS metadata may be supplied with
`ALETHEIA_VOICE_TTS_MODEL_PATH`, but the current sidecar exposes only an
unavailable, non-streaming TTS capability until a reviewed local adapter is
packaged. No environment variable may point to a URL. The desktop package
ships the fixed `backend/voice_sidecar/aletheia_voice_sidecar.py` protocol
script; an operator-overridden sidecar requires a SHA-256 pin.

The sidecar starts with a reduced environment, offline Hugging Face/Transformers
flags, and a Python socket guard. It receives a single JSON request on stdin and
emits a single JSON response on stdout. It is invoked using an absolute Python
path with `shell: false`; request payloads cannot select a binary, script,
model, working directory, or command arguments.

## HTTP contract

All routes require normal Aletheia authentication and matter ownership.

- `GET /aletheia/local-voice/status` reports install/model/health/failure state.
- `POST /aletheia/matters/:matterId/local-voice/grants` with
  `{ "purpose": "transcribe" }` issues a 60-second, single-use,
  matter-and-user-scoped grant.
- `POST /aletheia/matters/:matterId/local-voice/transcriptions` accepts only
  `audio/wav`, `audio/x-wav`, or `audio/L16`; send grant values in
  `X-Aletheia-Voice-Grant-Id` and `X-Aletheia-Voice-Grant-Token`.
  Raw PCM requires `X-Aletheia-Pcm-Sample-Rate` and
  `X-Aletheia-Pcm-Channels`.
- `POST /aletheia/matters/:matterId/local-voice/speech` is a safe TTS capability
  endpoint. It responds unavailable until a local NeuTTS adapter is installed;
  it never claims streaming support.

Audio must be canonical mono/stereo PCM16, 8–48 kHz, up to 120 seconds and the
configured byte limit (24 MiB by default). The backend writes a `0700` scoped
temporary directory / `0600` WAV file only while invoking STT, then deletes the
file on every success and failure path. Original audio is not stored.

The transcription response always contains `confirmationRequired: true` and
`submittedToAgent: false`. The UI must show editable text and only place the
text into a composer after explicit Confirm; it must not start or submit an
agent run automatically. Matter audit events include hashes, duration, model,
language, grant ID, and cleanup outcome—never the audio bytes or transcript.

## Desktop packaging

`desktop/package.json` includes the sidecar script as an extra resource and
`desktop/main.js` checks for it before startup. Python, faster-whisper, and
models remain operator-installed offline prerequisites. macOS production
integration also requires a microphone permission policy and
`NSMicrophoneUsageDescription` before a recorder UI is enabled.
