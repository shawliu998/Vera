import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { WorkspaceModelProviderRegistry } from "../lib/workspace/modelProviderRegistry";
import type {
  ModelEvent,
  ModelGenerateRequest,
  ModelProvider,
} from "../lib/workspace/providers";
import { AssistantRetrievalRepository } from "../lib/workspace/repositories/assistantRetrieval";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { documentStorageKey } from "../lib/workspace/repositories/documents";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import {
  ModelProfilesRepository,
  type StoredModelProfileRecord,
} from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceRuntime } from "../lib/workspace/runtime";
import {
  DOCUMENT_TOOLS,
  WorkspaceAssistantDocumentTools,
} from "../lib/workspace/services/assistantDocumentTools";
import { WorkspaceAssistantModelAdapter } from "../lib/workspace/services/assistantModelAdapter";
import type {
  AssistantModelPort,
  AssistantModelToolCall,
} from "../lib/workspace/services/assistantRuntime";
import { ChatsService } from "../lib/workspace/services/chats";
import { WorkspaceJobsService } from "../lib/workspace/services/jobs";
import { createVeraApplication } from "../veraApplication";

const NOW = "2026-07-15T00:00:00.000Z";
const PROFILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNTESTED_PROFILE_ID = "abababab-abab-4bab-8bab-abababababab";
const PROJECT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOREIGN_PROJECT_ID = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
const DOCUMENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CHUNK_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FOREIGN_DOCUMENT_ID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const FOREIGN_VERSION_ID = "dededede-dede-4ded-8ded-dededededede";
const FOREIGN_CHUNK_ID = "efefefef-efef-4fef-8fef-efefefefefef";
const CHAT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const TOOL_TEXT =
  "The agreement is governed by Delaware law and the courts of Delaware have exclusive jurisdiction.";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function createProfile(
  profiles: ModelProfilesRepository,
  tests: ModelConnectionTestsRepository,
  id: string,
  ready: boolean,
) {
  profiles.create({
    id,
    name: `Audit profile ${id.slice(0, 4)}`,
    provider: "openai",
    model: "gpt-5.4",
    baseUrl: null,
    credentialOrigin: null,
    credentialState: "missing",
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
    enabled: false,
    isDefault: false,
    capabilities: {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
    },
    now: NOW,
  });
  if (!ready) return;
  const stored = profiles.requireStored(id);
  assert.deepEqual(
    tests.storeIfCurrent({
      profileId: id,
      expectedConnectionRevision: stored.connectionRevision,
      status: "passed",
      errorCode: null,
      retryable: false,
      latencyMs: 12,
      testedAt: NOW,
    }).stored,
    true,
  );
  profiles.update(id, { enabled: true, now: NOW });
  assert.equal(profiles.requireEnabled(id).enabled, true);
}

function insertProject(projects: ProjectsRepository, id: string, name: string) {
  projects.create({
    id,
    name,
    description: null,
    cmNumber: null,
    practice: null,
    now: NOW,
  });
}

function insertDocument(
  database: WorkspaceDatabase,
  input: {
    projectId: string;
    documentId: string;
    versionId: string;
    chunkId: string;
    filename: string;
    text: string;
  },
) {
  database
    .prepare(
      `INSERT INTO documents
        (id,project_id,title,filename,mime_type,size_bytes,parse_status,
         current_version_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'pending',NULL,?,?)`,
    )
    .run(
      input.documentId,
      input.projectId,
      input.filename,
      input.filename,
      "text/plain",
      Buffer.byteLength(input.text),
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO document_versions
        (id,document_id,version_number,source,filename,mime_type,size_bytes,
         content_sha256,storage_key,page_count,created_at)
       VALUES (?,?,1,'upload',?,?,?,?,?,1,?)`,
    )
    .run(
      input.versionId,
      input.documentId,
      input.filename,
      "text/plain",
      Buffer.byteLength(input.text),
      hash(input.text),
      documentStorageKey(input.documentId, input.versionId),
      NOW,
    );
  database
    .prepare(
      `UPDATE documents
          SET current_version_id=?,parse_status='ready',updated_at=?
        WHERE id=?`,
    )
    .run(input.versionId, NOW, input.documentId);
  database
    .prepare(
      `INSERT INTO document_chunks
        (id,document_id,version_id,ordinal,text,start_offset,end_offset,
         page_start,page_end,content_sha256,created_at)
       VALUES (?,?,?,0,?,0,?,1,1,?,?)`,
    )
    .run(
      input.chunkId,
      input.documentId,
      input.versionId,
      input.text,
      input.text.length,
      hash(input.text),
      NOW,
    );
}

function fakeProvider(
  events: readonly ModelEvent[],
  capture?: {
    request?: ModelGenerateRequest;
    signal?: AbortSignal;
  },
): ModelProvider {
  return {
    id: "openai",
    async validateConfiguration() {
      return { valid: true };
    },
    async *generate(request, signal) {
      if (capture) {
        capture.request = request;
        capture.signal = signal;
      }
      if (signal.aborted) {
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      }
      for (const event of events) yield event;
    },
  };
}

function fakeRegistry(provider: ModelProvider) {
  return {
    runtimeWired: () => true,
    capabilitiesFor: () => ({
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
    }),
    createProvider: () => provider,
  } as unknown as WorkspaceModelProviderRegistry;
}

function modelInput(
  overrides: Partial<Parameters<AssistantModelPort["runTurn"]>[0]> = {},
) {
  return {
    modelProfileId: PROFILE_ID,
    projectId: null,
    operation: "assistant" as const,
    systemPrompt: "Be precise.",
    messages: [{ role: "user" as const, content: "Review the contract." }],
    tools: DOCUMENT_TOOLS,
    documents: [],
    evidence: [],
    signal: new AbortController().signal,
    async onTextDelta(_delta: string) {},
    async onReasoningDelta(_delta: string) {},
    async onReasoningBlockEnd() {},
    ...overrides,
  };
}

async function auditProviderModelAdapter(database: WorkspaceDatabase) {
  const profiles = new ModelProfilesRepository(database);
  const tests = new ModelConnectionTestsRepository(database);
  createProfile(profiles, tests, PROFILE_ID, true);
  createProfile(profiles, tests, UNTESTED_PROFILE_ID, false);
  const inferencePolicy = new WorkspaceInferencePolicy(database);
  new ModelProfilePrivacyRepository(database).declare(
    PROFILE_ID,
    {
      executionLocation: "local",
      retention: "zero",
      trainingUse: "prohibited",
      sensitiveDataAllowed: true,
    },
    NOW,
  );
  const adapterOptions = { inferencePolicy };

  let providerCreations = 0;
  const unavailableRegistry = {
    ...fakeRegistry(fakeProvider([{ type: "completed" }])),
    createProvider() {
      providerCreations += 1;
      return fakeProvider([{ type: "completed" }]);
    },
  } as unknown as WorkspaceModelProviderRegistry;
  const gate = new WorkspaceAssistantModelAdapter(
    profiles,
    unavailableRegistry,
    adapterOptions,
  );
  await assert.rejects(
    gate.registeredCapabilities({ modelProfileId: UNTESTED_PROFILE_ID }),
    /disabled|current passed connection test/i,
  );
  assert.equal(
    providerCreations,
    0,
    "an unready profile never creates a provider",
  );

  const capture: { request?: ModelGenerateRequest; signal?: AbortSignal } = {};
  const textDeltas: string[] = [];
  const reasoningDeltas: string[] = [];
  let reasoningEnds = 0;
  const adapter = new WorkspaceAssistantModelAdapter(
    profiles,
    fakeRegistry(
      fakeProvider(
        [
          { type: "reasoning_delta", text: "Inspecting" },
          { type: "text_delta", text: "Checking the document." },
          { type: "tool_call_start", id: "call-1", name: "read_document" },
          {
            type: "tool_call_delta",
            id: "call-1",
            argumentsDelta: '{"doc_id":',
          },
          {
            type: "tool_call_delta",
            id: "call-1",
            argumentsDelta: '"doc-0"}',
          },
          { type: "tool_call_end", id: "call-1" },
          { type: "usage", inputTokens: 25, outputTokens: 8 },
          { type: "completed" },
        ],
        capture,
      ),
    ),
    adapterOptions,
  );
  const turn = await adapter.runTurn(
    modelInput({
      documents: [
        { documentId: DOCUMENT_ID, versionId: VERSION_ID, attached: true },
      ],
      async onTextDelta(delta) {
        textDeltas.push(delta);
      },
      async onReasoningDelta(delta) {
        reasoningDeltas.push(delta);
      },
      async onReasoningBlockEnd() {
        reasoningEnds += 1;
      },
    }),
  );
  assert.equal(turn.content, "Checking the document.");
  assert.deepEqual(turn.toolCalls, [
    { id: "call-1", name: "read_document", input: { doc_id: "doc-0" } },
  ]);
  assert.equal(textDeltas.join(""), "Checking the document.");
  assert.deepEqual(reasoningDeltas, ["Inspecting"]);
  assert.equal(reasoningEnds, 1);
  assert.deepEqual(adapter.usageDiagnostics(), [
    {
      profileId: PROFILE_ID,
      provider: "openai",
      executionRevision: profiles.requireStored(PROFILE_ID).executionRevision,
      inputTokenCount: 25,
      outputTokenCount: 8,
      observedAt: adapter.usageDiagnostics()[0]?.observedAt,
    },
  ]);
  assert.equal(capture.request?.model, "gpt-5.4");
  assert.ok(capture.signal instanceof AbortSignal);
  assert.equal(
    JSON.stringify(capture.request).includes("credential"),
    false,
    "the provider request contains no credential reference",
  );

  const evidence = {
    chunkId: CHUNK_ID,
    documentId: DOCUMENT_ID,
    versionId: VERSION_ID,
    filename: "contract.txt",
    ordinal: 0,
    text: TOOL_TEXT,
    startOffset: 0,
    endOffset: TOOL_TEXT.length,
    pageStart: 1,
    pageEnd: 3,
    score: -1,
  };
  const citationAdapter = new WorkspaceAssistantModelAdapter(
    profiles,
    fakeRegistry(
      fakeProvider([
        { type: "text_delta", text: "Delaware governs [1].<CITA" },
        {
          type: "text_delta",
          text: `TIONS>[{"ref":1,"doc_id":"doc-0","quotes":[{"page":2,"quote":"governed by Delaware law"}]}]`,
        },
        { type: "text_delta", text: "</CITATIONS>  " },
        { type: "completed" },
      ]),
    ),
    adapterOptions,
  );
  const citationTurn = await citationAdapter.runTurn(
    modelInput({
      documents: [
        { documentId: DOCUMENT_ID, versionId: VERSION_ID, attached: true },
      ],
      evidence: [evidence],
    }),
  );
  assert.equal(citationTurn.content, "Delaware governs [1].");
  assert.deepEqual(citationTurn.sources[0]?.locator, {
    pageStart: 1,
    pageEnd: 3,
    startOffset: TOOL_TEXT.indexOf("governed by Delaware law"),
    endOffset:
      TOOL_TEXT.indexOf("governed by Delaware law") +
      "governed by Delaware law".length,
  });

  const invalidStreams: readonly (readonly ModelEvent[])[] = [
    [
      { type: "tool_call_delta", id: "missing", argumentsDelta: "{}" },
      { type: "completed" },
    ],
    [
      { type: "tool_call_start", id: "bad", name: "network_lookup" },
      { type: "tool_call_end", id: "bad" },
      { type: "completed" },
    ],
    [{ type: "completed" }, { type: "completed" }],
  ];
  for (const events of invalidStreams) {
    const invalid = new WorkspaceAssistantModelAdapter(
      profiles,
      fakeRegistry(fakeProvider(events)),
      adapterOptions,
    );
    await assert.rejects(invalid.runTurn(modelInput()), (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "assistant_output_invalid",
      ),
    );
  }

  const providerFailure = new WorkspaceAssistantModelAdapter(
    profiles,
    fakeRegistry(
      fakeProvider([
        {
          type: "error",
          code: "rate_limited",
          message: "raw provider response must not escape",
          retryable: true,
        },
      ]),
    ),
    adapterOptions,
  );
  await assert.rejects(
    providerFailure.runTurn(modelInput()),
    (error: unknown) => {
      const record = error as { code?: unknown; message?: unknown };
      return (
        record.code === "assistant_rate_limited" &&
        record.message === "Assistant model provider failed."
      );
    },
  );

  const abortController = new AbortController();
  abortController.abort();
  const abortCapture: { signal?: AbortSignal } = {};
  const abortAdapter = new WorkspaceAssistantModelAdapter(
    profiles,
    fakeRegistry(fakeProvider([], abortCapture)),
    adapterOptions,
  );
  await assert.rejects(
    abortAdapter.runTurn(modelInput({ signal: abortController.signal })),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(abortCapture.signal, abortController.signal);
}

async function auditDocumentTools(database: WorkspaceDatabase) {
  const projects = new ProjectsRepository(database);
  insertProject(projects, PROJECT_ID, "Tool scope");
  insertProject(projects, FOREIGN_PROJECT_ID, "Foreign scope");
  insertDocument(database, {
    projectId: PROJECT_ID,
    documentId: DOCUMENT_ID,
    versionId: VERSION_ID,
    chunkId: CHUNK_ID,
    filename: "contract.txt",
    text: TOOL_TEXT,
  });
  insertDocument(database, {
    projectId: FOREIGN_PROJECT_ID,
    documentId: FOREIGN_DOCUMENT_ID,
    versionId: FOREIGN_VERSION_ID,
    chunkId: FOREIGN_CHUNK_ID,
    filename: "foreign.txt",
    text: "Delaware foreign project material must never be returned.",
  });

  const chats = new ChatsRepository(database);
  const jobs = new WorkspaceJobsService(new WorkspaceJobsRepository(database));
  const service = new ChatsService(
    chats,
    projects,
    new ModelProfilesRepository(database),
    () => new Date(NOW),
    {
      jobs,
      generationControl: jobs,
      inferencePolicy: new WorkspaceInferencePolicy(database),
    },
  );
  service.create({
    projectId: PROJECT_ID,
    title: "Tool audit",
    modelProfileId: PROFILE_ID,
  });
  const chat = chats.listProjectChats(PROJECT_ID)[0];
  assert.ok(chat);
  const generation = service.requestGeneration({
    chatId: chat.id,
    prompt: "Find the governing law.",
    modelProfileId: PROFILE_ID,
    allowedDocumentIds: [DOCUMENT_ID],
    attachmentDocumentIds: [DOCUMENT_ID],
    retrievalLimit: 10,
  });
  const snapshot = chats.generationSnapshot(generation.jobId);
  const context = {
    jobId: snapshot.jobId,
    attempt: 1,
    chatId: snapshot.chatId,
    projectId: snapshot.payload.projectId,
    modelProfileId: snapshot.modelProfileId,
    documents: snapshot.documents,
  };
  const tools = new WorkspaceAssistantDocumentTools(
    database,
    chats,
    new AssistantRetrievalRepository(database),
  );
  const registration = await tools.registeredTools(context);
  assert.deepEqual(
    registration.tools.map((tool) => tool.name),
    ["list_documents", "read_document", "fetch_documents", "find_in_document"],
  );
  const signal = new AbortController().signal;
  const execute = (call: AssistantModelToolCall) =>
    tools.execute({ context, call, signal });
  const listed = await execute({
    id: "list",
    name: "list_documents",
    input: {},
  });
  assert.match(listed.content, /contract\.txt/);
  assert.doesNotMatch(listed.content, /foreign\.txt|foreign project material/i);

  const found = await execute({
    id: "find",
    name: "find_in_document",
    input: {
      doc_id: "doc-0",
      query: "Delaware",
      max_results: 5,
      context_chars: 40,
    },
  });
  assert.equal(found.sourceContext?.length, 1);
  assert.equal(found.sourceContext?.[0]?.documentId, DOCUMENT_ID);
  assert.match(found.content, /governed by Delaware law/);
  assert.doesNotMatch(found.content, /foreign project material/i);

  const read = await execute({
    id: "read",
    name: "read_document",
    input: { doc_id: "doc-0" },
  });
  assert.equal(read.sourceContext?.[0]?.chunkId, CHUNK_ID);
  assert.match(read.content, /exclusive jurisdiction/);
  await assert.rejects(
    execute({
      id: "read-again",
      name: "read_document",
      input: { doc_id: "doc-0" },
    }),
    /already read/i,
  );
  await assert.rejects(
    execute({
      id: "outside",
      name: "read_document",
      input: { doc_id: "doc-1" },
    }),
    /outside the generation snapshot/i,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    tools.execute({
      context,
      call: { id: "abort", name: "list_documents", input: {} },
      signal: aborted.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
}

function abortError() {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}

function runtimeAuditModel(
  onRunTurn?: (prompt: string) => void | Promise<void>,
): AssistantModelPort {
  return {
    async registeredCapabilities() {
      return {
        adapterId: "assistant-runtime-composition-audit",
        streaming: true,
        toolCalling: true,
        reasoning: false,
      };
    },
    async runTurn(input) {
      const prompt =
        [...input.messages].reverse().find((message) => message.role === "user")
          ?.content ?? "";
      await onRunTurn?.(prompt);
      if (prompt.includes("[FAIL]")) {
        throw Object.assign(new Error("raw provider body"), {
          code: "assistant_model_failed",
          retryable: false,
        });
      }
      if (prompt.includes("[CANCEL]")) {
        await new Promise<never>((_resolve, reject) => {
          if (input.signal.aborted) {
            reject(abortError());
            return;
          }
          input.signal.addEventListener("abort", () => reject(abortError()), {
            once: true,
          });
        });
      }
      const content = "Vera completed the local response.";
      await input.onTextDelta(content);
      return { content, toolCalls: [], sources: [] };
    },
  };
}

async function listen(app: ReturnType<typeof createVeraApplication>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function waitForStatus(
  baseUrl: string,
  jobId: string,
  token: string,
  predicate: (status: string) => boolean,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/v1/assistant/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string };
    if (predicate(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Assistant job ${jobId} did not reach the expected status.`);
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 10_000);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function deferredSignal() {
  let resolveSignal: () => void = () => {
    throw new Error("Deferred signal was not initialized.");
  };
  const promise = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  return { promise, resolve: resolveSignal };
}

async function replay(baseUrl: string, jobId: string, token: string) {
  const response = await fetch(
    `${baseUrl}/api/v1/assistant/jobs/${jobId}/events?cursor=0&limit=100`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(response.status, 200);
  return (await response.json()) as {
    status: string;
    terminal: boolean;
    events: Array<{
      event: { type: string; message?: string };
      terminal: boolean;
    }>;
  };
}

async function auditRuntimePumpAndRoutes(root: string) {
  const database = new WorkspaceDatabase(path.join(root, "runtime.db"));
  const profiles = new ModelProfilesRepository(database);
  const tests = new ModelConnectionTestsRepository(database);
  createProfile(profiles, tests, PROFILE_ID, true);
  new ModelProfilePrivacyRepository(database).declare(
    PROFILE_ID,
    {
      executionLocation: "local",
      retention: "zero",
      trainingUse: "prohibited",
      sensitiveDataAllowed: true,
    },
    NOW,
  );
  let modelTurnCount = 0;
  const conversionRaceEntered = deferredSignal();
  const conversionRaceRelease = deferredSignal();
  let conversionRaceReleased = false;
  const releaseConversionRace = () => {
    if (conversionRaceReleased) return;
    conversionRaceReleased = true;
    conversionRaceRelease.resolve();
  };
  const runtime = new WorkspaceRuntime({
    dataDir: path.join(root, "runtime-data"),
    database,
    assistantModel: runtimeAuditModel(async (prompt) => {
      modelTurnCount += 1;
      if (prompt.includes("[CONVERSION-RACE]")) {
        conversionRaceEntered.resolve();
        await conversionRaceRelease.promise;
      }
    }),
    // The execution audit does not create blobs. Keep the production runtime's
    // existing empty-store test seam instead of weakening encryption policy.
    blobs: { listStagedDeletesSync: () => [] } as never,
  });
  await runtime.start();
  assert.equal(runtime.assistantGenerationAvailable(), true);
  const token = "vera-assistant-execution-audit-token-0123456789";
  const app = createVeraApplication({
    runtime,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ALETHEIA_AUTH_MODE: "private_token",
      ALETHEIA_PRIVATE_AUTH_TOKEN: token,
      TRUST_PROXY_HOPS: "0",
      FRONTEND_URL: "http://127.0.0.1:3000",
      RATE_LIMIT_GENERAL_MAX: "1000",
    },
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    auditWriteBlocked: () => false,
  });
  const server = await listen(app);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  try {
    const create = await fetch(`${server.baseUrl}/api/v1/chat/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Execution audit",
        model_profile_id: PROFILE_ID,
      }),
    });
    assert.equal(create.status, 201);
    const chatId = String(((await create.json()) as { id: unknown }).id);

    const unauthorizedCount = Number(
      database.prepare("SELECT count(*) AS count FROM jobs").get()?.count,
    );
    const unauthorized = await fetch(`${server.baseUrl}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        model_profile_id: PROFILE_ID,
        messages: [{ role: "user", content: "unauthorized" }],
      }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(
      Number(
        database.prepare("SELECT count(*) AS count FROM jobs").get()?.count,
      ),
      unauthorizedCount,
      "authentication runs before the Assistant mutation",
    );

    const submit = async (content: string) => {
      const response = await fetch(`${server.baseUrl}/api/v1/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          chat_id: chatId,
          model_profile_id: PROFILE_ID,
          messages: [{ role: "user", content }],
        }),
      });
      assert.equal(response.status, 202);
      return (await response.json()) as { job_id: string };
    };

    const completed = await submit("Complete locally.");
    await waitForStatus(
      server.baseUrl,
      completed.job_id,
      token,
      (status) => status === "complete",
    );
    const completedReplay = await replay(
      server.baseUrl,
      completed.job_id,
      token,
    );
    assert.equal(completedReplay.status, "complete");
    assert.equal(completedReplay.terminal, true);
    assert.equal(
      completedReplay.events.filter((event) => event.terminal).length,
      1,
      "pump completion never writes a second terminal after the claim-fenced commit",
    );
    assert.equal(
      completedReplay.events[0]?.event.type,
      "chat_id",
      "durable replay begins with the enqueue-time chat identity",
    );
    assert.equal(
      completedReplay.events.some(
        (event) => event.event.type === "content_delta",
      ),
      true,
    );

    const failed = await submit("[FAIL]");
    await waitForStatus(
      server.baseUrl,
      failed.job_id,
      token,
      (status) => status === "failed",
    );
    const failedReplay = await replay(server.baseUrl, failed.job_id, token);
    assert.equal(
      failedReplay.events.filter((event) => event.terminal).length,
      1,
    );
    assert.equal(
      JSON.stringify(failedReplay).includes("raw provider body"),
      false,
    );

    const cancelled = await submit("[CANCEL]");
    await waitForStatus(
      server.baseUrl,
      cancelled.job_id,
      token,
      (status) => status === "running",
    );
    const cancel = await fetch(
      `${server.baseUrl}/api/v1/assistant/jobs/${cancelled.job_id}/cancel`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "User cancelled the local run." }),
      },
    );
    assert.equal(cancel.status, 202);
    await waitForStatus(
      server.baseUrl,
      cancelled.job_id,
      token,
      (status) => status === "cancelled",
    );
    const cancelledReplay = await replay(
      server.baseUrl,
      cancelled.job_id,
      token,
    );
    assert.equal(
      cancelledReplay.events.filter((event) => event.terminal).length,
      1,
      "pump cancellation never writes a second terminal after Assistant cancellation commit",
    );

    const genericProjectResponse = await fetch(
      `${server.baseUrl}/api/v1/projects`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Generic compatibility Project" }),
      },
    );
    assert.equal(genericProjectResponse.status, 201);
    const genericProjectId = String(
      ((await genericProjectResponse.json()) as { id: unknown }).id,
    );
    const genericChatResponse = await fetch(
      `${server.baseUrl}/api/v1/chat/create`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Generic Project compatibility",
          project_id: genericProjectId,
          model_profile_id: PROFILE_ID,
        }),
      },
    );
    assert.equal(genericChatResponse.status, 201);
    const genericChatId = String(
      ((await genericChatResponse.json()) as { id: unknown }).id,
    );
    const genericTurnCount = modelTurnCount;
    const genericSubmit = await fetch(`${server.baseUrl}/api/v1/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chat_id: genericChatId,
        model_profile_id: PROFILE_ID,
        messages: [{ role: "user", content: "Generic Project remains compatible." }],
      }),
    });
    assert.equal(genericSubmit.status, 202);
    const genericJobId = String(
      ((await genericSubmit.json()) as { job_id: unknown }).job_id,
    );
    await waitForStatus(
      server.baseUrl,
      genericJobId,
      token,
      (status) => status === "complete",
    );
    assert.equal(modelTurnCount, genericTurnCount + 1);

    const raceTurnCount = modelTurnCount;
    const raceSubmit = await fetch(`${server.baseUrl}/api/v1/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chat_id: genericChatId,
        model_profile_id: PROFILE_ID,
        messages: [
          {
            role: "user",
            content: "[CONVERSION-RACE] Hold the provider boundary.",
          },
        ],
      }),
    });
    assert.equal(raceSubmit.status, 202);
    const raceJobId = String(
      ((await raceSubmit.json()) as { job_id: unknown }).job_id,
    );
    await within(
      conversionRaceEntered.promise,
      "Assistant provider boundary was not entered.",
    );
    assert.equal(
      modelTurnCount,
      raceTurnCount + 1,
      "the conversion race is held inside an active provider turn",
    );

    const blockedConversion = await fetch(
      `${server.baseUrl}/api/v1/projects/${genericProjectId}/matter-profile`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ workspace_type: "general_legal" }),
      },
    );
    assert.equal(
      blockedConversion.status,
      409,
      "conversion must reject while an inference job is already running",
    );
    const blockedConversionBody = await blockedConversion.text();
    assert.equal(blockedConversionBody.includes("raw provider body"), false);

    const stillGeneric = await fetch(
      `${server.baseUrl}/api/v1/projects/${genericProjectId}/matter-profile`,
      { headers },
    );
    assert.equal(stillGeneric.status, 200);
    const stillGenericBody = (await stillGeneric.json()) as {
      matter_profile: unknown;
      profile_state: string;
    };
    assert.equal(stillGenericBody.matter_profile, null);
    assert.equal(stillGenericBody.profile_state, "absent");

    releaseConversionRace();
    await waitForStatus(
      server.baseUrl,
      raceJobId,
      token,
      (status) => status === "complete",
    );

    const completedConversion = await fetch(
      `${server.baseUrl}/api/v1/projects/${genericProjectId}/matter-profile`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ workspace_type: "general_legal" }),
      },
    );
    assert.equal(completedConversion.status, 201);
    const convertedMatter = (await completedConversion.json()) as {
      profile_state: string;
      capabilities: { assistant: string };
    };
    assert.equal(convertedMatter.profile_state, "ready");
    assert.equal(convertedMatter.capabilities.assistant, "policy_gate_closed");

    const beforeConvertedSubmit = modelTurnCount;
    const convertedSubmit = await fetch(`${server.baseUrl}/api/v1/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chat_id: genericChatId,
        model_profile_id: PROFILE_ID,
        messages: [
          {
            role: "user",
            content: "Converted Matter must now fail closed.",
          },
        ],
      }),
    });
    assert.equal(convertedSubmit.status, 412);
    assert.equal(
      modelTurnCount,
      beforeConvertedSubmit,
      "a converted Matter must make zero further provider turns",
    );

    const matterResponse = await fetch(`${server.baseUrl}/api/v1/matters`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Policy-gated legal Matter",
        workspace_type: "general_legal",
      }),
    });
    assert.equal(matterResponse.status, 201);
    const matter = (await matterResponse.json()) as {
      project: { id: string };
      profile_state: string;
      capabilities: { assistant: string };
    };
    assert.equal(matter.profile_state, "ready");
    assert.equal(matter.capabilities.assistant, "policy_gate_closed");
    const matterChatResponse = await fetch(
      `${server.baseUrl}/api/v1/chat/create`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Matter policy gate",
          project_id: matter.project.id,
          model_profile_id: PROFILE_ID,
        }),
      },
    );
    assert.equal(matterChatResponse.status, 201);
    const matterChatId = String(
      ((await matterChatResponse.json()) as { id: unknown }).id,
    );
    const beforeClosedMatter = modelTurnCount;
    const matterSubmit = await fetch(`${server.baseUrl}/api/v1/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chat_id: matterChatId,
        model_profile_id: PROFILE_ID,
        messages: [{ role: "user", content: "This must fail closed." }],
      }),
    });
    assert.equal(matterSubmit.status, 412);
    assert.equal(
      modelTurnCount,
      beforeClosedMatter,
      "a Matter without Gate 3 policy must make zero provider turns",
    );
  } finally {
    releaseConversionRace();
    await server.close();
    await runtime.stop();
  }
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-assistant-execution-"));
  let adapterDatabase: WorkspaceDatabase | null = null;
  try {
    adapterDatabase = new WorkspaceDatabase(path.join(root, "adapter.db"));
    await auditProviderModelAdapter(adapterDatabase);
    await auditDocumentTools(adapterDatabase);
    adapterDatabase.close();
    adapterDatabase = null;
    await auditRuntimePumpAndRoutes(root);
    console.log(
      "Vera Assistant execution audit passed (provider adapter, bounded snapshot tools, Matter policy fail-closed, generic compatibility, durable pump, route auth, and single terminal semantics).",
    );
  } finally {
    adapterDatabase?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
