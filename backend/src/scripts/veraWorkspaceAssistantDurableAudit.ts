import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

import { MikeGenerationReplaySchema } from "../lib/workspace/assistantCompatibility";
import {
  WorkspaceDatabase,
  WORKSPACE_MIGRATIONS,
} from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import {
  AssistantRuntimeService,
  type AssistantModelPort,
  type AssistantToolPort,
} from "../lib/workspace/services/assistantRuntime";
import { ChatsService } from "../lib/workspace/services/chats";
import { WorkspaceJobsService } from "../lib/workspace/services/jobs";
import {
  createWorkspaceChatsV1Router,
  type WorkspaceChatsV1Port,
} from "../routes/workspaceChatsV1";

const NOW = "2026-07-15T01:00:00.000Z";
const CLAIM_AT = "2026-07-15T01:01:00.000Z";
const LEASE_AT = "2026-07-15T01:11:00.000Z";
const LATER = "2026-07-15T01:20:00.000Z";
const TOOL = {
  name: "list_documents" as const,
  description: "List immutable local document snapshots.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function seedEnabledProfile(database: WorkspaceDatabase) {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO model_profiles
        (id,name,provider,model,credential_status,credential_state,
         capabilities_json,settings_json,enabled,is_default,
         connection_revision,created_at,updated_at)
       VALUES (?,?,'openai',?,'not_configured','missing',?,'{}',1,0,0,?,?)`,
    )
    .run(
      id,
      `Durable ${id}`,
      `model-${id}`,
      JSON.stringify({
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
      }),
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO model_profile_connection_tests
        (profile_id,connection_revision,status,error_code,retryable,latency_ms,tested_at)
       VALUES (?,0,'passed',NULL,0,1,?)`,
    )
    .run(id, NOW);
  if (
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='model_profile_privacy'",
      )
      .get()
  ) {
    new ModelProfilePrivacyRepository(database).declare(
      id,
      {
        executionLocation: "local",
        retention: "zero",
        trainingUse: "prohibited",
        sensitiveDataAllowed: true,
      },
      NOW,
    );
  }
  return id;
}

function createServices(
  database: WorkspaceDatabase,
  lifecycle?: {
    cancelQueued(jobIds: readonly string[]): void;
    requestAbortRunning(jobIds: readonly string[]): void;
  },
) {
  const chats = new ChatsRepository(database);
  const jobs = new WorkspaceJobsRepository(database);
  const jobService = new WorkspaceJobsService(jobs, {
    now: () => new Date(NOW),
  });
  const profiles = new ModelProfilesRepository(database);
  const service = new ChatsService(
    chats,
    new ProjectsRepository(database),
    profiles,
    () => new Date(NOW),
    {
      jobs: jobService,
      generationControl: jobService,
      capabilities: {
        hydrate: () => ({ can_read: true, can_download: true }),
      },
      lifecycle,
      inferencePolicy: new WorkspaceInferencePolicy(database),
    },
  );
  return { chats, jobs, jobService, profiles, service };
}

function tools(): AssistantToolPort {
  return {
    async registeredTools() {
      return { adapterId: "durable-audit-tools", tools: [TOOL] };
    },
    async execute() {
      throw new Error("The no-document audit must not invoke tools.");
    },
  };
}

function successfulModel(content: string): AssistantModelPort {
  return {
    async registeredCapabilities() {
      return {
        adapterId: "durable-audit-model",
        streaming: true,
        toolCalling: true,
      };
    },
    async runTurn({ onTextDelta }) {
      await onTextDelta(content);
      return { content, toolCalls: [], sources: [] };
    },
  };
}

function acceptedGeneration(service: ChatsService, profileId: string) {
  const chat = service.create({ modelProfileId: profileId });
  const generation = service.requestGeneration({
    chatId: chat.id,
    prompt: "Verify durable local streaming.",
  });
  return { chat, generation };
}

function claim(jobs: WorkspaceJobsRepository, worker: string) {
  const value = jobs.claimNextQueued(CLAIM_AT, worker, LEASE_AT);
  assert.ok(value, "expected a queued Assistant job");
  assert.equal(value.type, "assistant_generate");
  return value;
}

function routePort(service: ChatsService): WorkspaceChatsV1Port {
  return {
    async listChats(_context, input) {
      const page = service.list(input);
      return { items: page.items, nextCursor: page.nextCursor };
    },
    async listProjectChats(_context, projectId) {
      return service.listProjectChats(projectId);
    },
    async createChat(_context, input) {
      return service.create({
        projectId: input.projectId,
        title: input.title,
        modelProfileId: input.modelProfileId,
      });
    },
    async getChatDetail(_context, chatId) {
      return service.detail(chatId);
    },
    async updateChat(_context, chatId, input) {
      return service.update(chatId, input);
    },
    async deleteChat(_context, chatId) {
      service.delete(chatId);
    },
    async requestGeneration(_context, input) {
      return service.requestGeneration(input);
    },
    async generationStatus(_context, jobId) {
      return service.generationStatus(jobId);
    },
    async listGenerationStatuses(_context, chatId, limit) {
      return service.listGenerationStatuses(chatId, limit);
    },
    async generationEvents(_context, jobId, input) {
      return service.generationEvents(jobId, input);
    },
    async cancelGeneration(_context, jobId, reason) {
      return service.cancelGeneration(jobId, reason);
    },
    async retryGeneration(_context, jobId) {
      return service.retryGeneration(jobId);
    },
    async regenerateGeneration(_context, jobId) {
      return service.regenerateGeneration(jobId);
    },
  };
}

async function withServer(
  app: express.Express,
  operation: (baseUrl: string) => Promise<void>,
) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as AddressInfo;
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function terminalUpgradeReplay(root: string) {
  const databasePath = path.join(root, "terminal-upgrade.db");
  const database = new WorkspaceDatabase(databasePath, {
    migrations: WORKSPACE_MIGRATIONS.filter(
      (migration) => migration.version <= 9,
    ),
  });
  const chatId = randomUUID();
  const promptMessageId = randomUUID();
  const outputMessageId = randomUUID();
  const jobId = randomUUID();
  const modelProfileId = seedEnabledProfile(database);
  const payload = {
    schema: "vera-assistant-generation-v1" as const,
    chatId,
    projectId: null,
    promptMessageId,
    outputMessageId,
    modelProfileId,
    documents: [],
    retrieval: { currentVersionOnly: true as const, limit: 40 },
  };
  database
    .prepare(
      `INSERT INTO chats
        (id,project_id,scope,title,status,created_at,updated_at)
       VALUES (?,NULL,'global','Terminal upgrade','active',?,?)`,
    )
    .run(chatId, NOW, NOW);
  const jobs = new WorkspaceJobsService(new WorkspaceJobsRepository(database), {
    now: () => new Date(NOW),
    createId: () => jobId,
  });
  jobs.createJob({
    type: "assistant_generate",
    payload,
    resourceType: "chat",
    resourceId: chatId,
    maxAttempts: 3,
  });
  database
    .prepare(
      `INSERT INTO chat_messages
        (id,chat_id,sequence,role,content,status,model_profile_id,job_id,
         created_at,updated_at,completed_at)
       VALUES (?,?,0,'user','Upgrade prompt','complete',NULL,NULL,?,?,?),
              (?,?,1,'assistant','','pending',?,?,?,?,NULL)`,
    )
    .run(
      promptMessageId,
      chatId,
      NOW,
      NOW,
      NOW,
      outputMessageId,
      chatId,
      modelProfileId,
      jobId,
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO assistant_generation_snapshots
        (job_id,chat_id,prompt_message_id,output_message_id,model_profile_id,
         current_version_only,retrieval_limit,created_at)
       VALUES (?,?,?,?,?,1,40,?)`,
    )
    .run(jobId, chatId, promptMessageId, outputMessageId, modelProfileId, NOW);
  jobs.transitionJobInCurrentTransaction(jobId, {
    type: "start",
    at: CLAIM_AT,
  });
  jobs.transitionJobInCurrentTransaction(jobId, {
    type: "complete",
    at: "2026-07-15T01:02:00.000Z",
    result: { messageId: outputMessageId },
  });
  database
    .prepare(
      `UPDATE chat_messages
          SET content='Upgrade answer',status='complete',updated_at=?,completed_at=?
        WHERE id=?`,
    )
    .run(
      "2026-07-15T01:02:00.000Z",
      "2026-07-15T01:02:00.000Z",
      outputMessageId,
    );
  database.close();

  const upgraded = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(upgraded.migration?.currentVersion, 17);
    const replay = new ChatsRepository(upgraded).listGenerationEvents(jobId);
    assert.equal(replay.terminal, true);
    assert.deepEqual(
      replay.events.map((event) => event.event.type),
      ["chat_id", "status", "content_done", "complete"],
    );
    assert.deepEqual(replay.events[1]?.event, {
      type: "status",
      job_id: jobId,
      status: "running",
    });
    MikeGenerationReplaySchema.parse({
      job_id: replay.jobId,
      status: replay.status,
      attempt: replay.attempt,
      terminal: replay.terminal,
      events: replay.events.map((event) => ({
        cursor: event.cursor,
        attempt: event.attempt,
        event: event.event,
        terminal: event.terminal,
        created_at: event.createdAt,
      })),
      next_cursor: replay.nextCursor,
    });
  } finally {
    upgraded.close();
  }
}

async function midJobRestart(root: string) {
  const databasePath = path.join(root, "mid-job-restart.db");
  let database = new WorkspaceDatabase(databasePath);
  const profileId = seedEnabledProfile(database);
  let setup = createServices(database);
  const { generation } = acceptedGeneration(setup.service, profileId);
  const claimed = setup.jobs.claimNextQueued(
    CLAIM_AT,
    "restart-worker-one",
    "2026-07-15T01:02:00.000Z",
  );
  assert.ok(claimed);
  const snapshot = setup.chats.generationSnapshot(generation.jobId);
  setup.chats.beginGenerationAttempt({
    snapshot,
    claim: {
      jobId: generation.jobId,
      leaseOwner: "restart-worker-one",
      attempt: claimed.attempt,
      at: CLAIM_AT,
    },
    claims: setup.jobs,
    now: CLAIM_AT,
  });
  setup.chats.appendGenerationEvent({
    snapshot,
    claim: {
      jobId: generation.jobId,
      leaseOwner: "restart-worker-one",
      attempt: claimed.attempt,
      at: CLAIM_AT,
    },
    claims: setup.jobs,
    event: { type: "content_delta", text: "stale partial" },
    now: CLAIM_AT,
  });
  database.close();

  database = new WorkspaceDatabase(databasePath);
  try {
    setup = createServices(database);
    const recovered = setup.jobs.recoverStaleRunningJobs(LATER);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "queued");
    const beforeRetry = setup.service.generationEvents(generation.jobId);
    assert.equal(beforeRetry.attempt, 2);
    assert.equal(beforeRetry.events.length, 0);
    const retryClaim = setup.jobs.claimNextQueued(
      LATER,
      "restart-worker-two",
      "2026-07-15T01:30:00.000Z",
    );
    assert.equal(retryClaim?.attempt, 2);
    await new AssistantRuntimeService(
      setup.chats,
      setup.jobs,
      successfulModel("Recovered answer"),
      {
        tools: tools(),
        clock: () => new Date(LATER),
      },
    ).execute({
      jobId: generation.jobId,
      leaseOwner: "restart-worker-two",
      attempt: retryClaim!.attempt,
      signal: new AbortController().signal,
    });
    const replay = setup.service.generationEvents(generation.jobId);
    assert.equal(replay.attempt, 2);
    assert.equal(replay.terminal, true);
    assert.equal(
      replay.events.some(
        (event) =>
          event.event.type === "content_delta" &&
          event.event.text === "stale partial",
      ),
      false,
    );
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count FROM assistant_generation_events
            WHERE job_id=? AND attempt=1 AND event_type='content_delta'`,
        )
        .get(generation.jobId)?.count,
      1,
      "old attempt evidence remains durable but is excluded from active replay",
    );
  } finally {
    database.close();
  }
}

async function run() {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-assistant-durable-"));
  const databasePath = path.join(root, "workspace.db");
  let database: WorkspaceDatabase | null = new WorkspaceDatabase(databasePath);
  let observer: WorkspaceDatabase | null = null;
  try {
    assert.equal(database.migration?.currentVersion, 17);
    const profileId = seedEnabledProfile(database);
    const activeControllers = new Map<string, AbortController>();
    const setup = createServices(database, {
      cancelQueued(jobIds) {
        for (const jobId of jobIds) {
          setup.service.cancelGeneration(jobId, "Chat cleanup requested.");
        }
      },
      requestAbortRunning(jobIds) {
        for (const jobId of jobIds) activeControllers.get(jobId)?.abort();
      },
    });

    const live = acceptedGeneration(setup.service, profileId);
    const liveClaim = claim(setup.jobs, "live-worker");
    assert.equal(liveClaim.id, live.generation.jobId);
    const firstDeltaPersisted = deferred();
    const releaseModel = deferred();
    const liveModel: AssistantModelPort = {
      async registeredCapabilities() {
        return {
          adapterId: "live-durable-model",
          streaming: true,
          toolCalling: true,
        };
      },
      async runTurn({ onTextDelta }) {
        await onTextDelta("first delta ");
        firstDeltaPersisted.resolve();
        await releaseModel.promise;
        await onTextDelta("second delta");
        return {
          content: "first delta second delta",
          toolCalls: [],
          sources: [],
        };
      },
    };
    const liveExecution = new AssistantRuntimeService(
      setup.chats,
      setup.jobs,
      liveModel,
      { tools: tools(), clock: () => new Date(CLAIM_AT) },
    ).execute({
      jobId: live.generation.jobId,
      leaseOwner: "live-worker",
      attempt: liveClaim.attempt,
      signal: new AbortController().signal,
    });
    await firstDeltaPersisted.promise;
    observer = new WorkspaceDatabase(databasePath, {
      migrate: false,
      readOnly: true,
    });
    const observerChats = new ChatsRepository(observer);
    const whileRunning = observerChats.listGenerationEvents(
      live.generation.jobId,
    );
    assert.equal(whileRunning.status, "running");
    assert.equal(whileRunning.terminal, false);
    assert.equal(
      whileRunning.events.some(
        (record) =>
          record.event.type === "content_delta" &&
          record.event.text === "first delta ",
      ),
      true,
      "an independent handle sees the first delta before the model turn completes",
    );
    assert.equal(
      observer
        .prepare("SELECT status FROM chat_messages WHERE id=?")
        .get(live.generation.outputMessageId)?.status,
      "pending",
    );
    releaseModel.resolve();
    await liveExecution;
    const completedReplay = setup.service.generationEvents(
      live.generation.jobId,
    );
    assert.equal(completedReplay.terminal, true);
    assert.deepEqual(
      completedReplay.events
        .map((record) => record.cursor)
        .slice()
        .sort((left, right) => left - right),
      completedReplay.events.map((record) => record.cursor),
    );
    assert.equal(
      new Set(completedReplay.events.map((record) => record.cursor)).size,
      completedReplay.events.length,
    );
    assert.equal(
      completedReplay.events
        .filter((record) => record.event.type === "content_delta")
        .map((record) =>
          record.event.type === "content_delta" ? record.event.text : "",
        )
        .join(""),
      "first delta second delta",
    );
    const completedMessage = database
      .prepare("SELECT status,content FROM chat_messages WHERE id=?")
      .get(live.generation.outputMessageId);
    assert.equal(completedMessage?.status, "complete");
    assert.equal(completedMessage?.content, "first delta second delta");
    assert.equal(setup.jobs.getJob(live.generation.jobId)?.status, "complete");
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count FROM assistant_generation_events
            WHERE job_id=? AND terminal=1`,
        )
        .get(live.generation.jobId)?.count,
      1,
    );

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use((_request, response, next) => {
      response.locals.userId = WORKSPACE_LOCAL_PRINCIPAL_ID;
      next();
    });
    app.use(
      createWorkspaceChatsV1Router(routePort(setup.service), {
        capabilities: { generation: true },
      }),
    );
    await withServer(app, async (baseUrl) => {
      const listed = await fetch(
        `${baseUrl}/assistant/jobs?chat_id=${live.chat.id}`,
      );
      assert.equal(listed.status, 200);
      assert.equal(
        ((await listed.json()) as { items: unknown[] }).items.length,
        1,
      );

      const firstPage = setup.service.generationEvents(live.generation.jobId, {
        limit: 3,
      });
      assert.equal(firstPage.events.length, 3);
      const cursor = firstPage.nextCursor;
      const resumed = await fetch(
        `${baseUrl}/assistant/jobs/${live.generation.jobId}/events`,
        {
          headers: {
            Accept: "text/event-stream",
            "Last-Event-ID": String(cursor),
          },
        },
      );
      assert.equal(resumed.status, 200);
      const resumedText = await resumed.text();
      const ids = [...resumedText.matchAll(/^id: (\d+)$/gm)].map((match) =>
        Number(match[1]),
      );
      assert.equal(
        ids.every((id) => id > cursor),
        true,
      );
      assert.equal(new Set(ids).size, ids.length);
      assert.match(resumedText, /data: \[DONE\]/);

      const invalid = await fetch(
        `${baseUrl}/assistant/jobs/${live.generation.jobId}/events?cursor=2147483647`,
      );
      assert.equal(invalid.status, 409);

      const disconnected = acceptedGeneration(setup.service, profileId);
      const controller = new AbortController();
      const stream = await fetch(
        `${baseUrl}/assistant/jobs/${disconnected.generation.jobId}/events`,
        {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        },
      );
      const reader = stream.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      controller.abort();
      try {
        await reader.read();
      } catch {
        // Aborting the reader is the behavior under test.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const unchanged = setup.service.generationStatus(
        disconnected.generation.jobId,
      );
      assert.equal(unchanged.status, "queued");
      assert.equal(unchanged.cancelRequested, false);
      const cancelled = setup.service.cancelGeneration(
        disconnected.generation.jobId,
        "Disconnected stream cleanup.",
      );
      assert.equal(cancelled.status, "cancelled");
      assert.equal(
        setup.service
          .generationEvents(disconnected.generation.jobId)
          .events.at(-1)?.terminal,
        true,
      );
    });

    const unauthenticated = express();
    unauthenticated.use(
      createWorkspaceChatsV1Router(routePort(setup.service), {
        capabilities: { generation: true },
      }),
    );
    await withServer(unauthenticated, async (baseUrl) => {
      assert.equal(
        (await fetch(`${baseUrl}/assistant/jobs/${live.generation.jobId}`))
          .status,
        401,
      );
    });
    const forbidden = express();
    forbidden.use(
      createWorkspaceChatsV1Router(routePort(setup.service), {
        context: () => ({ principalId: randomUUID() }),
        capabilities: { generation: true },
      }),
    );
    await withServer(forbidden, async (baseUrl) => {
      assert.equal(
        (await fetch(`${baseUrl}/assistant/jobs/${live.generation.jobId}`))
          .status,
        403,
      );
    });

    const failed = acceptedGeneration(setup.service, profileId);
    const failedClaim = claim(setup.jobs, "failure-worker");
    assert.equal(failedClaim.id, failed.generation.jobId);
    const originalAppend = setup.chats.appendGenerationEvent.bind(setup.chats);
    let injectFailure = true;
    setup.chats.appendGenerationEvent = ((input) => {
      if (injectFailure && input.event.type === "content_delta") {
        injectFailure = false;
        throw {
          code: "assistant_timeout",
          retryable: true,
          unsafe: "/Users/private/api_key=plaintext-secret",
        };
      }
      return originalAppend(input);
    }) as typeof setup.chats.appendGenerationEvent;
    await assert.rejects(
      new AssistantRuntimeService(
        setup.chats,
        setup.jobs,
        successfulModel("event write must fail"),
        { tools: tools(), clock: () => new Date(CLAIM_AT) },
      ).execute({
        jobId: failed.generation.jobId,
        leaseOwner: "failure-worker",
        attempt: failedClaim.attempt,
        signal: new AbortController().signal,
      }),
      (error) =>
        error instanceof WorkspaceApiError && error.code === "JOB_FAILED",
    );
    setup.chats.appendGenerationEvent = originalAppend;
    const failedStatus = setup.service.generationStatus(
      failed.generation.jobId,
    );
    assert.equal(failedStatus.status, "failed");
    assert.equal(failedStatus.retryable, true);
    const failedReplay = setup.service.generationEvents(
      failed.generation.jobId,
    );
    assert.equal(failedReplay.events.at(-1)?.event.type, "error");
    assert.doesNotMatch(
      JSON.stringify(failedReplay),
      /Users\/private|plaintext-secret|api_key/i,
    );
    const retried = setup.service.retryGeneration(failed.generation.jobId);
    assert.equal(retried.status, "queued");
    const retryQueuedReplay = setup.service.generationEvents(
      failed.generation.jobId,
    );
    assert.equal(retryQueuedReplay.attempt, 2);
    assert.deepEqual(
      retryQueuedReplay.events.map((record) => record.event.type),
      ["chat_id", "status", "status"],
    );
    assert.deepEqual(
      retryQueuedReplay.events
        .filter((record) => record.event.type === "status")
        .map((record) =>
          record.event.type === "status" ? record.event.status : "",
        ),
      ["retrying", "queued"],
    );
    const retryClaim = claim(setup.jobs, "retry-worker");
    assert.equal(retryClaim.id, failed.generation.jobId);
    assert.equal(retryClaim.attempt, 2);
    await new AssistantRuntimeService(
      setup.chats,
      setup.jobs,
      successfulModel("retry complete"),
      { tools: tools(), clock: () => new Date(CLAIM_AT) },
    ).execute({
      jobId: failed.generation.jobId,
      leaseOwner: "retry-worker",
      attempt: retryClaim.attempt,
      signal: new AbortController().signal,
    });
    assert.equal(
      setup.service.generationStatus(failed.generation.jobId).status,
      "complete",
    );

    const running = acceptedGeneration(setup.service, profileId);
    const runningClaim = claim(setup.jobs, "cancel-worker");
    assert.equal(runningClaim.id, running.generation.jobId);
    const cancelController = new AbortController();
    activeControllers.set(running.generation.jobId, cancelController);
    const cancelDelta = deferred();
    const cancelModel: AssistantModelPort = {
      async registeredCapabilities() {
        return {
          adapterId: "cancel-model",
          streaming: true,
          toolCalling: true,
        };
      },
      async runTurn({ onTextDelta, signal }) {
        await onTextDelta("cancel partial");
        cancelDelta.resolve();
        await new Promise<void>((_resolve, reject) => {
          const fail = () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const cancellationExecution = new AssistantRuntimeService(
      setup.chats,
      setup.jobs,
      cancelModel,
      { tools: tools(), clock: () => new Date(CLAIM_AT) },
    ).execute({
      jobId: running.generation.jobId,
      leaseOwner: "cancel-worker",
      attempt: runningClaim.attempt,
      signal: cancelController.signal,
    });
    await cancelDelta.promise;
    const snapshot = setup.chats.generationSnapshot(running.generation.jobId);
    assert.throws(
      () =>
        setup.chats.appendGenerationEvent({
          snapshot,
          claim: {
            jobId: running.generation.jobId,
            leaseOwner: "cancel-worker",
            attempt: runningClaim.attempt,
            at: CLAIM_AT,
          },
          claims: setup.jobs,
          event: {
            type: "content_delta",
            text: "sk-123456789012345678901234 /Users/private/secret",
          },
          now: CLAIM_AT,
        }),
      /unsafe/i,
    );
    const requested = setup.service.cancelGeneration(
      running.generation.jobId,
      "User requested cancellation.",
    );
    assert.equal(requested.cancelRequested, true);
    const cancellationResult = await cancellationExecution;
    assert.deepEqual(cancellationResult, {
      messageId: running.generation.outputMessageId,
      status: "cancelled",
    });
    const cancelledStatus = setup.service.generationStatus(
      running.generation.jobId,
    );
    assert.equal(cancelledStatus.status, "cancelled");
    const cancelledMessage = database
      .prepare("SELECT status,content FROM chat_messages WHERE id=?")
      .get(running.generation.outputMessageId);
    assert.equal(cancelledMessage?.status, "cancelled");
    assert.equal(cancelledMessage?.content, "cancel partial");
    assert.equal(
      setup.service.generationEvents(running.generation.jobId).events.at(-1)
        ?.event.type,
      "error",
    );

    const regenerated = setup.service.regenerateGeneration(
      live.generation.jobId,
    );
    assert.notEqual(regenerated.jobId, live.generation.jobId);
    assert.notEqual(
      regenerated.outputMessageId,
      live.generation.outputMessageId,
    );
    assert.equal(regenerated.chatId, live.chat.id);
    setup.service.cancelGeneration(
      regenerated.jobId,
      "Regeneration audit cleanup.",
    );

    observer.close();
    observer = null;
    database.close();
    database = null;
    const reopened = new WorkspaceDatabase(databasePath);
    try {
      const replay = new ChatsRepository(reopened).listGenerationEvents(
        live.generation.jobId,
      );
      assert.equal(replay.terminal, true);
      assert.equal(
        replay.events
          .filter((record) => record.event.type === "content_delta")
          .map((record) =>
            record.event.type === "content_delta" ? record.event.text : "",
          )
          .join(""),
        "first delta second delta",
      );
      assert.equal(
        reopened.prepare("PRAGMA foreign_key_check").all().length,
        0,
      );
    } finally {
      reopened.close();
    }

    await terminalUpgradeReplay(root);
    await midJobRestart(root);
    console.log("Vera workspace Assistant durable audit passed.");
  } finally {
    observer?.close();
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
