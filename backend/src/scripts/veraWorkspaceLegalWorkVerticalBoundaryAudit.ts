import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mammoth from "mammoth";

import { toMikeChatDetail } from "../lib/workspace/assistantCompatibility";
import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { exportDocumentStudioMarkdownToDocx } from "../lib/workspace/documentStudioDocx";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { WorkspaceDocumentStudioRepository } from "../lib/workspace/repositories/documentStudio";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import {
  WorkspaceLegalResearchOwnershipAdapterV22,
  WorkspaceLegalResearchRepository,
  WorkspaceLegalResearchSourceCaptureAdapterV22,
} from "../lib/workspace/repositories/legalResearch";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceSourceFoundationRepository } from "../lib/workspace/repositories/sourceFoundation";
import { WorkspaceSourceRetentionLifecycleRepository } from "../lib/workspace/repositories/sourceRetentionLifecycle";
import { WorkspaceAssistantLegalResearchToolModule } from "../lib/workspace/services/assistantLegalResearchTools";
import { WorkspaceAssistantActionLedger } from "../lib/workspace/services/assistantActionLedger";
import { WorkspaceAssistantDraftToolModule } from "../lib/workspace/services/assistantDraftTools";
import {
  AssistantRuntimeService,
  type AssistantModelPort,
} from "../lib/workspace/services/assistantRuntime";
import { WorkspaceAssistantToolRegistry } from "../lib/workspace/services/assistantToolRegistry";
import { WorkspaceChatsRuntimePort } from "../lib/workspace/services/assistantChatsPort";
import { ChatsService } from "../lib/workspace/services/chats";
import { WorkspaceDocumentStudioService } from "../lib/workspace/services/documentStudio";
import { WorkspaceDocumentStudioRepositoryAdapter } from "../lib/workspace/services/documentStudioRepositoryAdapter";
import { WorkspaceJobsService } from "../lib/workspace/services/jobs";
import {
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
const VERTICAL_TRACE: string[] = [];

/**
 * This is deliberately a boundary audit, not a claim that production legal
 * research is live. The test-only provider can be registered only through
 * WorkspaceLegalResearchProviderRegistry.forTesting(). The current production
 * activation gate remains intentionally not asserted live: the deterministic
 * provider is accepted only by the explicit test registry and production must
 * still construct this composition from an activated authorized provider.
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
      VERTICAL_TRACE.push(`model:${toolMessages.length}`);
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
      if (toolMessages.length === 2) {
        return {
          content: "",
          sources: [],
          toolCalls: [
            {
              id: "create-authority-draft",
              name: "create_draft",
              input: {
                title: "Assistant authority memorandum",
                documentType: "legal_research_memo",
                contentMarkdown:
                  "# Test legal memorandum\n\nThe deterministic fixture applies[1].\n",
                evidenceSources: [
                  {
                    evidenceId: read.excerpts[0]!.anchorCandidateId,
                    exactQuote: read.excerpts[0]!.text,
                  },
                ],
              },
            },
          ],
        };
      }
      const created = JSON.parse(toolMessages[2]!.content) as {
        draftId: string;
        versionId: string;
      };
      assert.match(created.draftId, /^[a-f0-9-]{36}$/i);
      assert.match(created.versionId, /^[a-f0-9-]{36}$/i);
      const authority = input.legalAuthorityEvidence?.[0];
      assert.ok(authority);
      const content = "测试法源支持该测试结论[1]。";
      await input.onTextDelta(content);
      return {
        content,
        sources: [
          {
            sourceKind: "legal_authority",
            readId: authority.readId,
            snapshotId: authority.snapshotId,
            anchorId: authority.anchorId,
            quote: authority.exactQuote,
            locator: authority.locator,
            rank: 0,
            score: null,
            citationOrdinal: 0,
            citationMetadata: {
              citationNumber: 1,
              label: authority.title,
            },
          },
        ],
        toolCalls: [],
      };
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
    let capturedSnapshotId: string | null = null;
    let capturedAnchorId: string | null = null;
    const captureDelegate: LegalResearchSourceCapturePort = {
      async capture(input) {
        assert.equal(input.context.projectId, PROJECT_ID);
        assert.match(input.readId, /^[a-f0-9-]{36}$/i);
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
    const legalResearchRepository = new WorkspaceLegalResearchRepository(
      database,
      { now: () => NOW },
    );
    const ownership = new WorkspaceLegalResearchOwnershipAdapterV22(
      legalResearchRepository,
    );
    const capture = new WorkspaceLegalResearchSourceCaptureAdapterV22(
      captureDelegate,
      ownership,
    );
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
      ownership,
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
    const module = new WorkspaceAssistantLegalResearchToolModule(
      research,
      {
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
      },
      legalResearchRepository,
    );
    const draftModule = new WorkspaceAssistantDraftToolModule(
      database,
      chatsRepository,
      studio,
      (projectId, content, citationSources) => {
        VERTICAL_TRACE.push("draft:rebuild-anchors");
        assert.match(content, /\[1\]/);
        return citationSources.map((citation) => {
          assert.ok("anchorId" in citation);
          const retained = retention.readAnchorQuote(
            projectId,
            citation.anchorId,
          );
          assert.equal(retained.snapshotId, citation.snapshotId);
          assert.equal(retained.exactQuote, citation.quote);
          retention.assertStudioAnchorBindings({
            projectId,
            anchorIds: [citation.anchorId],
          });
          return citation.anchorId;
        });
      },
      new WorkspaceAssistantActionLedger(database),
    );
    const runtime = new AssistantRuntimeService(
      chatsRepository,
      jobsRepository,
      boundaryModel(),
      {
        clock: () => new Date(NOW),
        tools: new WorkspaceAssistantToolRegistry([module, draftModule]),
        legalAuthorityCommit: legalResearchRepository,
      },
    );
    let completed: Awaited<ReturnType<AssistantRuntimeService["execute"]>>;
    try {
      completed = await runtime.execute({
        jobId: generation.jobId,
        leaseOwner: WORKER,
        attempt: claimed!.attempt,
        signal: new AbortController().signal,
      });
    } catch (error) {
      const diagnostic = database
        .prepare("SELECT status,error_code FROM chat_messages WHERE id=?")
        .get(generation.outputMessageId);
      throw new Error(
        `Vertical Assistant failed: ${JSON.stringify(diagnostic)} ${VERTICAL_TRACE.join(",")}`,
        {
          cause: error,
        },
      );
    }
    assert.equal(completed.messageId, generation.outputMessageId);
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
      "legal authority citations must not be forged into document message_sources",
    );
    assert.equal(
      database
        .prepare("SELECT status FROM chat_messages WHERE id=?")
        .get(generation.outputMessageId)?.status,
      "complete",
      "the authority-grounded Assistant output must complete durably",
    );
    assert.equal(jobsRepository.getJob(generation.jobId)?.status, "complete");
    const authorityMessageSources =
      legalResearchRepository.listAssistantAuthoritySources(
        generation.outputMessageId,
      );
    assert.equal(authorityMessageSources.length, 1);
    assert.equal(authorityMessageSources[0]!.snapshotId, capturedSnapshotId);
    assert.equal(authorityMessageSources[0]!.anchorId, capturedAnchorId);
    assert.equal(authorityMessageSources[0]!.exactQuote, AUTHORITY_QUOTE);
    assert.equal(
      Number(
        database
          .prepare(
            "SELECT count(*) AS total FROM documents WHERE project_id=? AND document_kind='draft'",
          )
          .get(PROJECT_ID)?.total,
      ),
      1,
      "the Assistant create_draft handoff must persist one Studio Draft",
    );
    assert.equal(
      sources.getSnapshot(FOREIGN_PROJECT_ID, capturedSnapshotId!),
      null,
    );
    assert.equal(
      sources.getCitationAnchor(FOREIGN_PROJECT_ID, capturedAnchorId!),
      null,
    );

    const draftRow = database
      .prepare(
        `SELECT id
           FROM documents
          WHERE project_id=? AND document_kind='draft' AND deleted_at IS NULL`,
      )
      .get(PROJECT_ID);
    assert.equal(typeof draftRow?.id, "string");
    const draft = await studio.getDocument(PROJECT_ID, String(draftRow!.id));
    const initialContent = draft.content;
    assert.equal(draft.document.title, "Assistant authority memorandum");
    assert.deepEqual(draft.version.citationAnchorIds, [capturedAnchorId]);
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
    const deletedText = "applies";
    const startOffset = initialContent.indexOf(deletedText);
    const suggestion = await studio.createSuggestionFromAssistantTool({
      projectId: PROJECT_ID,
      documentId: draft.document.id,
      baseVersionId: draft.version.id,
      messageId: generation.outputMessageId,
      jobId: generation.jobId,
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
    const reopenedLegalResearch = new WorkspaceLegalResearchRepository(
      database,
      { now: () => NOW },
    );
    const reopenedChatsRepository = new ChatsRepository(database);
    const reopenedChats = new ChatsService(
      reopenedChatsRepository,
      new ProjectsRepository(database),
      new ModelProfilesRepository(database),
      () => new Date(NOW),
      {
        capabilities: {
          hydrate: () => ({ can_read: true, can_download: true }),
        },
      },
    );
    const reopenedChatPort = new WorkspaceChatsRuntimePort(
      reopenedChats,
      reopenedLegalResearch,
    );
    const reopenedChatDetail = await reopenedChatPort.getChatDetail(
      { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID },
      chat.id,
    );
    const mikeChat = toMikeChatDetail(reopenedChatDetail);
    const assistantMessage = mikeChat.messages.find(
      (message) => message.id === generation.outputMessageId,
    );
    assert.ok(assistantMessage);
    assert.equal(assistantMessage.citations?.length, 1);
    const authorityWire = assistantMessage.citations?.[0];
    assert.deepEqual(Object.keys(authorityWire ?? {}).sort(), [
      "kind",
      "locator",
      "quote",
      "ref",
      "source_type",
      "title",
      "type",
    ]);
    assert.deepEqual(authorityWire, {
      type: "citation_data",
      kind: "legal_authority",
      ref: 1,
      title: "Deterministic Contract Law Fixture",
      source_type: "statute",
      locator: { article: "1" },
      quote: AUTHORITY_QUOTE,
    });
    const authorityWireJson = JSON.stringify(authorityWire);
    assert.doesNotMatch(
      authorityWireJson,
      /readId|snapshotId|anchorId|sourceRef|providerSourceId|https?:|bearer|sk_/i,
    );
    assert.equal(
      reopenedLegalResearch.listAssistantAuthoritySources(
        generation.outputMessageId,
      )[0]?.anchorId,
      capturedAnchorId,
    );
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
          suite: "vera-legal-work-vertical-boundary-v22",
          full_vertical_status: "complete_test_only",
          production_provider_status: "not_asserted_live",
          checks: [
            "test-only deterministic provider is rejected by the production registry",
            "real AssistantRuntime search/read tool loop captures a Matter-scoped durable v22 authority",
            "create_draft consumes only the current-attempt anchorCandidateId and exact quote",
            "final Assistant legal authority citation binds to its durable message owner without document message_sources",
            "Assistant-created Draft/version supports suggestion acceptance and exact-version DOCX export",
            "cross-Matter source and Draft access fail closed",
            "reopened chat wire exposes only the reviewed legal-authority citation projection",
            "authority owner, snapshot, anchor, Draft, accepted suggestion, current version, blob content, and deterministic DOCX survive reopen",
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
