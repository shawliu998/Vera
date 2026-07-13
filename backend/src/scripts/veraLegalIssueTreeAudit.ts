import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";

type RecordValue = Record<string, any>;

async function request(
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? (JSON.parse(text) as RecordValue) : {} };
}

async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "vera-legal-issue-tree-"));
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "issue-tree-auditor";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "issue-tree-auditor@vera.local";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  let server: http.Server | null = null;
  try {
    const [{ createAletheiaRepository }, { createLegalResearchIssuesRouter }] = await Promise.all([
      import("../lib/aletheia"),
      import("../routes/legalResearchIssues"),
    ]);
    const repo = createAletheiaRepository();
    const ctx = { userId: "issue-tree-auditor", userEmail: "issue-tree-auditor@vera.local" };
    const foreignCtx = { userId: "foreign-issue-tree-user", userEmail: "foreign@vera.local" };
    const createMatter = async (owner: typeof ctx, title: string) => repo.createMatter(owner, {
      title,
      objective: "Legal issue tree audit.",
      template: "civil_litigation",
      status: "in_progress",
      riskLevel: "high",
      clientOrProject: "Vera audit",
      sourceProjectId: null,
      sharedWith: [],
      metadata: {},
    }) as Promise<RecordValue>;
    const createResearchRequest = async (owner: typeof ctx, matterId: string) => repo.createWorkProduct(owner, matterId, {
      kind: "legal_research_request",
      title: "Research request",
      status: "draft",
      schemaVersion: "vera-legal-research-request-v1",
      content: {
        schemaVersion: "vera-legal-research-request-v1",
        request: {
          title: "Contract termination research",
          facts: "CONFIDENTIAL FACTS MUST NOT APPEAR IN ISSUE TREE AUDIT EVENTS",
          jurisdiction: "PRC",
          asOfDate: "2026-07-12",
          question: "When can a buyer terminate after late delivery?",
        },
        networkStatus: "not_dispatched",
      },
      validationErrors: [],
      generatedBy: "human",
      model: null,
    }) as Promise<RecordValue>;

    const matter = await createMatter(ctx, "Issue tree owner matter");
    const researchRequest = await createResearchRequest(ctx, matter.id);
    const malformedRequest = await repo.createWorkProduct(ctx, matter.id, {
      kind: "legal_research_request",
      title: "Malformed research request",
      status: "draft",
      schemaVersion: "vera-legal-research-request-v1",
      content: {
        schemaVersion: "vera-legal-research-request-v1",
        request: {
          title: "Malformed request",
          facts: "A fact",
          jurisdiction: "PRC",
          asOfDate: "not-a-date",
          question: "A question",
        },
      },
      validationErrors: [],
      generatedBy: "human",
      model: null,
    }) as RecordValue;
    const foreignMatter = await createMatter(foreignCtx, "Foreign issue tree matter");
    const foreignRequest = await createResearchRequest(foreignCtx, foreignMatter.id);

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/aletheia", createLegalResearchIssuesRouter());
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const root = `/aletheia/matters/${matter.id}/research/requests/${researchRequest.id}/issues`;
    const tree = {
      nodes: [
        { id: "root", parentId: null, title: "Termination", status: "open", order: 0 },
        { id: "late-delivery", parentId: "root", title: "Late delivery", description: "Assess materiality.", status: "needs_material", order: 0 },
        { id: "notice", parentId: "root", title: "Notice", status: "resolved", order: 1 },
      ],
    };
    const created = await request(baseUrl, root, { method: "POST", body: tree });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.kind, "legal_research_issue_tree");
    assert.equal(created.body.content.requestId, researchRequest.id);
    assert.equal(created.body.content.tree.nodeCount, 3);
    assert.equal(created.body.content.tree.maxDepth, 2);
    assert.match(created.body.content.tree.treeHash, /^sha256:[a-f0-9]{64}$/);
    const issueTreeId = created.body.id as string;

    const latest = await request(baseUrl, root);
    assert.equal(latest.response.status, 200);
    assert.equal(latest.body.id, issueTreeId);

    const malformed = await request(baseUrl, root, {
      method: "POST",
      body: { nodes: [{ id: "root", parentId: null, title: "Root", status: "open", order: "zero" }] },
    });
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.code, "invalid_issue_tree");

    const malformedRequestRejected = await request(
      baseUrl,
      `/aletheia/matters/${matter.id}/research/requests/${malformedRequest.id}/issues`,
      { method: "POST", body: tree },
    );
    assert.equal(malformedRequestRejected.response.status, 409);
    assert.equal(malformedRequestRejected.body.code, "invalid_state");

    const cyclic = await request(baseUrl, root, {
      method: "POST",
      body: { nodes: [
        { id: "root", parentId: null, title: "Root", status: "open", order: 0 },
        { id: "a", parentId: "b", title: "A", status: "open", order: 0 },
        { id: "b", parentId: "a", title: "B", status: "open", order: 0 },
      ] },
    });
    assert.equal(cyclic.response.status, 400);
    assert.equal(cyclic.body.code, "invalid_issue_tree");

    const noRoot = await request(baseUrl, root, {
      method: "POST",
      body: { nodes: [
        { id: "a", parentId: "b", title: "A", status: "open", order: 0 },
        { id: "b", parentId: "a", title: "B", status: "open", order: 0 },
      ] },
    });
    assert.equal(noRoot.response.status, 400);
    assert.equal(noRoot.body.code, "invalid_issue_tree");

    const foreignRequestRejected = await request(
      baseUrl,
      `/aletheia/matters/${matter.id}/research/requests/${foreignRequest.id}/issues`,
      { method: "POST", body: tree },
    );
    assert.equal(foreignRequestRejected.response.status, 404);
    const foreignMatterRejected = await request(
      baseUrl,
      `/aletheia/matters/${foreignMatter.id}/research/requests/${foreignRequest.id}/issues`,
    );
    assert.equal(foreignMatterRejected.response.status, 404);

    const reloaded = createAletheiaRepository();
    const reloadedDetail = await reloaded.getMatterDetail(ctx, matter.id) as RecordValue;
    const persisted = reloadedDetail.workProducts.find((product: RecordValue) => product.id === issueTreeId);
    assert(persisted, "issue tree must survive a repository reload");
    assert.deepEqual(persisted.content.tree.nodes, created.body.content.tree.nodes);

    const db = new LocalDatabase(path.join(dataDir, "aletheia.db"), { readOnly: true });
    try {
      const row = db.prepare(
        "select details from aletheia_audit_events where action = 'legal_research_issue_tree_recorded' and matter_id = ?",
      ).get(matter.id) as { details: string } | undefined;
      assert(row, "issue tree audit event must be persisted");
      const details = JSON.parse(row.details) as RecordValue;
      assert.deepEqual(details.statusCounts, { open: 1, resolved: 1, needs_material: 1 });
      assert.equal(details.nodeCount, 3);
      assert.equal(details.maxDepth, 2);
      assert.match(details.treeHash, /^sha256:[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(details).includes("Termination"), false);
      assert.equal(JSON.stringify(details).includes("CONFIDENTIAL"), false);
    } finally {
      db.close();
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      suite: "vera-legal-issue-tree-audit-v1",
      checks: [
        "complete lawyer-supplied local issue tree",
        "bounded tree validation",
        "malformed research-request rejection",
        "cycle and root rejection",
        "matter and request isolation",
        "immutable work-product reload",
        "counts-and-hashes-only audit",
      ],
    })}\n`);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
