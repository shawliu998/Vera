import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mammoth from "mammoth";

import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { exportDocumentStudioMarkdownToDocx } from "../lib/workspace/documentStudioDocx";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { WorkspaceDocumentStudioRepository } from "../lib/workspace/repositories/documentStudio";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceSourceFoundationRepository } from "../lib/workspace/repositories/sourceFoundation";
import { WorkspaceSourceRetentionLifecycleRepository } from "../lib/workspace/repositories/sourceRetentionLifecycle";
import { WorkspaceAssistantLegalResearchToolModule } from "../lib/workspace/services/assistantLegalResearchTools";
import {
  AssistantRuntimeService,
  type AssistantModelPort,
} from "../lib/workspace/services/assistantRuntime";
import { WorkspaceAssistantToolRegistry } from "../lib/workspace/services/assistantToolRegistry";
import { ChatsService } from "../lib/workspace/services/chats";
import { WorkspaceDocumentStudioService } from "../lib/workspace/services/documentStudio";
import { WorkspaceDocumentStudioRepositoryAdapter } from "../lib/workspace/services/documentStudioRepositoryAdapter";
import { WorkspaceJobsService } from "../lib/workspace/services/jobs";
import {
  BoundedInMemoryLegalResearchSessionOwnership,
  WorkspaceLegalResearchTools,
  type LegalResearchSourceCapturePort,
} from "../lib/workspace/services/legalResearchTools";
import { WorkspaceLegalResearchProviderRegistry } from "../lib/workspace/services/legalResearchProvider";
import { WorkspaceSourceRetentionService } from "../lib/workspace/services/sourceRetention";
import {
  createDeterministicFakeLegalResearchProvider,
  DETERMINISTIC_FAKE_LEGAL_RESEARCH_PROVIDER_ID,
} from "../lib/workspace/services/testing/deterministicFakeLegalResearchProvider";

const NOW = "2099-07-16T08:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const WORKER = "legal-vertical-boundary-audit";
const AUTHORITY_QUOTE =
  "Article 1. A deterministic legal-source fixture exists only for automated contract tests.";

/**
 * This is deliberately a boundary audit, not a claim that production legal
 * research is live. The test-only provider can be registered only through
 * WorkspaceLegalResearchProviderRegistry.forTesting(). The current production
 * gap is intentionally asserted below:
 *
 * 1. introduce a durable legal-authority evidence union alongside document
 *    retrieval chunks (snapshotId + anchorId, never provider payload identity);
 * 2. teach AssistantRuntime source validation/writes to bind that union to the
 *    immutable project_source_snapshots/source_citation_anchors rows;
 * 3. let create_draft rebuild citations from those durable authority anchors;
 * 4. construct the legal module in WorkspaceRuntime only from an activated,
 *    policy-authorized production provider (the deterministic fake stays test-only).
 */
class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(input: Parameters<WorkspaceBlobCodec["encode"]>[0]) {
    return Buffer.from(input.plaintext);
  }
  decode(input: Parameters<WorkspaceBlobCodec["decode"]>[0]) {
    return Buffer.from(input.envelope);
  }
}

function seedReadyProfile(database: WorkspaceDatabase) {
  const profiles = new ModelProfilesRepository(database);
  profiles.create({
    id: PROFILE_ID,
    name: "Legal vertical boundary model",
    provider: "openai",
    model: "boundary-model",
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

function seedCompleteSuggestionOrigin(
  database: WorkspaceDatabase,
  projectId: string,
) {
  const profileId = randomUUID();
  const chatId = randomUUID();
  const jobId = randomUUID();
  const promptMessageId = randomUUID();
  const outputMessageId = randomUUID();
  database
    .prepare(
      `INSERT INTO model_profiles (
         id,name,provider,model,capabilities_json,settings_json,enabled,
         created_at,updated_at
       ) VALUES (?,?,'openai',?,'{}','{}',1,?,?)`,
    )
    .run(profileId, `Boundary downstream ${profileId}`, "test-model", NOW, NOW);
  database
    .prepare(
      `INSERT INTO chats (
         id,project_id,scope,title,status,model_profile_id,created_at,updated_at
       ) VALUES (?,?,'project','Boundary downstream','active',?,?,?)`,
    )
    .run(chatId, projectId, profileId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO jobs (
         id,type,status,resource_type,resource_id,payload_json,
         created_at,updated_at
       ) VALUES (?,'assistant_generate','queued','chat',?,?,?,?)`,
    )
    .run(
      jobId,
      chatId,
      JSON.stringify({
        schema: "vera-assistant-generation-v1",
        chatId,
        projectId,
        promptMessageId,
        outputMessageId,
        modelProfileId: profileId,
        documents: [],
        retrieval: { currentVersionOnly: true, limit: 40 },
      }),
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO chat_messages (
         id,chat_id,sequence,role,content,status,model_profile_id,job_id,
         created_at,updated_at,completed_at
       ) VALUES (?,?,0,'user','Review the Draft.','complete',NULL,NULL,?,?,?),
                (?,?,1,'assistant','','pending',?,?, ?,?,NULL)`,
    )
    .run(
      promptMessageId,
      chatId,
      NOW,
      NOW,
      NOW,
      outputMessageId,
      chatId,
      profileId,
      jobId,
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO assistant_generation_snapshots (
         job_id,chat_id,prompt_message_id,output_message_id,model_profile_id,
         current_version_only,retrieval_limit,created_at
       ) VALUES (?,?,?,?,?,1,40,?)`,
    )
    .run(jobId, chatId, promptMessageId, outputMessageId, profileId, NOW);
  database
    .prepare(
      `UPDATE jobs
          SET status='complete',attempt=1,updated_at=?,completed_at=?
        WHERE id=?`,
    )
    .run(NOW, NOW, jobId);
  database
    .prepare(
      `UPDATE chat_messages
          SET content='Suggested exact edit.',status='complete',updated_at=?,completed_at=?
        WHERE id=?`,
    )
    .run(NOW, NOW, outputMessageId);
  return { jobId, outputMessageId };
}

function boundaryModel(): AssistantModelPort {
  return {
    async registeredCapabilities() {
      return {
        adapterId: "legal-vertical-boundary-model",
        streaming: true,
        toolCalling: true,
        reasoning: false,
      };
    },
    async runTurn(input) {
      const toolMessages = input.messages.filter(
        (message) => message.role === "tool",
      );
      if (toolMessages.length === 0) {
        return {
          content: "",
          sources: [],
          toolCalls: [
            {
              id: "search-authority",
              name: "search_legal_sources",
              input: { query: "deterministic", limit: 1 },
            },
          ],
        };
      }
      if (toolMessages.length === 1) {
        const search = JSON.parse(toolMessages[0]!.content) as {
          results: Array<{ sourceRef: string }>;
        };
        assert.equal(search.results.length, 1);
        return {
          content: "",
          sources: [],
          toolCalls: [
            {
              id: "read-authority",
              name: "read_legal_source",
              input: { sourceRef: search.results[0]!.sourceRef },
            },
          ],
        };
      }
      const read = JSON.parse(toolMessages[1]!.content) as {
        durable: boolean;
        snapshotId: string;
        excerpts: Array<{ anchorCandidateId: string; text: string }>;
      };
      assert.equal(read.durable, true);
      assert.equal(read.excerpts[0]?.text, AUTHORITY_QUOTE);
      const content = "测试法源支持该测试结论[1]。";
      await input.onTextDelta(content);
      // There is no legal-authority variant in AssistantModelSourceSchema, so
      // the honest model cannot attach the captured snapshot/anchor here.
      return { content, sources: [], toolCalls: [] };
    },
  };
}

async function run() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "vera-legal-vertical-boundary-"),
  );
  const databasePath = path.join(root, "workspace.sqlite");
  const blobRoot = path.join(root, "blobs");
  let database: WorkspaceDatabase | null = null;
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    database = new WorkspaceDatabase(databasePath);
    const projects = new ProjectsRepository(database);
    projects.create({
      id: PROJECT_ID,
      name: "Legal vertical boundary Matter",
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
    const profiles = seedReadyProfile(database);
    const sources = new WorkspaceSourceFoundationRepository(database);
    let capturedSnapshotId: string | null = null;
    let capturedAnchorId: string | null = null;
    const capture: LegalResearchSourceCapturePort = {
      async capture(input) {
        assert.equal(input.context.projectId, PROJECT_ID);
        assert.equal(input.document.content, AUTHORITY_QUOTE);
        const snapshot = sources.createSnapshot({
          id: randomUUID(),
          projectId: PROJECT_ID,
          sourceKind: "legal_authority",
          sourceRecordId: input.document.providerSourceId,
          sourceVersionId: input.document.sourceVersionId,
          titleSnapshot: input.document.title,
          contentSha256: input.document.contentSha256,
          locator: input.document.locator,
          retrievedAt: input.document.retrievedAt,
          license: input.dataUsePolicy,
          retentionPolicy: input.dataUsePolicy.retention,
          retentionExpiresAt: input.document.retentionExpiresAt,
          retrievalMetadata: {
            provider: input.providerId,
            testOnly: true,
          },
          createdAt: NOW,
        });
        const anchor = sources.createCitationAnchor({
          id: randomUUID(),
          projectId: PROJECT_ID,
          snapshotId: snapshot.id,
          ordinal: 0,
          exactQuote: input.document.content,
          locator: input.document.locator,
          createdAt: NOW,
        });
        capturedSnapshotId = snapshot.id;
        capturedAnchorId = anchor.id;
        return {
          snapshotId: snapshot.id,
          excerpts: [
            {
              anchorCandidateId: anchor.id,
              text: anchor.exactQuote,
              locator: input.document.locator,
            },
          ],
        };
      },
    };
    const fake = createDeterministicFakeLegalResearchProvider({
      testingOnly: true,
    });
    assert.equal(fake.id, DETERMINISTIC_FAKE_LEGAL_RESEARCH_PROVIDER_ID);
    assert.equal(fake.runtime, "test");
    assert.throws(
      () => WorkspaceLegalResearchProviderRegistry.production([fake]),
      /explicit test registry/i,
    );
    const research = new WorkspaceLegalResearchTools(
      fake.id,
      WorkspaceLegalResearchProviderRegistry.forTesting([fake]),
      new BoundedInMemoryLegalResearchSessionOwnership(),
      capture,
    );

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
      title: "Legal research boundary",
      modelProfileId: PROFILE_ID,
    });
    const generation = chats.requestGeneration({
      chatId: chat.id,
      prompt:
        "Research the deterministic authority and answer with a citation.",
      modelProfileId: PROFILE_ID,
      allowedDocumentIds: [],
      attachmentDocumentIds: [],
      retrievalLimit: 10,
    });
    const claimed = jobsRepository.claimNextQueuedForTypes(
      NOW,
      ["assistant_generate"],
      WORKER,
      "2099-07-16T08:10:00.000Z",
    );
    assert.equal(claimed?.id, generation.jobId);
    const module = new WorkspaceAssistantLegalResearchToolModule(research, {
      get: (projectId) =>
        projectId === PROJECT_ID
          ? {
              projectId,
              externalEgressMode: "allowed_by_policy",
              executionLocations: ["standard_remote"],
              allowExternalLegalSources: true,
              allowWordBridge: false,
              createdAt: NOW,
              updatedAt: NOW,
            }
          : null,
    });
    const runtime = new AssistantRuntimeService(
      chatsRepository,
      jobsRepository,
      boundaryModel(),
      {
        clock: () => new Date(NOW),
        tools: new WorkspaceAssistantToolRegistry([module]),
      },
    );
    await assert.rejects(
      runtime.execute({
        jobId: generation.jobId,
        leaseOwner: WORKER,
        attempt: claimed!.attempt,
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert(error instanceof WorkspaceApiError);
        assert.equal(error.code, "JOB_FAILED");
        assert.equal(
          error.message,
          "Assistant citation markers and source references must be unique, continuous, and bidirectionally consistent.",
        );
        return true;
      },
    );
    assert.ok(capturedSnapshotId);
    assert.ok(capturedAnchorId);
    assert.equal(
      Number(
        database
          .prepare(
            "SELECT count(*) AS total FROM message_sources WHERE message_id=?",
          )
          .get(generation.outputMessageId)?.total,
      ),
      0,
      "failed legal citation binding must not persist forged message sources",
    );
    assert.equal(
      database
        .prepare("SELECT status FROM chat_messages WHERE id=?")
        .get(generation.outputMessageId)?.status,
      "failed",
      "citation binding failure must durably fail the output message",
    );
    assert.equal(jobsRepository.getJob(generation.jobId)?.status, "failed");
    assert.equal(
      Number(
        database
          .prepare(
            "SELECT count(*) AS total FROM documents WHERE project_id=? AND document_kind='draft'",
          )
          .get(PROJECT_ID)?.total,
      ),
      0,
      "the failed Assistant boundary must not create a Draft",
    );
    assert.equal(
      sources.getSnapshot(FOREIGN_PROJECT_ID, capturedSnapshotId!),
      null,
    );
    assert.equal(
      sources.getCitationAnchor(FOREIGN_PROJECT_ID, capturedAnchorId!),
      null,
    );

    // Downstream reuse proof starts at the explicit durable-authority boundary.
    // It does not erase the expected-fail Assistant citation gap above.
    const blobRecords = new WorkspaceBlobRecordsRepository(database);
    const blobs = new LocalWorkspaceBlobStore({
      root: blobRoot,
      codec: new IdentityCodec(),
      allowUnencryptedCodec: true,
    });
    const retention = new WorkspaceSourceRetentionService(
      new WorkspaceSourceRetentionLifecycleRepository(database),
      () => Date.parse(NOW),
    );
    const studio = new WorkspaceDocumentStudioService(
      new WorkspaceDocumentStudioRepositoryAdapter(
        new WorkspaceDocumentStudioRepository(database, {
          blobRecords,
          now: () => NOW,
        }),
        sources,
        retention,
        () => NOW,
      ),
      blobs,
      blobRecords,
      { cleanupRecorder: { record: () => undefined } },
    );
    const initialContent = `# Test legal memorandum\n\nThe deterministic fixture applies[1].\n`;
    const draft = await studio.createDraft({
      projectId: PROJECT_ID,
      title: "Boundary downstream memorandum",
      content: initialContent,
      source: "assistant_edit",
      citationAnchorIds: [capturedAnchorId!],
      documentType: "legal_research_memo",
      originType: "manual",
      originRef: null,
    });
    await assert.rejects(
      studio.createDraft({
        projectId: FOREIGN_PROJECT_ID,
        title: "Cross-Matter authority attempt",
        content: initialContent,
        citationAnchorIds: [capturedAnchorId!],
      }),
      (error: unknown) => {
        assert(error instanceof WorkspaceApiError);
        assert.equal(error.status, 404);
        assert.equal(error.code, "NOT_FOUND");
        assert.equal(error.message, "Studio document was not found.");
        return true;
      },
    );
    const origin = seedCompleteSuggestionOrigin(database, PROJECT_ID);
    const deletedText = "applies";
    const startOffset = initialContent.indexOf(deletedText);
    const suggestion = await studio.createSuggestionFromAssistantTool({
      projectId: PROJECT_ID,
      documentId: draft.document.id,
      baseVersionId: draft.version.id,
      messageId: origin.outputMessageId,
      jobId: origin.jobId,
      attempt: 1,
      toolCallId: "boundary-suggestion",
      startOffset,
      endOffset: startOffset + deletedText.length,
      exactDeletedText: deletedText,
      insertedText: "is retained for test verification",
      summary: "Clarify the deterministic test-only status",
    });
    assert.equal(suggestion.status, "pending");
    assert.equal(
      (await studio.getDocument(PROJECT_ID, draft.document.id)).content,
      initialContent,
    );
    const accepted = await studio.acceptSuggestion(
      PROJECT_ID,
      draft.document.id,
      suggestion.id,
    );
    assert.equal(accepted.suggestion.status, "accepted");
    assert.equal(accepted.document.version.versionNumber, 2);
    assert.deepEqual(accepted.document.version.citationAnchorIds, [
      capturedAnchorId,
    ]);
    const current = await studio.getDocument(PROJECT_ID, draft.document.id);
    const exported = await exportDocumentStudioMarkdownToDocx({
      title: current.document.title,
      markdown: current.content,
    });
    assert.equal(
      exported.mimeType,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.ok(exported.bytes.byteLength > 1_000);
    assert.equal(exported.bytes.subarray(0, 2).toString("ascii"), "PK");
    const exportedText = (
      await mammoth.extractRawText({ buffer: exported.bytes })
    ).value;
    assert.match(exportedText, /retained for test verification/);

    database.close();
    database = new WorkspaceDatabase(databasePath);
    const reopenedSources = new WorkspaceSourceFoundationRepository(database);
    const reopenedRecords = new WorkspaceBlobRecordsRepository(database);
    const reopenedBlobs = new LocalWorkspaceBlobStore({
      root: blobRoot,
      codec: new IdentityCodec(),
      allowUnencryptedCodec: true,
    });
    const reopened = new WorkspaceDocumentStudioService(
      new WorkspaceDocumentStudioRepositoryAdapter(
        new WorkspaceDocumentStudioRepository(database, {
          blobRecords: reopenedRecords,
          now: () => NOW,
        }),
        reopenedSources,
        new WorkspaceSourceRetentionService(
          new WorkspaceSourceRetentionLifecycleRepository(database),
          () => Date.parse(NOW),
        ),
        () => NOW,
      ),
      reopenedBlobs,
      reopenedRecords,
      { cleanupRecorder: { record: () => undefined } },
    );
    const recovered = await reopened.getDocument(PROJECT_ID, draft.document.id);
    assert.equal(recovered.version.id, accepted.document.version.id);
    assert.equal(recovered.version.versionNumber, 2);
    assert.deepEqual(recovered.version.citationAnchorIds, [capturedAnchorId]);
    assert.match(recovered.content, /retained for test verification/);
    assert.equal(
      reopened.getSuggestion(PROJECT_ID, draft.document.id, suggestion.id)
        .status,
      "accepted",
    );
    assert.equal(
      reopenedSources.getCitationAnchor(PROJECT_ID, capturedAnchorId!)
        ?.exactQuote,
      AUTHORITY_QUOTE,
    );
    const reexported = await exportDocumentStudioMarkdownToDocx({
      title: recovered.document.title,
      markdown: recovered.content,
    });
    assert.equal(reexported.bytes.subarray(0, 2).toString("ascii"), "PK");
    assert.equal(
      (await mammoth.extractRawText({ buffer: reexported.bytes })).value,
      exportedText,
      "the exact current version must export the same document text after reopen",
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-legal-work-vertical-boundary-v1",
          full_vertical_status: "blocked_fail_closed",
          production_provider_status: "not_asserted_live",
          checks: [
            "test-only deterministic provider is rejected by the production registry",
            "real AssistantRuntime search/read tool loop captures a Matter-scoped durable authority",
            "document-only Assistant citation schema rejects the authority citation with JOB_FAILED and no message_sources",
            "durable authority anchor is reusable by Studio Draft/version/suggestion/DOCX after the explicit boundary",
            "cross-Matter source and Draft access fail closed",
            "authority, accepted suggestion, current version, blob content, and deterministic DOCX survive reopen",
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

void run();
