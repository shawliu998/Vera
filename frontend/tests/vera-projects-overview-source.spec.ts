import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import {
  deleteVeraDocument,
  listVeraProjects,
  retryVeraDocumentParse,
  uploadVeraDocument,
  uploadVeraDocumentVersion,
} from "../src/app/lib/veraApi.ts";

const LOCKED_MIKE_SHA = "e32daad5a4c64a5561e04c53ee12411e3c5e7238";
const FRONTEND_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(FRONTEND_ROOT, "..");

const SOURCES = {
  page: "frontend/src/app/(pages)/projects/page.tsx",
  overview: "frontend/src/app/components/projects/ProjectsOverview.tsx",
  create: "frontend/src/app/components/projects/NewProjectModal.tsx",
  details: "frontend/src/app/components/projects/ProjectDetailsModal.tsx",
  api: "frontend/src/app/lib/mikeApi.ts",
} as const;

function upstream(sourcePath: string): string {
  return execFileSync("git", ["show", `${LOCKED_MIKE_SHA}:${sourcePath}`], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
}

function current(relativePath: string): string {
  return readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8");
}

function withoutPortHeader(source: string): string {
  return source.replace(
    /\n?\/\/ Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:\n\/\/ frontend\/src\/app\/[^\n]+\n/,
    "\n",
  );
}

function assertInOrder(source: string, fragments: readonly string[]) {
  let cursor = 0;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor);
    assert.notEqual(next, -1, `missing ordered Mike fragment: ${fragment}`);
    cursor = next + fragment.length;
  }
}

function classTokens(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/className="([^"]+)"/g)].flatMap((match) =>
      match[1].split(/\s+/).filter(Boolean),
    ),
  );
}

test("all Project overview ports identify the exact locked Mike source", () => {
  assert.equal(
    execFileSync("git", ["rev-parse", LOCKED_MIKE_SHA], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim(),
    LOCKED_MIKE_SHA,
  );

  for (const [file, sourcePath] of [
    ["src/app/(pages)/projects/page.tsx", SOURCES.page],
    ["src/app/components/projects/ProjectsOverview.tsx", SOURCES.overview],
    ["src/app/components/projects/NewProjectModal.tsx", SOURCES.create],
    ["src/app/components/projects/ProjectDetailsModal.tsx", SOURCES.details],
  ] as const) {
    const source = current(file);
    assert.match(source, new RegExp(LOCKED_MIKE_SHA));
    assert.ok(source.includes(sourcePath));
  }
});

test("the route page is syntax-equivalent after provenance and formatting", () => {
  assert.equal(
    withoutPortHeader(current("src/app/(pages)/projects/page.tsx")).replace(
      /\s+/g,
      " ",
    ),
    upstream(SOURCES.page).replace(/\s+/g, " "),
  );
});

test("ProjectsOverview preserves Mike state, table, row, and modal ordering", () => {
  const source = current("src/app/components/projects/ProjectsOverview.tsx");
  assertInOrder(source, [
    "useEffect, useRef, useState",
    "useRouter",
    "NewProjectModal",
    "ProjectDetailsModal",
    "TableToolbar",
    "RowActionMenuItems",
    "RowActions",
    "PageHeader",
    "TableScrollArea",
    "const [projects",
    "const [loading",
    "const [loadError",
    "const [modalOpen",
    "const [detailsProject",
    "const [activeFilter",
    "const [selectedIds",
    "const [search",
    "const filtered",
    "const allSelected",
    "const someSelected",
    "function toggleAll",
    "function toggleOne",
    "const filters",
    "const toolbarActions",
    "<PageHeader",
    "<TableToolbar",
    "<TableScrollArea>",
    "<TableHeaderRow>",
    "loading ?",
    "loadError ?",
    "filtered.length === 0",
    "filtered.map",
    "<TableRow",
    "<TablePrimaryCell",
    "<RowActions",
    "<NewProjectModal",
    "<ProjectDetailsModal",
  ]);

  const lockedClasses = classTokens(upstream(SOURCES.overview));
  const portClasses = classTokens(source);
  const sharedClasses = [...lockedClasses].filter((token) =>
    portClasses.has(token),
  );
  assert.ok(
    sharedClasses.length >= 35,
    `expected Mike Tailwind lineage, found ${sharedClasses.length} shared tokens`,
  );
});

test("new and details modals preserve Mike's interaction skeleton", () => {
  const create = current("src/app/components/projects/NewProjectModal.tsx");
  assertInOrder(create, [
    'useState<"details" | "documents">',
    "const [name",
    "const [pendingFiles",
    "const [loading",
    "const [error",
    "fileInputRef",
    "handleFileChange",
    "handleSubmit",
    "resetForm",
    "<Modal",
    'type="file"',
    "<form",
    'step === "details"',
  ]);
  assert.match(create, /createVeraProject/);
  assert.match(create, /uploadVeraDocument/);
  assert.match(create, /Promise\.allSettled/);

  const details = current(
    "src/app/components/projects/ProjectDetailsModal.tsx",
  );
  assertInOrder(details, [
    "useEffect",
    "useMemo",
    "useState",
    "nameDraft",
    "descriptionDraft",
    "saving",
    "saved",
    "error",
    "hasChanges",
    "handleSave",
    "<Modal",
  ]);
  assert.match(details, /confirmName !== project(?:\?|)\.name/);
  assert.match(details, /projects\.deleteConfirm\.namePrompt/);
  assert.match(details, /projects\.deleteConfirm\.action/);
  assert.match(details, /onArchive/);
  assert.match(details, /onUnarchive/);
});

test("local adaptations remove cloud UI and keep translated, cancellable actions", () => {
  const source = [
    current("src/app/components/projects/ProjectsOverview.tsx"),
    current("src/app/components/projects/NewProjectModal.tsx"),
    current("src/app/components/projects/ProjectDetailsModal.tsx"),
  ].join("\n");

  assert.doesNotMatch(
    source,
    /AuthContext|useAuth|OwnerOnly|AddUserInput|PeopleModal|UserLookupResult|onShareProject|sharedUsers|shared-with-me|Supabase/i,
  );
  assert.doesNotMatch(source, /window\.(?:confirm|prompt|alert)/);
  assert.doesNotMatch(source, /fixture|mockData|fallbackProject/i);
  assert.doesNotMatch(source, /aletheiaApi|mikeApi/);
  assert.match(source, /useI18n/);
  assert.match(source, /AbortController/);
  assert.match(source, /data-project-modal-autofocus/);
  assert.match(
    current("src/app/components/projects/useProjectModalA11y.ts"),
    /event\.key === "Escape"[\s\S]*event\.key !== "Tab"/,
  );
});

test("Vera project and document API methods retain Mike lineage behind one strict local boundary", () => {
  const mike = upstream(SOURCES.api);
  for (const method of [
    "listProjects",
    "createProject",
    "updateProject",
    "deleteProject",
    "uploadProjectDocument",
    "uploadDocumentVersion",
    "deleteDocument",
  ]) {
    assert.match(mike, new RegExp(`export async function ${method}`));
  }

  const api = current("src/app/lib/veraApi.ts");
  for (const method of [
    "listVeraProjects",
    "createVeraProject",
    "updateVeraProject",
    "deleteVeraProject",
    "uploadVeraDocument",
    "uploadVeraDocumentVersion",
    "retryVeraDocumentParse",
    "deleteVeraDocument",
  ]) {
    assert.match(api, new RegExp(`export (?:async )?function ${method}`));
  }
  assert.match(api, /json: \{ confirm_name: confirmName \}/);
  assert.match(api, /form\.append\("file", file, file\.name\)/);
  assert.doesNotMatch(api, /Content-Type[^\n]*multipart/i);
  assert.match(api, /parseVeraDocumentMutationWire/);
  assert.match(api, /parseVeraDocumentVersionsWire/);
  assert.match(api, /wire\.shared_with\.length !== 0/);
  assert.match(api, /VERA_LOCAL_USER_ID/);
  assert.doesNotMatch(api, /storage_path:\s*string|authorization:\s*["'`]/i);
});

test("document mutations use scoped multipart routes and accept only safe local wire data", async () => {
  const localUserId = "00000000-0000-4000-8000-000000000001";
  const projectId = "11111111-1111-4111-8111-111111111111";
  const documentId = "22222222-2222-4222-8222-222222222222";
  const versionId = "33333333-3333-4333-8333-333333333333";
  const jobId = "44444444-4444-4444-8444-444444444444";
  const token = "vdt_1234567890abcdefghijklmnopqrstuvwxyz";
  const timestamp = "2026-07-14T00:00:00.000Z";
  const document = {
    id: documentId,
    user_id: localUserId,
    project_id: projectId,
    folder_id: null,
    filename: "evidence.pdf",
    owner_email: null,
    owner_display_name: "Local User",
    file_type: "pdf",
    storage_path: null,
    pdf_storage_path: "local-preview",
    size_bytes: 8,
    page_count: 1,
    structure_tree: null,
    status: "processing",
    created_at: timestamp,
    updated_at: timestamp,
    active_version_number: 1,
    latest_version_number: 1,
  } as const;
  const version = {
    id: versionId,
    version_number: 1,
    source: "upload",
    created_at: timestamp,
    filename: "evidence.pdf",
    file_type: "pdf",
    size_bytes: 8,
    page_count: 1,
    deleted_at: null,
    deleted_by: null,
  } as const;
  const job = {
    id: jobId,
    type: "document_parse",
    status: "queued",
    attempt: 0,
    max_attempts: 3,
    retryable: true,
    created_at: timestamp,
    scheduled_at: timestamp,
    started_at: null,
    completed_at: null,
  } as const;
  const project = {
    id: projectId,
    user_id: localUserId,
    name: "Evidence review",
    description: "Local project",
    cm_number: null,
    practice: null,
    shared_with: [],
    created_at: timestamp,
    updated_at: timestamp,
    is_owner: true,
    owner_display_name: "Local User",
    owner_email: null,
    documents: [],
    folders: [],
    document_count: 0,
    chat_count: 0,
    review_count: 0,
    workflow_count: 0,
    status: "active",
    archived_at: null,
    default_model_profile_id: null,
  } as const;

  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      aletheiaDesktop: {
        async getInfo() {
          return { workspaceApiUrl: "http://127.0.0.1:43123/api/v1" };
        },
        async getAuthToken() {
          return token;
        },
      },
    },
  });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const payload = url.pathname.endsWith("/retry")
      ? { job }
      : url.pathname.endsWith("/projects")
        ? [project]
        : { document, version, job };
    return new Response(JSON.stringify(payload), {
      status: url.pathname.endsWith("/retry") ? 202 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    assert.deepEqual(await listVeraProjects(), [project]);
    const file = new File([new Uint8Array([1, 2, 3])], "evidence.pdf", {
      type: "application/pdf",
    });
    await uploadVeraDocument({ file, projectId });
    await uploadVeraDocumentVersion(documentId, file, { projectId });
    await retryVeraDocumentParse(documentId, { projectId });
    await deleteVeraDocument(documentId, { projectId });

    assert.equal(calls[0].url.search, "");
    assert.equal(
      calls[1].url.pathname,
      `/api/v1/projects/${projectId}/documents`,
    );
    assert.equal(
      calls[2].url.pathname,
      `/api/v1/projects/${projectId}/documents/${documentId}/versions`,
    );
    assert.equal(
      calls[3].url.pathname,
      `/api/v1/projects/${projectId}/documents/${documentId}/retry`,
    );
    assert.equal(calls[4].init?.method, "DELETE");
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${token}`);
      assert.equal(call.url.href.includes(token), false);
    }
    for (const call of [calls[1], calls[2]]) {
      assert.ok(call.init?.body instanceof FormData);
      assert.equal(new Headers(call.init?.headers).has("content-type"), false);
      assert.ok(call.init?.body.get("file") instanceof File);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (priorWindow) {
      Object.defineProperty(globalThis, "window", priorWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});
