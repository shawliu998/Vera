import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { ModelProfilePrivacyRepository } from "../lib/workspace/inferencePolicy";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { TabularRepository } from "../lib/workspace/repositories/tabular";
import { workspaceBlobStorageKey } from "../lib/workspace/repositories/blobRecords";
import { WorkspaceRuntime } from "../lib/workspace/runtime";
import { AuthoritativeExtractedTextReader } from "../lib/workspace/services/authoritativeExtractedText";
import {
  prepareTabularReviewStudioSourceV23,
  readTabularReviewStudioJobLineageV23,
} from "../lib/workspace/tabularReviewStudioHandoffV23";
import {
  tabularCellIdempotencyKey,
  tabularCellJobPayload,
  tabularGenerationSha256,
  tabularReviewRevisionSha256,
} from "../lib/workspace/tabularGenerationContract";
import {
  mikeColumnFormat,
  mikeColumnTags,
} from "../lib/workspace/workflowCompatibility";

const PROJECT_ID = "23000000-0000-4000-8000-000000000001";
const OTHER_PROJECT_ID = "23000000-0000-4000-8000-000000000002";
const PROFILE_ID = "23000000-0000-4000-8000-000000000003";
const NOW = "2026-07-17T05:00:00.000Z";
const SOURCE_TEXT = "Termination requires thirty days written notice.";
const SOURCE_QUOTE = "thirty days written notice";

class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(input: Parameters<WorkspaceBlobCodec["encode"]>[0]) {
    return Buffer.from(input.plaintext);
  }
  decode(input: Parameters<WorkspaceBlobCodec["decode"]>[0]) {
    return Buffer.from(input.envelope);
  }
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function seedFoundation(
  database: WorkspaceDatabase,
  blobs: LocalWorkspaceBlobStore,
) {
  const projects = new ProjectsRepository(database);
  for (const [id, name] of [
    [PROJECT_ID, "Tabular handoff Matter"],
    [OTHER_PROJECT_ID, "Other Matter"],
  ] as const) {
    projects.create({
      id,
      name,
      description: null,
      cmNumber: null,
      practice: "General Transactions",
      now: NOW,
    });
  }
  const profiles = new ModelProfilesRepository(database);
  profiles.create({
    id: PROFILE_ID,
    name: "Tabular handoff audit model",
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
      toolCalling: false,
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

  const documentId = randomUUID();
  const versionId = randomUUID();
  const chunkId = randomUUID();
  const textBytes = Buffer.byteLength(SOURCE_TEXT, "utf8");
  database
    .prepare(
      `INSERT INTO documents (
         id, project_id, title, filename, mime_type, size_bytes, parse_status,
         current_version_id, created_at, updated_at
       ) VALUES (?, ?, 'Contract', 'contract.txt', 'text/plain', ?, 'pending',
                 NULL, ?, ?)`,
    )
    .run(documentId, PROJECT_ID, textBytes, NOW, NOW);
  database
    .prepare(
      `INSERT INTO document_versions (
         id, document_id, version_number, source, filename, mime_type,
         size_bytes, content_sha256, storage_key, page_count, created_at
       ) VALUES (?, ?, 1, 'upload', 'contract.txt', 'text/plain', ?, ?, ?, 1, ?)`,
    )
    .run(
      versionId,
      documentId,
      textBytes,
      sha256(SOURCE_TEXT),
      workspaceBlobStorageKey({ kind: "original", documentId, versionId }),
      NOW,
    );
  const storedText = blobs.putSync(
    { kind: "extracted_text", documentId, versionId },
    SOURCE_TEXT,
  );
  new WorkspaceBlobRecordsRepository(database).registerStored({
    locator: storedText.locator,
    contentSha256: storedText.sha256,
    sizeBytes: storedText.size,
    storedSizeBytes: storedText.storedSize,
  });
  database
    .prepare(
      `INSERT INTO document_chunks (
         id, document_id, version_id, ordinal, text, start_offset, end_offset,
         page_start, page_end, content_sha256, created_at
       ) VALUES (?, ?, ?, 0, ?, 0, ?, 1, 1, ?, ?)`,
    )
    .run(
      chunkId,
      documentId,
      versionId,
      SOURCE_TEXT,
      SOURCE_TEXT.length,
      sha256(SOURCE_TEXT),
      NOW,
    );
  database
    .prepare(
      `UPDATE documents
          SET current_version_id = ?, parse_status = 'ready', updated_at = ?
        WHERE id = ?`,
    )
    .run(versionId, NOW, documentId);
  return { profiles, documentId, versionId, chunkId };
}

function completeReview(input: {
  runtime: WorkspaceRuntime;
  database: WorkspaceDatabase;
  blobs: LocalWorkspaceBlobStore;
  documentId: string;
  versionId: string;
  chunkId: string;
}) {
  const workflow = input.runtime.workflows
    .list({ type: "tabular", includeHidden: true, limit: 100 })
    .items.find(
      (candidate) =>
        candidate.type === "tabular" &&
        candidate.isBuiltin &&
        candidate.status === "active" &&
        candidate.projectId === null &&
        candidate.columns.length > 0 &&
        [
          "builtin-coc-dd-tabular-review",
          "builtin-commercial-agreement-tabular-review",
        ].includes(
          input.runtime.workflows.getMikeBuiltinMapping(candidate.id)
            ?.upstreamId ?? "",
        ),
    );
  assert.ok(workflow && workflow.type === "tabular");
  const reviewId = randomUUID();
  const columns = workflow.columns.map((column) => ({
    id: randomUUID(),
    reviewId,
    key: column.key,
    title: column.title,
    outputType: column.outputType,
    format: mikeColumnFormat(workflow, column),
    prompt: column.prompt,
    enumValues: column.enumValues,
    tags: mikeColumnTags(workflow, column),
    ordinal: column.ordinal,
    legacyMetadata: {},
  }));
  const cells = columns.map((column) => ({
    id: randomUUID(),
    documentId: input.documentId,
    columnId: column.id,
    outputType: column.outputType,
  }));
  const tabular = new TabularRepository(input.database);
  tabular.create({
    id: reviewId,
    projectId: PROJECT_ID,
    workflowId: workflow.id,
    modelProfileId: PROFILE_ID,
    title: "Completed contract review",
    documentIds: [input.documentId],
    columns,
    cells,
    now: NOW,
  });
  const snapshot = new AuthoritativeExtractedTextReader(
    input.database,
    input.blobs,
  ).currentSnapshot({
    projectId: PROJECT_ID,
    documentId: input.documentId,
    maxTextBytes: 4 * 1024 * 1024,
  });
  const executionRevision = new ModelProfilesRepository(
    input.database,
  ).requireStored(PROFILE_ID).executionRevision;
  const reviewRevisionSha256 = tabularReviewRevisionSha256({
    reviewId,
    projectId: PROJECT_ID,
    workflowId: workflow.id,
    documentIds: [input.documentId],
    columns,
  });
  const quoteStart = SOURCE_TEXT.indexOf(SOURCE_QUOTE);
  assert.ok(quoteStart >= 0);
  cells.forEach((cell, index) => {
    const at = new Date(Date.parse(NOW) + (index + 1) * 1000).toISOString();
    const jobId = randomUUID();
    const column = columns[index]!;
    const payload = tabularCellJobPayload({
      reviewId,
      projectId: PROJECT_ID,
      cellId: cell.id,
      generationId: jobId,
      snapshot,
      column,
      modelProfileId: PROFILE_ID,
      modelExecutionRevision: executionRevision,
      reviewRevisionSha256,
      generation: 1,
    });
    tabular.queueCell({ cellId: cell.id, jobId, nextAttempt: 1, now: at }, () =>
      input.runtime.jobs.enqueueJobInCurrentTransaction({
        id: jobId,
        type: "tabular_cell",
        resourceType: "tabular_cell",
        resourceId: cell.id,
        idempotencyKey: tabularCellIdempotencyKey(payload),
        payload,
        maxAttempts: 1,
        now: at,
      }),
    );
    const leaseOwner = `tabular-handoff-audit-${index}`;
    const claim = input.runtime.jobs.repository.claimNextQueued(
      at,
      leaseOwner,
      new Date(Date.parse(at) + 60_000).toISOString(),
    );
    assert.equal(claim?.id, jobId);
    const claimInput = {
      id: jobId,
      type: "tabular_cell" as const,
      resourceType: "tabular_cell" as const,
      resourceId: cell.id,
      leaseOwner,
      attempt: claim!.attempt,
      at,
      payload,
    };
    tabular.startClaimedCell(cell.id, at, () =>
      input.runtime.jobs.repository.assertClaimInCurrentTransaction(claimInput),
    );
    const summary = column.enumValues?.[0] ?? "Extracted contract term";
    const content = {
      summary,
      flag: index % 2 === 0 ? ("yellow" as const) : ("grey" as const),
      reasoning: "Verify this model extraction against the cited clause.",
    };
    const sources = [
      {
        documentId: input.documentId,
        versionId: input.versionId,
        chunkId: input.chunkId,
        quote: SOURCE_QUOTE,
        startOffset: quoteStart,
        endOffset: quoteStart + SOURCE_QUOTE.length,
      },
    ];
    const result = {
      schema: "vera-tabular-cell-result-v1",
      cellId: cell.id,
      contentSha256: tabularGenerationSha256({ content, sources }),
      sourceCount: 1,
    };
    tabular.completeClaimedCell(
      cell.id,
      content,
      sources,
      result,
      at,
      () =>
        input.runtime.jobs.repository.assertClaimInCurrentTransaction(
          claimInput,
        ),
      () =>
        input.runtime.jobs.repository.finishClaimInCurrentTransaction({
          ...claimInput,
          event: { type: "complete", at, result },
        }),
    );
  });
  assert.equal(tabular.require(reviewId).status, "complete");
  return { reviewId, tabular };
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-tabular-studio-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const blobRoot = path.join(root, "blobs");
  const runtimeDataDir = path.join(root, "runtime");
  let database = new WorkspaceDatabase(databasePath);
  let blobs = new LocalWorkspaceBlobStore({
    root: blobRoot,
    codec: new IdentityCodec(),
    allowUnencryptedCodec: true,
  });
  let runtime: WorkspaceRuntime | null = null;
  try {
    const source = seedFoundation(database, blobs);
    runtime = new WorkspaceRuntime({
      database,
      blobs,
      dataDir: runtimeDataDir,
    });
    await runtime.start();
    const { reviewId, tabular } = completeReview({
      runtime,
      database,
      blobs,
      ...source,
    });
    const context = { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID };
    await assert.rejects(
      () =>
        runtime!.createStudioDocumentFromTabularReview(
          context,
          OTHER_PROJECT_ID,
          reviewId,
        ),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.status === 404,
    );
    const first = (await runtime.createStudioDocumentFromTabularReview(
      context,
      PROJECT_ID,
      reviewId,
    )) as Record<string, unknown>;
    const replay = (await runtime.createStudioDocumentFromTabularReview(
      context,
      PROJECT_ID,
      reviewId,
    )) as Record<string, unknown>;
    const firstVersion = first.version as Record<string, unknown>;
    const replayVersion = replay.version as Record<string, unknown>;
    assert.equal(replay.document_id, first.document_id);
    assert.equal(replayVersion.id, firstVersion.id);
    assert.equal(first.current_version_id, firstVersion.id);
    assert.match(String(first.content), /AI 生成草稿/);
    assert.match(String(first.content), /模型提取标记/);
    assert.doesNotMatch(String(first.content), /风险级别/);
    assert.match(String(first.content), /\[1\]/);
    const handoff = database
      .prepare("SELECT * FROM tabular_review_studio_handoffs")
      .get();
    assert.ok(handoff);
    assert.equal(handoff.document_type, "contract_review_memo");
    assert.equal(handoff.document_id, first.document_id);
    assert.equal(handoff.version_id, firstVersion.id);
    const detail = tabular.requireDetail(reviewId);
    const jobLineage = readTabularReviewStudioJobLineageV23({
      database,
      projectId: PROJECT_ID,
      detail,
    });
    const freshlyPrepared = prepareTabularReviewStudioSourceV23({
      projectId: PROJECT_ID,
      detail,
      jobLineage,
    });
    assert.equal(handoff.identity_sha256, freshlyPrepared.identitySha256);
    assert.equal(
      handoff.review_state_sha256,
      freshlyPrepared.reviewStateSha256,
    );
    assert.equal(
      handoff.source_manifest_sha256,
      freshlyPrepared.sourceManifestSha256,
    );
    assert.equal(
      handoff.source_manifest_json,
      freshlyPrepared.sourceManifestJson,
    );
    assert.equal(
      sha256(String(handoff.source_manifest_json)),
      handoff.source_manifest_sha256,
    );
    const manifest = JSON.parse(String(handoff.source_manifest_json)) as {
      cells: Array<{
        attempt: number;
        jobId: string | null;
        completedAt: string | null;
        jobLineage: {
          cellId: string;
          jobId: string;
          generation: number;
          documentVersionId: string;
          columnRevisionSha256: string;
          reviewRevisionSha256: string;
          jobPayloadSha256: string;
          jobResultSha256: string;
        };
      }>;
    };
    assert.equal(
      manifest.cells.every(
        (cell) =>
          cell.attempt >= 1 &&
          cell.jobId !== null &&
          cell.completedAt !== null &&
          cell.jobLineage.jobId === cell.jobId &&
          cell.jobLineage.generation === cell.attempt &&
          cell.jobLineage.documentVersionId === source.versionId &&
          [
            cell.jobLineage.columnRevisionSha256,
            cell.jobLineage.reviewRevisionSha256,
            cell.jobLineage.jobPayloadSha256,
            cell.jobLineage.jobResultSha256,
          ].every((value) => /^[a-f0-9]{64}$/.test(value)),
      ),
      true,
    );
    const metadata = database
      .prepare(
        `SELECT document_type, origin_type, origin_ref
           FROM document_studio_draft_metadata WHERE document_id = ?`,
      )
      .get(String(first.document_id));
    assert.deepEqual(metadata ? { ...metadata } : null, {
      document_type: "contract_review_memo",
      origin_type: "unknown",
      origin_ref: null,
    });
    const binding = database
      .prepare(
        `SELECT binding.version_id, anchor.exact_quote, anchor.quote_sha256,
                anchor.locator_json
           FROM document_version_citation_anchors binding
           JOIN source_citation_anchors anchor ON anchor.id = binding.anchor_id
          WHERE binding.document_id = ? AND binding.version_id = ?`,
      )
      .all(String(first.document_id), String(firstVersion.id));
    assert.equal(binding.length, 1);
    assert.equal(binding[0]?.exact_quote, SOURCE_QUOTE);
    assert.equal(binding[0]?.quote_sha256, sha256(SOURCE_QUOTE));
    const locator = JSON.parse(String(binding[0]?.locator_json)) as Record<
      string,
      unknown
    >;
    const quoteStart = SOURCE_TEXT.indexOf(SOURCE_QUOTE);
    assert.equal(locator.chunkId, source.chunkId);
    assert.equal(locator.documentVersionId, source.versionId);
    assert.equal(locator.startOffset, quoteStart);
    assert.equal(locator.endOffset, quoteStart + SOURCE_QUOTE.length);
    assert.equal(locator.documentStartOffset, quoteStart);
    assert.equal(locator.documentEndOffset, quoteStart + SOURCE_QUOTE.length);
    const wireAnchors = first.citation_anchors as Array<
      Record<string, unknown>
    >;
    assert.equal(wireAnchors.length, 1);
    assert.equal(wireAnchors[0]?.exact_quote, SOURCE_QUOTE);
    assert.deepEqual(wireAnchors[0]?.locator, locator);
    const drafts = await runtime.listStudioDrafts(context, PROJECT_ID, {
      limit: 10,
      cursor: null,
    });
    assert.equal(drafts.drafts[0]?.originType, "tabular");
    assert.equal(
      database
        .prepare("SELECT count(*) AS total FROM tabular_review_studio_handoffs")
        .get()?.total,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS total FROM documents WHERE project_id = ? AND document_kind = 'draft'",
        )
        .get(PROJECT_ID)?.total,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS total FROM document_versions WHERE document_id = ?",
        )
        .get(String(first.document_id))?.total,
      1,
    );
    assert.throws(
      () => tabular.delete(reviewId),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.status === 409,
    );
    assert.throws(() =>
      database
        .prepare(
          "UPDATE tabular_review_studio_handoffs SET id = id WHERE id = ?",
        )
        .run(String(handoff.id)),
    );
    assert.throws(() =>
      database
        .prepare("DELETE FROM tabular_review_studio_handoffs WHERE id = ?")
        .run(String(handoff.id)),
    );
    assert.throws(() =>
      database
        .prepare("DELETE FROM tabular_reviews WHERE id = ?")
        .run(reviewId),
    );

    const anchorId = String(wireAnchors[0]?.id);
    const saved = (await runtime.saveStudioDocument(
      context,
      PROJECT_ID,
      String(first.document_id),
      {
        expectedVersionId: String(firstVersion.id),
        content: `${String(first.content)}\n\n律师复核备注。`,
        source: "assistant_edit",
        citationAnchorIds: [anchorId],
        summary: "Lawyer review checkpoint.",
      },
    )) as Record<string, unknown>;
    assert.notEqual(saved.current_version_id, firstVersion.id);
    const replayAfterEdit =
      (await runtime.createStudioDocumentFromTabularReview(
        context,
        PROJECT_ID,
        reviewId,
      )) as Record<string, unknown>;
    assert.equal(replayAfterEdit.document_id, first.document_id);
    assert.equal(
      (replayAfterEdit.version as Record<string, unknown>).id,
      firstVersion.id,
    );
    assert.equal(replayAfterEdit.current_version_id, saved.current_version_id);
    assert.equal(replayAfterEdit.content, first.content);

    await runtime.stop();
    runtime = null;
    database = new WorkspaceDatabase(databasePath);
    blobs = new LocalWorkspaceBlobStore({
      root: blobRoot,
      codec: new IdentityCodec(),
      allowUnencryptedCodec: true,
    });
    runtime = new WorkspaceRuntime({
      database,
      blobs,
      dataDir: runtimeDataDir,
    });
    await runtime.start();
    const restartedReplay =
      (await runtime.createStudioDocumentFromTabularReview(
        context,
        PROJECT_ID,
        reviewId,
      )) as Record<string, unknown>;
    assert.equal(restartedReplay.document_id, first.document_id);
    assert.equal(
      (restartedReplay.version as Record<string, unknown>).id,
      firstVersion.id,
    );
    assert.equal(restartedReplay.current_version_id, saved.current_version_id);
    assert.equal(restartedReplay.content, first.content);
    const restartedDrafts = await runtime.listStudioDrafts(
      context,
      PROJECT_ID,
      {
        limit: 10,
        cursor: null,
      },
    );
    assert.equal(restartedDrafts.drafts[0]?.originType, "tabular");
    assert.equal(
      database
        .prepare("SELECT count(*) AS total FROM tabular_review_studio_handoffs")
        .get()?.total,
      1,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-workspace-tabular-studio-handoff-v23",
          checks: [
            "server-canonical bounded source manifest with durable cell/job lineage",
            "Matter scope and completed built-in preset eligibility",
            "byte/offset citation re-verification and contiguous markers",
            "atomic v1 Draft metadata, citation bindings, blob/job, and immutable handoff",
            "server-derived identity replay with no duplicate handoff or Draft",
            "server identity replay returns the frozen handoff version after edits and restart",
            "tabular origin projection without falsifying v20 workflow provenance",
            "handoff review deletion protection and immutable evidence rows",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (runtime) await runtime.stop().catch(() => undefined);
    else database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
