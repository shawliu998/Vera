import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import JSZip from "jszip";
import { validateLegalIssueTree } from "../lib/aletheia/legalIssues";
import { LocalAletheiaRepository } from "../lib/aletheia/localRepository";
import { createLegalOpinionsRouter } from "../routes/legalOpinions";

type Row = Record<string, any>;

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

async function mustReject(operation: () => unknown | Promise<unknown>, message: string) {
  await assert.rejects(async () => operation(), message);
}

async function routeRequest(
  baseUrl: string,
  pathname: string,
  body?: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) as Row : {} };
}

async function createAcceptedResearchAnswer(
  repository: LocalAletheiaRepository,
  ctx: { userId: string; userEmail: string },
  suffix: string,
) {
  const matter = await repository.createMatter(ctx, {
    title: `法律意见审计 ${suffix}`,
    objective: "验证已采纳研究结论到法律意见书的受控闭环。",
    template: "civil_litigation",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: "Vera audit",
    sourceProjectId: null,
    sharedWith: [],
    metadata: {},
  }) as Row;
  const request = await repository.createWorkProduct(ctx, matter.id, {
    kind: "legal_research_request", title: `研究请求 ${suffix}`, status: "accepted",
    schemaVersion: "vera-legal-research-request-v1", generatedBy: "human", model: null,
    validationErrors: [], content: { schemaVersion: "vera-legal-research-request-v1" },
  }) as Row;
  const tree = validateLegalIssueTree({
    nodes: [{ id: "root", parentId: null, title: "迟延履行解除合同", description: "民法典规则", status: "open", order: 0 }],
  });
  const issueTree = await repository.createWorkProduct(ctx, matter.id, {
    kind: "legal_research_issue_tree", title: `争点树 ${suffix}`, status: "accepted",
    schemaVersion: "vera-legal-research-issue-tree-v1", generatedBy: "human", model: null,
    validationErrors: [], content: { schemaVersion: "vera-legal-research-issue-tree-v1", requestId: request.id, tree },
  }) as Row;
  const sourceText = `民法典第五百六十三条 ${suffix}`;
  const source = await repository.createWorkProduct(ctx, matter.id, {
    kind: "external_source_workpaper", title: `来源 ${suffix}`, status: "accepted",
    schemaVersion: "vera-legal-source-snapshot-v1", generatedBy: "human", model: null,
    validationErrors: [], content: {
      sourceIdentity: `civil-code-563-${suffix}`,
      snapshot: { contentHash: hash(sourceText), content: sourceText },
    },
  }) as Row;
  const bindingHash = hash(`binding-${suffix}`);
  const manifest = await repository.createWorkProduct(ctx, matter.id, {
    kind: "legal_research_input_manifest", title: `输入清单 ${suffix}`, status: "accepted",
    schemaVersion: "vera-legal-research-input-manifest-v1", generatedBy: "human", model: null,
    validationErrors: [], content: {
      schemaVersion: "vera-legal-research-input-manifest-v1", requestId: request.id,
      issueTreeId: issueTree.id, issueTreeHash: tree.treeHash, bindingHash, excerpts: [],
    },
  }) as Row;
  const answer = await repository.createWorkProduct(ctx, matter.id, {
    kind: "legal_qa_answer", title: `法律研究备忘录 ${suffix}`, status: "needs_review",
    schemaVersion: "vera-legal-research-memo-v1", generatedBy: "human", model: null,
    validationErrors: [], content: {
      schemaVersion: "vera-legal-research-memo-v1", requestId: request.id,
      issueTreeId: issueTree.id, issueTreeHash: tree.treeHash,
      inputManifestId: manifest.id, inputBindingHash: bindingHash,
      sourceSnapshots: [{ sourceIdentity: `civil-code-563-${suffix}`, contentHash: hash(sourceText) }],
      gate: { status: "ready_for_review" },
      findings: [{
        conclusion: "迟延履行致使合同目的不能实现时，可以主张解除合同。",
        confidence: "high", position: "supporting", uncertainty: null,
        citations: [{ snapshotId: source.id, quote: sourceText, sourceType: "statute", effectiveFrom: "2021-01-01", effectiveTo: null, caseVerificationStatus: "not_applicable" }],
      }],
    },
  }) as Row;
  const answerReview = await repository.addReview(ctx, matter.id, {
    targetType: "work_product", targetId: answer.id, workProductId: answer.id,
    evidenceItemId: null, reviewerName: "审核律师", tag: "needs_human_judgment", comment: "研究结论与引用复核。",
  }) as Row;
  await repository.resolveReview(ctx, matter.id, answerReview.id, { status: "accepted", comment: "接受。" });
  await repository.appendAuditEvent(ctx, matter.id, {
    actor: "human", action: "human_note.legal_qa_answer_persisted", workflowVersion: "vera-legal-research-memo-v1", model: null,
    details: { workpaperId: answer.id },
  });
  const accepted = await repository.approveLegalQaAnswer(ctx, matter.id, answer.id) as Row;
  assert.equal(accepted.status, "accepted");
  return { matter, request, tree, issueTree, source, sourceText, answer: accepted };
}

async function approveOpinion(repository: LocalAletheiaRepository, ctx: { userId: string; userEmail: string }, research: Awaited<ReturnType<typeof createAcceptedResearchAnswer>>) {
  const opinion = await repository.createLegalOpinion(ctx, research.matter.id, {
    answerId: research.answer.id,
    cover: { title: "民商事诉讼法律意见书", addressee: "委托人", limitation: "仅供本案内部使用。" },
  }) as Row;
  const review = opinion.review as Row;
  await repository.resolveReview(ctx, research.matter.id, review.id, { status: "accepted", comment: "律师复核通过。" });
  const accepted = await repository.approveLegalOpinion(ctx, research.matter.id, opinion.id) as Row;
  assert.equal(accepted.status, "accepted");
  return { opinion, accepted };
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-legal-opinion-audit-"));
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_LOCAL_USER_ID = "opinion-auditor";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "opinion-auditor@vera.local";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const ctx = { userId: "opinion-auditor", userEmail: "opinion-auditor@vera.local" };
  let server: http.Server | null = null;
  try {
    const repository = new LocalAletheiaRepository();
    const research = await createAcceptedResearchAnswer(repository, ctx, "success");

    await mustReject(
      () => repository.createWorkProduct(ctx, research.matter.id, {
        kind: "legal_opinion", title: "Direct bypass", status: "accepted", schemaVersion: "vera-legal-opinion-v1",
        content: {}, validationErrors: [], generatedBy: "human", model: null,
      }),
      "generic work-product creation must not bypass legal-opinion workflow",
    );
    const unaccepted = await repository.createWorkProduct(ctx, research.matter.id, {
      kind: "legal_qa_answer", title: "未采纳答案", status: "needs_review", schemaVersion: "vera-legal-research-memo-v1",
      content: {}, validationErrors: [], generatedBy: "human", model: null,
    }) as Row;
    await mustReject(() => repository.createLegalOpinion(ctx, research.matter.id, { answerId: unaccepted.id, cover: {} }), "unaccepted answer must be rejected");

    const pending = await repository.createLegalOpinion(ctx, research.matter.id, { answerId: research.answer.id, cover: {} }) as Row;
    await mustReject(() => repository.approveLegalOpinion(ctx, research.matter.id, pending.id), "open opinion review must block approval");
    await repository.resolveReview(ctx, research.matter.id, pending.review.id, { status: "rejected", comment: "拒绝。" });
    await mustReject(() => repository.approveLegalOpinion(ctx, research.matter.id, pending.id), "rejected opinion review must block approval");

    const lifecycle = await approveOpinion(repository, ctx, research);
    const exported = await repository.exportLegalOpinionDocx(ctx, research.matter.id, lifecycle.opinion.id) as Row;
    const downloaded = await repository.downloadLegalOpinionDocx(ctx, research.matter.id, exported.exportId);
    assert.ok(downloaded?.bytes.subarray(0, 2).equals(Buffer.from("PK")), "approved DOCX must be readable");
    const docx = await JSZip.loadAsync(downloaded!.bytes);
    const documentXml = await docx.file("word/document.xml")?.async("string");
    const headerXml = await docx.file("word/header1.xml")?.async("string");
    assert.match(documentXml ?? "", /法律意见书/, "DOCX must use the dedicated legal-opinion title");
    assert.match(documentXml ?? "", /迟延履行致使合同目的不能实现/, "DOCX must contain only the accepted conclusion");
    assert.match(documentXml ?? "", /民法典第五百六十三条/, "DOCX must retain the accepted exact quotation");
    assert.match(headerXml ?? "", /Vera/, "DOCX must use the Vera running header");
    assert.doesNotMatch(documentXml ?? "", /Local litigation workspace/, "DOCX must not fall back to the generic litigation-workpaper renderer");

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/aletheia", createLegalOpinionsRouter({ createRepository: () => repository }));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const rootPath = `/aletheia/matters/${research.matter.id}`;
    const routeOpinion = await routeRequest(baseUrl, `${rootPath}/legal-opinions`, {
      answerId: research.answer.id,
      cover: { title: "路由法律意见书", addressee: "委托人" },
    });
    assert.equal(routeOpinion.response.status, 201, "legal-opinion route must persist an eligible answer binding");
    const routeOpinionId = String(routeOpinion.body.id);
    const routeReviewId = String((routeOpinion.body.review as Row).id);
    await repository.resolveReview(ctx, research.matter.id, routeReviewId, { status: "accepted", comment: "路由审核通过。" });
    const routeApproved = await routeRequest(baseUrl, `${rootPath}/legal-opinions/${routeOpinionId}/approve`);
    assert.equal(routeApproved.response.status, 200, "legal-opinion route must require and record approval");
    const routeExport = await routeRequest(baseUrl, `${rootPath}/legal-opinions/${routeOpinionId}/docx`);
    assert.equal(routeExport.response.status, 201, "legal-opinion route must create an approval-bound DOCX export");
    const routeDownload = await fetch(`${baseUrl}${rootPath}/legal-opinion-exports/${String(routeExport.body.exportId)}/download`);
    assert.equal(routeDownload.status, 200, "legal-opinion route must serve its exact approved export");
    assert.equal(routeDownload.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.deepEqual(new Uint8Array((await routeDownload.arrayBuffer()).slice(0, 2)), Uint8Array.from([0x50, 0x4b]));
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;

    const restarted = new LocalAletheiaRepository();
    const afterRestart = await restarted.downloadLegalOpinionDocx(ctx, research.matter.id, exported.exportId);
    assert.equal(afterRestart?.contentHash, lifecycle.accepted.content_hash, "export must survive repository restart");

    const otherMatter = await restarted.createMatter(ctx, {
      title: "隔离事项", objective: "隔离", template: "civil_litigation", status: "in_progress", riskLevel: "low",
      clientOrProject: null, sourceProjectId: null, sharedWith: [], metadata: {},
    }) as Row;
    await mustReject(() => restarted.createLegalOpinion(ctx, otherMatter.id, { answerId: research.answer.id, cover: {} }), "cross-matter answer binding must fail");
    assert.equal(await restarted.getMatterDetail({ userId: "another-user" }, research.matter.id), null, "cross-user matter access must remain isolated");

    const bypass = await restarted.createLegalOpinion(ctx, research.matter.id, { answerId: research.answer.id, cover: {} }) as Row;
    (restarted as any).db.prepare("update aletheia_work_products set status = 'accepted' where id = ?").run(bypass.id);
    await mustReject(() => restarted.approveLegalOpinion(ctx, research.matter.id, bypass.id), "direct accepted status bypass must fail without approval audit");

    const sourceChanged = await createAcceptedResearchAnswer(restarted, ctx, "source-change");
    const sourceOpinion = await approveOpinion(restarted, ctx, sourceChanged);
    await restarted.createWorkProduct(ctx, sourceChanged.matter.id, {
      kind: "external_source_workpaper", title: "更新来源", status: "accepted", schemaVersion: "vera-legal-source-snapshot-v1",
      content: { sourceIdentity: `civil-code-563-source-change`, snapshot: { contentHash: hash("changed"), content: "changed" } }, validationErrors: [], generatedBy: "human", model: null,
    });
    await mustReject(() => restarted.exportLegalOpinionDocx(ctx, sourceChanged.matter.id, sourceOpinion.opinion.id), "changed legal source must block export");

    const treeChanged = await createAcceptedResearchAnswer(restarted, ctx, "tree-change");
    const treeOpinion = await approveOpinion(restarted, ctx, treeChanged);
    const replacementTree = validateLegalIssueTree({
      nodes: [{ id: "root", parentId: null, title: "更新后的解除合同争点", description: "范围变更", status: "open", order: 0 }],
    });
    await restarted.createWorkProduct(ctx, treeChanged.matter.id, {
      kind: "legal_research_issue_tree", title: "更新争点树", status: "accepted", schemaVersion: "vera-legal-research-issue-tree-v1",
      content: { schemaVersion: "vera-legal-research-issue-tree-v1", requestId: treeChanged.request.id, tree: replacementTree }, validationErrors: [], generatedBy: "human", model: null,
    });
    await mustReject(() => restarted.exportLegalOpinionDocx(ctx, treeChanged.matter.id, treeOpinion.opinion.id), "changed issue tree must block export");

    (restarted as any).db.prepare("update aletheia_work_products set content_hash = 'sha256:deadbeef' where id = ?").run(lifecycle.opinion.id);
    await mustReject(() => restarted.downloadLegalOpinionDocx(ctx, research.matter.id, exported.exportId), "tampered opinion hash must block download");
    console.log("vera legal opinion audit passed");
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
