import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

import type {
  BlobIntegrity,
  BlobStore,
  StoredWorkspaceBlob,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { WorkspaceDocumentStudioRepository } from "../lib/workspace/repositories/documentStudio";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceSourceFoundationRepository } from "../lib/workspace/repositories/sourceFoundation";
import { WorkspaceSourceRetentionLifecycleRepository } from "../lib/workspace/repositories/sourceRetentionLifecycle";
import { WorkspaceAssistantDocumentTools } from "../lib/workspace/services/assistantDocumentTools";
import {
  AssistantRuntimeService,
  type AssistantModelPort,
  type AssistantToolPort,
} from "../lib/workspace/services/assistantRuntime";
import { ChatsService } from "../lib/workspace/services/chats";
import { WorkspaceDocumentStudioService } from "../lib/workspace/services/documentStudio";
import { WorkspaceDocumentStudioRepositoryAdapter } from "../lib/workspace/services/documentStudioRepositoryAdapter";
import { WorkspaceJobsService } from "../lib/workspace/services/jobs";
import { WorkspaceSourceRetentionService } from "../lib/workspace/services/sourceRetention";
import {
  createWorkspaceDocumentStudioV1Router,
  type WorkspaceDocumentStudioV1Port,
} from "../routes/workspaceDocumentStudioV1";

// The v13 lifecycle trigger anchors new rows to SQLite wall time. Keep this
// audit clock safely ahead of wall time so its explicit tombstone cannot move
// lifecycle time backwards as the calendar advances.
const NOW = "2099-07-15T14:00:00.000Z";
const LEASE_EXPIRES = "2099-07-15T15:00:00.000Z";
const AFTER_LEASE = "2099-07-15T16:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";

function key(locator: WorkspaceBlobLocator) {
  return JSON.stringify(locator);
}

class MemoryBlobStore implements BlobStore {
  readonly stored = new Map<string, Buffer>();
  readonly staged = new Map<
    string,
    { locator: WorkspaceBlobLocator; value: Buffer }
  >();
  failNextPut = false;

  putSync(
    locator: WorkspaceBlobLocator,
    plaintext: Buffer | string,
  ): StoredWorkspaceBlob {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("audit blob put failure");
    }
    const value = Buffer.isBuffer(plaintext)
      ? Buffer.from(plaintext)
      : Buffer.from(plaintext, "utf8");
    this.stored.set(key(locator), value);
    return {
      locator,
      sha256: createHash("sha256").update(value).digest("hex"),
      size: value.byteLength,
      storedSize: value.byteLength,
    };
  }

  readSync(locator: WorkspaceBlobLocator, expected: BlobIntegrity): Buffer {
    const value = this.stored.get(key(locator));
    if (!value) throw new Error("audit blob missing");
    assert.equal(value.byteLength, expected.size);
    assert.equal(
      createHash("sha256").update(value).digest("hex"),
      expected.sha256,
    );
    return Buffer.from(value);
  }

  stageDeleteSync(locator: WorkspaceBlobLocator): WorkspaceBlobDeleteReceipt {
    const storageKey = key(locator);
    const value = this.stored.get(storageKey);
    if (!value) throw new Error("audit compensation blob missing");
    const quarantineId = randomUUID();
    this.stored.delete(storageKey);
    this.staged.set(quarantineId, { locator, value });
    return { status: "staged", locator, quarantineId };
  }

  finalizeDeleteSync(receipt: WorkspaceBlobDeleteReceipt): void {
    if (!this.staged.delete(receipt.quarantineId)) {
      throw new Error("audit staged blob missing");
    }
  }

  restoreDeleteSync(receipt: WorkspaceBlobDeleteReceipt): void {
    const staged = this.staged.get(receipt.quarantineId);
    if (!staged) throw new Error("audit staged blob missing");
    this.stored.set(key(staged.locator), staged.value);
    this.staged.delete(receipt.quarantineId);
  }
}

function seedProfile(database: WorkspaceDatabase) {
  const profiles = new ModelProfilesRepository(database);
  const tests = new ModelConnectionTestsRepository(database);
  profiles.create({
    id: PROFILE_ID,
    name: "Suggestion audit model",
    provider: "openai",
    model: "audit-model",
    baseUrl: null,
    credentialOrigin: null,
    credentialState: "missing",
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
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
  const stored = profiles.requireStored(PROFILE_ID);
  assert.equal(
    tests.storeIfCurrent({
      profileId: PROFILE_ID,
      expectedConnectionRevision: stored.connectionRevision,
      status: "passed",
      errorCode: null,
      retryable: false,
      latencyMs: 1,
      testedAt: NOW,
    }).stored,
    true,
  );
  profiles.update(PROFILE_ID, { enabled: true, now: NOW });
  return profiles;
}

function count(database: WorkspaceDatabase, table: string) {
  return Number(
    database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count,
  );
}

function assertApiFailure(
  operation: () => unknown | Promise<unknown>,
  status: number,
) {
  return assert.rejects(
    async () => operation(),
    (error) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === status,
      ),
  );
}

async function strictDecisionRouteAudit(input: {
  projectId: string;
  documentId: string;
  suggestionId: string;
}) {
  let decisionCalls = 0;
  const port = {
    listStudioSuggestions: async () => ({
      suggestions: [],
      has_more: false,
    }),
    acceptStudioSuggestion: async () => {
      decisionCalls += 1;
      throw new Error("strict-body audit must not reach the port");
    },
    rejectStudioSuggestion: async () => {
      decisionCalls += 1;
      throw new Error("strict-body audit must not reach the port");
    },
  } as unknown as WorkspaceDocumentStudioV1Port;
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createWorkspaceDocumentStudioV1Router(port));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const root = `http://127.0.0.1:${address.port}/api/v1/projects/${input.projectId}/studio/documents/${input.documentId}/suggestions`;
    for (const [action, body] of [
      ["accept", { inserted_text: "client mutation" }],
      ["reject", { reason: "client mutation" }],
    ] as const) {
      const response = await fetch(`${root}/${input.suggestionId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422);
    }
    const publicCreate = await fetch(root, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inserted_text: "client mutation" }),
    });
    assert.equal(publicCreate.status, 404);
    assert.equal(decisionCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function retentionSuggestionRouteAudit(input: {
  port: WorkspaceDocumentStudioV1Port;
  projectId: string;
  documentId: string;
  suggestionId: string;
  secretText: string;
}) {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createWorkspaceDocumentStudioV1Router(input.port));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const root = `http://127.0.0.1:${address.port}/api/v1/projects/${input.projectId}/studio/documents/${input.documentId}/suggestions`;
    for (const request of [
      { url: root, method: "GET" },
      { url: `${root}/${input.suggestionId}`, method: "GET" },
      { url: `${root}/${input.suggestionId}/reject`, method: "POST" },
    ]) {
      const response = await fetch(request.url, {
        method: request.method,
        ...(request.method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: "{}",
            }
          : {}),
      });
      assert.equal(response.status, 409);
      assert.doesNotMatch(await response.text(), new RegExp(input.secretText));
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-studio-suggestions-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const blobs = new MemoryBlobStore();
  let database: WorkspaceDatabase | null = null;
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    database = new WorkspaceDatabase(databasePath);
    assert.equal(database.migration?.currentVersion, 16);
    const projects = new ProjectsRepository(database);
    for (const [id, name] of [
      [PROJECT_ID, "Suggestion Project"],
      [FOREIGN_PROJECT_ID, "Foreign Project"],
    ] as const) {
      projects.create({
        id,
        name,
        description: null,
        cmNumber: null,
        practice: null,
        now: NOW,
      });
    }
    const profiles = seedProfile(database);
    const sourceFoundation = new WorkspaceSourceFoundationRepository(database);
    const sourceSnapshot = sourceFoundation.createSnapshot({
      id: randomUUID(),
      projectId: PROJECT_ID,
      sourceKind: "legal_authority",
      sourceRecordId: "suggestion-audit-authority",
      sourceVersionId: null,
      titleSnapshot: "Suggestion audit authority",
      contentSha256: createHash("sha256")
        .update("authority body", "utf8")
        .digest("hex"),
      locator: { authorityIdentifier: "suggestion-audit-authority" },
      retrievedAt: NOW,
      license: {
        basis: "user_provided",
        retention: "full_text_permitted",
        export: "permitted",
        modelUse: "permitted",
      },
      retentionPolicy: "full_text_permitted",
      retentionExpiresAt: null,
      retrievalMetadata: {},
      createdAt: NOW,
    });
    const sourceAnchor = sourceFoundation.createCitationAnchor({
      id: randomUUID(),
      projectId: PROJECT_ID,
      snapshotId: sourceSnapshot.id,
      ordinal: 0,
      exactQuote: "authority exact quote",
      locator: { section: "1" },
      createdAt: NOW,
    });
    const blobRecords = new WorkspaceBlobRecordsRepository(database);
    const retention = new WorkspaceSourceRetentionService(
      new WorkspaceSourceRetentionLifecycleRepository(database),
      () => Date.parse(NOW),
    );
    const studioRepository = new WorkspaceDocumentStudioRepository(database, {
      blobRecords,
      now: () => NOW,
    });
    const adapter = new WorkspaceDocumentStudioRepositoryAdapter(
      studioRepository,
      sourceFoundation,
      retention,
      () => NOW,
    );
    const service = new WorkspaceDocumentStudioService(
      adapter,
      blobs,
      blobRecords,
      { cleanupRecorder: { record: () => undefined } },
    );
    const initialContent = "Hello old world.\n";
    const draft = await service.createDraft({
      projectId: PROJECT_ID,
      title: "AI suggestion draft",
      content: initialContent,
      source: "assistant_edit",
      citationAnchorIds: [sourceAnchor.id],
    });
    assert.equal(draft.version.versionNumber, 1);

    const chatsRepository = new ChatsRepository(database);
    const jobs = new WorkspaceJobsService(
      new WorkspaceJobsRepository(database),
    );
    const chats = new ChatsService(
      chatsRepository,
      projects,
      profiles,
      () => new Date(NOW),
      { jobs, generationControl: jobs },
    );
    const chat = chats.create({
      projectId: PROJECT_ID,
      title: "Suggestion source chat",
      modelProfileId: PROFILE_ID,
    });
    const generation = chats.requestGeneration({
      chatId: chat.id,
      prompt: "Read the raw draft and suggest replacing old with new.",
      modelProfileId: PROFILE_ID,
      allowedDocumentIds: [draft.document.id],
      attachmentDocumentIds: [draft.document.id],
      retrievalLimit: 10,
    });
    const snapshot = chatsRepository.generationSnapshot(generation.jobId);
    const initialClaimed = jobs.repository.claimNextQueuedForTypes(
      NOW,
      ["assistant_generate"],
      "suggestion-audit-initial",
      LEASE_EXPIRES,
    );
    assert.equal(initialClaimed?.id, generation.jobId);
    assert(initialClaimed);
    assert.equal(initialClaimed.attempt, 1);
    const initialClaim = {
      jobId: generation.jobId,
      leaseOwner: "suggestion-audit-initial",
      attempt: initialClaimed.attempt,
      at: NOW,
    };
    chatsRepository.beginGenerationAttempt({
      snapshot,
      claim: initialClaim,
      claims: jobs.repository,
      now: NOW,
    });
    const toolContext = {
      jobId: snapshot.jobId,
      attempt: initialClaimed.attempt,
      chatId: snapshot.chatId,
      projectId: snapshot.payload.projectId,
      modelProfileId: snapshot.modelProfileId,
      documents: snapshot.documents,
    };
    const tools = new WorkspaceAssistantDocumentTools(
      database,
      chatsRepository,
      undefined,
      {
        studioSuggestions: service,
        assertModelUse: () => undefined,
      },
    );
    const registered = await tools.registeredTools(toolContext);
    assert(
      registered.tools.some((tool) => tool.name === "read_studio_document"),
    );
    assert(
      registered.tools.some((tool) => tool.name === "suggest_studio_edit"),
    );
    const suggestDefinition = registered.tools.find(
      (tool) => tool.name === "suggest_studio_edit",
    );
    assert(suggestDefinition);
    const suggestSchema = suggestDefinition.inputSchema as {
      properties?: {
        exact_deleted?: { maxLength?: number };
        inserted_text?: { maxLength?: number };
      };
    };
    assert.equal(suggestSchema.properties?.exact_deleted?.maxLength, 20_000);
    assert.equal(suggestSchema.properties?.inserted_text?.maxLength, 20_000);
    assert(
      JSON.stringify({
        doc_id: "doc-0",
        start_offset: 0,
        end_offset: 20_000,
        exact_deleted: '"'.repeat(20_000),
        inserted_text: "\\".repeat(20_000),
        summary: "S".repeat(500),
      }).length < 100_000,
      "every schema-valid maximum edit must fit the Assistant dispatcher budget",
    );
    const signal = new AbortController().signal;
    const read = await tools.execute({
      context: toolContext,
      call: {
        id: "read-raw-markdown",
        name: "read_studio_document",
        input: { doc_id: "doc-0" },
      },
      signal,
    });
    assert.match(read.content, /raw_markdown_v1/);
    const createdByTool = await tools.execute({
      context: toolContext,
      call: {
        id: "suggest-replace-old",
        name: "suggest_studio_edit",
        input: {
          doc_id: "doc-0",
          start_offset: 6,
          end_offset: 9,
          exact_deleted: "old",
          inserted_text: "new",
          summary: "Replace old with new",
        },
      },
      signal,
    });
    assert.match(createdByTool.content, /requires_explicit_user_acceptance/);
    const first = service.listSuggestions(PROJECT_ID, draft.document.id)[0];
    assert.equal(first.status, "pending");
    assert.equal(first.startOffset, 6);
    assert.equal(first.endOffset, 9);
    assert.equal(first.contextBefore, "Hello ");
    assert.equal(first.contextAfter, " world.\n");
    assert.equal(count(database, "document_versions"), 1);
    assert.equal(blobs.stored.size, 1);
    await strictDecisionRouteAudit({
      projectId: PROJECT_ID,
      documentId: draft.document.id,
      suggestionId: first.id,
    });

    await assertApiFailure(
      () => service.acceptSuggestion(PROJECT_ID, draft.document.id, first.id),
      409,
    );
    assert.equal(
      adapter.getSuggestion(PROJECT_ID, draft.document.id, first.id)?.status,
      "pending",
    );
    assert.equal(count(database, "document_versions"), 1);

    chatsRepository.commitGenerationComplete({
      snapshot,
      claim: initialClaim,
      claims: jobs.repository,
      content: "Suggestion ready.",
      sources: [],
      now: NOW,
    });

    database.exec(`
      CREATE TRIGGER audit_fail_suggestion_accept
      BEFORE UPDATE OF status ON document_edits
      WHEN new.status = 'accepted'
      BEGIN
        SELECT RAISE(ABORT, 'audit forced acceptance failure');
      END;
    `);
    await assertApiFailure(
      () => service.acceptSuggestion(PROJECT_ID, draft.document.id, first.id),
      500,
    );
    assert.equal(count(database, "document_versions"), 1);
    assert.equal(count(database, "document_studio_versions"), 1);
    assert.equal(count(database, "workspace_blob_records"), 1);
    assert.equal(
      blobs.stored.size,
      1,
      "failed DB transaction compensates prepared blob",
    );
    assert.equal(
      adapter.getSuggestion(PROJECT_ID, draft.document.id, first.id)?.status,
      "pending",
    );
    database.exec("DROP TRIGGER audit_fail_suggestion_accept");

    const accepted = await service.acceptSuggestion(
      PROJECT_ID,
      draft.document.id,
      first.id,
    );
    assert.equal(accepted.suggestion.status, "accepted");
    assert.equal(accepted.document.content, "Hello new world.\n");
    assert.equal(accepted.document.version.versionNumber, 2);
    assert.equal(accepted.document.version.source, "user_accept");
    assert.deepEqual(accepted.document.version.citationAnchorIds, [
      sourceAnchor.id,
    ]);
    assert.equal(
      accepted.suggestion.resultVersionId,
      accepted.document.version.id,
    );
    await assertApiFailure(
      () => service.acceptSuggestion(PROJECT_ID, draft.document.id, first.id),
      409,
    );

    const current = accepted.document;
    const makeSuggestion = (toolCallId: string, insertedText: string) =>
      service.createSuggestionFromAssistantTool({
        projectId: PROJECT_ID,
        documentId: current.document.id,
        baseVersionId: current.version.id,
        messageId: generation.outputMessageId,
        jobId: generation.jobId,
        attempt: 1,
        toolCallId,
        startOffset: current.content.length,
        endOffset: current.content.length,
        exactDeletedText: "",
        insertedText,
        summary: `Append ${insertedText.trim()}`,
      });
    const blobFailure = await makeSuggestion("blob-failure", "Appendix A\n");
    blobs.failNextPut = true;
    await assertApiFailure(
      () =>
        service.acceptSuggestion(
          PROJECT_ID,
          current.document.id,
          blobFailure.id,
        ),
      500,
    );
    assert.equal(
      adapter.getSuggestion(PROJECT_ID, current.document.id, blobFailure.id)
        ?.status,
      "pending",
    );
    assert.equal(count(database, "document_versions"), 2);
    const rejected = service.rejectSuggestion(
      PROJECT_ID,
      current.document.id,
      blobFailure.id,
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(count(database, "document_versions"), 2);

    const winsRace = await makeSuggestion("wins-race", "Winner\n");
    const stale = await makeSuggestion("becomes-stale", "Stale\n");
    const raceAccepted = await service.acceptSuggestion(
      PROJECT_ID,
      current.document.id,
      winsRace.id,
    );
    assert.equal(raceAccepted.document.version.versionNumber, 3);
    await assertApiFailure(
      () => service.acceptSuggestion(PROJECT_ID, current.document.id, stale.id),
      409,
    );
    assert.equal(
      adapter.getSuggestion(PROJECT_ID, current.document.id, stale.id)?.status,
      "pending",
    );
    assert.equal(count(database, "document_versions"), 3);
    await assertApiFailure(
      () =>
        service.acceptSuggestion(
          FOREIGN_PROJECT_ID,
          current.document.id,
          stale.id,
        ),
      404,
    );
    const staleRejected = service.rejectSuggestion(
      PROJECT_ID,
      current.document.id,
      stale.id,
    );
    assert.equal(staleRejected.status, "rejected");

    const startSuggestionRun = async (input: {
      title: string;
      studio: {
        document: { id: string };
        version: { id: string };
        content: string;
      };
      toolCallId: string;
      insertedText: string;
      leaseOwner: string;
    }) => {
      const runChat = chats.create({
        projectId: PROJECT_ID,
        title: input.title,
        modelProfileId: PROFILE_ID,
      });
      const runGeneration = chats.requestGeneration({
        chatId: runChat.id,
        prompt: input.title,
        modelProfileId: PROFILE_ID,
        allowedDocumentIds: [input.studio.document.id],
        attachmentDocumentIds: [input.studio.document.id],
        retrievalLimit: 10,
      });
      const runSnapshot = chatsRepository.generationSnapshot(
        runGeneration.jobId,
      );
      const studioDocumentIndex = runSnapshot.documents.findIndex(
        (document) => document.documentId === input.studio.document.id,
      );
      assert.notEqual(studioDocumentIndex, -1);
      assert.equal(
        runSnapshot.documents[studioDocumentIndex]?.versionId,
        input.studio.version.id,
      );
      const studioDocumentLabel = `doc-${studioDocumentIndex}`;
      const claimed = jobs.repository.claimNextQueuedForTypes(
        NOW,
        ["assistant_generate"],
        input.leaseOwner,
        LEASE_EXPIRES,
      );
      assert.equal(claimed?.id, runGeneration.jobId);
      assert(claimed);
      const claim = {
        jobId: claimed.id,
        leaseOwner: input.leaseOwner,
        attempt: claimed.attempt,
        at: NOW,
      };
      chatsRepository.beginGenerationAttempt({
        snapshot: runSnapshot,
        claim,
        claims: jobs.repository,
        now: NOW,
      });
      const context = {
        jobId: runSnapshot.jobId,
        attempt: claimed.attempt,
        chatId: runSnapshot.chatId,
        projectId: runSnapshot.payload.projectId,
        modelProfileId: runSnapshot.modelProfileId,
        documents: runSnapshot.documents,
      };
      const runTools = new WorkspaceAssistantDocumentTools(
        database!,
        chatsRepository,
        undefined,
        { studioSuggestions: service, assertModelUse: () => undefined },
      );
      await runTools.registeredTools(context);
      const rawRead = await runTools.execute({
        context,
        call: {
          id: `read-${input.toolCallId}`,
          name: "read_studio_document",
          input: { doc_id: studioDocumentLabel },
        },
        signal,
      });
      const rawReadPayload = JSON.parse(rawRead.content) as {
        document?: { content_length?: unknown };
        range?: { complete?: unknown };
      };
      assert.equal(rawReadPayload.range?.complete, true);
      assert.equal(
        rawReadPayload.document?.content_length,
        input.studio.content.length,
      );
      const insertionOffset = Number(rawReadPayload.document?.content_length);
      const created = await runTools.execute({
        context,
        call: {
          id: input.toolCallId,
          name: "suggest_studio_edit",
          input: {
            doc_id: studioDocumentLabel,
            start_offset: insertionOffset,
            end_offset: insertionOffset,
            exact_deleted: "",
            inserted_text: input.insertedText,
            summary: input.title,
          },
        },
        signal,
      });
      const suggestionId = String(
        (JSON.parse(created.content) as { suggestion?: { id?: unknown } })
          .suggestion?.id,
      );
      const suggestion = adapter.getSuggestion(
        PROJECT_ID,
        input.studio.document.id,
        suggestionId,
      );
      assert(suggestion);
      return {
        chat: runChat,
        generation: runGeneration,
        snapshot: runSnapshot,
        claim,
        context,
        tools: runTools,
        suggestion,
      };
    };

    const failedRun = await startSuggestionRun({
      title: "Failure closes pending suggestion",
      studio: raceAccepted.document,
      toolCallId: "same-tool-call-after-retry",
      insertedText: "Failure candidate\n",
      leaseOwner: "suggestion-audit-failure",
    });
    chatsRepository.commitGenerationFailure({
      snapshot: failedRun.snapshot,
      claim: failedRun.claim,
      claims: jobs.repository,
      error: {
        code: "audit_generation_failed",
        message: "Audit generation failed.",
        retryable: true,
      },
      now: NOW,
    });
    assert.equal(
      adapter.getSuggestion(
        PROJECT_ID,
        raceAccepted.document.document.id,
        failedRun.suggestion.id,
      )?.status,
      "rejected",
    );
    await assertApiFailure(
      () =>
        service.acceptSuggestion(
          PROJECT_ID,
          raceAccepted.document.document.id,
          failedRun.suggestion.id,
        ),
      409,
    );

    const retryGhostId = randomUUID();
    database
      .prepare(
        `INSERT INTO document_edits (
           id,document_id,version_id,message_id,change_id,deleted_text,
           inserted_text,context_before,context_after,summary,status,
           created_at,resolved_at,start_offset,end_offset,offset_scope,offset_unit
         ) VALUES (?, ?, ?, ?, ?, '', 'ghost', '', '', ?, 'pending', ?, NULL,
                   ?, ?, 'raw_markdown_v1', 'utf16_code_unit')`,
      )
      .run(
        retryGhostId,
        raceAccepted.document.document.id,
        raceAccepted.document.version.id,
        failedRun.generation.outputMessageId,
        `retry-ghost:${randomUUID()}`,
        "Retry closes recovered pending suggestion",
        NOW,
        raceAccepted.document.content.length,
        raceAccepted.document.content.length,
      );
    const retriedStatus = chats.retryGeneration(failedRun.generation.jobId);
    assert.equal(retriedStatus.status, "queued");
    assert.equal(
      adapter.getSuggestion(
        PROJECT_ID,
        raceAccepted.document.document.id,
        retryGhostId,
      )?.status,
      "rejected",
    );
    const retryClaimed = jobs.repository.claimNextQueuedForTypes(
      NOW,
      ["assistant_generate"],
      "suggestion-audit-retry-2",
      LEASE_EXPIRES,
    );
    assert.equal(retryClaimed?.id, failedRun.generation.jobId);
    assert(retryClaimed);
    assert.equal(retryClaimed.attempt, 2);
    const retryClaim = {
      jobId: retryClaimed.id,
      leaseOwner: "suggestion-audit-retry-2",
      attempt: retryClaimed.attempt,
      at: NOW,
    };
    chatsRepository.beginGenerationAttempt({
      snapshot: failedRun.snapshot,
      claim: retryClaim,
      claims: jobs.repository,
      now: NOW,
    });
    const retryContext = {
      ...failedRun.context,
      attempt: retryClaimed.attempt,
    };
    await failedRun.tools.registeredTools(retryContext);
    await failedRun.tools.execute({
      context: retryContext,
      call: {
        id: "read-retry-attempt-2",
        name: "read_studio_document",
        input: { doc_id: "doc-0" },
      },
      signal,
    });
    const retryCreated = await failedRun.tools.execute({
      context: retryContext,
      call: {
        id: "same-tool-call-after-retry",
        name: "suggest_studio_edit",
        input: {
          doc_id: "doc-0",
          start_offset: raceAccepted.document.content.length,
          end_offset: raceAccepted.document.content.length,
          exact_deleted: "",
          inserted_text: "Retry candidate\n",
          summary: "Retry creates a distinct immutable suggestion",
        },
      },
      signal,
    });
    const retrySuggestionId = String(
      (JSON.parse(retryCreated.content) as { suggestion?: { id?: unknown } })
        .suggestion?.id,
    );
    const retrySuggestion = adapter.getSuggestion(
      PROJECT_ID,
      raceAccepted.document.document.id,
      retrySuggestionId,
    );
    assert(retrySuggestion);
    assert.notEqual(retrySuggestion.id, failedRun.suggestion.id);
    assert.notEqual(retrySuggestion.changeId, failedRun.suggestion.changeId);
    jobs.repository.requestCancellation(
      retryClaimed.id,
      NOW,
      "Close retry audit.",
    );
    assert.equal(
      chatsRepository.commitGenerationCancellation({
        snapshot: failedRun.snapshot,
        claim: retryClaim,
        claims: jobs.repository,
        now: NOW,
      }),
      true,
    );
    assert.equal(
      adapter.getSuggestion(
        PROJECT_ID,
        raceAccepted.document.document.id,
        retrySuggestion.id,
      )?.status,
      "rejected",
    );

    const cancelledRun = await startSuggestionRun({
      title: "Cancellation closes pending suggestion",
      studio: raceAccepted.document,
      toolCallId: "cancelled-suggestion",
      insertedText: "Cancel candidate\n",
      leaseOwner: "suggestion-audit-cancel",
    });
    jobs.repository.requestCancellation(
      cancelledRun.generation.jobId,
      NOW,
      "Audit cancellation.",
    );
    assert.equal(
      chatsRepository.commitGenerationCancellation({
        snapshot: cancelledRun.snapshot,
        claim: cancelledRun.claim,
        claims: jobs.repository,
        now: NOW,
      }),
      true,
    );
    assert.equal(
      adapter.getSuggestion(
        PROJECT_ID,
        raceAccepted.document.document.id,
        cancelledRun.suggestion.id,
      )?.status,
      "rejected",
    );

    const recoveredRun = await startSuggestionRun({
      title: "Lease recovery closes attempt one suggestion",
      studio: raceAccepted.document,
      toolCallId: "same-tool-call-after-recovery",
      insertedText: "Recovered attempt one\n",
      leaseOwner: "suggestion-audit-recovery-1",
    });
    const recoveredJobs = jobs.repository.recoverStaleRunningJobs(AFTER_LEASE);
    assert.equal(
      recoveredJobs.find((job) => job.id === recoveredRun.generation.jobId)
        ?.status,
      "queued",
    );
    assert.equal(
      adapter.getSuggestion(
        PROJECT_ID,
        raceAccepted.document.document.id,
        recoveredRun.suggestion.id,
      )?.status,
      "rejected",
    );
    const recoveredClaimed = jobs.repository.claimNextQueuedForTypes(
      AFTER_LEASE,
      ["assistant_generate"],
      "suggestion-audit-recovery-2",
      "2099-07-15T17:00:00.000Z",
    );
    assert.equal(recoveredClaimed?.id, recoveredRun.generation.jobId);
    assert(recoveredClaimed);
    assert.equal(recoveredClaimed.attempt, 2);
    const recoveredClaim = {
      jobId: recoveredClaimed.id,
      leaseOwner: "suggestion-audit-recovery-2",
      attempt: recoveredClaimed.attempt,
      at: AFTER_LEASE,
    };
    chatsRepository.beginGenerationAttempt({
      snapshot: recoveredRun.snapshot,
      claim: recoveredClaim,
      claims: jobs.repository,
      now: AFTER_LEASE,
    });
    const recoveredContext = {
      ...recoveredRun.context,
      attempt: recoveredClaimed.attempt,
    };
    await recoveredRun.tools.registeredTools(recoveredContext);
    await recoveredRun.tools.execute({
      context: recoveredContext,
      call: {
        id: "read-recovery-attempt-2",
        name: "read_studio_document",
        input: { doc_id: "doc-0" },
      },
      signal,
    });
    const recoveredCreated = await recoveredRun.tools.execute({
      context: recoveredContext,
      call: {
        id: "same-tool-call-after-recovery",
        name: "suggest_studio_edit",
        input: {
          doc_id: "doc-0",
          start_offset: raceAccepted.document.content.length,
          end_offset: raceAccepted.document.content.length,
          exact_deleted: "",
          inserted_text: "Recovered attempt two\n",
          summary: "Recovered attempt creates a distinct suggestion",
        },
      },
      signal,
    });
    const recoveredSuggestionId = String(
      (
        JSON.parse(recoveredCreated.content) as {
          suggestion?: { id?: unknown };
        }
      ).suggestion?.id,
    );
    const recoveredSuggestion = adapter.getSuggestion(
      PROJECT_ID,
      raceAccepted.document.document.id,
      recoveredSuggestionId,
    );
    assert(recoveredSuggestion);
    assert.notEqual(
      recoveredSuggestion.changeId,
      recoveredRun.suggestion.changeId,
    );
    await assertApiFailure(
      () =>
        service.acceptSuggestion(
          PROJECT_ID,
          raceAccepted.document.document.id,
          recoveredRun.suggestion.id,
        ),
      409,
    );
    jobs.repository.requestCancellation(
      recoveredClaimed.id,
      AFTER_LEASE,
      "Close recovery audit.",
    );
    chatsRepository.commitGenerationCancellation({
      snapshot: recoveredRun.snapshot,
      claim: recoveredClaim,
      claims: jobs.repository,
      now: AFTER_LEASE,
    });

    const latest = raceAccepted.document;
    const deletedSource = await service.createSuggestionFromAssistantTool({
      projectId: PROJECT_ID,
      documentId: latest.document.id,
      baseVersionId: latest.version.id,
      messageId: generation.outputMessageId,
      jobId: generation.jobId,
      attempt: 1,
      toolCallId: "deleted-source",
      startOffset: latest.content.length,
      endOffset: latest.content.length,
      exactDeletedText: "",
      insertedText: "Must not apply\n",
      summary: "Deleted source must fail",
    });

    const emojiPrefix = `${"x".repeat(10)}😀${"y".repeat(239)}`;
    const emojiContent = `${emojiPrefix}old${"z".repeat(239)}😀tail`;
    const emojiDraft = await service.createDraft({
      projectId: PROJECT_ID,
      title: "Unicode scalar suggestion audit",
      content: emojiContent,
      source: "assistant_edit",
    });
    const emojiSuggestion = await service.createSuggestionFromAssistantTool({
      projectId: PROJECT_ID,
      documentId: emojiDraft.document.id,
      baseVersionId: emojiDraft.version.id,
      messageId: generation.outputMessageId,
      jobId: generation.jobId,
      attempt: 1,
      toolCallId: "emoji-context-boundary",
      startOffset: emojiPrefix.length,
      endOffset: emojiPrefix.length + 3,
      exactDeletedText: "old",
      insertedText: "new",
      summary: "Keep scalar-safe context boundaries",
    });
    assert.equal(emojiSuggestion.contextBefore, `😀${"y".repeat(239)}`);
    assert.equal(emojiSuggestion.contextAfter, `${"z".repeat(239)}😀`);
    await assertApiFailure(
      () =>
        service.createSuggestionFromAssistantTool({
          projectId: PROJECT_ID,
          documentId: emojiDraft.document.id,
          baseVersionId: emojiDraft.version.id,
          messageId: generation.outputMessageId,
          jobId: generation.jobId,
          attempt: 1,
          toolCallId: "split-surrogate-boundary",
          startOffset: 11,
          endOffset: 11,
          exactDeletedText: "",
          insertedText: "X",
          summary: "Must reject a split surrogate boundary",
        }),
      409,
    );
    const graphemeDraft = await service.createDraft({
      projectId: PROJECT_ID,
      title: "Unicode grapheme suggestion audit",
      content: "👩‍⚖️ e\u0301",
      source: "assistant_edit",
    });
    const zwjSuggestion = await service.createSuggestionFromAssistantTool({
      projectId: PROJECT_ID,
      documentId: graphemeDraft.document.id,
      baseVersionId: graphemeDraft.version.id,
      messageId: generation.outputMessageId,
      jobId: generation.jobId,
      attempt: 1,
      toolCallId: "zwj-scalar-boundary",
      startOffset: "👩".length,
      endOffset: "👩".length,
      exactDeletedText: "",
      insertedText: "X",
      summary: "ZWJ grapheme boundaries may remain scalar-safe",
    });
    assert.equal(zwjSuggestion.status, "pending");
    service.rejectSuggestion(
      PROJECT_ID,
      graphemeDraft.document.id,
      zwjSuggestion.id,
    );
    const combiningOffset = graphemeDraft.content.indexOf("\u0301");
    const combiningSuggestion = await service.createSuggestionFromAssistantTool(
      {
        projectId: PROJECT_ID,
        documentId: graphemeDraft.document.id,
        baseVersionId: graphemeDraft.version.id,
        messageId: generation.outputMessageId,
        jobId: generation.jobId,
        attempt: 1,
        toolCallId: "combining-scalar-boundary",
        startOffset: combiningOffset,
        endOffset: combiningOffset,
        exactDeletedText: "",
        insertedText: "X",
        summary: "Combining sequence boundaries may remain scalar-safe",
      },
    );
    assert.equal(combiningSuggestion.status, "pending");
    service.rejectSuggestion(
      PROJECT_ID,
      graphemeDraft.document.id,
      combiningSuggestion.id,
    );

    const capRun = await startSuggestionRun({
      title: "Bounded pending preview page",
      studio: latest,
      toolCallId: "pending-cap-first",
      insertedText: "cap first\n",
      leaseOwner: "suggestion-audit-cap",
    });
    chatsRepository.commitGenerationComplete({
      snapshot: capRun.snapshot,
      claim: capRun.claim,
      claims: jobs.repository,
      content: "Pending suggestions are ready for review.",
      sources: [],
      now: NOW,
    });
    let largeSuggestion: Awaited<
      ReturnType<
        WorkspaceDocumentStudioService["createSuggestionFromAssistantTool"]
      >
    > | null = null;
    for (let index = 0; index < 48; index += 1) {
      const created = await service.createSuggestionFromAssistantTool({
        projectId: PROJECT_ID,
        documentId: latest.document.id,
        baseVersionId: latest.version.id,
        messageId: capRun.generation.outputMessageId,
        jobId: capRun.generation.jobId,
        attempt: 1,
        toolCallId: `pending-cap-${index}`,
        startOffset: latest.content.length,
        endOffset: latest.content.length,
        exactDeletedText: "",
        insertedText: index === 0 ? "L".repeat(200_000) : `cap ${index}\n`,
        summary: `Pending cap ${index}`,
      });
      if (index === 0) largeSuggestion = created;
    }
    assert(largeSuggestion);
    const previewPage = adapter.listSuggestionPreviews(
      PROJECT_ID,
      latest.document.id,
    );
    assert.equal(previewPage.suggestions.length, 50);
    assert.equal(previewPage.hasMore, false);
    assert(
      Buffer.byteLength(JSON.stringify(previewPage), "utf8") < 150_000,
      "bounded preview projection must stay far below the 16 MiB client cap",
    );
    assert.equal(
      previewPage.suggestions.find(
        (suggestion) => suggestion.id === largeSuggestion?.id,
      )?.insertedTruncated,
      true,
    );
    const idempotentAtCap = await service.createSuggestionFromAssistantTool({
      projectId: PROJECT_ID,
      documentId: latest.document.id,
      baseVersionId: latest.version.id,
      messageId: capRun.generation.outputMessageId,
      jobId: capRun.generation.jobId,
      attempt: 1,
      toolCallId: "pending-cap-0",
      startOffset: latest.content.length,
      endOffset: latest.content.length,
      exactDeletedText: "",
      insertedText: "L".repeat(200_000),
      summary: "Pending cap 0",
    });
    assert.equal(idempotentAtCap.id, largeSuggestion.id);
    await assertApiFailure(
      () =>
        service.createSuggestionFromAssistantTool({
          projectId: PROJECT_ID,
          documentId: latest.document.id,
          baseVersionId: latest.version.id,
          messageId: capRun.generation.outputMessageId,
          jobId: capRun.generation.jobId,
          attempt: 1,
          toolCallId: "pending-cap-51",
          startOffset: latest.content.length,
          endOffset: latest.content.length,
          exactDeletedText: "",
          insertedText: "unreachable pending suggestion",
          summary: "Fifty-first pending suggestion must fail",
        }),
      409,
    );

    const restrictedText = "TOMBSTONED_DERIVED_PAYLOAD_SECRET";
    const restrictedSnapshot = sourceFoundation.createSnapshot({
      id: randomUUID(),
      projectId: PROJECT_ID,
      sourceKind: "legal_authority",
      sourceRecordId: "restricted-suggestion-authority",
      sourceVersionId: null,
      titleSnapshot: "Restricted suggestion authority",
      contentSha256: createHash("sha256")
        .update(restrictedText, "utf8")
        .digest("hex"),
      locator: { authorityIdentifier: "restricted-suggestion-authority" },
      retrievedAt: NOW,
      license: {
        basis: "user_provided",
        retention: "full_text_permitted",
        export: "permitted",
        modelUse: "permitted",
      },
      retentionPolicy: "full_text_permitted",
      retentionExpiresAt: null,
      retrievalMetadata: {},
      createdAt: NOW,
    });
    const restrictedAnchor = sourceFoundation.createCitationAnchor({
      id: randomUUID(),
      projectId: PROJECT_ID,
      snapshotId: restrictedSnapshot.id,
      ordinal: 0,
      exactQuote: restrictedText,
      locator: { section: "restricted" },
      createdAt: NOW,
    });
    const restrictedDraft = await service.createDraft({
      projectId: PROJECT_ID,
      title: "Restricted derived payload",
      content: `${restrictedText}\nold`,
      source: "assistant_edit",
      citationAnchorIds: [restrictedAnchor.id],
    });
    const restrictedSuggestion =
      await service.createSuggestionFromAssistantTool({
        projectId: PROJECT_ID,
        documentId: restrictedDraft.document.id,
        baseVersionId: restrictedDraft.version.id,
        messageId: capRun.generation.outputMessageId,
        jobId: capRun.generation.jobId,
        attempt: 1,
        toolCallId: "restricted-derived-payload",
        startOffset: restrictedDraft.content.length - 3,
        endOffset: restrictedDraft.content.length,
        exactDeletedText: "old",
        insertedText: "new",
        summary: "Restricted derived payload must not leak",
      });
    const guardChat = chats.create({
      projectId: PROJECT_ID,
      title: "Retention recheck before second model round",
      modelProfileId: PROFILE_ID,
    });
    const guardGeneration = chats.requestGeneration({
      chatId: guardChat.id,
      prompt: "Read the restricted Studio draft.",
      modelProfileId: PROFILE_ID,
      allowedDocumentIds: [restrictedDraft.document.id],
      attachmentDocumentIds: [restrictedDraft.document.id],
      retrievalLimit: 10,
    });
    const guardSnapshot = chatsRepository.generationSnapshot(
      guardGeneration.jobId,
    );
    const guardClaimed = jobs.repository.claimNextQueuedForTypes(
      NOW,
      ["assistant_generate"],
      "suggestion-audit-retention-recheck",
      LEASE_EXPIRES,
    );
    assert.equal(guardClaimed?.id, guardGeneration.jobId);
    assert(guardClaimed);
    const restrictedDocumentIndex = guardSnapshot.documents.findIndex(
      (document) => document.documentId === restrictedDraft.document.id,
    );
    assert.notEqual(restrictedDocumentIndex, -1);
    const restrictedDocumentLabel = `doc-${restrictedDocumentIndex}`;
    let modelCalls = 0;
    const guardModel: AssistantModelPort = {
      async registeredCapabilities() {
        return {
          adapterId: "suggestion-retention-audit-model",
          streaming: true,
          toolCalling: true,
        };
      },
      async runTurn() {
        modelCalls += 1;
        return {
          content: "",
          toolCalls: [
            {
              id: "read-before-tombstone",
              name: "read_studio_document",
              input: { doc_id: restrictedDocumentLabel },
            },
          ],
          sources: [],
        };
      },
    };
    const guardTools = new WorkspaceAssistantDocumentTools(
      database,
      chatsRepository,
      undefined,
      {
        studioSuggestions: service,
        assertModelUse: ({ projectId, documentId, versionId }) => {
          retention.assertStudioVersionAction({
            projectId,
            documentId,
            versionId,
            action: "model_use",
            modelExecution: "unknown",
          });
        },
      },
    );
    let tombstonedAfterRead = false;
    const guardedToolPort: AssistantToolPort = {
      assertModelUse: (context) => guardTools.assertModelUse(context),
      registeredTools: (context) => guardTools.registeredTools(context),
      execute: async (input) => {
        const result = await guardTools.execute(input);
        if (!tombstonedAfterRead) {
          retention.tombstoneLegalSnapshot({
            projectId: PROJECT_ID,
            snapshotId: restrictedSnapshot.id,
            reason: "manual_tombstone",
          });
          tombstonedAfterRead = true;
        }
        return result;
      },
    };
    const guardedRuntime = new AssistantRuntimeService(
      chatsRepository,
      jobs.repository,
      guardModel,
      { tools: guardedToolPort, clock: () => new Date(NOW) },
    );
    let guardedFailure: unknown = null;
    try {
      await guardedRuntime.execute({
        jobId: guardGeneration.jobId,
        leaseOwner: "suggestion-audit-retention-recheck",
        attempt: guardClaimed.attempt,
        signal,
      });
    } catch (error) {
      guardedFailure = error;
    }
    assert(
      guardedFailure,
      "retention tombstone must fail the guarded Assistant generation",
    );
    assert.equal(
      tombstonedAfterRead,
      true,
      `modelCalls=${modelCalls}; ${
        guardedFailure instanceof Error
          ? guardedFailure.stack
          : String(guardedFailure)
      }`,
    );
    assert.equal(modelCalls, 1, "tombstone must block the second model round");
    assert.equal(
      chats.generationStatus(guardGeneration.jobId).status,
      "failed",
    );
    await retentionSuggestionRouteAudit({
      port: {
        listStudioSuggestions: async () => {
          service.listSuggestionPreviews(
            PROJECT_ID,
            restrictedDraft.document.id,
          );
          return { suggestions: [], has_more: false };
        },
        getStudioSuggestion: async () => ({
          suggestion: service.getSuggestion(
            PROJECT_ID,
            restrictedDraft.document.id,
            restrictedSuggestion.id,
          ),
        }),
        rejectStudioSuggestion: async () => ({
          suggestion: service.rejectSuggestion(
            PROJECT_ID,
            restrictedDraft.document.id,
            restrictedSuggestion.id,
          ),
        }),
      } as unknown as WorkspaceDocumentStudioV1Port,
      projectId: PROJECT_ID,
      documentId: restrictedDraft.document.id,
      suggestionId: restrictedSuggestion.id,
      secretText: restrictedText,
    });
    const versionsBeforeSourceChatDelete = count(database, "document_versions");
    chatsRepository.delete(chat.id);
    assert.equal(
      adapter.getSuggestion(PROJECT_ID, latest.document.id, deletedSource.id)
        ?.messageId,
      null,
    );
    await assertApiFailure(
      () =>
        service.acceptSuggestion(
          PROJECT_ID,
          latest.document.id,
          deletedSource.id,
        ),
      409,
    );
    assert.equal(
      count(database, "document_versions"),
      versionsBeforeSourceChatDelete,
    );
    assert.equal(
      adapter.getSuggestion(PROJECT_ID, latest.document.id, deletedSource.id)
        ?.status,
      "rejected",
    );

    database.close();
    database = new WorkspaceDatabase(databasePath);
    const restartedSource = new WorkspaceSourceFoundationRepository(database);
    const restartedBlobRecords = new WorkspaceBlobRecordsRepository(database);
    const restartedRetention = new WorkspaceSourceRetentionService(
      new WorkspaceSourceRetentionLifecycleRepository(database),
      () => Date.parse(NOW),
    );
    const restartedAdapter = new WorkspaceDocumentStudioRepositoryAdapter(
      new WorkspaceDocumentStudioRepository(database, {
        blobRecords: restartedBlobRecords,
        now: () => NOW,
      }),
      restartedSource,
      restartedRetention,
      () => NOW,
    );
    const restarted = new WorkspaceDocumentStudioService(
      restartedAdapter,
      blobs,
      restartedBlobRecords,
      { cleanupRecorder: { record: () => undefined } },
    );
    const recovered = restarted.listSuggestions(PROJECT_ID, latest.document.id);
    assert(recovered.some((suggestion) => suggestion.status === "accepted"));
    assert(recovered.some((suggestion) => suggestion.status === "rejected"));
    assert(recovered.some((suggestion) => suggestion.status === "pending"));

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-document-studio-ai-suggestions-v14",
          checks: [
            "registered bounded raw Markdown read and pending-only suggestion tools",
            "raw_markdown_v1 UTF-16 exact range and server-derived context",
            "strict empty decision bodies and no public suggestion-create route",
            "incomplete and deleted durable Assistant sources fail closed",
            "DB rollback plus prepared-blob compensation keeps suggestion pending",
            "blob put failure creates neither version nor accepted state",
            "single-transaction user_accept version and accepted resolution",
            "citation inheritance, stale/cross-Project/resolved rejection",
            "reject changes only suggestion status",
            "restart-safe pending/accepted/rejected history",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
