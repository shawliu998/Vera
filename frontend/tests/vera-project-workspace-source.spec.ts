import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";

const LOCKED_MIKE_SHA = "e32daad5a4c64a5561e04c53ee12411e3c5e7238";
const FRONTEND_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(FRONTEND_ROOT, "..");

function current(relativePath: string): string {
    return readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8");
}

function assertInOrder(source: string, fragments: readonly string[]) {
    let cursor = 0;
    for (const fragment of fragments) {
        const next = source.indexOf(fragment, cursor);
        assert.notEqual(next, -1, `missing ordered Mike fragment: ${fragment}`);
        cursor = next + fragment.length;
    }
}

test("workspace port identifies the exact locked Mike sources", () => {
    assert.equal(
        execFileSync("git", ["rev-parse", LOCKED_MIKE_SHA], {
            cwd: REPOSITORY_ROOT,
            encoding: "utf8",
        }).trim(),
        LOCKED_MIKE_SHA,
    );

    const ports = [
        [
            "src/app/(pages)/projects/[id]/layout.tsx",
            "frontend/src/app/(pages)/projects/[id]/layout.tsx",
        ],
        [
            "src/app/(pages)/projects/[id]/page.tsx",
            "frontend/src/app/(pages)/projects/[id]/page.tsx",
        ],
        [
            "src/app/(pages)/projects/[id]/assistant/page.tsx",
            "frontend/src/app/(pages)/projects/[id]/assistant/page.tsx",
        ],
        [
            "src/app/(pages)/projects/[id]/tabular-reviews/page.tsx",
            "frontend/src/app/(pages)/projects/[id]/tabular-reviews/page.tsx",
        ],
        [
            "src/app/components/projects/ProjectWorkspace.tsx",
            "frontend/src/app/components/projects/ProjectWorkspace.tsx",
        ],
        [
            "src/app/components/projects/ProjectDocumentsView.tsx",
            "frontend/src/app/components/projects/ProjectDocumentsView.tsx",
        ],
        [
            "src/app/components/projects/DocumentSidePanel.tsx",
            "frontend/src/app/components/projects/DocumentSidePanel.tsx",
        ],
        [
            "src/app/components/projects/ProjectExplorer.tsx",
            "frontend/src/app/components/projects/ProjectExplorer.tsx",
        ],
        [
            "src/app/components/projects/ProjectPageParts.tsx",
            "frontend/src/app/components/projects/ProjectPageParts.tsx",
        ],
        [
            "src/app/components/shared/FileDirectory.tsx",
            "frontend/src/app/components/shared/FileDirectory.tsx",
        ],
        [
            "src/app/components/shared/useDirectoryData.ts",
            "frontend/src/app/components/shared/useDirectoryData.ts",
        ],
        [
            "src/app/components/shared/AddProjectDocsModal.tsx",
            "frontend/src/app/components/modals/AddProjectDocsModal.tsx",
        ],
        [
            "src/app/components/shared/views/PdfView.tsx",
            "frontend/src/app/components/shared/views/PdfView.tsx",
        ],
        [
            "src/app/components/shared/views/DocxView.tsx",
            "frontend/src/app/components/shared/views/DocxView.tsx",
        ],
        [
            "src/app/components/shared/views/SpreadsheetView.tsx",
            "frontend/src/app/components/shared/views/SpreadsheetView.tsx",
        ],
    ] as const;

    for (const [file, sourcePath] of ports) {
        const source = current(file);
        assert.match(source, new RegExp(LOCKED_MIKE_SHA));
        assert.ok(source.includes(sourcePath), `${file} locks ${sourcePath}`);
    }
});

test("Project stays the Mike container and preserves every real deep link", () => {
    const workspace = current(
        "src/app/components/projects/ProjectWorkspace.tsx",
    );
    assertInOrder(workspace, [
        'id: "documents"',
        'id: "assistant"',
        'id: "workflows"',
        'id: "reviews"',
    ]);
    for (const section of ["documents", "assistant", "workflows", "reviews"]) {
        assert.match(
            workspace,
            new RegExp(`id: "${section}"[^\n]+disabled: false`),
        );
    }
    assert.match(workspace, /title=\{item\.disabled \? t\("errors\.unsupported"\)/);
    assert.match(
        current("src/app/(pages)/projects/[id]/assistant/page.tsx"),
        /ProjectAssistantTable/,
    );
    assert.match(
        current("src/app/(pages)/projects/[id]/tabular-reviews/page.tsx"),
        /ProjectReviewsTable/,
    );
});

test("document mutations use the single Vera transport helpers", () => {
    const source = [
        current("src/app/components/projects/ProjectDocumentsView.tsx"),
        current("src/app/components/shared/AddProjectDocsModal.tsx"),
    ].join("\n");
    for (const helper of [
        "uploadVeraDocument",
        "uploadVeraDocumentVersion",
        "retryVeraDocumentParse",
        "deleteVeraDocument",
        "attachVeraProjectDocument",
        "renameVeraProjectDocument",
        "moveVeraProjectDocument",
        "createVeraProjectFolder",
        "updateVeraProjectFolder",
        "deleteVeraProjectFolder",
    ]) {
        assert.match(source, new RegExp(`\\b${helper}\\b`), helper);
    }
    assert.doesNotMatch(source, /veraApiRequest|veraApiFetch|\bfetch\s*\(/);
    assert.doesNotMatch(
        source,
        /FormData|multipart|["'`]\/api\/v1/,
    );
    assert.match(source, /`\/projects\/\$\{projectId\}\/documents\/\$\{/);
});

test("active document parsing is wired through the mutation-aware coordinator", () => {
    const workspace = current(
        "src/app/components/projects/ProjectWorkspace.tsx",
    );
    const polling = workspace.slice(
        workspace.indexOf("const hasActiveDocumentParsing"),
        workspace.indexOf("if (!deleteConfirmOpen) return"),
    );

    assert.match(
        workspace,
        /document\.status === "pending" \|\| document\.status === "processing"/,
    );
    assertInOrder(polling, [
        "if (!hasActiveDocumentParsing) return",
        "createDocumentStatusPollCoordinator",
        "listVeraProjectDocuments",
        "mutationGeneration: () =>",
        "applySnapshot: replaceDocumentsState",
        "reportError:",
        "window.setTimeout",
        "window.clearTimeout",
        "coordinator.start()",
        "coordinator.stop()",
    ]);
    assert.match(
        workspace,
        /documentMutationGenerationRef\.current \+= 1;[\s\S]*replaceDocumentsState\(update\)/,
    );
    assert.doesNotMatch(polling, /setInterval/);
});

test("every Project upload surface uses the backend-supported accept contract", () => {
    const pickerPaths = [
        "src/app/components/projects/ProjectDocumentsView.tsx",
        "src/app/components/projects/NewProjectModal.tsx",
        "src/app/components/projects/DocumentSidePanel.tsx",
        "src/app/components/shared/AddProjectDocsModal.tsx",
    ];
    const pickers = pickerPaths.map(current).join("\n");
    const validation = current(
        "src/app/lib/documentUploadValidation.ts",
    );
    const transport = current("src/app/lib/veraApi.ts");

    for (const extension of [".pdf", ".docx", ".xlsx", ".txt", ".md"]) {
        assert.match(validation, new RegExp(`"\\${extension}"`));
    }
    assert.match(
        validation,
        /SUPPORTED_DOCUMENT_ACCEPT =\s*SUPPORTED_DOCUMENT_EXTENSIONS\.join\(","\)/,
    );
    assert.equal(
        pickers.match(/accept=\{SUPPORTED_DOCUMENT_ACCEPT\}/g)?.length,
        5,
    );
    for (const pickerPath of pickerPaths) {
        assert.match(current(pickerPath), /SUPPORTED_DOCUMENT_ACCEPT/);
    }
    for (const unsupported of [".doc,", ".xls,", ".xlsm", ".ppt,", ".pptx"]) {
        assert.equal(pickers.includes(unsupported), false, unsupported);
    }
    assert.match(transport, /!isSupportedDocumentFile\(\{ name: filename \}\)/);
    assert.equal(transport.includes("instanceof Blob"), false);
    assert.match(transport, /probe\.append\("file", file as Blob, filename\)/);
    assert.match(transport, /DOCUMENT_UPLOAD_ERROR_CODES\.unsupportedType/);
});

test("preview and downloads remain authenticated capabilities without paths", () => {
    const preview = [
        current("src/app/components/shared/views/useVeraDisplayBlob.ts"),
        current("src/app/components/shared/views/PdfView.tsx"),
        current("src/app/components/shared/views/DocxView.tsx"),
        current("src/app/components/shared/views/SpreadsheetView.tsx"),
        current("src/app/components/projects/DocumentSidePanel.tsx"),
    ].join("\n");
    const documents = current(
        "src/app/components/projects/ProjectDocumentsView.tsx",
    );
    assert.match(preview, /displayVeraDocument/);
    assert.match(preview, /URL\.createObjectURL/);
    assert.match(preview, /URL\.revokeObjectURL/);
    assert.match(documents, /getVeraDocumentDownloadCapability/);
    assert.match(documents, /downloadVeraCapability/);
    assert.doesNotMatch(preview, /readVeraDocument|extracted|storage_path/);
    assert.doesNotMatch(
        `${preview}\n${documents}`,
        /supabase|mikeApi|aletheiaApi|owner_email|shared_with|localStorage|sessionStorage/,
    );
});

test("Mike table, side panel, responsive, drag and keyboard landmarks remain", () => {
    const documents = current(
        "src/app/components/projects/ProjectDocumentsView.tsx",
    );
    assertInOrder(documents, [
        "<ProjectSectionToolbar actions={tableActions}",
        'className={`w-full min-h-0 flex-1 overflow-auto',
        'className="flex min-h-full min-w-max flex-col"',
        "sticky top-0 z-[70]",
        "sticky left-0 z-[80]",
        "renderLevel(null, 0)",
        "<AddProjectDocsModal",
        "<DocumentSidePanel",
    ]);
    assert.match(documents, /application\/vera-document/);
    assert.match(documents, /application\/vera-folder/);
    assert.match(documents, /event\.key === "Enter"/);
    assert.match(documents, /event\.key === "Escape"/);
    assert.match(documents, /onClick=\{\(\) => void refreshProject\(\)\}/);

    const panel = current(
        "src/app/components/projects/DocumentSidePanel.tsx",
    );
    assert.match(panel, /fixed inset-0 z-\[180\]/);
    assert.match(panel, /max-w-\[1180px\]/);
    assert.match(panel, /md:hidden/);
    assert.match(panel, /role="dialog"/);
    assert.match(panel, /aria-modal="true"/);
});

test("destructive and drop paths are fenced and reconcile complete subtrees", () => {
    const documents = current(
        "src/app/components/projects/ProjectDocumentsView.tsx",
    );
    assert.match(documents, /busyKeysRef\.current\.has\(key\)/);
    assert.match(documents, /type FolderDeleteImpact/);
    assert.match(documents, /descendantFolderIds\(folder\.id\)/);
    assertInOrder(documents, [
        "await deleteVeraProjectFolder(projectId, impact.folder.id)",
        "setFolders((current)",
        "setDocuments((current)",
        "setVersionsByDocument((current)",
        "setExpandedVersionDocuments((current)",
        "setLoadingVersions((current)",
        "versionControllersRef.current.get(documentId)?.abort()",
    ]);
    assert.match(documents, /cancelDisabled=\{/);
    assert.match(documents, /pendingDeleteFolder\.folderIds\.length/);
    assert.match(documents, /pendingDeleteFolder\.documentIds\.length/);
    assert.match(documents, /event\.dataTransfer\.types\.includes\("Files"\)/);
    assert.match(documents, /uploadVersion\(document\.id, files\[0\]\)/);

    const panel = current(
        "src/app/components/projects/DocumentSidePanel.tsx",
    );
    assert.match(panel, /busyActionRef\.current/);
    assert.match(panel, /cancelDisabled=\{busyAction === "delete"\}/);
});
