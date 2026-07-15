import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  assertNoVeraTabularSensitiveFields,
  parseVeraTabularCapabilities,
  parseVeraTabularCell,
  parseVeraTabularReview,
  parseVeraTabularReviewDetail,
} from "../src/app/lib/veraTabularApi.ts";
import {
  clampTabularPage,
  tabularPageCount,
  TABULAR_ROWS_PER_PAGE,
} from "../src/app/components/tabular/TRTable.tsx";
import {
  sourceIdentity,
  tabularSourceOffsetLabel,
  tabularSourcePageLabel,
} from "../src/app/components/tabular/citation-utils.ts";

const REVIEW_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "10000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "10000000-0000-4000-8000-000000000003";
const VERSION_ID = "10000000-0000-4000-8000-000000000004";
const CHUNK_ID = "10000000-0000-4000-8000-000000000005";
const MODEL_ID = "10000000-0000-4000-8000-000000000006";
const CELL_ID = "10000000-0000-4000-8000-000000000007";
const NOW = "2026-07-15T10:00:00.000Z";

function reviewWire() {
  return {
    id: REVIEW_ID,
    project_id: PROJECT_ID,
    user_id: USER_ID,
    title: "Contract review",
    columns_config: [
      {
        index: 0,
        name: "Governing law",
        prompt: "Return the governing law and cite the exact clause.",
        format: "text",
        tags: [],
      },
    ],
    document_ids: [DOCUMENT_ID],
    workflow_id: null,
    model_profile_id: MODEL_ID,
    status: "complete",
    practice: null,
    shared_with: [],
    is_owner: true,
    created_at: NOW,
    updated_at: NOW,
    document_count: 1,
  };
}

function sourceWire() {
  return {
    document_id: DOCUMENT_ID,
    version_id: VERSION_ID,
    chunk_id: CHUNK_ID,
    quote: "This agreement is governed by the laws of New York.",
    start_offset: 120,
    end_offset: 172,
    page_start: 4,
    page_end: 4,
  };
}

function cellWire() {
  return {
    id: CELL_ID,
    review_id: REVIEW_ID,
    document_id: DOCUMENT_ID,
    column_index: 0,
    content: {
      summary: "New York law",
      flag: "green",
      reasoning: "The governing-law clause states this expressly.",
    },
    status: "done",
    error: null,
    sources: [sourceWire()],
    attempt: 1,
    created_at: NOW,
    updated_at: NOW,
    completed_at: NOW,
  };
}

function documentWire() {
  return {
    id: DOCUMENT_ID,
    user_id: USER_ID,
    project_id: PROJECT_ID,
    folder_id: null,
    filename: "Agreement.pdf",
    owner_email: null,
    owner_display_name: "Local User",
    file_type: "pdf",
    storage_path: null,
    pdf_storage_path: "local-preview",
    size_bytes: 1024,
    page_count: 12,
    structure_tree: null,
    status: "ready",
    created_at: NOW,
    updated_at: NOW,
    active_version_number: 1,
    latest_version_number: 1,
  };
}

test("Tabular exact contracts accept one complete persisted matrix", () => {
  const review = parseVeraTabularReview(reviewWire());
  const cell = parseVeraTabularCell(cellWire());
  const detail = parseVeraTabularReviewDetail({
    review: reviewWire(),
    cells: [cellWire()],
    documents: [documentWire()],
  });

  assert.equal(review.document_count, 1);
  assert.equal(cell.sources[0]?.quote, sourceWire().quote);
  assert.equal(detail.cells[0]?.content?.summary, "New York law");
  assert.deepEqual(parseVeraTabularCapabilities({ generation: true, chat: false }), {
    generation: true,
    chat: false,
  });
});

test("Tabular contracts reject unknown keys, matrix drift, and unsafe data", () => {
  assert.throws(() =>
    parseVeraTabularReview({ ...reviewWire(), provider_payload: {} }),
  );
  assert.throws(() =>
    parseVeraTabularReview({ ...reviewWire(), document_count: 2 }),
  );
  assert.throws(() =>
    parseVeraTabularReview({
      ...reviewWire(),
      columns_config: [
        { ...reviewWire().columns_config[0], index: 1 },
      ],
    }),
  );
  assert.throws(() =>
    parseVeraTabularReviewDetail({
      review: reviewWire(),
      cells: [],
      documents: [documentWire()],
    }),
  );
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      sources: [{ ...sourceWire(), document_id: PROJECT_ID }],
    }),
  );
  assert.throws(() =>
    assertNoVeraTabularSensitiveFields({
      error: { message: "Bearer local-secret-token-value" },
    }),
  );
  assert.throws(() =>
    assertNoVeraTabularSensitiveFields({ quote: "See /Users/local/private.txt" }),
  );
  assert.throws(() =>
    assertNoVeraTabularSensitiveFields({
      documents: [{ storage_path: "/private/vera/blob" }],
    }),
  );
});

test("Tabular cell lifecycle invariants fail closed", () => {
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      status: "done",
      content: null,
    }),
  );
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      status: "error",
      content: null,
      error: null,
      completed_at: null,
    }),
  );
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      sources: [{ ...sourceWire(), end_offset: 100 }],
    }),
  );
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      sources: [{ ...sourceWire(), version_id: null }],
    }),
  );
});

test("Tabular pagination keeps large matrices bounded and navigable", () => {
  assert.equal(TABULAR_ROWS_PER_PAGE, 25);
  assert.equal(tabularPageCount(0), 1);
  assert.equal(tabularPageCount(26), 2);
  assert.equal(tabularPageCount(1000), 40);
  assert.equal(clampTabularPage(-4, 1000), 0);
  assert.equal(clampTabularPage(99, 1000), 39);
});

test("structured source labels retain page and exact offset identity", () => {
  const source = parseVeraTabularCell(cellWire()).sources[0]!;
  assert.equal(tabularSourcePageLabel(source), "4");
  assert.equal(tabularSourceOffsetLabel(source), "120–172");
  assert.equal(
    sourceIdentity(source),
    `${DOCUMENT_ID}:${VERSION_ID}:${CHUNK_ID}:120:172`,
  );
});

test("Mike-pinned Tabular client is wired to Vera routes without simulated execution", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const required = [
    "src/app/components/tabular/TRTable.tsx",
    "src/app/components/tabular/TabularCell.tsx",
    "src/app/components/tabular/TabularReviewView.tsx",
    "src/app/components/tabular/AddColumnModal.tsx",
    "src/app/components/tabular/TREditColumnMenu.tsx",
    "src/app/components/tabular/TRSidePanel.tsx",
    "src/app/components/tabular/NewTRModal.tsx",
    "src/app/components/tabular/TabularReviewDetailsModal.tsx",
    "src/app/components/tabular/TabularDocumentsModal.tsx",
    "src/app/components/projects/ProjectReviewsTable.tsx",
    "src/app/components/tabular/citation-utils.ts",
    "src/app/components/tabular/columnFormat.ts",
  ];
  const sources = await Promise.all(
    required.map((file) => readFile(path.join(root, file), "utf8")),
  );
  for (const source of sources) {
    assert.match(source, /e32daad5a4c64a5561e04c53ee12411e3c5e7238/);
  }

  const api = await readFile(
    path.join(root, "src/app/lib/veraTabularApi.ts"),
    "utf8",
  );
  const view = sources[2]!;
  const sidebar = await readFile(
    path.join(root, "src/app/components/vera-shell/VeraSidebar.tsx"),
    "utf8",
  );
  const projectWorkspace = await readFile(
    path.join(root, "src/app/components/projects/ProjectWorkspace.tsx"),
    "utf8",
  );

  assert.match(api, /\/tabular-review\/\$\{safeId\(reviewId/);
  assert.match(api, /streamVeraSse/);
  assert.match(api, /export\.\$\{format\}/);
  assert.match(view, /streamVeraTabularGeneration/);
  assert.match(view, /cancelVeraTabularCell/);
  assert.match(view, /regenerateVeraTabularCell/);
  assert.match(view, /clearVeraTabularCells/);
  assert.match(view, /exportVeraTabularReview/);
  assert.match(view, /runBoundedMutations/);
  assert.match(view, /clearConfirmDocumentIds/);
  assert.match(view, /projectChanged/);
  assert.doesNotMatch(view, /setTimeout|mockData|TRChatPanel|Promise\.allSettled/);
  assert.match(sidebar, /href: "\/tabular-review"/);
  assert.match(projectWorkspace, /\/tabular-reviews/);
});
