import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

const dataDir = mkdtempSync(path.join(tmpdir(), "aletheia-review-resolution-"));

process.env.ALETHEIA_DATA_DIR = dataDir;
process.env.ALETHEIA_AUTH_MODE = "single_user";
process.env.ALETHEIA_LOCAL_USER_ID = "review-resolution-audit-user";

type JsonResponse = Record<string, any>;

async function jsonFetch(url: string, init?: RequestInit) {
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
    response.ok,
    true,
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
  const ctx = { userId: "review-resolution-audit-user" };
  const matter = (await repo.createMatter(ctx, {
    title: "Review Resolution Audit Matter",
    objective: "Verify durable local review resolution and eval persistence.",
    template: "legal_matter_review",
    status: "active",
    riskLevel: "high",
    clientOrProject: "Local V1",
    sourceProjectId: null,
    sharedWith: [],
    metadata: { localOnly: true },
  })) as { id: string };

  const missingCitationReview = (await repo.addReview(ctx, matter.id, {
    targetType: "claim",
    targetId: "claim-missing-citation",
    tag: "needs_human_judgment",
    comment:
      "This claim is missing a citation and source-linked evidence before export.",
    workProductId: null,
    evidenceItemId: null,
    reviewerName: "Local Expert",
  })) as { id: string };

  const app = express();
  app.use(express.json());
  app.use("/aletheia", aletheiaRouter);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/aletheia`;

  try {
    const apiResolution = await jsonFetch(
      `${baseUrl}/matters/${matter.id}/reviews/${missingCitationReview.id}/resolution`,
      {
        method: "POST",
        body: JSON.stringify({
          status: "needs_material",
          comment: "Request the missing source citation before relying on it.",
        }),
      },
    );
    assert.equal(apiResolution.review.resolution_status, "needs_material");
    assert.equal(
      apiResolution.auditEvent.action,
      "review_resolution_recorded",
    );
    assert.equal(apiResolution.evalCase.failure_type, "missing_citation");

    const wrongRiskReview = (await repo.addReview(ctx, matter.id, {
      targetType: "memo_section",
      targetId: "risk-section",
      tag: "needs_human_judgment",
      comment:
        "Risk level is too low; severity should remain high until expert override is incorporated.",
      workProductId: null,
      evidenceItemId: null,
      reviewerName: "Local Expert",
    })) as { id: string };

    const repoResolution = (await repo.resolveReview(
      ctx,
      matter.id,
      wrongRiskReview.id,
      {
        status: "rejected",
        comment: "Reject the current risk rating and preserve high severity.",
      },
    )) as { review: any; auditEvent: any; evalCase: any };
    assert.equal(repoResolution.review.resolution_status, "rejected");
    assert.equal(repoResolution.evalCase.failure_type, "wrong_risk_level");

    const evalPayload = await jsonFetch(`${baseUrl}/matters/${matter.id}/eval-cases`);
    assert.equal(evalPayload.local_only, true);
    assert.equal(evalPayload.eval_cases.length, 2);
    assert.deepEqual(
      evalPayload.eval_cases
        .map((item: { failure_type: string }) => item.failure_type)
        .sort(),
      ["missing_citation", "wrong_risk_level"],
    );

    const detail = (await repo.getMatterDetail(ctx, matter.id)) as {
      reviews: any[];
      evalCases: any[];
      auditEvents: any[];
    };
    assert.equal(detail.reviews.length, 2);
    assert.equal(detail.evalCases.length, 2);
    assert.equal(
      detail.auditEvents.filter(
        (event) => event.action === "review_resolution_recorded",
      ).length,
      2,
    );
    assert.ok(
      detail.evalCases.every(
        (item) =>
          item.input_snapshot.source_audit_event_id ||
          item.source_audit_event_id,
      ),
      "eval cases should preserve audit provenance",
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
