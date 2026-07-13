import { createAletheiaRepository } from ".";
import type { AletheiaRepository, AletheiaUserContext } from "./repository";

const DEFAULT_DEMO_SEED_ID = "aletheia-local-demo-seed-v1";
const DEFAULT_DEMO_TITLE = "Private Contract Review Demo";

type SeedDecision = {
  shouldSeed: boolean;
  reason: string;
};

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function envText(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function demoSeedId(): string {
  return envText("ALETHEIA_DEMO_SEED_ID", DEFAULT_DEMO_SEED_ID);
}

function demoMatterTitle(): string {
  const suffix = process.env.ALETHEIA_DEMO_SEED_TITLE_SUFFIX?.trim();
  return suffix ? `${DEFAULT_DEMO_TITLE} — ${suffix}` : DEFAULT_DEMO_TITLE;
}

function localUserContext(): AletheiaUserContext {
  return {
    userId: process.env.ALETHEIA_LOCAL_USER_ID ?? "local-user",
    userEmail:
      process.env.ALETHEIA_LOCAL_USER_EMAIL ?? "local@aletheia.internal",
  };
}

function hasDemoSeed(matters: unknown[], seedId: string): boolean {
  return matters.some(
    (matter: any) => matter?.metadata?.demoSeedId === seedId,
  );
}

function existingDemoMatter(matters: unknown[], seedId: string) {
  return matters.find(
    (matter: any) => matter?.metadata?.demoSeedId === seedId,
  ) as { id?: string; title?: string } | undefined;
}

async function seedDecision(
  repo: AletheiaRepository,
  ctx: AletheiaUserContext,
): Promise<SeedDecision> {
  if (!envFlag("ALETHEIA_DEMO_SEED_ENABLED", false)) {
    return { shouldSeed: false, reason: "disabled" };
  }
  const matters = await repo.listMatters(ctx);
  if (hasDemoSeed(matters, demoSeedId())) {
    return { shouldSeed: false, reason: "already-seeded" };
  }

  const mode = (process.env.ALETHEIA_DEMO_SEED_MODE ?? "empty")
    .trim()
    .toLowerCase();
  if (mode === "always") {
    return { shouldSeed: true, reason: "always" };
  }
  if (mode === "empty" && matters.length === 0) {
    return { shouldSeed: true, reason: "empty-workspace" };
  }
  return { shouldSeed: false, reason: `mode-${mode}-with-existing-data` };
}

async function approve(
  repo: AletheiaRepository,
  ctx: AletheiaUserContext,
  matterId: string,
  action: "audit_pack_export" | "feedback_dataset_export" | "final_memo_export",
  prompt: string,
  seedId: string,
) {
  const checkpoint: any = await repo.requestApproval(ctx, matterId, {
    action,
    prompt,
    requestedPayload: { demoSeedId: seedId },
  });
  if (!checkpoint?.id) {
    throw new Error(`Demo seed could not request ${action} approval`);
  }
  await repo.decideApproval(ctx, matterId, checkpoint.id, {
    decision: "approved",
    comment: "Approved for the bundled local demo workspace.",
  });
  return checkpoint;
}

export async function seedAletheiaDemoMatter(
  repo: AletheiaRepository,
  ctx: AletheiaUserContext,
) {
  const seedId = demoSeedId();
  const title = demoMatterTitle();
  const timestamp = new Date().toISOString();
  const matter: any = await repo.createMatter(ctx, {
    title,
    objective:
      "Show the local V1 professional loop from ingestion and retrieval through evidence, memo, review, gates, audit export, eval export, and approved skill activation.",
    template: "legal_matter_review",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: "Aletheia local demo",
    sourceProjectId: null,
    sharedWith: [],
    metadata: {
      seededBy: "aletheiaDemoSeed",
      demoSeedId: seedId,
      seededAt: timestamp,
      localOnly: true,
    },
  });

  const sourceText = [
    "Aletheia local demo source record.",
    "The agreement requires thirty days written notice before termination for convenience.",
    "The indemnity covenant survives closing and applies to third-party claims.",
    "Board approval is required before any transfer of a material contract.",
    "The renewal clause is ambiguous because the notice window is not defined.",
    "Schedule 4.2 is missing and should block final reliance until a reviewer confirms the gap.",
  ].join("\n");

  const document: any = await repo.uploadMatterDocument(ctx, matter.id, {
    filename: "private-contract-review-demo.txt",
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(sourceText, "utf8"),
    buffer: Buffer.from(sourceText, "utf8"),
  });

  const searchResults: any[] | null = await repo.searchMatterDocuments(
    ctx,
    matter.id,
    {
      query: "termination written notice board approval missing schedule",
      limit: 5,
    },
  );
  if (!searchResults?.length) {
    throw new Error("Demo seed document did not produce searchable chunks");
  }

  const evidenceItems = [];
  for (const result of searchResults.slice(0, 3)) {
    const evidence: any = await repo.createEvidenceItem(ctx, matter.id, {
      sourceChunkId: result.chunk_id,
      relevance: "direct",
      supportStatus: "supports",
      confidence: "high",
      metadata: {
        seededBy: "aletheiaDemoSeed",
        demoSeedId: seedId,
        query: "termination written notice board approval missing schedule",
      },
    });
    if (evidence) evidenceItems.push(evidence);
  }

  const issueMap: any = await repo.generateIssueMap(ctx, matter.id);
  const matrix: any = await repo.generateEvidenceMatrix(ctx, matter.id);
  const draftMemo: any = await repo.generateDraftMemo(ctx, matter.id);

  const review: any = await repo.addReview(ctx, matter.id, {
    targetType: "work_product",
    targetId: draftMemo.id,
    tag: "missing_material",
    comment:
      "Schedule 4.2 is missing; keep final reliance blocked until the material gap is confirmed or resolved.",
    workProductId: draftMemo.id,
    evidenceItemId: evidenceItems[0]?.id ?? null,
    reviewerName: "Local demo reviewer",
  });
  if (review?.id) {
    await repo.resolveReview(ctx, matter.id, review.id, {
      status: "needs_material",
      comment: "Converted to a durable eval case for the local demo.",
      createEvalCase: true,
    });
  }

  const memory = await repo.addMatterMemory(ctx, matter.id, {
    category: "missing_material",
    title: "Missing schedule blocks final reliance",
    body: "Schedule 4.2 must be obtained or explicitly waived before a final memo can be treated as review-ready.",
    source: "review",
    metadata: { demoSeedId: seedId, reviewId: review?.id ?? null },
  });

  const playbook: any = await repo.createPlaybook(ctx, matter.id, {
    name: "Contract Review Demo Playbook",
    description:
      "Local-only reviewer-approved workflow for source-bound contract review demos.",
    version: "v0.1",
    content: {
      format: "markdown",
      body: [
        "1. Ingest local sources and preserve source anchors.",
        "2. Convert retrieval hits into evidence items.",
        "3. Draft memo sections only from source-linked evidence.",
        "4. Convert reviewer blockers into eval cases.",
        "5. Require explicit approval before audit or eval export.",
      ].join("\n"),
      controls: {
        localOnly: true,
        matterScoped: true,
        agentMayAutoModify: false,
        requiresHumanApprovalForUpdates: true,
      },
    },
  });
  await repo.approvePlaybook(ctx, matter.id, playbook.id);

  const run: any = await repo.createAgentRun(ctx, matter.id, {
    workflow: "legal_matter_review",
    goal: "Seed the local V1 demo workflow",
    status: "queued",
    metadata: { seededBy: "aletheiaDemoSeed", demoSeedId: seedId },
  });

  const auditApproval = await approve(
    repo,
    ctx,
    matter.id,
    "audit_pack_export",
    "Approve bundled local demo audit/export package.",
    seedId,
  );
  const evalApproval = await approve(
    repo,
    ctx,
    matter.id,
    "feedback_dataset_export",
    "Approve bundled local demo eval export.",
    seedId,
  );
  const finalMemoApproval = await approve(
    repo,
    ctx,
    matter.id,
    "final_memo_export",
    "Approve bundled local demo final memo export gate.",
    seedId,
  );

  const auditPack: any = await repo.createWorkProduct(ctx, matter.id, {
    kind: "audit_pack",
    title: "Private Contract Review Demo Audit Pack",
    status: "generated",
    schemaVersion: "aletheia-audit-pack-v0",
    content: {
      matterId: matter.id,
      documentId: document.id,
      evidenceIds: evidenceItems.map((item: any) => item.id),
      issueMapId: issueMap?.id ?? null,
      evidenceMatrixId: matrix?.id ?? null,
      draftMemoId: draftMemo?.id ?? null,
      memoryId: (memory as any)?.id ?? null,
      playbookId: playbook.id,
      runId: run?.id ?? null,
      demoSeedId: seedId,
    },
    validationErrors: [],
    generatedBy: "system",
    model: null,
    approvalCheckpointId: auditApproval.id,
  });

  const localExportPackage: any = await repo.createLocalExportPackage(
    ctx,
    matter.id,
    { approvalCheckpointId: auditApproval.id, includeChunks: true },
  );
  const durableEvalExport: any = await repo.createDurableEvalExport(
    ctx,
    matter.id,
    { approvalCheckpointId: evalApproval.id, includeClosed: true },
  );

  await repo.createWorkProduct(ctx, matter.id, {
    kind: "final_memo",
    title: "Private Contract Review Demo Final Memo",
    status: "approved",
    schemaVersion: "aletheia-final-memo-v0",
    content: {
      summary:
        "Demo final memo approved for local workflow inspection only; it is not legal advice.",
      sourceDraftMemoId: draftMemo?.id ?? null,
      unresolvedLimitations: ["Schedule 4.2 remains a demo blocker."],
      gateResults: [
        {
          id: "demo-citation-gate",
          matter_id: matter.id,
          gate_type: "citation",
          status: "passed",
          reason: "Demo memo claims are linked to local source evidence.",
          affected_artifact_ids: [draftMemo?.id, evidenceItems[0]?.id].filter(
            Boolean,
          ),
        },
        {
          id: "demo-human-approval-gate",
          matter_id: matter.id,
          gate_type: "human_approval",
          status: "passed",
          reason: "Demo final memo export was approved by the local reviewer.",
          affected_artifact_ids: [draftMemo?.id, finalMemoApproval.id].filter(
            Boolean,
          ),
        },
        {
          id: "demo-export-gate",
          matter_id: matter.id,
          gate_type: "export",
          status: "passed",
          reason: "Demo final memo export is authorized for local inspection.",
          affected_artifact_ids: [draftMemo?.id, finalMemoApproval.id].filter(
            Boolean,
          ),
        },
      ],
      gateProvenance: [
        {
          gate_id: "demo-citation-gate",
          gate_type: "citation",
          status: "passed",
          displayed_reason: "Source-linked evidence is present.",
          source_record_refs: [
            {
              type: "evidence_item",
              id: evidenceItems[0]?.id,
              role: "provenance",
            },
          ],
          unresolved_source_requirements: [],
        },
        {
          gate_id: "demo-human-approval-gate",
          gate_type: "human_approval",
          status: "passed",
          displayed_reason: "Approved checkpoint is persisted.",
          source_record_refs: [
            {
              type: "human_checkpoint",
              id: finalMemoApproval.id,
              role: "approval",
            },
          ],
          unresolved_source_requirements: [],
        },
        {
          gate_id: "demo-export-gate",
          gate_type: "export",
          status: "passed",
          displayed_reason:
            "Final export is authorized by the same checkpoint.",
          source_record_refs: [
            {
              type: "human_checkpoint",
              id: finalMemoApproval.id,
              role: "approval",
            },
          ],
          unresolved_source_requirements: [],
        },
      ],
      demoSeedId: seedId,
    },
    validationErrors: ["Schedule 4.2 remains a demo blocker."],
    generatedBy: "system",
    model: null,
    approvalCheckpointId: finalMemoApproval.id,
  });

  return {
    matterId: matter.id,
    matterTitle: title,
    documentId: document.id,
    evidenceCount: evidenceItems.length,
    issueMapId: issueMap?.id ?? null,
    evidenceMatrixId: matrix?.id ?? null,
    draftMemoId: draftMemo?.id ?? null,
    reviewId: review?.id ?? null,
    auditPackId: auditPack?.id ?? null,
    localExportId: localExportPackage?.export_id ?? null,
    durableEvalExportId: durableEvalExport?.export_id ?? null,
  };
}

export async function seedAletheiaDemoIfNeeded() {
  const ctx = localUserContext();
  const repo = createAletheiaRepository();
  const decision = await seedDecision(repo, ctx);
  if (!decision.shouldSeed) {
    const matters = await repo.listMatters(ctx);
    const existing = existingDemoMatter(matters, demoSeedId());
    return {
      seeded: false,
      reason: decision.reason,
      ...(existing?.id ? { matterId: existing.id } : {}),
      ...(existing?.title ? { matterTitle: existing.title } : {}),
    };
  }
  const result = await seedAletheiaDemoMatter(repo, ctx);
  return { seeded: true, reason: decision.reason, ...result };
}
