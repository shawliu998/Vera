import path from "node:path";

export const LOCAL_VOICE_PROTOCOL_VERSION = "aletheia-local-voice-sidecar-v1";
export const LOCAL_VOICE_MAX_DURATION_SECONDS = 120;
export const LOCAL_VOICE_DEFAULT_MAX_AUDIO_BYTES = 24 * 1024 * 1024;

export type LocalVoiceOperation = "health" | "transcribe" | "tts";

export type LocalVoiceSidecarRequest = {
  protocolVersion: typeof LOCAL_VOICE_PROTOCOL_VERSION;
  operation: LocalVoiceOperation;
  sttModelPath?: string;
  ttsModelPath?: string;
  inputPath?: string;
  language?: string;
  text?: string;
};

export type LocalVoiceCapabilityStatus = {
  engine: "faster-whisper" | "neutts";
  installed: boolean;
  modelImported: boolean;
  healthy: boolean;
  available: boolean;
  failureReason: string | null;
};

export type LocalVoiceRuntimeStatus = {
  schemaVersion: "aletheia-local-voice-status-v1";
  localOnly: true;
  pythonInstalled: boolean;
  sidecarInstalled: boolean;
  healthy: boolean;
  failureReason: string | null;
  stt: LocalVoiceCapabilityStatus;
  tts: LocalVoiceCapabilityStatus & { streaming: false };
};

export type LocalVoiceTranscription = {
  transcript: string;
  model: string;
  language: string | null;
};

export type ValidatedVoiceAudio = {
  wav: Buffer;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: 16;
};

export class LocalVoiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_input"
      | "input_too_large"
      | "audio_too_long"
      | "capability_denied"
      | "grant_expired"
      | "grant_exhausted"
      | "runtime_unavailable"
      | "sidecar_timeout"
      | "sidecar_failed"
      | "closed",
    readonly status = 400,
  ) {
    super(message);
    this.name = "LocalVoiceError";
  }
}

function uint16(buffer: Buffer, offset: number) {
  if (offset + 2 > buffer.length)
    throw new LocalVoiceError("WAV header is truncated.", "invalid_input");
  return buffer.readUInt16LE(offset);
}

function uint32(buffer: Buffer, offset: number) {
  if (offset + 4 > buffer.length)
    throw new LocalVoiceError("WAV header is truncated.", "invalid_input");
  return buffer.readUInt32LE(offset);
}

function validatePcmParameters(
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
) {
  if (sampleRate < 8_000 || sampleRate > 48_000) {
    throw new LocalVoiceError(
      "PCM sample rate must be between 8000 and 48000 Hz.",
      "invalid_input",
    );
  }
  if (channels !== 1 && channels !== 2) {
    throw new LocalVoiceError(
      "PCM audio must be mono or stereo.",
      "invalid_input",
    );
  }
  if (bitsPerSample !== 16) {
    throw new LocalVoiceError(
      "Only signed 16-bit little-endian PCM is accepted.",
      "invalid_input",
    );
  }
}

function durationOrThrow(dataBytes: number, byteRate: number) {
  if (dataBytes <= 0 || byteRate <= 0) {
    throw new LocalVoiceError("Audio contains no PCM samples.", "invalid_input");
  }
  const durationSeconds = dataBytes / byteRate;
  if (durationSeconds > LOCAL_VOICE_MAX_DURATION_SECONDS) {
    throw new LocalVoiceError(
      `Audio exceeds the ${LOCAL_VOICE_MAX_DURATION_SECONDS}s recording limit.`,
      "audio_too_long",
      413,
    );
  }
  return durationSeconds;
}

export function validatePcm16Wav(buffer: Buffer): ValidatedVoiceAudio {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new LocalVoiceError(
      "Audio must be a RIFF/WAVE PCM file.",
      "invalid_input",
    );
  }
  const declaredSize = uint32(buffer, 4) + 8;
  if (declaredSize !== buffer.length) {
    throw new LocalVoiceError(
      "WAV container size does not match the received bytes.",
      "invalid_input",
    );
  }

  let offset = 12;
  let format:
    | {
        audioFormat: number;
        channels: number;
        sampleRate: number;
        byteRate: number;
        blockAlign: number;
        bitsPerSample: number;
      }
    | undefined;
  let dataOffset = -1;
  let dataBytes = -1;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = uint32(buffer, offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) {
      throw new LocalVoiceError("WAV chunk is truncated.", "invalid_input");
    }
    if (id === "fmt ") {
      if (size < 16)
        throw new LocalVoiceError("WAV fmt chunk is invalid.", "invalid_input");
      format = {
        audioFormat: uint16(buffer, start),
        channels: uint16(buffer, start + 2),
        sampleRate: uint32(buffer, start + 4),
        byteRate: uint32(buffer, start + 8),
        blockAlign: uint16(buffer, start + 12),
        bitsPerSample: uint16(buffer, start + 14),
      };
    } else if (id === "data" && dataOffset < 0) {
      dataOffset = start;
      dataBytes = size;
    }
    offset = end + (size % 2);
  }
  if (!format || dataOffset < 0) {
    throw new LocalVoiceError(
      "WAV must contain fmt and data chunks.",
      "invalid_input",
    );
  }
  validatePcmParameters(
    format.sampleRate,
    format.channels,
    format.bitsPerSample,
  );
  const expectedBlockAlign = format.channels * 2;
  const expectedByteRate = format.sampleRate * expectedBlockAlign;
  if (
    format.audioFormat !== 1 ||
    format.blockAlign !== expectedBlockAlign ||
    format.byteRate !== expectedByteRate ||
    dataBytes % expectedBlockAlign !== 0
  ) {
    throw new LocalVoiceError(
      "WAV must contain canonical uncompressed PCM16 frames.",
      "invalid_input",
    );
  }
  return {
    wav: buffer,
    durationSeconds: durationOrThrow(dataBytes, format.byteRate),
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: 16,
  };
}

export function pcm16ToWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
): ValidatedVoiceAudio {
  validatePcmParameters(sampleRate, channels, 16);
  const blockAlign = channels * 2;
  if (!pcm.length || pcm.length % blockAlign !== 0) {
    throw new LocalVoiceError(
      "PCM byte length must contain complete signed 16-bit frames.",
      "invalid_input",
    );
  }
  const byteRate = sampleRate * blockAlign;
  const durationSeconds = durationOrThrow(pcm.length, byteRate);
  const wav = Buffer.allocUnsafe(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return { wav, durationSeconds, sampleRate, channels, bitsPerSample: 16 };
}

export function safeLanguage(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value)) {
    throw new LocalVoiceError("language is invalid.", "invalid_input");
  }
  return value.toLowerCase();
}

export function modelLabel(modelPath: string | undefined) {
  return modelPath ? path.basename(modelPath) : "unavailable";
}
