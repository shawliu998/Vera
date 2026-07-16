import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { toMikeChatDetail } from "../lib/workspace/assistantCompatibility";
import type {
  BlobIntegrity,
  BlobStore,
  StoredWorkspaceBlob,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { WorkspaceDocumentStudioRepository } from "../lib/workspace/repositories/documentStudio";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceSourceFoundationRepository } from "../lib/workspace/repositories/sourceFoundation";
import { WorkspaceSourceRetentionLifecycleRepository } from "../lib/workspace/repositories/sourceRetentionLifecycle";
import { WorkspaceAssistantDraftToolModule } from "../lib/workspace/services/assistantDraftTools";
import { WorkspaceAssistantActionLedger } from "../lib/workspace/services/assistantActionLedger";
import type {
  AssistantModelToolCall,
  AssistantToolContext,
} from "../lib/workspace/services/assistantRuntime";
import { ChatsService } from "../lib/workspace/services/chats";
import { WorkspaceDocumentStudioService } from "../lib/workspace/services/documentStudio";
import { WorkspaceDocumentStudioRepositoryAdapter } from "../lib/workspace/services/documentStudioRepositoryAdapter";
import { WorkspaceJobsService } from "../lib/workspace/services/jobs";
import { WorkspaceSourceRetentionService } from "../lib/workspace/services/sourceRetention";

const NOW = "2099-07-16T08:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";

function blobKey(locator: WorkspaceBlobLocator) {
  return JSON.stringify(locator);
}

class MemoryBlobStore implements BlobStore {
  private readonly stored = new Map<string, Buffer>();
  private readonly staged = new Map<
    string,
    { locator: WorkspaceBlobLocator; value: Buffer }
  >();

  putSync(
    locator: WorkspaceBlobLocator,
    plaintext: Buffer | string,
  ): StoredWorkspaceBlob {
    const value = Buffer.isBuffer(plaintext)
      ? Buffer.from(plaintext)
      : Buffer.from(plaintext, "utf8");
    this.stored.set(blobKey(locator), value);
    return {
      locator,
      sha256: createHash("sha256").update(value).digest("hex"),
      size: value.byteLength,
      storedSize: value.byteLength,
    };
  }

  readSync(locator: WorkspaceBlobLocator, expected: BlobIntegrity): Buffer {
    const value = this.stored.get(blobKey(locator));
    if (!value) throw new Error("Audit blob is missing.");
    assert.equal(value.byteLength, expected.size);
    assert.equal(
      createHash("sha256").update(value).digest("hex"),
      expected.sha256,
    );
    return Buffer.from(value);
  }

  stageDeleteSync(locator: WorkspaceBlobLocator): WorkspaceBlobDeleteReceipt {
    const key = blobKey(locator);
    const value = this.stored.get(key);
    if (!value) throw new Error("Audit blob is missing for deletion.");
    const quarantineId = randomUUID();
    this.stored.delete(key);
    this.staged.set(quarantineId, { locator, value });
    return { status: "staged", locator, quarantineId };
  }

  finalizeDeleteSync(receipt: WorkspaceBlobDeleteReceipt): void {
    if (!this.staged.delete(receipt.quarantineId)) {
      throw new Error("Audit staged blob is missing.");
    }
  }

  restoreDeleteSync(receipt: WorkspaceBlobDeleteReceipt): void {
    const staged = this.staged.get(receipt.quarantineId);
    if (!staged) throw new Error("Audit staged blob is missing.");
    this.stored.set(blobKey(staged.locator), staged.value);
    this.staged.delete(receipt.quarantineId);
  }
}

function seedReadyLocalProfile(database: WorkspaceDatabase) {
  const profiles = new ModelProfilesRepository(database);
  profiles.create({
    id: PROFILE_ID,
    name: "Draft tool audit model",
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
    new ModelConnectionTestsRepository(database).storeIfCurrent({
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
  return profiles;
}

function toolCall(
  name: AssistantModelToolCall["name"],
  input: Record<string, unknown>,
) {
  return { id: randomUUID(), name, input } as const;
}

function parseResult(result: { content: string }) {
  return JSON.parse(result.content) as Record<string, unknown>;
}

async function rejects(operation: () => Promise<unknown>) {
  await assert.rejects(operation);
}

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-draft-tools-"));
  let database: WorkspaceDatabase | null = null;
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    database = new WorkspaceDatabase(path.join(root, "workspace.sqlite"));
    assert.equal(database.migration?.currentVersion, 21);

    const projects = new ProjectsRepository(database);
    projects.create({
      id: PROJECT_ID,
      name: "Draft tool Matter",
      description: null,
      cmNumber: null,
      practice: null,
      now: NOW,
    });
    projects.create({
      id: FOREIGN_PROJECT_ID,
      name: "Foreign Matter",
      description: null,
      cmNumber: null,
      practice: null,
      now: NOW,
    });
    const profiles = seedReadyLocalProfile(database);
    const sources = new WorkspaceSourceFoundationRepository(database);
    const blobRecords = new WorkspaceBlobRecordsRepository(database);
    const studioRepository = new WorkspaceDocumentStudioRepository(database, {
      blobRecords,
      now: () => NOW,
    });
    const retention = new WorkspaceSourceRetentionService(
      new WorkspaceSourceRetentionLifecycleRepository(database),
      () => Date.parse(NOW),
    );
    const studio = new WorkspaceDocumentStudioService(
      new WorkspaceDocumentStudioRepositoryAdapter(
        studioRepository,
        sources,
        retention,
        () => NOW,
      ),
      new MemoryBlobStore(),
      blobRecords,
      { cleanupRecorder: { record: () => undefined } },
    );

    const sourceContent = "Article 1 provides the exact audit authority.";
    const sourceDraft = await studio.createDraft({
      projectId: PROJECT_ID,
      title: "Current run source",
      content: sourceContent,
    });
    const sourceSnapshot = sources.createSnapshot({
      id: randomUUID(),
      projectId: PROJECT_ID,
      sourceKind: "project_document",
      sourceRecordId: sourceDraft.document.id,
      sourceVersionId: sourceDraft.version.id,
      titleSnapshot: sourceDraft.document.title,
      contentSha256: sourceDraft.version.contentSha256,
      locator: {
        documentId: sourceDraft.document.id,
        documentVersionId: sourceDraft.version.id,
      },
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
    const sourceAnchor = sources.createCitationAnchor({
      id: randomUUID(),
      projectId: PROJECT_ID,
      snapshotId: sourceSnapshot.id,
      ordinal: 0,
      exactQuote: "exact audit authority",
      locator: { startOffset: 23, endOffset: 44 },
      createdAt: NOW,
    });
    const foreignSource = sources.createSnapshot({
      ...sourceSnapshot,
      id: randomUUID(),
      projectId: FOREIGN_PROJECT_ID,
      sourceRecordId: "foreign-authority",
      sourceVersionId: null,
      sourceKind: "legal_authority",
      contentSha256: createHash("sha256")
        .update("foreign authority", "utf8")
        .digest("hex"),
      locator: { authorityId: "foreign-authority" },
    });

    const jobsRepository = new WorkspaceJobsRepository(database);
    const jobs = new WorkspaceJobsService(jobsRepository);
    const chatsRepository = new ChatsRepository(database);
    const chats = new ChatsService(
      chatsRepository,
      projects,
      profiles,
      () => new Date(NOW),
      {
        jobs,
        generationControl: jobs,
        inferencePolicy: new WorkspaceInferencePolicy(database),
        capabilities: {
          hydrate: () => ({ can_read: true, can_download: true }),
        },
      },
    );
    const chat = chats.create({
      projectId: PROJECT_ID,
      title: "Draft tool audit chat",
      modelProfileId: PROFILE_ID,
    });
    const generation = chats.requestGeneration({
      chatId: chat.id,
      prompt: "Create and then revise a legal Draft.",
      modelProfileId: PROFILE_ID,
      allowedDocumentIds: [sourceDraft.document.id],
      attachmentDocumentIds: [sourceDraft.document.id],
      retrievalLimit: 10,
    });
    const snapshot = chatsRepository.generationSnapshot(generation.jobId);
    const claim = jobsRepository.claimNextQueuedForTypes(
      NOW,
      ["assistant_generate"],
      "draft-tools-audit-worker",
      "2099-07-16T08:10:00.000Z",
    );
    assert.equal(claim?.id, generation.jobId);
    const claimIdentity = {
      jobId: generation.jobId,
      leaseOwner: "draft-tools-audit-worker",
      attempt: claim!.attempt,
      at: NOW,
    };
    chatsRepository.beginGenerationAttempt({
      snapshot,
      claim: claimIdentity,
      claims: jobsRepository,
      now: NOW,
    });
    const context: AssistantToolContext = {
      jobId: snapshot.jobId,
      attempt: claim!.attempt,
      leaseOwner: "draft-tools-audit-worker",
      chatId: snapshot.chatId,
      projectId: snapshot.payload.projectId,
      modelProfileId: snapshot.modelProfileId,
      documents: snapshot.documents,
      evidence: [
        {
          chunkId: sourceAnchor.id,
          documentId: sourceDraft.document.id,
          versionId: sourceDraft.version.id,
          filename: sourceDraft.document.filename,
          ordinal: 0,
          text: sourceContent,
          startOffset: 0,
          endOffset: sourceContent.length,
          pageStart: null,
          pageEnd: null,
          score: 1,
        },
      ],
    };
    const module = new WorkspaceAssistantDraftToolModule(
      database,
      chatsRepository,
      studio,
      (projectId, content, evidence) => {
        assert.equal(projectId, PROJECT_ID);
        assert.match(content, /\[1\]/);
        assert.equal(evidence[0]?.chunkId, sourceAnchor.id);
        assert.equal(evidence[0]?.quote, "exact audit authority");
        return [sourceAnchor.id];
      },
      new WorkspaceAssistantActionLedger(database, () => new Date(NOW)),
    );
    const definitions = await module.registeredTools(context);
    assert.deepEqual(
      definitions.map((tool) => tool.name),
      ["create_draft", "read_draft", "suggest_draft_edit"],
    );
    assert.equal(
      definitions.some((tool) => tool.name.includes("accept")),
      false,
    );

    const beforeInvalidCreate = Number(
      database.prepare("SELECT count(*) AS total FROM documents").get()?.total,
    );
    await rejects(() =>
      module.execute({
        context,
        call: toolCall("create_draft", {
          title: "Unsafe overwrite attempt",
          documentType: "legal_opinion",
          contentMarkdown: "Unsafe",
          localPath: "/tmp/overwrite.md",
        }),
        signal: new AbortController().signal,
      }),
    );
    assert.equal(
      Number(
        database.prepare("SELECT count(*) AS total FROM documents").get()
          ?.total,
      ),
      beforeInvalidCreate,
    );
    await rejects(() =>
      module.execute({
        context,
        call: toolCall("create_draft", {
          title: "Foreign source attempt",
          documentType: "legal_opinion",
          contentMarkdown: "Unsafe",
          sourceSnapshotIds: [foreignSource.id],
        }),
        signal: new AbortController().signal,
      }),
    );

    const createdExecution = await module.execute({
      context,
      call: toolCall("create_draft", {
        title: "Assistant legal opinion",
        documentType: "legal_opinion",
        contentMarkdown: "Hello old world [1].\n",
        evidenceSources: [
          {
            evidenceId: sourceAnchor.id,
            exactQuote: "exact audit authority",
          },
        ],
      }),
      signal: new AbortController().signal,
    });
    const createdResult = parseResult(createdExecution);
    const draftId = String(createdResult.draftId);
    const versionId = String(createdResult.versionId);
    assert.equal(createdResult.title, "Assistant legal opinion");
    assert.equal(
      createdResult.route,
      `/projects/${PROJECT_ID}/documents/${draftId}/studio`,
    );
    assert.deepEqual(createdExecution.events, [
      {
        type: "draft_created",
        draft_id: draftId,
        version_id: versionId,
        title: "Assistant legal opinion",
        route: `/projects/${PROJECT_ID}/documents/${draftId}/studio`,
      },
    ]);
    chatsRepository.appendGenerationEvent({
      snapshot,
      claim: claimIdentity,
      claims: jobsRepository,
      event: createdExecution.events![0]!,
      now: NOW,
    });
    const createdDraft = await studio.getDocument(PROJECT_ID, draftId);
    assert.equal(createdDraft.version.id, versionId);
    assert.deepEqual(createdDraft.version.citationAnchorIds, [sourceAnchor.id]);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT document_type,origin_type,origin_ref
               FROM document_studio_draft_metadata WHERE document_id=?`,
          )
          .get(draftId),
      },
      {
        document_type: "legal_opinion",
        origin_type: "assistant",
        origin_ref: snapshot.outputMessageId,
      },
    );
    database
      .prepare("DELETE FROM document_studio_draft_metadata WHERE document_id=?")
      .run(draftId);
    database
      .prepare("UPDATE documents SET title='collision' WHERE id=?")
      .run(draftId);
    await rejects(() =>
      module.execute({
        context,
        call: toolCall("create_draft", {
          title: "Assistant legal opinion",
          documentType: "legal_opinion",
          contentMarkdown: "Hello old world [1].\n",
          evidenceSources: [
            {
              evidenceId: sourceAnchor.id,
              exactQuote: "exact audit authority",
            },
          ],
        }),
        signal: new AbortController().signal,
      }),
    );
    assert.equal(
      Number(
        database
          .prepare(
            "SELECT count(*) AS total FROM document_studio_draft_metadata WHERE document_id=?",
          )
          .get(draftId)?.total,
      ),
      0,
      "a mismatched v19 Draft must not receive repaired provenance",
    );
    database
      .prepare("UPDATE documents SET title=? WHERE id=?")
      .run("Assistant legal opinion", draftId);
    const replayedCreate = parseResult(
      await module.execute({
        context,
        call: toolCall("create_draft", {
          title: "Assistant legal opinion",
          documentType: "legal_opinion",
          contentMarkdown: "Hello old world [1].\n",
          evidenceSources: [
            {
              evidenceId: sourceAnchor.id,
              exactQuote: "exact audit authority",
            },
          ],
        }),
        signal: new AbortController().signal,
      }),
    );
    assert.equal(replayedCreate.draftId, draftId);
    assert.equal(replayedCreate.versionId, versionId);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT document_type,origin_type,origin_ref
               FROM document_studio_draft_metadata WHERE document_id=?`,
          )
          .get(draftId),
      },
      {
        document_type: "legal_opinion",
        origin_type: "assistant",
        origin_ref: snapshot.outputMessageId,
      },
      "an exact v19 create_draft retry rebinds typed v20 provenance",
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT action_type,status,resource_type,resource_id
             FROM assistant_action_ledger
            WHERE job_id=? ORDER BY action_type,action_key`,
        )
        .all(context.jobId)
        .map((row) => ({ ...row })),
      [
        {
          action_type: "create_draft",
          status: "complete",
          resource_type: "draft",
          resource_id: draftId,
        },
      ],
    );

    await rejects(() =>
      module.execute({
        context,
        call: toolCall("suggest_draft_edit", {
          draftId,
          revision: versionId,
          startOffset: 6,
          endOffset: 9,
          exactDeletedText: "old",
          insertedText: "new",
          summary: "Replace old with new",
        }),
        signal: new AbortController().signal,
      }),
    );

    const read = parseResult(
      await module.execute({
        context,
        call: toolCall("read_draft", {
          draftId,
          startOffset: 6,
          maxChars: 3,
        }),
        signal: new AbortController().signal,
      }),
    );
    assert.equal(read.revision, versionId);
    assert.deepEqual(read.range, {
      startOffset: 6,
      endOffset: 9,
      text: "old",
      complete: false,
    });
    await rejects(() =>
      module.execute({
        context,
        call: toolCall("suggest_draft_edit", {
          draftId,
          revision: versionId,
          startOffset: 6,
          endOffset: 9,
          exactDeletedText: "OLD",
          insertedText: "new",
          summary: "Mismatched exact text",
        }),
        signal: new AbortController().signal,
      }),
    );

    const suggestion = parseResult(
      await module.execute({
        context,
        call: toolCall("suggest_draft_edit", {
          draftId,
          revision: versionId,
          startOffset: 6,
          endOffset: 9,
          exactDeletedText: "old",
          insertedText: "new",
          summary: "Replace old with new",
        }),
        signal: new AbortController().signal,
      }),
    );
    assert.equal(suggestion.status, "pending");
    assert.equal(suggestion.requiresExplicitUserAcceptance, true);
    assert.equal(suggestion.documentContentChanged, false);
    assert.equal(
      Number(
        database
          .prepare(
            `SELECT count(*) AS total FROM assistant_action_ledger
              WHERE job_id=? AND action_type='suggest_draft_edit'
                AND status='complete'`,
          )
          .get(context.jobId)?.total,
      ),
      1,
    );
    assert.equal(
      (await studio.getDocument(PROJECT_ID, draftId)).content,
      "Hello old world [1].\n",
    );

    const durableSuggestion = studio.getSuggestion(
      PROJECT_ID,
      draftId,
      String(suggestion.suggestionId),
    );
    const corruptedSuggestionModule = new WorkspaceAssistantDraftToolModule(
      database,
      chatsRepository,
      {
        createDraft: studio.createDraft.bind(studio),
        getDocument: studio.getDocument.bind(studio),
        getSuggestion: (
          projectId: string,
          documentId: string,
          suggestionId: string,
        ) => ({
          ...studio.getSuggestion(projectId, documentId, suggestionId),
          summary: "Corrupted durable summary",
        }),
        createSuggestionFromAssistantTool:
          studio.createSuggestionFromAssistantTool.bind(studio),
      },
      () => [],
      new WorkspaceAssistantActionLedger(database, () => new Date(NOW)),
    );
    await corruptedSuggestionModule.registeredTools(context);
    await corruptedSuggestionModule.execute({
      context,
      call: toolCall("read_draft", {
        draftId,
        startOffset: 6,
        maxChars: 3,
      }),
      signal: new AbortController().signal,
    });
    await assert.rejects(
      corruptedSuggestionModule.execute({
        context,
        call: toolCall("suggest_draft_edit", {
          draftId,
          revision: versionId,
          startOffset: 6,
          endOffset: 9,
          exactDeletedText: "old",
          insertedText: "new",
          summary: "Replace old with new",
        }),
        signal: new AbortController().signal,
      }),
      /does not match the reserved Assistant action/i,
    );
    assert.equal(durableSuggestion.summary, "Replace old with new");

    const changed = await studio.save({
      projectId: PROJECT_ID,
      documentId: draftId,
      expectedVersionId: versionId,
      content: "Hello independently changed world.\n",
      source: "user_upload",
      citationAnchorIds: [sourceAnchor.id],
    });
    assert.notEqual(changed.version.id, versionId);
    await rejects(() =>
      module.execute({
        context,
        call: toolCall("suggest_draft_edit", {
          draftId,
          revision: versionId,
          startOffset: 6,
          endOffset: 9,
          exactDeletedText: "old",
          insertedText: "newer",
          summary: "Stale revision must fail",
        }),
        signal: new AbortController().signal,
      }),
    );

    const foreignDraft = await studio.createDraft({
      projectId: FOREIGN_PROJECT_ID,
      title: "Foreign Draft",
      content: "Foreign content",
    });
    await rejects(() =>
      module.execute({
        context,
        call: toolCall("read_draft", { draftId: foreignDraft.document.id }),
        signal: new AbortController().signal,
      }),
    );

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () =>
        module.execute({
          context,
          call: toolCall("read_draft", { draftId }),
          signal: aborted.signal,
        }),
      (error) => error instanceof Error && error.name === "AbortError",
    );

    chatsRepository.commitGenerationComplete({
      snapshot,
      claim: claimIdentity,
      claims: jobsRepository,
      content: "Draft created and edit suggested.",
      sources: [],
      now: NOW,
    });
    const completedMikeDetail = toMikeChatDetail(chats.detail(chat.id));
    const completedOutput = completedMikeDetail.messages.find(
      (message) => message.id === snapshot.outputMessageId,
    );
    assert.deepEqual(completedOutput?.events, createdExecution.events);
    assert.equal(jobsRepository.getJob(generation.jobId)?.status, "complete");

    console.log(
      JSON.stringify({
        ok: true,
        suite: "vera-workspace-assistant-draft-tools-v1",
        tools: definitions.map((tool) => tool.name),
        createIsNewOnly: true,
        sourceScopeRebuilt: true,
        exactReadRequired: true,
        staleRevisionRejected: true,
        userAcceptanceRequired: true,
        completedDraftEventRestored: true,
      }),
    );
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
