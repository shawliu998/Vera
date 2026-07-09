import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

const dataDir = mkdtempSync(
  path.join(tmpdir(), "aletheia-approved-skill-activation-"),
);

process.env.ALETHEIA_DATA_DIR = dataDir;
process.env.ALETHEIA_STORAGE_DRIVER = "local";
process.env.ALETHEIA_AUTH_MODE = "single_user";
process.env.ALETHEIA_LOCAL_USER_ID = "approved-skill-audit-user";

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
  const { LocalAletheiaRepository } = await import(
    "../lib/aletheia/localRepository"
  );
  const { aletheiaRouter } = await import("../routes/aletheia");
  const repo = new LocalAletheiaRepository();
  const ctx = { userId: "approved-skill-audit-user" };
  const matter = (await repo.createMatter(ctx, {
    title: "Approved Skill Activation Audit Matter",
    objective:
      "Verify review-derived eval candidates require explicit local approval before activation.",
    template: "legal_matter_review",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: "Local V1",
    sourceProjectId: null,
    sharedWith: [],
    metadata: { localOnly: true },
  })) as { id: string };

  const review = (await repo.addReview(ctx, matter.id, {
    targetType: "memo_section",
    targetId: "memo-section-source-gap",
    tag: "citation_not_supporting",
    comment:
      "This section needs a pinpoint citation before the conclusion can be reused.",
    workProductId: null,
    evidenceItemId: null,
    reviewerName: "Local Expert",
  })) as { id: string };

  const resolution = (await repo.resolveReview(ctx, matter.id, review.id, {
    status: "needs_material",
    comment: "Add a source-linked remediation gate for this repeated gap.",
    createEvalCase: true,
  })) as { evalCase: { id: string; failure_type: string } };
  assert.ok(resolution.evalCase.id);

  const app = express();
  app.use(express.json());
  app.use("/aletheia", aletheiaRouter);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/aletheia`;

  const candidate = {
    id: "skill-candidate-local-citation-remediation",
    name: "Local Citation Remediation Gate",
    description:
      "Require source-linked remediation before future work reuses unsupported memo sections.",
    trigger_conditions: ["failure_type == missing_citation"],
    required_inputs: ["draft_memo", "review_comment"],
    expected_outputs: ["gate_result", "review_comment"],
    evidence_requirements: [
      "Persist the review-derived eval case ID and source review item.",
    ],
    approval_status: "candidate",
    created_from_eval_case_ids: [resolution.evalCase.id],
    version: "0.1.0",
  };

  try {
    const blocked = await jsonFetch(
      `${baseUrl}/matters/${matter.id}/skills/approve-candidate`,
      {
        method: "POST",
        body: JSON.stringify({
          candidate: {
            ...candidate,
            id: "skill-candidate-missing-eval-provenance",
            created_from_eval_case_ids: [],
          },
          approvalComment: "Approve without eval provenance.",
        }),
      },
      409,
    );
    assert.equal(blocked.code, "approval_required");

    const activation = await jsonFetch(
      `${baseUrl}/matters/${matter.id}/skills/approve-candidate`,
      {
        method: "POST",
        body: JSON.stringify({
          candidate,
          approvalComment:
            "Approved for this local matter after expert review of the eval case.",
        }),
      },
      201,
    );

    assert.equal(activation.schema_version, "aletheia-approved-skill-activation-local-v1");
    assert.equal(activation.local_only, true);
    assert.equal(activation.active, true);
    assert.equal(activation.active_skill.approval_status, "approved");
    assert.equal(activation.active_skill.active, true);
    assert.equal(activation.playbook.status, "approved");
    assert.equal(activation.playbook.approved_by, ctx.userId);
    assert.equal(
      activation.playbook.content.schemaVersion,
      "aletheia-approved-skill-playbook-local-v1",
    );
    assert.equal(activation.playbook.content.professionalSkillId, candidate.id);
    assert.equal(
      activation.playbook.content.professionalSkill.approval_status,
      "approved",
    );
    assert.deepEqual(activation.playbook.content.sourceEvalCaseIds, [
      resolution.evalCase.id,
    ]);
    assert.equal(activation.audit_event.action, "approved_skill_activated");
    assert.equal(activation.audit_event.details.active, true);

    const detail = (await repo.getMatterDetail(ctx, matter.id)) as {
      playbooks: any[];
      auditEvents: any[];
    };
    assert.ok(
      detail.playbooks.some(
        (playbook) =>
          playbook.id === activation.playbook.id &&
          playbook.status === "approved" &&
          playbook.content.professionalSkillId === candidate.id,
      ),
    );
    assert.ok(
      detail.auditEvents.some(
        (event) =>
          event.action === "approved_skill_activated" &&
          event.details.candidateSkillId === candidate.id,
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
