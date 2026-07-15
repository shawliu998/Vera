import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { MESSAGES } from "../src/app/i18n/messages.ts";
import { firstDocumentCitationViewerEntry } from "../src/app/components/shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHA = "e32daad5a4c64a5561e04c53ee12411e3c5e7238";

function source(relativePath: string) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

const PORTS = [
  [
    "src/app/(pages)/assistant/page.tsx",
    "frontend/src/app/(pages)/assistant/page.tsx",
  ],
  [
    "src/app/(pages)/assistant/chat/[id]/page.tsx",
    "frontend/src/app/(pages)/assistant/chat/[id]/page.tsx",
  ],
  [
    "src/app/(pages)/projects/[id]/assistant/page.tsx",
    "frontend/src/app/(pages)/projects/[id]/assistant/page.tsx",
  ],
  [
    "src/app/(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
    "frontend/src/app/(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
  ],
  [
    "src/app/components/assistant/InitialView.tsx",
    "frontend/src/app/components/assistant/InitialView.tsx",
  ],
  [
    "src/app/components/assistant/ChatView.tsx",
    "frontend/src/app/components/assistant/ChatView.tsx",
  ],
  [
    "src/app/components/assistant/ChatInput.tsx",
    "frontend/src/app/components/assistant/ChatInput.tsx",
  ],
  [
    "src/app/components/assistant/UserMessage.tsx",
    "frontend/src/app/components/assistant/UserMessage.tsx",
  ],
  [
    "src/app/components/assistant/AssistantMessage.tsx",
    "frontend/src/app/components/assistant/AssistantMessage.tsx",
  ],
  [
    "src/app/components/assistant/ModelToggle.tsx",
    "frontend/src/app/components/assistant/ModelToggle.tsx",
  ],
  [
    "src/app/components/projects/ProjectAssistantTable.tsx",
    "frontend/src/app/components/projects/ProjectAssistantTable.tsx",
  ],
  [
    "src/app/contexts/ChatHistoryContext.tsx",
    "frontend/src/app/contexts/ChatHistoryContext.tsx",
  ],
  [
    "src/app/hooks/useAssistantChat.ts",
    "frontend/src/app/hooks/useAssistantChat.ts",
  ],
] as const;

test("Assistant UI records exact pinned Mike provenance without copying its brand", () => {
  for (const [relativePath, upstream] of PORTS) {
    const current = source(relativePath);
    assert.match(current, new RegExp(SHA));
    assert.ok(
      current.includes(upstream),
      `${relativePath} records ${upstream}`,
    );
  }
  const combined = PORTS.map(([file]) => source(file)).join("\n");
  assert.doesNotMatch(combined, /MikeIcon|mike-icon|>\s*Mike\s*</);
  assert.match(combined, /VeraMark/);
});

test("Assistant runtime uses durable local APIs with no auth/cloud/mock fallback", () => {
  const files = [
    ...PORTS.map(([file]) => file),
    "src/app/components/assistant/AssistantDocumentPicker.tsx",
    "src/app/components/assistant/SidebarChatItem.tsx",
    "src/app/lib/veraAssistantApi.ts",
  ];
  const combined = files.map(source).join("\n");
  const uiRuntime = files
    .filter((file) => file !== "src/app/lib/veraAssistantApi.ts")
    .map(source)
    .join("\n");
  assert.doesNotMatch(
    combined,
    /AuthContext|useAuth|Supabase|mikeApi|localStorage|sessionStorage|indexedDB/,
  );
  assert.doesNotMatch(uiRuntime, /setTimeout/);
  assert.doesNotMatch(combined, /mock[A-Z(]|fake[A-Z(]/);
  assert.match(combined, /startVeraAssistantGeneration/);
  assert.match(combined, /replayVeraAssistantJob/);
  assert.match(combined, /streamVeraAssistantJob/);
  assert.match(combined, /Last-Event-ID/);
  assert.match(combined, /cancelVeraAssistantJob/);
  assert.match(combined, /retryVeraAssistantJob/);
  assert.match(combined, /regenerateVeraAssistantJob/);
  assert.match(combined, /listVeraAssistantJobs/);
});

test("job acceptance, replay and restart routes stay canonical and separate", () => {
  const api = source("src/app/lib/veraAssistantApi.ts");
  assert.match(
    api,
    /const path = projectId\s*\? `\/projects\/\$\{safeId\(projectId, "project id"\)\}\/chat`\s*: "\/chat"/,
  );
  assert.match(api, /\/assistant\/jobs\/\$\{safeJobId\}\/events/);
  assert.match(
    api,
    /\/assistant\/jobs\/\$\{safeId\(jobId, "Assistant job id"\)\}\/cancel/,
  );
  assert.match(api, /"retry" \| "regenerate"/);
  assert.doesNotMatch(api, /EventSource/);
});

test("refresh recovery and terminal controls are explicit in the hook", () => {
  const hook = source("src/app/hooks/useAssistantChat.ts");
  const assistantMessage = source(
    "src/app/components/assistant/AssistantMessage.tsx",
  );
  assert.match(hook, /Promise\.all\(\[\s*getVeraAssistantChat/);
  assert.match(hook, /listVeraAssistantJobs\(initialChatId, 20/);
  assert.match(hook, /replay\.terminal/);
  assert.match(hook, /status === "failed"/);
  assert.match(hook, /status === "interrupted"/);
  assert.match(assistantMessage, /generation\?\.status === "cancelled"/);
  assert.match(hook, /setLoadRevision/);
  assert.match(hook, /setMessages\(\[\]\)/);
});

test("Project Assistant document citations reuse the scoped source viewer and exact version", () => {
  const assistantMessage = source(
    "src/app/components/assistant/AssistantMessage.tsx",
  );
  const chatView = source("src/app/components/assistant/ChatView.tsx");
  const sourceViewer = source(
    "src/app/components/projects/ProjectCitationSourceViewer.tsx",
  );
  const projectChat = source(
    "src/app/(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
  );

  assert.match(assistantMessage, /ProjectCitationSourceViewer/);
  assert.match(assistantMessage, /firstDocumentCitationViewerEntry/);
  assert.match(
    assistantMessage,
    /citationScope\.documentIds\.includes\(documentCitation\.document_id\)/,
  );
  assert.match(assistantMessage, /versionId: documentCitation\.version_id/);
  assert.match(assistantMessage, /assistant-citation-open-/);
  assert.match(chatView, /citationScope=/);
  assert.match(chatView, /documentIds: \(availableDocuments \?\? \[\]\)\.map/);
  assert.match(projectChat, /availableDocuments=\{workspace\.documents\}/);
  assert.match(sourceViewer, /kind: "assistant_document"/);
  assert.match(sourceViewer, /<PdfView/);
  assert.match(sourceViewer, /version_id: normalized\.versionId/);
  assert.doesNotMatch(
    `${assistantMessage}\n${sourceViewer}`,
    /window\.open|target="_blank"|file:\/\//,
  );
});

test("Assistant source viewer opens one exact page excerpt for multi-page citations", () => {
  const selected = firstDocumentCitationViewerEntry({
    type: "citation_data",
    ref: 1,
    doc_id: "doc-0",
    document_id: "00000000-0000-4000-8000-000000000001",
    version_id: "00000000-0000-4000-8000-000000000002",
    filename: "authority.pdf",
    page: "7-8",
    quote: "page seven[[PAGE_BREAK]]page eight",
    quotes: [
      { page: 7, quote: "page seven" },
      { page: 8, quote: "page eight" },
    ],
  });
  assert.deepEqual(selected, { page: 7, quote: "page seven" });
  assert.equal(selected?.quote.includes("page eight"), false);
});

test("shell and Project navigation expose real Assistant routes", () => {
  const rootPage = source("src/app/page.tsx");
  const assistantChatPage = source(
    "src/app/(pages)/assistant/chat/[id]/page.tsx",
  );
  const shell = source("src/app/components/vera-shell/VeraShell.tsx");
  const sidebar = source("src/app/components/vera-shell/VeraSidebar.tsx");
  const workspace = source("src/app/components/projects/ProjectWorkspace.tsx");
  assert.match(shell, /ChatHistoryProvider/);
  assert.match(rootPage, /redirect\("\/assistant"\)/);
  assert.match(assistantChatPage, /t\("assistant\.restoring"\)/);
  assert.match(assistantChatPage, /t\("common\.actions\.retry"\)/);
  assert.match(assistantChatPage, /t\("assistant\.newChat"\)/);
  assert.match(sidebar, /href: "\/assistant"/);
  assert.match(sidebar, /t\("assistant\.history\.title"\)/);
  assert.equal(MESSAGES["zh-CN"].assistant.history.title, "助手历史");
  assert.equal(MESSAGES["en-US"].assistant.history.title, "Assistant history");
  assert.match(workspace, /id: "assistant"[^\n]+disabled: false/);
  assert.match(workspace, /`\/projects\/\$\{projectId\}\/assistant`/);
});
