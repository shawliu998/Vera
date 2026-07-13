import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { pcm16ToWav } from "../lib/aletheia/localVoiceProtocol";
import { LocalVoiceRuntime } from "../lib/aletheia/localVoiceRuntime";
import { createLocalVoiceRouter } from "../routes/localVoice";

function fakeFile(root: string, name: string) {
  const target = path.join(root, name);
  writeFileSync(target, "fixture", { mode: 0o700 });
  return target;
}

function pcm16WavWithoutDurationValidation(pcm: Buffer) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-local-voice-audit-"));
  const tempRoot = path.join(root, "voice-temp");
  const model = path.join(root, "whisper-model");
  const ttsModel = path.join(root, "neutts-model");
  mkdirSync(model, { mode: 0o700 });
  mkdirSync(ttsModel, { mode: 0o700 });
  const audit: Array<Record<string, unknown>> = [];
  let server: ReturnType<typeof createServer> | undefined;
  let runtime: LocalVoiceRuntime | undefined;
  try {
    runtime = new LocalVoiceRuntime({
      pythonPath: fakeFile(root, "python"),
      sidecarPath: fakeFile(root, "voice-sidecar.py"),
      sttModelPath: model,
      ttsModelPath: ttsModel,
      tempRoot,
      maxAudioBytes: 1_000_000,
      audit: async (event) => {
        audit.push(event);
        return { id: `audit-${audit.length}` };
      },
      executor: async (request) => {
        if (request.operation === "health") {
          return {
            ok: true,
            stt: { installed: true, healthy: true },
            tts: { installed: false, healthy: false, available: false },
          };
        }
        assert.equal(request.operation, "transcribe");
        assert.match(request.inputPath ?? "", /\.wav$/);
        assert.equal(request.sttModelPath, realpathSync(model));
        return { ok: true, transcript: "Pending human confirmation", model: "offline-test", language: "en" };
      },
    });

    const status = await runtime.status();
    assert.equal(status.stt.available, true);
    assert.equal(status.tts.available, false);
    assert.equal(status.tts.streaming, false);

    const audio = pcm16ToWav(Buffer.alloc(16_000 * 2), 16_000, 1).wav;
    const grant = await runtime.issueGrant({
      matterId: "matter-a",
      userId: "local-user",
      purpose: "transcribe",
    });
    const result = await runtime.transcribe({
      matterId: "matter-a",
      userId: "local-user",
      grantId: grant.grantId,
      grantToken: grant.token,
      audio: { bytes: audio, contentType: "audio/wav", language: "en" },
    });
    assert.equal(result.transcript, "Pending human confirmation");
    assert.equal(result.confirmationRequired, true);
    assert.equal(result.submittedToAgent, false);
    assert.ok(result.audioSha256);
    assert.equal(readdirSync(tempRoot, { recursive: true }).filter((entry) => String(entry).endsWith(".wav")).length, 0);
    assert.equal(audit.some((event) => event.action === "local_voice_transcription_completed"), true);
    assert.equal(JSON.stringify(audit).includes("Pending human confirmation"), false, "audit must not duplicate the transcript");

    await assert.rejects(
      runtime.transcribe({
        matterId: "matter-a",
        userId: "local-user",
        grantId: grant.grantId,
        grantToken: grant.token,
        audio: { bytes: audio, contentType: "audio/wav" },
      }),
      /already consumed/,
    );
    const crossMatter = await runtime.issueGrant({ matterId: "matter-a", userId: "local-user", purpose: "transcribe" });
    await assert.rejects(
      runtime.transcribe({
        matterId: "matter-b",
        userId: "local-user",
        grantId: crossMatter.grantId,
        grantToken: crossMatter.token,
        audio: { bytes: audio, contentType: "audio/wav" },
      }),
      /invalid for this matter/,
    );
    const oversized = await runtime.issueGrant({ matterId: "matter-a", userId: "local-user", purpose: "transcribe" });
    await assert.rejects(
      runtime.transcribe({
        matterId: "matter-a",
        userId: "local-user",
        grantId: oversized.grantId,
        grantToken: oversized.token,
        audio: { bytes: Buffer.alloc(1_000_001), contentType: "audio/wav" },
      }),
      /byte limit/,
    );
    const ttsGrant = await runtime.issueGrant({ matterId: "matter-a", userId: "local-user", purpose: "tts" });
    await assert.rejects(
      runtime.denyUnavailableTts({
        matterId: "matter-a",
        userId: "local-user",
        grantId: ttsGrant.grantId,
        grantToken: ttsGrant.token,
        text: "This must remain local and unavailable without NeuTTS.",
      }),
      /unavailable/i,
    );

    const unavailable = new LocalVoiceRuntime({
      pythonPath: fakeFile(root, "python-no-model"),
      sidecarPath: fakeFile(root, "sidecar-no-model.py"),
      tempRoot: path.join(root, "unavailable-temp"),
      executor: async () => ({ ok: true, stt: { installed: true, healthy: false } }),
    });
    const unavailableStatus = await unavailable.status();
    assert.equal(unavailableStatus.pythonInstalled, true, "Python install state remains detectable without a model");
    assert.equal(unavailableStatus.stt.available, false, "no local model remains unavailable");
    await unavailable.close();
    const durationRuntime = new LocalVoiceRuntime({
      pythonPath: fakeFile(root, "python-duration"),
      sidecarPath: fakeFile(root, "sidecar-duration.py"),
      sttModelPath: model,
      tempRoot: path.join(root, "duration-temp"),
      maxAudioBytes: 8 * 1024 * 1024,
      executor: async () => ({ ok: true, stt: { installed: true, healthy: true } }),
    });
    const durationGrant = await durationRuntime.issueGrant({ matterId: "matter-a", userId: "local-user", purpose: "transcribe" });
    await assert.rejects(
      durationRuntime.transcribe({
        matterId: "matter-a",
        userId: "local-user",
        grantId: durationGrant.grantId,
        grantToken: durationGrant.token,
        audio: { bytes: pcm16WavWithoutDurationValidation(Buffer.alloc(16_000 * 2 * 121)), contentType: "audio/wav" },
      }),
      /120s recording limit/,
    );
    await durationRuntime.close();
    const remote = new LocalVoiceRuntime({
      pythonPath: "https://example.invalid/python",
      tempRoot: path.join(root, "remote-temp"),
      executor: async () => ({ ok: true }),
    });
    assert.equal((await remote.status()).pythonInstalled, false, "remote Python paths are rejected");
    await remote.close();

    const app = express();
    app.use(express.json());
    app.use(
      "/aletheia",
      createLocalVoiceRouter({
        runtime,
        auth: (_req, res, next) => {
          res.locals.userId = "local-user";
          next();
        },
        repository: {
          getMatterDetail: async () => ({ id: "matter-a" }),
        } as any,
      }),
    );
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/aletheia/matters/matter-a/local-voice/grants`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "transcribe", pythonPath: "/bin/sh" }),
      },
    );
    assert.equal(response.status, 400, "HTTP cannot select an arbitrary executable");
    console.log(JSON.stringify({ ok: true, suite: "aletheia-local-voice-v1", auditEvents: audit.length }, null, 2));
  } finally {
    await runtime?.close();
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
