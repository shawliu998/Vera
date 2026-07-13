import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { readProtectedLocalFileSync } from "../lib/aletheia/localEnvelopeCrypto";

const dataDir = mkdtempSync(
  path.join(tmpdir(), "aletheia-local-export-routes-"),
);

process.env.ALETHEIA_DATA_DIR = dataDir;
process.env.ALETHEIA_AUTH_MODE = "single_user";
process.env.ALETHEIA_LOCAL_USER_ID = "local-export-route-audit-user";

type JsonResponse = Record<string, any>;

async function jsonFetch(
  url: string,
  init?: RequestInit,
  expectedStatus = 200,
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as JsonResponse;
  assert.equal(
    response.status,
    expectedStatus,
    `HTTP ${response.status} ${response.statusText}: ${JSON.stringify(body)}`,
  );
  return body;
}

async function main() {
  const { LocalAletheiaRepository } =
    await import("../lib/aletheia/localRepository");
  const { aletheiaRouter } = await import("../routes/aletheia");
  const repo = new LocalAletheiaRepository();
  const ctx = { userId: "local-export-route-audit-user" };
  const matter = (await repo.createMatter(ctx, {
    title: "Local Export Route Audit Matter",
    objective:
      "Verify local audit package and durable eval export routes are approval-gated and persisted.",
    template: "contract_review",
    status: "active",
    riskLevel: "high",
    clientOrProject: "Local V1",
    sourceProjectId: null,
    sharedWith: [],
    metadata: { localOnly: true },
  })) as { id: string };

  await repo.uploadMatterDocument(ctx, matter.id, {
    filename: "private-contract.txt",
    mimeType: "text/plain",
    sizeBytes: 122,
    buffer: Buffer.from(
      "Section 8.2: Any change of control requires prior written consent before closing.",
      "utf8",
    ),
  });

  const review = (await repo.addReview(ctx, matter.id, {
    targetType: "claim",
    targetId: "claim-change-of-control",
    tag: "needs_human_judgment",
    comment:
      "The change-of-control claim needs a specific source citation before export.",
    workProductId: null,
    evidenceItemId: null,
    reviewerName: "Local Expert",
  })) as { id: string };

  await repo.resolveReview(ctx, matter.id, review.id, {
    status: "needs_material",
    comment: "Hold export until the claim is linked to source evidence.",
  });

  const app = express();
  app.use(express.json());
  app.use("/aletheia", aletheiaRouter);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/aletheia`;

  try {
    const blockedAuditExport = await jsonFetch(
      `${baseUrl}/matters/${matter.id}/v1/export-package`,
      {
        method: "POST",
        body: JSON.stringify({ includeChunks: false }),
      },
      409,
    );
    assert.equal(blockedAuditExport.code, "approval_required");

    const auditApproval = (await repo.requestApproval(ctx, matter.id, {
      action: "audit_pack_export",
      prompt: "Approve local audit package export for reviewer handoff.",
      requestedPayload: { localOnly: true },
    })) as { id: string };
    await repo.decideApproval(ctx, matter.id, auditApproval.id, {
      decision: "approved",
      comment: "Approved for local private pilot export.",
    });

    const feedbackApproval = (await repo.requestApproval(ctx, matter.id, {
      action: "feedback_dataset_export",
      prompt: "Approve review-derived eval export for local regression use.",
      requestedPayload: { localOnly: true },
    })) as { id: string };
    await repo.decideApproval(ctx, matter.id, feedbackApproval.id, {
      decision: "approved",
      comment: "Approved for local eval export.",
    });

    const auditExport = await jsonFetch(
      `${baseUrl}/matters/${matter.id}/v1/export-package`,
      {
        method: "POST",
        body: JSON.stringify({
          approvalCheckpointId: auditApproval.id,
          includeChunks: true,
          chunkLimit: 10,
        }),
      },
      201,
    );
    assert.equal(auditExport.local_only, true);
    assert.equal(
      auditExport.gate_authorization.approval_checkpoint_id,
      auditApproval.id,
    );
    assert.match(auditExport.export_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(auditExport.metadata_persisted, true);
    assert.ok(auditExport.audit_event_id);
    assert.ok(existsSync(auditExport.export_path));
    const auditExportFile = JSON.parse(
      readProtectedLocalFileSync({
        filePath: auditExport.export_path,
        purpose: "local_export",
      }).toString("utf8"),
    );
    assert.equal(auditExportFile.export_hash, auditExport.export_hash);
    assert.ok(auditExport.source_index_manifest.counts.documents >= 1);

    const evalExport = await jsonFetch(
      `${baseUrl}/matters/${matter.id}/eval-cases/export`,
      {
        method: "POST",
        body: JSON.stringify({
          approvalCheckpointId: feedbackApproval.id,
          includeClosed: true,
        }),
      },
      201,
    );
    assert.equal(evalExport.local_only, true);
    assert.equal(
      evalExport.gate_authorization.approval_checkpoint_id,
      feedbackApproval.id,
    );
    assert.match(evalExport.export_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(evalExport.metadata_persisted, true);
    assert.ok(evalExport.audit_event_id);
    assert.ok(existsSync(evalExport.export_path));
    assert.equal(evalExport.eval_cases.length, 1);

    const detail = (await repo.getMatterDetail(ctx, matter.id)) as {
      auditEvents: any[];
    };
    assert.ok(
      detail.auditEvents.some(
        (event) => event.action === "local_export_package_created",
      ),
    );
    assert.ok(
      detail.auditEvents.some(
        (event) => event.action === "durable_eval_export_created",
      ),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
