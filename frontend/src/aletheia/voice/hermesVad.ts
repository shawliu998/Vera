/** Pure PCM16 voice activity detection; it records or transmits nothing. */
export const DEFAULT_HERMES_VAD_CONFIG = {
  rmsThreshold: 200,
  minSpeechMs: 300,
  endSilenceMs: 3_000,
  noSpeechTimeoutMs: 15_000,
  maxDurationMs: 120_000,
} as const;

export type HermesVadConfig = typeof DEFAULT_HERMES_VAD_CONFIG;
export type HermesVadPhase = "waiting" | "candidate" | "speaking" | "complete";
export type HermesVadEndReason = "silence" | "no_speech_timeout" | "max_duration";

export type HermesVadState = {
  phase: HermesVadPhase;
  elapsedMs: number;
  candidateSpeechMs: number;
  silenceMs: number;
  endReason?: HermesVadEndReason;
};

export type HermesVadFrame = {
  samples: Int16Array;
  sampleRate: number;
};

export type HermesVadUpdate = {
  state: HermesVadState;
  rms: number;
  event?: { type: "speech_confirmed" | "complete"; reason?: HermesVadEndReason };
};

function validConfig(config: HermesVadConfig) {
  return (
    Number.isFinite(config.rmsThreshold) &&
    config.rmsThreshold >= 0 &&
    [
      config.minSpeechMs,
      config.endSilenceMs,
      config.noSpeechTimeoutMs,
      config.maxDurationMs,
    ].every((value) => Number.isFinite(value) && value > 0) &&
    config.maxDurationMs >= config.noSpeechTimeoutMs
  );
}

export function calculatePcm16Rms(samples: Int16Array) {
  if (!samples.length) return 0;
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  return Math.sqrt(sumSquares / samples.length);
}

export function createHermesVadState(): HermesVadState {
  return { phase: "waiting", elapsedMs: 0, candidateSpeechMs: 0, silenceMs: 0 };
}

export function processHermesVadFrame(
  state: HermesVadState,
  frame: HermesVadFrame,
  config: HermesVadConfig = DEFAULT_HERMES_VAD_CONFIG,
): HermesVadUpdate {
  if (!validConfig(config) || !Number.isFinite(frame.sampleRate) || frame.sampleRate <= 0) {
    throw new Error("Hermes VAD configuration and sample rate must be valid.");
  }
  if (state.phase === "complete") return { state, rms: 0 };
  const frameMs = (frame.samples.length / frame.sampleRate) * 1_000;
  if (!Number.isFinite(frameMs) || frameMs < 0) {
    throw new Error("Hermes VAD frame is invalid.");
  }
  const elapsedMs = state.elapsedMs + frameMs;
  const rms = calculatePcm16Rms(frame.samples);
  const active = rms >= config.rmsThreshold;
  const complete = (reason: HermesVadEndReason): HermesVadUpdate => ({
    rms,
    state: {
      ...state,
      phase: "complete",
      elapsedMs,
      endReason: reason,
      silenceMs: active ? 0 : state.silenceMs + frameMs,
    },
    event: { type: "complete", reason },
  });
  if (elapsedMs >= config.maxDurationMs) return complete("max_duration");

  if (state.phase === "waiting" || state.phase === "candidate") {
    if (!active) {
      if (elapsedMs >= config.noSpeechTimeoutMs) return complete("no_speech_timeout");
      return {
        rms,
        state: { phase: "waiting", elapsedMs, candidateSpeechMs: 0, silenceMs: 0 },
      };
    }
    const candidateSpeechMs = state.candidateSpeechMs + frameMs;
    if (candidateSpeechMs >= config.minSpeechMs) {
      return {
        rms,
        state: { phase: "speaking", elapsedMs, candidateSpeechMs, silenceMs: 0 },
        event: { type: "speech_confirmed" },
      };
    }
    return {
      rms,
      state: { phase: "candidate", elapsedMs, candidateSpeechMs, silenceMs: 0 },
    };
  }

  const silenceMs = active ? 0 : state.silenceMs + frameMs;
  if (!active && silenceMs >= config.endSilenceMs) return complete("silence");
  return {
    rms,
    state: { ...state, elapsedMs, silenceMs },
  };
}
