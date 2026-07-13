import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePcm16Rms,
  createHermesVadState,
  processHermesVadFrame,
} from "../src/aletheia/voice/hermesVad";

function frame(value: number, milliseconds: number) {
  return { samples: new Int16Array(milliseconds * 16).fill(value), sampleRate: 16_000 };
}

test("RMS honors the Hermes threshold boundary", () => {
  assert.equal(calculatePcm16Rms(new Int16Array()), 0);
  assert.equal(calculatePcm16Rms(new Int16Array([200, -200])), 200);
});

test("speech needs 300ms and candidate silence resets", () => {
  let state = createHermesVadState();
  state = processHermesVadFrame(state, frame(200, 299)).state;
  assert.equal(state.phase, "candidate");
  state = processHermesVadFrame(state, frame(0, 1)).state;
  assert.equal(state.phase, "waiting");
  const update = processHermesVadFrame(state, frame(200, 300));
  assert.equal(update.state.phase, "speaking");
  assert.equal(update.event?.type, "speech_confirmed");
});

test("speaking ends after exactly 3 seconds of silence", () => {
  let state = processHermesVadFrame(createHermesVadState(), frame(300, 300)).state;
  state = processHermesVadFrame(state, frame(0, 2_999)).state;
  assert.equal(state.phase, "speaking");
  const update = processHermesVadFrame(state, frame(0, 1));
  assert.equal(update.state.endReason, "silence");
});

test("waiting times out at 15 seconds and max duration fails closed", () => {
  let update = processHermesVadFrame(createHermesVadState(), frame(0, 15_000));
  assert.equal(update.state.endReason, "no_speech_timeout");
  update = processHermesVadFrame(createHermesVadState(), frame(400, 120_000));
  assert.equal(update.state.endReason, "max_duration");
  assert.equal(processHermesVadFrame(update.state, frame(0, 10)).state, update.state);
});
