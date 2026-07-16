import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type ProvenanceCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function readText(root: string, relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function fileExists(root: string, relativePath: string) {
  return existsSync(path.join(root, relativePath));
}

function hasAll(source: string, values: string[]) {
  return values.every((value) => source.includes(value));
}

function packageScript(root: string, packagePath: string, script: string) {
  if (!fileExists(root, packagePath)) return false;
  const parsed = JSON.parse(readText(root, packagePath)) as {
    scripts?: Record<string, string>;
  };
  return typeof parsed.scripts?.[script] === "string";
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): ProvenanceCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const documentParser = readText(
    root,
    "backend/src/lib/aletheia/documentParser.ts",
  );
  const localRepository = readText(
    root,
    "backend/src/lib/aletheia/localRepository.ts",
  );
  const domain = readText(root, "backend/src/lib/aletheia/domain.ts");
  const localRegression = readText(
    root,
    "backend/src/scripts/aletheiaLocalRegression.ts",
  );
  const demoSeed = readText(root, "backend/src/lib/aletheia/demoSeed.ts");
  const evidenceUi = [
    "frontend/src/aletheia/types.ts",
    "frontend/src/aletheia/RemoteMatterPage.tsx",
    "frontend/src/aletheia/RemoteMatterSidebar.tsx",
    "frontend/src/aletheia/AletheiaEvidenceRegistry.tsx",
    "frontend/src/aletheia/exports.ts",
  ]
    .map((file) => readText(root, file))
    .join("\n");
  const docs = [
    "README.md",
    "docs/status.md",
    "docs/local_deployment.md",
    "docs/local_first_runtime.md",
    "docs/hybrid_retrieval.md",
    "docs/demo_evidence.md",
    "docs/ui_smoke.md",
    "docs/release_notes_local_first_mvp.md",
  ]
    .filter((file) => fileExists(root, file))
    .map((file) => readText(root, file))
    .join("\n");

  const checks: ProvenanceCheck[] = [
    check(
      "parser-chunk-offsets",
      hasAll(documentParser, [
        "extractMatterDocumentText",
        "chunkMatterDocument",
        "quoteStart",
        "quoteEnd",
        "writeMatterDocumentFile",
        "documentId: string",
      ]),
      "Document parser must extract real text and create chunks with document IDs and quote offsets.",
    ),
    check(
      "local-source-schema",
      hasAll(localRepository, [
        "create table if not exists aletheia_document_chunks",
        "source_chunk_id text",
        "document_id text",
        "quote text not null",
        "quote_start integer",
        "quote_end integer",
        "support_status text not null default 'insufficient'",
        "from aletheia_document_chunks_fts f",
        "and f.matter_id = ?",
      ]),
      "Local SQLite schema and FTS5 search must retain source chunk, document, quote, offset, support status, and matter filter fields.",
    ),
    check(
      "local-map-evidence-from-source",
      hasAll(localRepository, [
        "createEvidenceItem",
        "source.document_id",
        "source.chunk_id",
        "source.text",
        "source.quote_start ?? null",
        "source.quote_end ?? null",
        "sourceChunkId: input.sourceChunkId",
        "documentId: source.document_id",
        "evidence_mapped",
      ]),
      "Local evidence mapping must promote a selected source chunk into a source-linked Evidence Item and audit the mapping.",
    ),
    check(
      "work-products-keep-provenance",
      hasAll(domain, [
        "documentId: stringOrNull(item.document_id)",
        "sourceChunkId: stringOrNull(item.source_chunk_id)",
        "quoteStart: numberOrNull(item.quote_start)",
        "quoteEnd: numberOrNull(item.quote_end)",
        "representativeQuotes",
        "sourceChunkIds",
        "Confirm page, section, and quote offsets",
      ]),
      "Issue maps, evidence matrices, and draft work products must retain source IDs, quote offsets, representative quotes, and review instructions.",
    ),
    check(
      "local-regression-provenance",
      hasAll(localRegression, [
        "TXT document should parse",
        "DOCX document should parse",
        "PDF document should parse",
        "FTS search should find text",
        "Evidence should retain source chunk ID",
        "Evidence should derive claim ID from the source chunk when none is supplied",
        "sourceChunkId: evidence.source_chunk_id",
        "documentId: evidence.document_id",
        "quote: evidence.quote",
        "supportStatus: evidence.support_status",
      ]),
      "Local regression must prove real parsing, FTS search, source-linked evidence, derived claim IDs, and exportable evidence provenance.",
    ),
    check(
      "ui-and-smoke-provenance",
      hasAll(demoSeed, [
        "listV1SourceIndex",
        "includeChunks: true",
        "const evidenceChunks = new Map",
        "sourceChunkId: String(chunk.id)",
        "documentId: document.id",
      ]) &&
        hasAll(evidenceUi, [
          "source_chunk_id",
          "quote_start",
          "quote_end",
          "documentId: string",
          "quote: string",
          "support_status",
          "Source-linked evidence matrix generated",
          "No source-linked evidence mapped yet.",
          "Filter by matter, source, claim, or quote",
        ]),
      "UI smoke and registry/workspace UI must expose source chunk IDs, documents, quote offsets, support status, and quote filters.",
    ),
    check(
      "docs-provenance-posture",
      packageScript(
        root,
        "backend/package.json",
        "check:aletheia:source-provenance",
      ) &&
        hasAll(docs, [
          "source-linked",
          "source chunk",
          "quote offsets",
          "support status",
          "SQLite FTS5",
          "npm run check:aletheia:source-provenance",
        ]),
      "Docs and package scripts must list the source provenance audit and describe source-linked evidence, quote offsets, support status, and SQLite FTS5.",
    ),
  ];

  const failedCritical = checks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = checks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: failedCritical.length === 0,
        suite: "aletheia-source-provenance-audit-v0",
        checkedAt: new Date().toISOString(),
        provenanceScope: [
          "document parser",
          "source chunks",
          "SQLite FTS5",
          "Evidence Items",
          "Issue Map",
          "Evidence Matrix",
          "Draft Memo",
          "UI registries",
          "demo exports",
        ],
        warnings: warnings.length,
        checks,
      },
      null,
      2,
    )}\n`,
  );

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
