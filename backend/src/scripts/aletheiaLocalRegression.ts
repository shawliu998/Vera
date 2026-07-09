import "dotenv/config";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Document as DocxDocument, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  ApprovalRequiredError,
  CapabilityNotAvailableError,
} from "../lib/aletheia/repository";
import type { AletheiaUserContext } from "../lib/aletheia/repository";
import { requireAuth } from "../middleware/auth";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSpecialistToolPolicy(run: any) {
  const expectedRoles = new Set([
    "Intake Parser",
    "Evidence Mapper",
    "Memo Drafter",
    "Risk Reviewer",
    "Export Controller",
  ]);
  const observedRoles = new Set(
    run.steps
      .map((step: any) => step.output?.specialistRole)
      .filter((role: unknown): role is string => typeof role === "string"),
  );
  for (const role of expectedRoles) {
    assert(observedRoles.has(role), `Agent run should expose ${role} role`);
  }
  for (const step of run.steps) {
    const allowedTools = step.output?.allowedTools;
    if (!Array.isArray(allowedTools)) continue;
    const tools = run.tool_calls
      .filter((call: any) => call.step_id === step.id)
      .map((call: any) => call.tool_name);
    for (const tool of tools) {
      assert(
        allowedTools.includes(tool),
        `Specialist step ${step.step_key} should not call ${tool}`,
      );
    }
  }
}

function assertWorkflowGraph(run: any, options: { resumed?: boolean } = {}) {
  const graph = run.metadata?.workflowGraph;
  assert(
    graph?.schemaVersion === "aletheia-workflow-graph-v0",
    "Agent run should expose workflow graph",
  );
  assert(Array.isArray(graph.nodes), "Workflow graph should include nodes");
  assert(Array.isArray(graph.edges), "Workflow graph should include edges");
  assert(
    graph.nodes.some((node: any) => node.key === "human_review"),
    "Workflow graph should include human review node",
  );
  assert(
    graph.edges.some(
      (edge: any) =>
        edge.to === "audit_export_gate" &&
        edge.condition === "requires_human_approval",
    ),
    "Workflow graph should mark audit export as approval-gated",
  );
  assert(
    graph.controls?.defaultToolPolicy === "allowlist_per_step",
    "Workflow graph should expose allowlist tool policy",
  );
  if (options.resumed) {
    assert(
      graph.nodes.some((node: any) =>
        String(node.key).startsWith("resume_after_human_checkpoint_"),
      ),
      "Resumed workflow graph should include resume node",
    );
    assert(
      graph.edges.some((edge: any) => edge.condition === "return_to_review"),
      "Resumed workflow graph should return to human review",
    );
  }
}

function textContent(result: any) {
  return (
    result.content?.find((item: { type?: string }) => item.type === "text")
      ?.text ?? ""
  );
}

function escapePdfText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function createPdfFixture(text: string) {
  const content = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

async function createDocxFixture(text: string) {
  const doc = new DocxDocument({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun(text)],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function createXlsxFixture() {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Obligations");
  worksheet.addRow(["Clause", "Owner", "Deadline"]);
  worksheet.addRow([
    "Escrow source code release",
    "Vendor",
    "Bankruptcy trigger",
  ]);
  worksheet.addRow(["Incident notice", "Vendor", "48 hours"]);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function runMcpSmoke(dataDir: string, expectedMatterTitle: string) {
  const client = new Client({
    name: "aletheia-local-regression",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: "npm",
    args: ["run", "mcp:aletheia"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ALETHEIA_STORAGE_DRIVER: "local",
      ALETHEIA_AUTH_MODE: "single_user",
      ALETHEIA_DATA_DIR: dataDir,
      ALETHEIA_LOCAL_USER_ID: "local-user",
      ALETHEIA_LOCAL_USER_EMAIL: "local@aletheia.internal",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert(tools.tools.length === 8, "MCP should expose exactly 8 tools");
    assert(
      tools.tools.some((tool) => tool.name === "search_matter_documents"),
      "MCP search_matter_documents tool should be present",
    );

    const listResult = await client.callTool({
      name: "list_matters",
      arguments: {},
    });
    const matters = JSON.parse(textContent(listResult)) as Array<{
      id: string;
      title: string;
    }>;
    const matter = matters.find((item) => item.title === expectedMatterTitle);
    assert(matter, "MCP list_matters should include regression matter");

    const readResult = await client.callTool({
      name: "read_matter",
      arguments: { matterId: matter.id },
    });
    const detail = JSON.parse(textContent(readResult));
    assert(
      detail.matter.title === expectedMatterTitle,
      "MCP read_matter should return the seeded matter",
    );
  } finally {
    await client.close();
  }
}

async function runPrivateTokenAuthSmoke() {
  const previousAuthMode = process.env.ALETHEIA_AUTH_MODE;
  const previousPrivateToken = process.env.ALETHEIA_PRIVATE_AUTH_TOKEN;
  const previousUserId = process.env.ALETHEIA_LOCAL_USER_ID;
  const previousUserEmail = process.env.ALETHEIA_LOCAL_USER_EMAIL;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_PRIVATE_AUTH_TOKEN = "regression-private-token";
  process.env.ALETHEIA_LOCAL_USER_ID = "private-token-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "private-token@aletheia.internal";

  async function invoke(path: string, authorization?: string) {
    let nextCalled = false;
    const response: any = {
      locals: {},
      statusCode: 200,
      body: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    await requireAuth(
      {
        originalUrl: path,
        method: "GET",
        headers: authorization ? { authorization } : {},
      } as any,
      response,
      (() => {
        nextCalled = true;
      }) as any,
    );
    return { nextCalled, response };
  }

  try {
    const missing = await invoke("/aletheia/matters");
    assert(
      !missing.nextCalled && missing.response.statusCode === 401,
      "Aletheia private token auth should reject missing bearer tokens",
    );
    const wrong = await invoke("/aletheia/matters", "Bearer wrong-token");
    assert(
      !wrong.nextCalled && wrong.response.statusCode === 401,
      "Aletheia private token auth should reject invalid bearer tokens",
    );
    const allowed = await invoke(
      "/aletheia/matters",
      "Bearer regression-private-token",
    );
    assert(
      allowed.nextCalled &&
        allowed.response.locals.userId === "private-token-user" &&
        allowed.response.locals.userEmail === "private-token@aletheia.internal",
      "Aletheia private token auth should establish the configured local user",
    );
    const inheritedRoute = await invoke(
      "/projects",
      "Bearer regression-private-token",
    );
    assert(
      !inheritedRoute.nextCalled &&
        [401, 500].includes(inheritedRoute.response.statusCode),
      "Aletheia private token auth must not bypass Supabase auth for inherited routes",
    );
  } finally {
    if (previousAuthMode === undefined) {
      delete process.env.ALETHEIA_AUTH_MODE;
    } else {
      process.env.ALETHEIA_AUTH_MODE = previousAuthMode;
    }
    if (previousPrivateToken === undefined) {
      delete process.env.ALETHEIA_PRIVATE_AUTH_TOKEN;
    } else {
      process.env.ALETHEIA_PRIVATE_AUTH_TOKEN = previousPrivateToken;
    }
    if (previousUserId === undefined) {
      delete process.env.ALETHEIA_LOCAL_USER_ID;
    } else {
      process.env.ALETHEIA_LOCAL_USER_ID = previousUserId;
    }
    if (previousUserEmail === undefined) {
      delete process.env.ALETHEIA_LOCAL_USER_EMAIL;
    } else {
      process.env.ALETHEIA_LOCAL_USER_EMAIL = previousUserEmail;
    }
  }
}

async function runTemplateWorkProductSmoke(args: {
  repo: ReturnType<typeof createAletheiaRepository>;
  ctx: AletheiaUserContext;
  template: string;
  title: string;
  objective: string;
  filename: string;
  text: string;
  searchQuery: string;
  expectedKind: string;
  expectedSchema: string;
  expectedSectionTitle: string;
}) {
  const matter: any = await args.repo.createMatter(args.ctx, {
    title: args.title,
    objective: args.objective,
    template: args.template,
    status: "draft",
    riskLevel: "high",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { regression: true, templateSmoke: true },
  });
  const document: any = await args.repo.uploadMatterDocument(
    args.ctx,
    matter.id,
    {
      filename: args.filename,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(args.text, "utf8"),
      buffer: Buffer.from(args.text, "utf8"),
    },
  );
  assert(
    document.parsed_status === "parsed",
    `${args.template} document should parse`,
  );

  const results: any[] | null = await args.repo.searchMatterDocuments(
    args.ctx,
    matter.id,
    { query: args.searchQuery, limit: 5 },
  );
  assert(
    results && results.length > 0,
    `${args.template} search should find source text`,
  );

  const evidence: any = await args.repo.createEvidenceItem(
    args.ctx,
    matter.id,
    {
      sourceChunkId: results[0].chunk_id,
      relevance: "direct",
      supportStatus: "supports",
      confidence: "high",
      metadata: { regression: true, templateSmoke: true },
    },
  );
  assert(evidence.source_chunk_id, `${args.template} evidence should map`);

  const issueMap: any = await args.repo.generateIssueMap(args.ctx, matter.id);
  assert(issueMap.kind === "issue_map", `${args.template} issue map persists`);
  const matrix: any = await args.repo.generateEvidenceMatrix(
    args.ctx,
    matter.id,
  );
  assert(
    matrix.kind === "evidence_matrix",
    `${args.template} evidence matrix persists`,
  );

  const workProduct: any = await args.repo.generateDraftMemo(
    args.ctx,
    matter.id,
  );
  assert(
    workProduct.kind === args.expectedKind,
    `${args.template} should generate ${args.expectedKind}`,
  );
  assert(
    workProduct.content.schemaVersion === args.expectedSchema,
    `${args.template} work product should expose ${args.expectedSchema}`,
  );
  assert(
    workProduct.content.sections.some(
      (section: any) => section.title === args.expectedSectionTitle,
    ),
    `${args.template} work product should include template-specific sections`,
  );

  const run: any = await args.repo.createAgentRun(args.ctx, matter.id, {
    workflow: args.template,
    goal: `${args.template} template smoke`,
    status: "queued",
    metadata: { regression: true, templateSmoke: true },
  });
  assert(
    run.steps.some(
      (step: any) => step.output?.workProductKind === args.expectedKind,
    ),
    `${args.template} run trace should reference ${args.expectedKind}`,
  );
}

async function main() {
  const dataDir = path.join(
    os.tmpdir(),
    `aletheia-local-regression-${Date.now()}`,
  );
  rmSync(dataDir, { recursive: true, force: true });
  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "local-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "local@aletheia.internal";

  const ctx: AletheiaUserContext = {
    userId: "local-user",
    userEmail: "local@aletheia.internal",
  };
  const repo = createAletheiaRepository();
  const matterTitle = "Aletheia Local Regression Matter";

  await runPrivateTokenAuthSmoke();

  const matter: any = await repo.createMatter(ctx, {
    title: matterTitle,
    objective:
      "Verify local-first professional workflow from source document to audit export.",
    template: "legal_matter_review",
    status: "draft",
    riskLevel: "high",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { regression: true },
  });

  const document: any = await repo.uploadMatterDocument(ctx, matter.id, {
    filename: "synthetic-review-record.txt",
    mimeType: "text/plain",
    sizeBytes: 220,
    buffer: Buffer.from(
      [
        "Synthetic source record for local regression.",
        "The agreement includes a termination clause requiring 30 days notice.",
        "The renewal clause is ambiguous and requires human review.",
      ].join("\n"),
      "utf8",
    ),
  });
  assert(document.parsed_status === "parsed", "TXT document should parse");

  const docxBuffer = await createDocxFixture(
    "Synthetic DOCX fixture states the indemnity covenant survives closing.",
  );
  const docxDocument: any = await repo.uploadMatterDocument(ctx, matter.id, {
    filename: "synthetic-covenant-review.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: docxBuffer.length,
    buffer: docxBuffer,
  });
  assert(docxDocument.parsed_status === "parsed", "DOCX document should parse");

  const pdfBuffer = createPdfFixture(
    "Synthetic PDF fixture states board approval is required before transfer.",
  );
  const pdfDocument: any = await repo.uploadMatterDocument(ctx, matter.id, {
    filename: "synthetic-approval-record.pdf",
    mimeType: "application/pdf",
    sizeBytes: pdfBuffer.length,
    buffer: pdfBuffer,
  });
  assert(pdfDocument.parsed_status === "parsed", "PDF document should parse");

  const xlsxBuffer = await createXlsxFixture();
  const xlsxDocument: any = await repo.uploadMatterDocument(ctx, matter.id, {
    filename: "synthetic-obligations-table.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: xlsxBuffer.length,
    buffer: xlsxBuffer,
  });
  assert(xlsxDocument.parsed_status === "parsed", "XLSX document should parse");
  assert(
    xlsxDocument.metadata.sheetCount === 1,
    "XLSX metadata should preserve sheet count",
  );
  assert(
    xlsxDocument.metadata.sectionCount === 1,
    "XLSX metadata should preserve populated sheet count",
  );

  const scannedPdfBuffer = createPdfFixture("");
  const scannedPdfDocument: any = await repo.uploadMatterDocument(
    ctx,
    matter.id,
    {
      filename: "synthetic-scanned-record.pdf",
      mimeType: "application/pdf",
      sizeBytes: scannedPdfBuffer.length,
      buffer: scannedPdfBuffer,
    },
  );
  assert(
    scannedPdfDocument.parsed_status === "needs_ocr",
    "PDF without a text layer should be marked needs_ocr",
  );
  assert(
    scannedPdfDocument.metadata.needsOcr === true,
    "needs_ocr document metadata should advertise the OCR requirement",
  );
  assert(
    scannedPdfDocument.metadata.chunkCount === 0,
    "needs_ocr document should not create searchable chunks",
  );

  const searchResults: any[] | null = await repo.searchMatterDocuments(
    ctx,
    matter.id,
    { query: "termination notice", limit: 5 },
  );
  assert(
    searchResults && searchResults.length > 0,
    "FTS search should find text",
  );
  assert(
    searchResults[0].retrieval_mode === "keyword",
    "Default retrieval should stay in keyword mode",
  );
  assert(searchResults[0].retrieval_rank === 1, "Top result should be ranked");
  assert(
    searchResults[0].retrieval_score_direction === "lower_is_better",
    "Keyword retrieval should expose BM25 score direction",
  );
  assert(
    searchResults[0].retrieval_explanation?.basis ===
      "SQLite FTS5 BM25 keyword match",
    "Keyword retrieval should expose an audit-readable ranking basis",
  );
  assert(
    typeof searchResults[0].id === "string" &&
      searchResults[0].id.startsWith("retrieval:"),
    "Search result should expose a V1 retrieval result id",
  );
  assert(
    searchResults[0].method === "keyword",
    "Search result should expose the V1 retrieval method",
  );
  assert(
    typeof searchResults[0].quote_preview === "string" &&
      searchResults[0].quote_preview.includes("termination clause"),
    "Search result should expose a V1 quote preview",
  );
  assert(
    searchResults[0].ranking_basis ===
      searchResults[0].retrieval_explanation?.basis,
    "Search result should expose V1 ranking_basis",
  );
  try {
    await repo.searchMatterDocuments(ctx, matter.id, {
      query: "termination notice",
      mode: "semantic",
    });
    throw new Error(
      "Semantic retrieval should fail closed when not configured",
    );
  } catch (error) {
    assert(
      error instanceof CapabilityNotAvailableError,
      "Semantic retrieval should require an explicit configured local index",
    );
  }
  const previousSemanticEnabled = process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED;
  const previousSemanticDriver = process.env.ALETHEIA_SEMANTIC_INDEX_DRIVER;
  try {
    process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED = "true";
    process.env.ALETHEIA_SEMANTIC_INDEX_DRIVER = "local-json";
    const semanticSearch: any[] | null = await repo.searchMatterDocuments(
      ctx,
      matter.id,
      { query: "termination notice", mode: "semantic", limit: 5 },
    );
    assert(
      semanticSearch && semanticSearch.length > 0,
      "Configured local semantic retrieval should find text",
    );
    assert(
      semanticSearch[0].retrieval_layers.includes("local_json_semantic"),
      "Semantic retrieval should report the local JSON semantic layer",
    );
    assert(
      semanticSearch[0].retrieval_score_direction === "higher_is_better",
      "Semantic retrieval should expose score direction",
    );
    assert(
      semanticSearch[0].retrieval_explanation?.basis ===
        "local deterministic token-vector similarity",
      "Semantic retrieval should expose an audit-readable ranking basis",
    );
    const hybridSearch: any[] | null = await repo.searchMatterDocuments(
      ctx,
      matter.id,
      { query: "termination notice", mode: "hybrid", limit: 5 },
    );
    assert(
      hybridSearch && hybridSearch.length > 0,
      "Configured hybrid retrieval should find text",
    );
    assert(
      hybridSearch[0].retrieval_mode === "hybrid",
      "Hybrid retrieval should report hybrid mode",
    );
    assert(
      hybridSearch[0].retrieval_explanation?.layers.includes("sqlite_fts5") ||
        hybridSearch[0].retrieval_explanation?.layers.includes(
          "local_json_semantic",
        ),
      "Hybrid retrieval should expose contributing retrieval layers",
    );
  } finally {
    if (previousSemanticEnabled === undefined) {
      delete process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED;
    } else {
      process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED = previousSemanticEnabled;
    }
    if (previousSemanticDriver === undefined) {
      delete process.env.ALETHEIA_SEMANTIC_INDEX_DRIVER;
    } else {
      process.env.ALETHEIA_SEMANTIC_INDEX_DRIVER = previousSemanticDriver;
    }
  }
  const docxSearch: any[] | null = await repo.searchMatterDocuments(
    ctx,
    matter.id,
    { query: "indemnity covenant", limit: 5 },
  );
  assert(docxSearch && docxSearch.length > 0, "DOCX text should be searchable");
  const pdfSearch: any[] | null = await repo.searchMatterDocuments(
    ctx,
    matter.id,
    { query: "board approval", limit: 5 },
  );
  assert(pdfSearch && pdfSearch.length > 0, "PDF text should be searchable");
  const xlsxSearch: any[] | null = await repo.searchMatterDocuments(
    ctx,
    matter.id,
    { query: "escrow source code release", limit: 5 },
  );
  assert(
    xlsxSearch && xlsxSearch.length > 0,
    "XLSX table text should be searchable",
  );

  const evidence: any = await repo.createEvidenceItem(ctx, matter.id, {
    sourceChunkId: searchResults[0].chunk_id,
    relevance: "direct",
    supportStatus: "supports",
    confidence: "high",
    metadata: { regression: true },
  });
  assert(evidence.source_chunk_id, "Evidence should retain source chunk ID");
  assert(
    searchResults[0].suggested_claim_id === "claim-termination-notice",
    "Search result should include a deterministic claim suggestion",
  );
  assert(
    evidence.claim_id === "claim-termination-notice",
    "Evidence should derive claim ID from the source chunk when none is supplied",
  );
  const sourceIndex: any = await repo.listV1SourceIndex(ctx, matter.id, {
    includeChunks: true,
    includeEvidenceLinks: true,
    chunkLimit: 25,
  });
  assert(sourceIndex, "V1 source index should load for the local matter");
  assert(
    sourceIndex.documents.some(
      (item: any) =>
        item.id === document.id &&
        item.matter_id === matter.id &&
        item.status === "parsed",
    ),
    "V1 source index should include parsed DocumentRecord entries",
  );
  assert(
    sourceIndex.documents.some(
      (item: any) =>
        item.id === scannedPdfDocument.id && item.status === "needs_ocr",
    ),
    "V1 source index should preserve needs_ocr DocumentRecord status",
  );
  assert(
    sourceIndex.chunks.some(
      (item: any) =>
        item.id === searchResults[0].chunk_id &&
        item.document_id === document.id &&
        item.text.includes("termination clause"),
    ),
    "V1 source index should include source DocumentChunk text",
  );
  assert(
    sourceIndex.source_links.some(
      (item: any) =>
        item.evidence_item_id === evidence.id &&
        item.source_chunk_id === searchResults[0].chunk_id,
    ),
    "V1 source index should resolve EvidenceItem source links",
  );

  const issueMap: any = await repo.generateIssueMap(ctx, matter.id);
  assert(issueMap.kind === "issue_map", "Issue map should be generated");
  assert(
    issueMap.content.schemaVersion === "aletheia-issue-map-v0",
    "Issue map should expose schema version",
  );
  assert(
    issueMap.content.issues.some(
      (issue: any) => issue.claimId === "claim-termination-notice",
    ),
    "Issue map should group the mapped claim",
  );
  assert(
    issueMap.content.issues.some(
      (issue: any) => issue.title === "Termination notice requirement",
    ),
    "Issue map should preserve deterministic suggested issue title",
  );
  assert(
    issueMap.content.summary.evidenceItems === 1,
    "Issue map should count source evidence",
  );
  const issueReview: any = await repo.addReview(ctx, matter.id, {
    targetType: "claim",
    targetId: "claim-termination-notice",
    tag: "accepted",
    comment: "Reviewer accepted the source-linked issue map claim.",
    workProductId: issueMap.id,
    evidenceItemId: evidence.id,
    reviewerName: "Regression Reviewer",
  });
  assert(issueReview.tag === "accepted", "Issue review tag should persist");

  const matrix: any = await repo.generateEvidenceMatrix(ctx, matter.id);
  assert(
    matrix.kind === "evidence_matrix",
    "Evidence matrix should be created",
  );
  const draftMemo: any = await repo.generateDraftMemo(ctx, matter.id);
  assert(draftMemo.kind === "draft_memo", "Draft memo should be created");

  const memory: any = await repo.addMatterMemory(ctx, matter.id, {
    category: "confirmed_fact",
    title: "Notice period confirmed",
    body: "The synthetic source record states a 30-day notice period.",
    source: "human",
    metadata: { evidenceId: evidence.id },
  });
  assert(memory.category === "confirmed_fact", "Matter memory should persist");

  const playbook: any = await repo.createPlaybook(ctx, matter.id, {
    name: "Legal Matter Review Playbook",
    description: "Regression playbook",
    version: "v0.1",
    content: {
      format: "markdown",
      body: "Parse source, map evidence, draft memo, require human approval.",
      controls: { agentMayAutoModify: false },
    },
  });
  const approvedPlaybook: any = await repo.approvePlaybook(
    ctx,
    matter.id,
    playbook.id,
  );
  assert(approvedPlaybook.status === "approved", "Playbook should be approved");
  const feedbackMemory: any = await repo.addMatterMemory(ctx, matter.id, {
    category: "reviewer_feedback",
    title: "Reviewer requested stronger overclaim control",
    body: "Require explicit evidence support checks before final memo reliance.",
    source: "review",
    metadata: { regression: true },
  });
  assert(
    feedbackMemory.category === "reviewer_feedback",
    "Reviewer feedback memory should persist",
  );
  const review: any = await repo.addReview(ctx, matter.id, {
    targetType: "memo_section",
    targetId: "memo-review-checklist",
    tag: "overclaim",
    comment: "Draft memo needs a playbook step requiring overclaim checks.",
    workProductId: draftMemo.id,
    evidenceItemId: evidence.id,
    reviewerName: "Regression Reviewer",
  });
  assert(review.tag === "overclaim", "Reviewer overclaim tag should persist");
  const playbookProposal: any = await repo.proposePlaybookImprovement(
    ctx,
    matter.id,
    {
      sourcePlaybookId: approvedPlaybook.id,
      reviewerNote:
        "Add an overclaim verification step before final memo export.",
    },
  );
  assert(
    playbookProposal.status === "draft",
    "Playbook improvement proposal should remain draft",
  );
  assert(
    playbookProposal.content.proposalType === "playbook_improvement",
    "Playbook improvement proposal should be typed",
  );
  assert(
    playbookProposal.content.sourcePlaybookId === approvedPlaybook.id,
    "Playbook proposal should reference the approved source playbook",
  );
  assert(
    playbookProposal.content.sourceReviews.length > 0,
    "Playbook proposal should include source review feedback",
  );
  const detailAfterProposal: any = await repo.getMatterDetail(ctx, matter.id);
  const stillApproved = detailAfterProposal.playbooks.find(
    (item: any) => item.id === approvedPlaybook.id,
  );
  assert(
    stillApproved.status === "approved",
    "Playbook proposal must not mutate the approved source playbook",
  );

  const run: any = await repo.createAgentRun(ctx, matter.id, {
    workflow: "legal_matter_review",
    goal: "Regression run trace",
    status: "queued",
    budget: {
      maxSteps: 7,
      maxToolCalls: 12,
      maxWallTimeMs: 600000,
    },
    metadata: { regression: true },
  });
  assert(run.steps.length > 0, "Agent run should include trace steps");
  assert(run.budget.maxSteps === 7, "Agent run should persist budget");
  assert(
    typeof run.steps[0].metrics === "object",
    "Agent steps should expose metrics",
  );
  assert(
    typeof run.tool_calls[0].metrics === "object",
    "Tool calls should expose metrics",
  );
  assertSpecialistToolPolicy(run);
  assertWorkflowGraph(run);
  const resumeCheckpoint: any = await repo.requestApproval(ctx, matter.id, {
    action: "final_memo_export",
    prompt: "Ask the agent to revise before final memo export.",
    requestedPayload: { regression: true, resume: true },
  });
  await repo.decideApproval(ctx, matter.id, resumeCheckpoint.id, {
    decision: "edited",
    comment: "Revise the draft memo before final export.",
    editedPayload: { requestedChanges: "Add overclaim caveat." },
  });
  const resumedRun: any = await repo.resumeAgentRun(ctx, matter.id, run.id, {
    checkpointId: resumeCheckpoint.id,
    note: "Regression resume after edited checkpoint.",
  });
  assert(resumedRun.status === "needs_human", "Resumed run should need review");
  assert(
    resumedRun.steps.some(
      (step: any) => step.step_key === "resume_after_human_checkpoint",
    ),
    "Resumed run should append a resume step",
  );
  assertSpecialistToolPolicy(resumedRun);
  assertWorkflowGraph(resumedRun, { resumed: true });
  const detailAfterResume: any = await repo.getMatterDetail(ctx, matter.id);
  assert(
    detailAfterResume.workProducts.filter(
      (item: any) => item.kind === "draft_memo",
    ).length >= 2,
    "Resumed run should generate a revised draft memo",
  );
  assert(
    detailAfterResume.auditEvents.some(
      (event: any) => event.action === "agent_run_resumed",
    ),
    "Resumed run should write an audit event",
  );

  let approvalBlocked = false;
  try {
    await repo.createWorkProduct(ctx, matter.id, {
      kind: "audit_pack",
      title: "Blocked Audit Pack",
      status: "generated",
      schemaVersion: "aletheia-audit-pack-v0",
      content: { blocked: true },
      validationErrors: [],
      generatedBy: "agent",
      model: null,
    });
  } catch (error) {
    approvalBlocked = error instanceof ApprovalRequiredError;
  }
  assert(approvalBlocked, "Audit pack should require approval");

  let feedbackApprovalBlocked = false;
  try {
    await repo.createWorkProduct(ctx, matter.id, {
      kind: "feedback_export",
      title: "Blocked Feedback Dataset",
      status: "generated",
      schemaVersion: "aletheia-feedback-eval-v0",
      content: { blocked: true },
      validationErrors: [],
      generatedBy: "agent",
      model: null,
    });
  } catch (error) {
    feedbackApprovalBlocked = error instanceof ApprovalRequiredError;
  }
  assert(
    feedbackApprovalBlocked,
    "Feedback dataset export should require approval",
  );
  let finalMemoApprovalBlocked = false;
  try {
    await repo.createWorkProduct(ctx, matter.id, {
      kind: "final_memo",
      title: "Blocked Final Memo",
      status: "generated",
      schemaVersion: "aletheia-final-memo-v0",
      content: { blocked: true },
      validationErrors: [],
      generatedBy: "agent",
      model: null,
    });
  } catch (error) {
    finalMemoApprovalBlocked = error instanceof ApprovalRequiredError;
  }
  assert(finalMemoApprovalBlocked, "Final memo export should require approval");

  const checkpoint: any = await repo.requestApproval(ctx, matter.id, {
    action: "audit_pack_export",
    prompt: "Approve local regression audit pack export.",
    requestedPayload: { regression: true },
  });
  await repo.decideApproval(ctx, matter.id, checkpoint.id, {
    decision: "approved",
    comment: "Approved for local regression.",
  });
  const auditPack: any = await repo.createWorkProduct(ctx, matter.id, {
    kind: "audit_pack",
    title: "Local Regression Audit Pack",
    status: "generated",
    schemaVersion: "aletheia-audit-pack-v0",
    content: { matterId: matter.id, regression: true },
    validationErrors: [],
    generatedBy: "agent",
    model: null,
    approvalCheckpointId: checkpoint.id,
  });
  assert(auditPack.kind === "audit_pack", "Approved audit pack should persist");

  const feedbackCheckpoint: any = await repo.requestApproval(ctx, matter.id, {
    action: "feedback_dataset_export",
    prompt: "Approve local regression feedback dataset export.",
    requestedPayload: { regression: true, kind: "feedback_export" },
  });
  await repo.decideApproval(ctx, matter.id, feedbackCheckpoint.id, {
    decision: "approved",
    comment: "Approved for local regression eval export.",
  });
  const feedbackExport: any = await repo.createWorkProduct(ctx, matter.id, {
    kind: "feedback_export",
    title: "Local Regression Feedback Dataset",
    status: "generated",
    schemaVersion: "aletheia-feedback-eval-v0",
    content: { matterId: matter.id, regression: true },
    validationErrors: [],
    generatedBy: "agent",
    model: null,
    approvalCheckpointId: feedbackCheckpoint.id,
  });
  assert(
    feedbackExport.kind === "feedback_export",
    "Approved feedback dataset should persist",
  );

  const registrySnapshot: any = await repo.createWorkProduct(ctx, matter.id, {
    kind: "registry_snapshot",
    title: "Local Regression Evidence Registry Snapshot",
    status: "generated",
    schemaVersion: "aletheia-evidence-registry-snapshot-v0",
    content: {
      schemaVersion: "aletheia-evidence-registry-snapshot-v0",
      source: "local_repository",
      filters: { query: "termination", supportStatus: "supports" },
      recordCount: 1,
      records: [
        {
          evidenceItemId: evidence.id,
          sourceChunkId: evidence.source_chunk_id,
          claimId: evidence.claim_id,
          documentId: evidence.document_id,
          quote: evidence.quote,
          supportStatus: evidence.support_status,
        },
      ],
    },
    validationErrors: [],
    generatedBy: "human",
    model: null,
  });
  assert(
    registrySnapshot.kind === "registry_snapshot",
    "Matter-scoped registry snapshots should persist without export approval",
  );

  const finalMemoCheckpoint: any = await repo.requestApproval(ctx, matter.id, {
    action: "final_memo_export",
    prompt: "Ask for edits before final memo export.",
    requestedPayload: { regression: true, kind: "final_memo" },
  });
  const editedCheckpoint: any = await repo.decideApproval(
    ctx,
    matter.id,
    finalMemoCheckpoint.id,
    {
      decision: "edited",
      comment: "Request narrower reliance language.",
      editedPayload: { requestedChange: "Narrow reliance language" },
    },
  );
  assert(
    editedCheckpoint.status === "resolved" &&
      editedCheckpoint.decision === "edited",
    "Edited approval decisions should resolve checkpoints",
  );

  const approvedFinalMemoCheckpoint: any = await repo.requestApproval(
    ctx,
    matter.id,
    {
      action: "final_memo_export",
      prompt: "Approve local regression final memo export.",
      requestedPayload: { regression: true, kind: "final_memo" },
    },
  );
  await repo.decideApproval(ctx, matter.id, approvedFinalMemoCheckpoint.id, {
    decision: "approved",
    comment: "Approved for local regression final memo.",
  });
  let finalMemoGateBlocked = false;
  try {
    await repo.createWorkProduct(ctx, matter.id, {
      kind: "final_memo",
      title: "Gate Blocked Final Memo",
      status: "accepted",
      schemaVersion: "aletheia-final-memo-v0",
      content: {
        sourceDraftMemoId: draftMemo.id,
        gateResults: [
          {
            id: "gate-export-regression",
            matter_id: matter.id,
            gate_type: "export",
            status: "failed",
            reason: "Regression blocked gate",
            affected_artifact_ids: [draftMemo.id],
            required_action: "Resolve regression gate",
            created_at: new Date().toISOString(),
          },
        ],
        gateProvenance: [
          {
            gate_id: "gate-export-regression",
            gate_type: "export",
            status: "failed",
            displayed_reason: "Regression blocked gate",
            source_record_refs: [
              {
                type: "human_checkpoint",
                id: approvedFinalMemoCheckpoint.id,
                role: "approval",
              },
            ],
            unresolved_source_requirements: [],
          },
        ],
      },
      validationErrors: [],
      generatedBy: "human",
      model: null,
      approvalCheckpointId: approvedFinalMemoCheckpoint.id,
    });
  } catch (error) {
    finalMemoGateBlocked = error instanceof ApprovalRequiredError;
  }
  assert(
    finalMemoGateBlocked,
    "Final memo export should require a persisted passing gate snapshot",
  );

  const finalMemo: any = await repo.createWorkProduct(ctx, matter.id, {
    kind: "final_memo",
    title: "Local Regression Final Memo",
    status: "accepted",
    schemaVersion: "aletheia-final-memo-v0",
    content: {
      schemaVersion: "aletheia-final-memo-v0",
      sourceDraftMemoId: draftMemo.id,
      approvalCheckpointId: approvedFinalMemoCheckpoint.id,
      gateResults: [
        {
          id: "gate-citation-regression",
          matter_id: matter.id,
          gate_type: "citation",
          status: "passed",
          reason: "Regression evidence is source-linked.",
          affected_artifact_ids: [evidence.id],
          created_at: new Date().toISOString(),
        },
        {
          id: "gate-human-approval-regression",
          matter_id: matter.id,
          gate_type: "human_approval",
          status: "passed",
          reason: "Regression checkpoint approved.",
          affected_artifact_ids: [draftMemo.id],
          created_at: new Date().toISOString(),
        },
        {
          id: "gate-export-regression",
          matter_id: matter.id,
          gate_type: "export",
          status: "passed",
          reason: "Regression final export is approved and evidence-bound.",
          affected_artifact_ids: [draftMemo.id],
          created_at: new Date().toISOString(),
        },
      ],
      gateProvenance: [
        {
          gate_id: "gate-citation-regression",
          gate_type: "citation",
          status: "passed",
          displayed_reason: "Regression evidence is source-linked.",
          source_record_refs: [
            { type: "matter", id: matter.id, role: "input" },
            { type: "work_product", id: draftMemo.id, role: "input" },
            {
              type: "evidence_item",
              id: evidence.id,
              role: "provenance",
              document_id: evidence.document_id,
              source_chunk_id: evidence.source_chunk_id,
              quote_start: evidence.quote_start,
              quote_end: evidence.quote_end,
              claim_id: evidence.claim_id,
            },
          ],
          unresolved_source_requirements: [],
        },
        {
          gate_id: "gate-human-approval-regression",
          gate_type: "human_approval",
          status: "passed",
          displayed_reason: "Regression checkpoint approved.",
          source_record_refs: [
            { type: "matter", id: matter.id, role: "input" },
            { type: "work_product", id: draftMemo.id, role: "input" },
            {
              type: "human_checkpoint",
              id: approvedFinalMemoCheckpoint.id,
              role: "approval",
            },
          ],
          unresolved_source_requirements: [],
        },
        {
          gate_id: "gate-export-regression",
          gate_type: "export",
          status: "passed",
          displayed_reason: "Regression final export is approved.",
          source_record_refs: [
            { type: "matter", id: matter.id, role: "input" },
            { type: "work_product", id: draftMemo.id, role: "input" },
            {
              type: "human_checkpoint",
              id: approvedFinalMemoCheckpoint.id,
              role: "approval",
            },
          ],
          unresolved_source_requirements: [],
        },
      ],
    },
    validationErrors: [],
    generatedBy: "human",
    model: null,
    approvalCheckpointId: approvedFinalMemoCheckpoint.id,
  });
  assert(finalMemo.kind === "final_memo", "Approved final memo should persist");
  assert(
    typeof finalMemo.content?.persistedGateEvidence
      ?.gateSnapshotAuditEventId === "string",
    "Final memo should retain persisted gate snapshot evidence",
  );

  const detail: any = await repo.getMatterDetail(ctx, matter.id);
  const exportEvent = detail.auditEvents.find(
    (event: any) => event.action === "audit_pack_exported",
  );
  assert(
    typeof exportEvent?.details?.exportPath === "string",
    "Audit event should include export path",
  );
  assert(
    exportEvent?.details?.approvalCheckpointId === checkpoint.id,
    "Audit pack export event should retain the approved checkpoint ID",
  );
  const feedbackExportEvent = detail.auditEvents.find(
    (event: any) => event.action === "feedback_dataset_exported",
  );
  assert(
    feedbackExportEvent?.details?.approvalCheckpointId ===
      feedbackCheckpoint.id,
    "Feedback dataset export event should retain the approved checkpoint ID",
  );
  const registrySnapshotEvent = detail.auditEvents.find(
    (event: any) => event.action === "registry_snapshot_saved",
  );
  assert(
    typeof registrySnapshotEvent?.details?.exportPath === "string",
    "Registry snapshot audit event should include export path",
  );
  const blockedFinalExportEvent = detail.auditEvents.find(
    (event: any) => event.action === "final_export_gate_blocked",
  );
  assert(
    blockedFinalExportEvent?.details?.gateSnapshotAuditEventId,
    "Blocked final memo attempt should retain the persisted gate snapshot event ID",
  );
  const finalMemoExportEvent = detail.auditEvents.find(
    (event: any) => event.action === "final_memo_exported",
  );
  assert(
    finalMemoExportEvent?.details?.approvalCheckpointId ===
      approvedFinalMemoCheckpoint.id,
    "Final memo export event should retain the approved checkpoint ID",
  );
  assert(
    typeof finalMemoExportEvent?.details?.gateSnapshotAuditEventId === "string",
    "Final memo export event should retain the persisted gate snapshot ID",
  );
  assert(
    detail.auditEvents.some(
      (event: any) =>
        event.id ===
          finalMemoExportEvent.details.gateAuthorizationAuditEventId &&
        event.action === "final_export_gate_authorized",
    ),
    "Final memo export should resolve to a gate authorization audit event",
  );

  await runTemplateWorkProductSmoke({
    repo,
    ctx,
    template: "compliance_impact_review",
    title: "Aletheia Local Compliance Regression Matter",
    objective:
      "Verify compliance review can generate a source-linked register from uploaded control evidence.",
    filename: "synthetic-compliance-control.txt",
    text: [
      "Synthetic compliance source record.",
      "The policy requires breach notification within 72 hours after a data security incident.",
      "Control owner evidence is incomplete and requires human review.",
    ].join("\n"),
    searchQuery: "breach notification",
    expectedKind: "compliance_register",
    expectedSchema: "aletheia-compliance-register-v0",
    expectedSectionTitle: "3. Business Impact and Gap Register",
  });

  await runTemplateWorkProductSmoke({
    repo,
    ctx,
    template: "deal_due_diligence",
    title: "Aletheia Local Diligence Regression Matter",
    objective:
      "Verify diligence review can generate a source-linked red flag memo from uploaded VDR evidence.",
    filename: "synthetic-diligence-vdr.txt",
    text: [
      "Synthetic VDR source record.",
      "The target agreement contains a liability cap equal to one month of fees.",
      "Board approval is required before transfer of material customer contracts.",
    ].join("\n"),
    searchQuery: "liability cap",
    expectedKind: "red_flag_memo",
    expectedSchema: "aletheia-red-flag-memo-v0",
    expectedSectionTitle: "3. Contract and Diligence Findings",
  });

  await runMcpSmoke(dataDir, matterTitle);

  console.log(
    JSON.stringify(
      {
        ok: true,
        dataDir,
        matterId: matter.id,
        documentChunks: document.metadata.chunkCount,
        docxChunks: docxDocument.metadata.chunkCount,
        pdfChunks: pdfDocument.metadata.chunkCount,
        evidenceId: evidence.id,
        workProducts: detail.workProducts.length,
        auditEvents: detail.auditEvents.length,
        exportPath: exportEvent.details.exportPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[aletheia-local-regression] failed", error);
  process.exit(1);
});
