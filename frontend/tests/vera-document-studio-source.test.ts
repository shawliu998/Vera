import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(__dirname, "..");

function source(relativePath: string) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("Workflow and Studio share one pinned Mike rich-text editor implementation", () => {
  const shared = source("src/app/components/shared/VeraRichTextEditor.tsx");
  const workflow = source(
    "src/app/components/workflows/VeraWorkflowPromptEditor.tsx",
  );
  const studio = source("src/app/components/projects/DocumentStudioView.tsx");

  assert.match(shared, /e32daad5a4c64a5561e04c53ee12411e3c5e7238/);
  assert.match(shared, /@tiptap\/react/);
  assert.match(shared, /StarterKit/);
  assert.match(shared, /TableKit/);
  assert.match(shared, /onClick=\{\(\) => insertTable\(rows, cols\)\}/);
  assert.match(
    shared,
    /rawDraft\.sourceValue === value \? rawDraft\.markdown : value/,
  );
  assert.match(shared, /if \(!transaction\.docChanged\) return/);
  assert.match(shared, /editor\.setEditable\(!readOnly, false\)/);
  assert.match(
    shared,
    /editor\.commands\.setContent\(value, \{ emitUpdate: false \}\)/,
  );
  assert.match(workflow, /VeraRichTextEditor/);
  assert.match(studio, /VeraRichTextEditor/);
  assert.doesNotMatch(workflow, /@tiptap|useEditor|StarterKit|TableKit/);
  assert.doesNotMatch(studio, /@tiptap|useEditor|StarterKit|TableKit/);
});

test("Studio stays inside Project documents and uses only real capability/API state", () => {
  const documents = source(
    "src/app/components/projects/ProjectDocumentsView.tsx",
  );
  const documentPanel = source(
    "src/app/components/projects/DocumentSidePanel.tsx",
  );
  const studio = source("src/app/components/projects/DocumentStudioView.tsx");
  const route = source(
    "src/app/(pages)/projects/[id]/documents/[documentId]/studio/page.tsx",
  );
  const sidebar = source("src/app/components/vera-shell/VeraSidebar.tsx");

  assert.match(documents, /studio_capability\?\.editable === true/);
  assert.match(
    documents,
    /studio_capability\?\.editable !== true && \([\s\S]*documents\.newVersion/,
  );
  assert.match(
    documentPanel,
    /studio_capability\?\.editable !== true && \([\s\S]*documents\.newVersion/,
  );
  assert.match(documents, /createVeraStudioDocument/);
  assert.match(documents, /documents\/\$\{document\.id\}\/studio/);
  assert.match(route, /DocumentStudioView/);
  for (const helper of [
    "getVeraStudioDocument",
    "saveVeraStudioDocument",
    "listVeraStudioVersions",
    "restoreVeraStudioVersion",
    "importVeraStudioDocx",
    "exportVeraStudioDocx",
    "listVeraStudioSuggestions",
    "getVeraStudioSuggestion",
    "acceptVeraStudioSuggestion",
    "rejectVeraStudioSuggestion",
  ]) {
    assert.match(studio, new RegExp(`\\b${helper}\\b`));
  }
  assert.match(studio, /expected_version_id: document\.current_version_id/);
  assert.match(studio, /error\.status === 409/);
  assert.match(studio, /error\.code === "CONFLICT"/);
  assert.match(studio, /citation_anchors\.map/);
  assert.match(studio, /displayDocument\.citation_anchors/);
  assert.match(studio, /resolveVeraProjectCitation/);
  assert.match(studio, /ProjectCitationSourceViewer/);
  assert.match(studio, /studio-citation-open-/);
  assert.match(studio, /ariaLabel=\{t\("studio\.editorLabel"\)\}/);
  assert.match(studio, /data-testid="studio-save-status"/);
  assert.match(
    studio,
    /data-state=\{saving \? "saving" : dirty \? "dirty" : "saved"\}/,
  );
  assert.match(studio, /document\.capabilities\.docx_import === true/);
  assert.match(studio, /document\.capabilities\.docx_export === true/);
  assert.match(
    studio,
    /historical === null[\s\S]*!dirty[\s\S]*errorKind !== "conflict"/,
  );
  assert.match(
    studio,
    /selectedVersionId = \(historical \?\? document\)\.version\.id/,
  );
  assert.match(studio, /expectedVersionId = document\.current_version_id/);
  assert.match(studio, /setDocxWarnings/);
  assert.match(studio, /studio\.docx\.exportSavedOnly/);
  assert.match(studio, /ConfirmPopup[\s\S]*studio\.docx\.confirm\.title/);
  assert.match(studio, /veraStudioSuggestionMatchesPreview/);
  assert.match(
    studio,
    /acceptDisabled[\s\S]*stale[\s\S]*dirty[\s\S]*historical !== null/,
  );
  assert.match(studio, /data-testid="studio-suggestion-exact-diff"/);
  assert.match(studio, /data-testid="studio-suggestion-accept"/);
  assert.match(studio, /data-testid="studio-suggestion-reject"/);
  assert.match(studio, /aria-controls=\{`studio-suggestion-detail-/);
  assert.match(studio, /suggestionPanelRef\.current\?\.focus\(\)/);
  assert.match(studio, /role="status" aria-live="polite"/);
  assert.match(studio, /setSuggestionPage\(null\)/);
  assert.match(studio, /setSelectedSuggestion\(null\)/);
  assert.match(studio, /refreshSuggestions\(true\)/);
  assert.doesNotMatch(
    studio,
    /setTimeout[\s\S]{0,120}(?:setWorkingContent|setSavedContent|setDocument|setVersions)/,
  );
  assert.doesNotMatch(studio, /mock|fixture|demo|localStorage|sessionStorage/);
  assert.doesNotMatch(sidebar, /Document Studio|studio\.title/);
});

test("Citation viewer reuses the authenticated Project source and original PDF paths", () => {
  const viewer = source(
    "src/app/components/projects/ProjectCitationSourceViewer.tsx",
  );
  const sourceApi = source("src/app/lib/veraProjectSourceApi.ts");
  const pdf = source("src/app/components/shared/views/PdfView.tsx");
  const sidebar = source("src/app/components/vera-shell/VeraSidebar.tsx");

  assert.match(sourceApi, /\/projects\/\$\{safeId\(projectId/);
  assert.match(sourceApi, /\/sources\/\$\{parsedSnapshotId\}\/content/);
  assert.match(sourceApi, /chunk_id/);
  assert.match(sourceApi, /digestUtf8/);
  assert.match(sourceApi, /chunk\.text\.slice\(start, end\) !== quote/);
  assert.match(sourceApi, /calculatedQuoteHash !== quoteHash/);
  assert.match(viewer, /ProjectCitationSourceViewer/);
  assert.match(viewer, /project-citation-source-excerpt/);
  assert.match(viewer, /project-citation-highlight/);
  assert.match(viewer, /<PdfView/);
  assert.match(viewer, /page=\{normalized\.page\}/);
  assert.match(pdf, /`\$\{url\}#page=\$\{page\}`/);
  assert.doesNotMatch(
    sourceApi,
    /storage_key|metadata_json|filesystem|file:\/\//,
  );
  assert.doesNotMatch(sidebar, /sourceViewer|Citation Source|引用来源查看/);
});

test("Studio wire is strict, Project-scoped, and does not claim fake idempotency", () => {
  const api = source("src/app/lib/veraDocumentStudioApi.ts");
  const transport = source("src/app/lib/veraApi.ts");

  assert.match(api, /\/projects\/\$\{safeId\(projectId/);
  assert.match(api, /expected_version_id/);
  assert.match(api, /expected_current_version_id/);
  assert.match(api, /import-docx/);
  assert.match(api, /export-docx/);
  assert.match(api, /warningCodeAllowlist: VERA_STUDIO_DOCX_WARNING_CODES/);
  assert.match(api, /mime_type: "text\/markdown";/);
  assert.match(api, /exactKeys/);
  assert.match(api, /sameSuggestionImmutableFields/);
  assert.match(api, /sameCitationProvenance/);
  assert.match(api, /const expectedContent =/);
  assert.match(api, /document\.version\.source !== "user_accept"/);
  assert.doesNotMatch(api, /createVeraStudioSuggestion/);
  assert.match(transport, /"studio_capability"/);
  assert.match(transport, /capability\.editable/);
  assert.match(transport, /!docxImport \|\| !docxExport/);
  assert.match(
    transport,
    /capability\.format !== null \|\| docxImport \|\| docxExport/,
  );
  assert.doesNotMatch(api, /operation_id|setTimeout|fetch\s*\(/);
});
