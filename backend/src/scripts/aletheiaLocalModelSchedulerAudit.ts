import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import path from "node:path";
import {
  LocalModelScheduler,
  LocalModelSchedulerError,
  assertLoopbackModelEndpoint,
} from "../lib/aletheia/localModelScheduler";

type FakeServer = {
  endpoint: string;
  close: () => Promise<void>;
  active: () => number;
  maximumActive: () => number;
  lastBody: () => Record<string, unknown>;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readRequest(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

async function startFakeModelServer(
  port = 0,
  noisy = false,
): Promise<FakeServer> {
  let active = 0;
  let maximumActive = 0;
  let lastBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method === "GET" &&
        (request.url === "/v1/models" || request.url === "/api/tags")
      ) {
        json(
          response,
          200,
          request.url === "/api/tags"
            ? {
                models: ["fake-ollama", "fake-managed", "denied"].map(
                  (model) => ({
                    name: model,
                    model,
                    digest: `sha256:${"a".repeat(64)}`,
                  }),
                ),
              }
            : {
                data: ["fake-local", "fake-managed", "denied"].map((id) => ({
                  id,
                })),
              },
        );
        return;
      }
      if (request.method !== "POST") {
        json(response, 404, { error: "not found" });
        return;
      }

      const body = await readRequest(request);
      lastBody = body;
      const prompt =
        typeof body.prompt === "string"
          ? body.prompt
          : Array.isArray(body.messages)
            ? body.messages
                .map((entry) =>
                  entry && typeof entry === "object"
                    ? String((entry as Record<string, unknown>).content ?? "")
                    : "",
                )
                .join("\n")
            : "";
      if (prompt.includes("[redirect]")) {
        response.writeHead(302, {
          location: "https://example.com/cloud-model",
        });
        response.end();
        return;
      }

      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (prompt.includes("[slow]")) await sleep(180);
      active -= 1;
      if (request.url === "/api/generate") {
        json(response, 200, {
          response: `local:${prompt}`,
          prompt_eval_count: 4,
          eval_count: 2,
        });
        return;
      }
      json(response, 200, {
        choices: [{ message: { content: `local:${prompt}` } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    } catch (error) {
      active = Math.max(0, active - 1);
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fake model server did not bind a TCP port.");
  if (noisy)
    process.stdout.write(
      `fake-model-ready:${address.port}\n${"x".repeat(4_096)}\n`,
    );
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
    active: () => active,
    maximumActive: () => maximumActive,
    lastBody: () => lastBody,
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for audit condition.");
    await sleep(5);
  }
}

function expectSchedulerError(
  code: LocalModelSchedulerError["code"],
): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof LocalModelSchedulerError && error.code === code;
}

async function findUnusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve an audit port.");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function runChildProcess(): Promise<void> {
  const portArgument = process.argv.find((argument) =>
    argument.startsWith("--fake-model-port="),
  );
  const port = Number(portArgument?.split("=")[1]);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error("Fake managed model port is missing.");
  const fake = await startFakeModelServer(port, true);
  const shutdown = async () => {
    await fake.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

async function runAudit(): Promise<void> {
  assert.throws(
    () => assertLoopbackModelEndpoint("https://api.openai.com:443/v1"),
    expectSchedulerError("INVALID_CONFIGURATION"),
  );
  assert.throws(
    () => assertLoopbackModelEndpoint("http://192.168.1.10:11434"),
    expectSchedulerError("INVALID_CONFIGURATION"),
  );
  assert.throws(
    () => assertLoopbackModelEndpoint("http://0.0.0.0:11434"),
    expectSchedulerError("INVALID_CONFIGURATION"),
  );
  assert.throws(
    () => assertLoopbackModelEndpoint("http://user:password@127.0.0.1:11434"),
    expectSchedulerError("INVALID_CONFIGURATION"),
  );
  assert.throws(
    () => assertLoopbackModelEndpoint("file:///tmp/model.sock"),
    expectSchedulerError("INVALID_CONFIGURATION"),
  );
  assert.equal(
    assertLoopbackModelEndpoint("http://localhost:11434").hostname,
    "localhost",
  );
  assert.equal(
    assertLoopbackModelEndpoint("http://[::1]:11434").hostname,
    "[::1]",
  );

  const fake = await startFakeModelServer();
  const scheduler = new LocalModelScheduler({ healthCheckIntervalMs: 60_000 });
  scheduler.registerModel({
    id: "external-test",
    adapter: "openai-compatible",
    endpoint: fake.endpoint,
    model: "fake-local",
    revision: "fake-local-revision-1",
    contextWindowTokens: 4_096,
    maxOutputTokens: 2_048,
    concurrency: 1,
    queueLimit: 1,
    requestTimeoutMs: 1_000,
  });
  scheduler.registerModel({
    id: "ollama-test",
    adapter: "ollama",
    endpoint: fake.endpoint,
    model: "fake-ollama",
    contextWindowTokens: 256,
    maxOutputTokens: 32,
  });

  await scheduler.startAll();
  assert.equal(scheduler.snapshot("external-test").state, "ready");
  assert.equal(
    scheduler.snapshot("external-test").modelRevision,
    "fake-local-revision-1",
  );
  assert.equal(
    scheduler.snapshot("ollama-test").modelRevision,
    `sha256:${"a".repeat(64)}`,
  );
  const basic = await scheduler.generate({
    modelId: "external-test",
    prompt: "hello",
    maxOutputTokens: 8,
  });
  assert.equal(basic.text, "local:hello");
  assert.equal(basic.totalTokens, 6);
  await scheduler.generate({
    modelId: "external-test",
    prompt: "reasoning",
    maxOutputTokens: 128,
    reasoningEffort: "high",
  });
  assert.equal(fake.lastBody().reasoning_effort, "high");
  await scheduler.generate({
    modelId: "external-test",
    prompt: "fast",
    maxOutputTokens: 2_048,
    reasoningEffort: "high",
    fastMode: true,
  });
  assert.equal(fake.lastBody().reasoning_effort, undefined);
  assert.equal(fake.lastBody().max_tokens, 1_024);
  const ollama = await scheduler.generate({
    modelId: "ollama-test",
    prompt: "你好",
    maxOutputTokens: 8,
  });
  assert.equal(ollama.text, "local:你好");
  assert.equal(fake.lastBody().think, false);

  await assert.rejects(
    scheduler.generate({
      modelId: "external-test",
      prompt: "法".repeat(5_000),
      maxOutputTokens: 32,
    }),
    expectSchedulerError("TOKEN_BUDGET_EXCEEDED"),
  );

  const first = scheduler.generate({
    modelId: "external-test",
    prompt: "[slow] first",
    maxOutputTokens: 8,
  });
  await waitUntil(() => fake.active() === 1);
  const second = scheduler.generate({
    modelId: "external-test",
    prompt: "[slow] second",
    maxOutputTokens: 8,
  });
  await waitUntil(
    () => scheduler.snapshot("external-test").queuedRequests === 1,
  );
  await assert.rejects(
    scheduler.generate({
      modelId: "external-test",
      prompt: "third",
      maxOutputTokens: 8,
    }),
    expectSchedulerError("QUEUE_FULL"),
  );
  await Promise.all([first, second]);
  assert.equal(
    fake.maximumActive(),
    1,
    "per-model concurrency was not enforced",
  );

  const occupying = scheduler.generate({
    modelId: "external-test",
    prompt: "[slow] occupy",
    maxOutputTokens: 8,
  });
  await waitUntil(() => fake.active() === 1);
  const cancelledController = new AbortController();
  const cancelled = scheduler.generate({
    modelId: "external-test",
    prompt: "queued cancellation",
    maxOutputTokens: 8,
    signal: cancelledController.signal,
  });
  await waitUntil(
    () => scheduler.snapshot("external-test").queuedRequests === 1,
  );
  cancelledController.abort();
  await assert.rejects(cancelled, expectSchedulerError("REQUEST_ABORTED"));
  await occupying;

  await assert.rejects(
    scheduler.generate({
      modelId: "external-test",
      prompt: "[slow] timeout",
      maxOutputTokens: 8,
      timeoutMs: 30,
    }),
    expectSchedulerError("REQUEST_TIMEOUT"),
  );
  await assert.rejects(
    scheduler.generate({
      modelId: "external-test",
      prompt: "[redirect]",
      maxOutputTokens: 8,
    }),
    expectSchedulerError("LOCAL_MODEL_ERROR"),
  );
  await scheduler.close();
  await fake.close();

  const managedPort = await findUnusedPort();
  const managedScheduler = new LocalModelScheduler({
    managedExecutableAllowlist: [process.execPath],
    healthCheckIntervalMs: 60_000,
    maxManagedLogBytes: 1_024,
  });
  const scriptPath = path.resolve(__filename);
  const tsxLoader = require.resolve("tsx");
  managedScheduler.registerModel({
    id: "managed-test",
    adapter: "openai-compatible",
    endpoint: `http://127.0.0.1:${managedPort}`,
    model: "fake-managed",
    contextWindowTokens: 256,
    maxOutputTokens: 32,
    process: {
      executable: process.execPath,
      args: [
        "--import",
        tsxLoader,
        scriptPath,
        "--fake-model-child",
        `--fake-model-port=${managedPort}`,
      ],
      startupTimeoutMs: 5_000,
      shutdownGraceMs: 2_000,
    },
  });
  await managedScheduler.startModel("managed-test");
  const managedSnapshot = managedScheduler.snapshot("managed-test");
  assert.equal(managedSnapshot.state, "ready");
  assert.ok(managedSnapshot.pid);
  await waitUntil(
    () => managedScheduler.snapshot("managed-test").logTail.length > 0,
  );
  assert.ok(
    Buffer.byteLength(
      managedScheduler.snapshot("managed-test").logTail,
      "utf8",
    ) <= 1_024,
    "managed process log buffer exceeded its byte limit",
  );
  const managedResult = await managedScheduler.generate({
    modelId: "managed-test",
    prompt: "managed",
    maxOutputTokens: 8,
  });
  assert.equal(managedResult.text, "local:managed");
  await managedScheduler.stopModel("managed-test");
  assert.equal(managedScheduler.snapshot("managed-test").state, "stopped");
  await managedScheduler.close();

  const denied = new LocalModelScheduler({ managedExecutableAllowlist: [] });
  assert.throws(
    () =>
      denied.registerModel({
        id: "denied-process",
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:9999",
        model: "denied",
        contextWindowTokens: 256,
        maxOutputTokens: 32,
        process: { executable: process.execPath },
      }),
    expectSchedulerError("INVALID_CONFIGURATION"),
  );
  await denied.close();

  console.log("Aletheia local model scheduler audit passed.");
  console.log(
    JSON.stringify(
      {
        loopbackOnly: true,
        adapters: ["openai-compatible", "ollama"],
        boundedConcurrencyAndQueue: true,
        tokenBudget: true,
        reasoningAndFastMode: true,
        timeoutAndCancellation: true,
        redirectsBlocked: true,
        managedProcessAllowlist: true,
        gracefulShutdown: true,
        boundedLogs: true,
      },
      null,
      2,
    ),
  );
}

if (process.argv.includes("--fake-model-child")) {
  void runChildProcess().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  void runAudit().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
