import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  instrumentModelProvider,
  RotatingModelCallDiagnostics,
} from "../lib/workspace/modelCallDiagnostics";
import type {
  ModelGenerateRequest,
  ModelProvider,
  ModelProviderConfig,
} from "../lib/workspace/providers";

const SECRET_PROMPT = "sk-model-diagnostic-secret private contract text";
const REQUEST: ModelGenerateRequest = {
  model: "gpt-audit",
  messages: [{ role: "user", content: SECRET_PROMPT }],
  tools: [],
};

const CONFIG = {
  profile: {
    provider: "openai",
    model: "gpt-audit",
  },
} as ModelProviderConfig;

async function consume(provider: ModelProvider) {
  const events = [];
  for await (const event of provider.generate(REQUEST, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-model-log-audit-"));
  try {
    let clock = 0;
    const diagnostics = new RotatingModelCallDiagnostics(root, {
      maxBytes: 1_024,
      maxFiles: 3,
    });
    const completeProvider: ModelProvider = {
      id: "openai",
      async validateConfiguration() {
        return { valid: true };
      },
      async *generate() {
        yield { type: "text_delta", text: "answer" } as const;
        yield {
          type: "usage",
          inputTokens: 12,
          outputTokens: 4,
        } as const;
        yield { type: "completed" } as const;
      },
    };
    const complete = instrumentModelProvider({
      provider: completeProvider,
      config: CONFIG,
      diagnostics,
      requestId: () => "request-complete",
      clock: () => new Date(1_700_000_000_000 + clock++ * 1_000),
    });
    assert.deepEqual(
      (await consume(complete)).map((event) => event.type),
      ["text_delta", "usage", "completed"],
    );

    const failedProvider: ModelProvider = {
      id: "openai",
      async validateConfiguration() {
        return { valid: true };
      },
      async *generate() {
        yield {
          type: "error",
          code: "rate_limited",
          message: `Bearer ${SECRET_PROMPT}`,
          retryable: true,
        } as const;
      },
    };
    await consume(
      instrumentModelProvider({
        provider: failedProvider,
        config: CONFIG,
        diagnostics,
        requestId: () => "request-failed",
        clock: () => new Date(1_700_000_010_000 + clock++ * 1_000),
      }),
    );

    const initialRecords = readFileSync(
      path.join(root, "model-calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(initialRecords, [
      {
        schema: "vera-model-call-diagnostic-v1",
        request_id: "request-complete",
        provider: "openai",
        model: "gpt-audit",
        started_at: "2023-11-14T22:13:20.000Z",
        completed_at: "2023-11-14T22:13:21.000Z",
        input_tokens: 12,
        output_tokens: 4,
        status: "complete",
        error_code: null,
      },
      {
        schema: "vera-model-call-diagnostic-v1",
        request_id: "request-failed",
        provider: "openai",
        model: "gpt-audit",
        started_at: "2023-11-14T22:13:32.000Z",
        completed_at: "2023-11-14T22:13:33.000Z",
        input_tokens: null,
        output_tokens: null,
        status: "failed",
        error_code: "rate_limited",
      },
    ]);
    assert.equal(JSON.stringify(initialRecords).includes(SECRET_PROMPT), false);

    for (let index = 0; index < 80; index += 1) {
      diagnostics.record({
        requestId: `rotation-${index}`,
        provider: "openai",
        model: "gpt-audit",
        startedAt: "2026-07-15T00:00:00.000Z",
        completedAt: "2026-07-15T00:00:01.000Z",
        inputTokens: index,
        outputTokens: 1,
        status: "complete",
        errorCode: null,
      });
    }

    const files = readdirSync(root).sort();
    assert.ok(files.length >= 2 && files.length <= 4);
    const text = files
      .map((name) => {
        const target = path.join(root, name);
        assert.equal(statSync(target).mode & 0o077, 0);
        return readFileSync(target, "utf8");
      })
      .join("");
    assert.equal(text.includes(SECRET_PROMPT), false);
    assert.equal(text.includes("private contract text"), false);
    assert.doesNotMatch(text, /messages|prompt|authorization/i);
    const records = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(records.every((record) => record.schema === "vera-model-call-diagnostic-v1"));
    assert.ok(
      records.every(
        (record) =>
          Object.keys(record).sort().join(",") ===
          [
            "completed_at",
            "error_code",
            "input_tokens",
            "model",
            "output_tokens",
            "provider",
            "request_id",
            "schema",
            "started_at",
            "status",
          ]
            .sort()
            .join(","),
      ),
    );
    assert.equal(statSync(root).mode & 0o077, 0);

    const registrySource = readFileSync(
      path.resolve("src/lib/workspace/modelProviderRegistry.ts"),
      "utf8",
    );
    const runtimeSource = readFileSync(
      path.resolve("src/lib/workspace/runtime.ts"),
      "utf8",
    );
    assert.match(registrySource, /instrumentModelProvider/);
    assert.match(runtimeSource, /ALETHEIA_MODEL_CALL_LOG_DIR/);
    console.log("veraWorkspaceModelCallDiagnosticsAudit: ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
