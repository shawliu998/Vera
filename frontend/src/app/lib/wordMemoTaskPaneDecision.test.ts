import assert from "node:assert/strict";
import test from "node:test";

import type { WordMemoSourceManifestClassification } from "./wordMemoSourceManifest";
import type { WordMemoTaskBinding } from "./wordMemoTaskBinding";
import {
  wordMemoEvidenceManifest,
  wordMemoExportRequirementText,
  wordMemoBoundReviewSourceBlocked,
  wordMemoGenerateBlocked,
  wordMemoReviewPointerPersistenceDecision,
  wordMemoRestoreDisposition,
  wordMemoSavedMessage,
  wordMemoSaveBlocked,
  wordMemoSuggestionBindingMatchesCurrent,
  wordMemoVerifierStatusLabel,
} from "./wordMemoTaskPaneDecision";

const citation = {
  reference: "C-01-01-F-01",
  documentId: "document-1",
  versionId: "version-7",
  filename: "供应商主协议最终审阅版.docx",
  page: 18,
  locator: "第 18 页",
  quote: "客户应在收到无争议发票后三十日内付款。",
};

const legacyManifest: WordMemoSourceManifestClassification = {
  kind: "legacy",
  manifest: {
    schemaVersion: 1,
    projectId: "matter-1",
    reviewId: "review-1",
    citations: [citation],
  },
};

const boundManifest: WordMemoSourceManifestClassification = {
  kind: "bound",
  manifest: {
    schemaVersion: 1,
    generatorVersion: "tabular-review-word-memo-v1",
    projectId: "matter-1",
    reviewId: "review-1",
    taskId: "task-1",
    memoDocumentId: "memo-1",
    memoVersionId: "version-1",
    inputDigest: "digest-1",
    citations: [citation],
  },
};

const binding: WordMemoTaskBinding = {
  taskId: "task-1",
  taskStatus: "completed",
  projectId: "matter-1",
  reviewId: "review-1",
  memoDocumentId: "memo-1",
  memoVersionId: "version-1",
  memoVersionNumber: 1,
  memoFilename: "Memo.docx",
  executionChatId: "chat-1",
  inputDigest: "digest-1",
  reviewTitle: "Review",
  matterName: "Matter",
  verifierStatus: "passed",
  citations: [citation],
  sources: [
    {
      documentId: "document-1",
      versionId: "version-7",
      filename: "供应商主协议最终审阅版.docx",
      fileType: "docx",
      role: "source",
    },
  ],
};

test("evidence is shown for legacy manifests immediately", () => {
  assert.equal(
    wordMemoEvidenceManifest(legacyManifest, null),
    legacyManifest.manifest,
  );
});

test("evidence is shown for bound manifests only after server binding loads", () => {
  assert.equal(
    wordMemoEvidenceManifest(boundManifest, null),
    null,
    "unverified bound manifest must not render citation links",
  );
  assert.deepEqual(
    wordMemoEvidenceManifest(boundManifest, binding),
    boundManifest.manifest,
    "verified bound manifest may render citation links",
  );
});

test("stale or citation-mismatched bindings cannot unlock a new manifest", () => {
  assert.equal(
    wordMemoEvidenceManifest(boundManifest, {
      ...binding,
      taskId: "task-from-previous-document",
    }),
    null,
  );
  assert.equal(
    wordMemoEvidenceManifest(boundManifest, {
      ...binding,
      citations: [{ ...citation, quote: "altered local quote" }],
    }),
    null,
  );
});

test("save is blocked for invalid, checking, read-error, or unverified bound manifests", () => {
  assert.equal(
    wordMemoSaveBlocked({ kind: "invalid" }, null),
    true,
    "invalid manifest blocks save",
  );
  assert.equal(
    wordMemoSaveBlocked({ kind: "checking" }, null),
    true,
    "checking state blocks save",
  );
  assert.equal(
    wordMemoSaveBlocked({ kind: "read-error", error: "failed" }, null),
    true,
    "read-error state blocks save",
  );
  assert.equal(
    wordMemoSaveBlocked(boundManifest, null),
    true,
    "bound manifest without binding blocks save",
  );
  assert.equal(
    wordMemoSaveBlocked(boundManifest, binding),
    false,
    "bound manifest with binding allows save",
  );
  assert.equal(
    wordMemoSaveBlocked(boundManifest, {
      ...binding,
      memoDocumentId: "memo-from-previous-document",
    }),
    true,
    "a stale binding from the previous document cannot unlock save",
  );
  assert.equal(
    wordMemoSaveBlocked(legacyManifest, null),
    false,
    "legacy manifest does not block save",
  );
  assert.equal(
    wordMemoSaveBlocked({ kind: "absent" }, null),
    false,
    "absent manifest does not block save",
  );
});

test("generate is blocked when manifest is unsafe or bound is unverified", () => {
  assert.equal(
    wordMemoGenerateBlocked({ kind: "invalid" }),
    true,
    "invalid manifest blocks generate",
  );
  assert.equal(
    wordMemoGenerateBlocked({ kind: "checking" }),
    true,
    "checking state blocks generate",
  );
  assert.equal(
    wordMemoGenerateBlocked({ kind: "read-error", error: "failed" }),
    true,
    "read-error state blocks generate",
  );
  assert.equal(
    wordMemoGenerateBlocked(boundManifest),
    true,
    "bound manifest without verified binding blocks generate",
  );
  assert.equal(
    wordMemoGenerateBlocked(boundManifest, null),
    true,
    "bound manifest with no binding still blocks generate",
  );
  assert.equal(
    wordMemoGenerateBlocked(boundManifest, binding),
    false,
    "verified current bound Memo allows generate",
  );
  assert.equal(
    wordMemoGenerateBlocked(boundManifest, {
      ...binding,
      taskStatus: "verifying",
    }),
    true,
    "generate is blocked while the Task is verifying",
  );
  assert.equal(
    wordMemoGenerateBlocked(boundManifest, {
      ...binding,
      memoVersionId: "version-from-previous-document",
    }),
    true,
    "a stale binding version blocks generate",
  );
  assert.equal(
    wordMemoGenerateBlocked(legacyManifest),
    false,
    "legacy manifest does not block generate",
  );
  assert.equal(
    wordMemoGenerateBlocked({ kind: "absent" }),
    false,
    "absent manifest does not block generate",
  );
});

test("shortcut must be disabled when generate is gated", () => {
  const gatedStates: WordMemoSourceManifestClassification[] = [
    { kind: "invalid" },
    { kind: "checking" },
    { kind: "read-error", error: "failed" },
    boundManifest,
  ];
  for (const classification of gatedStates) {
    assert.equal(
      wordMemoGenerateBlocked(classification),
      true,
      `Ctrl/Cmd+Enter must be disabled for ${classification.kind}`,
    );
  }
  assert.equal(
    wordMemoGenerateBlocked(boundManifest, binding),
    false,
    "Ctrl/Cmd+Enter is enabled for a verified current bound Memo",
  );
  assert.equal(
    wordMemoGenerateBlocked(boundManifest, {
      ...binding,
      taskStatus: "verifying",
    }),
    true,
    "Ctrl/Cmd+Enter stays disabled while the Task is verifying",
  );
});

test("restore waits for a verified bound identity and never downgrades Task pointers", () => {
  assert.equal(
    wordMemoRestoreDisposition({ kind: "checking" }, null, true),
    "wait",
  );
  assert.equal(wordMemoRestoreDisposition(boundManifest, null, true), "wait");
  assert.equal(
    wordMemoRestoreDisposition(boundManifest, binding, true),
    "bound",
  );
  assert.equal(
    wordMemoRestoreDisposition(boundManifest, binding, false),
    "blocked",
  );
  assert.equal(
    wordMemoRestoreDisposition(
      { kind: "read-error", error: "failed" },
      null,
      true,
    ),
    "blocked",
  );
  assert.equal(
    wordMemoRestoreDisposition({ kind: "absent" }, null, true),
    "blocked",
  );
  assert.equal(
    wordMemoRestoreDisposition({ kind: "absent" }, null, false),
    "standalone",
  );
});

test("bound continuation requires document scope and one fixed Task source", () => {
  assert.equal(
    wordMemoBoundReviewSourceBlocked({
      classification: boundManifest,
      binding,
      scope: "selection",
      selectedDocumentId: "document-1",
    }),
    true,
  );
  assert.equal(
    wordMemoBoundReviewSourceBlocked({
      classification: boundManifest,
      binding,
      scope: "document",
      selectedDocumentId: "",
    }),
    true,
  );
  assert.equal(
    wordMemoBoundReviewSourceBlocked({
      classification: boundManifest,
      binding,
      scope: "document",
      selectedDocumentId: "outside-task",
    }),
    true,
  );
  assert.equal(
    wordMemoBoundReviewSourceBlocked({
      classification: boundManifest,
      binding,
      scope: "document",
      selectedDocumentId: "document-1",
    }),
    false,
  );
});

test("a V1 suggestion cannot write after the bound Memo advances to V2", () => {
  const suggestionBinding = {
    taskId: binding.taskId,
    projectId: binding.projectId,
    executionChatId: binding.executionChatId,
    memoDocumentId: binding.memoDocumentId,
    memoVersionId: binding.memoVersionId,
  };
  assert.equal(
    wordMemoSuggestionBindingMatchesCurrent(suggestionBinding, binding),
    true,
  );
  assert.equal(
    wordMemoSuggestionBindingMatchesCurrent(suggestionBinding, {
      ...binding,
      memoVersionId: "version-2",
      memoVersionNumber: 2,
    }),
    false,
    "saving V1 as V2 must stale the existing suggestion",
  );
  assert.equal(
    wordMemoSuggestionBindingMatchesCurrent(null, null),
    true,
    "ordinary Matter suggestions remain compatible",
  );
  assert.equal(
    wordMemoSuggestionBindingMatchesCurrent(null, binding),
    false,
    "a bound Memo cannot accept an unbound suggestion",
  );
});

test("pointer persistence preserves unresolved or invalid manifest transitions", () => {
  const ordinaryInput = {
    currentBinding: null,
    suggestionBinding: null,
    selectedProjectId: "matter-1",
    suggestionChatId: "chat-ordinary",
    reviewRunId: "review-run-1",
  };
  const unresolved: WordMemoSourceManifestClassification[] = [
    { kind: "checking" },
    { kind: "read-error", error: "Word custom properties unavailable" },
    { kind: "invalid" },
  ];

  for (const classification of unresolved) {
    assert.deepEqual(
      wordMemoReviewPointerPersistenceDecision({
        classification,
        ...ordinaryInput,
      }),
      { kind: "preserve" },
    );
  }
});

test("pointer persistence requires an exact verified Task and Memo version", () => {
  const taskSnapshot = {
    taskId: binding.taskId,
    projectId: binding.projectId,
    executionChatId: binding.executionChatId,
    memoDocumentId: binding.memoDocumentId,
    memoVersionId: binding.memoVersionId,
  };
  const validInput = {
    classification: boundManifest,
    currentBinding: binding,
    suggestionBinding: taskSnapshot,
    selectedProjectId: binding.projectId,
    suggestionChatId: binding.executionChatId,
    reviewRunId: "review-run-1",
  };

  assert.deepEqual(wordMemoReviewPointerPersistenceDecision(validInput), {
    kind: "persist-task",
    taskBinding: taskSnapshot,
  });
  assert.deepEqual(
    wordMemoReviewPointerPersistenceDecision({
      ...validInput,
      currentBinding: null,
    }),
    { kind: "preserve" },
    "a bound manifest without a verified binding must preserve storage",
  );
  assert.deepEqual(
    wordMemoReviewPointerPersistenceDecision({
      ...validInput,
      classification: {
        kind: "bound",
        manifest: {
          ...boundManifest.manifest,
          memoVersionId: "version-2",
        },
      },
      currentBinding: {
        ...binding,
        memoVersionId: "version-2",
        memoVersionNumber: 2,
      },
    }),
    { kind: "preserve" },
    "a V1 suggestion must not persist or upgrade against verified V2",
  );
  assert.deepEqual(
    wordMemoReviewPointerPersistenceDecision({
      ...validInput,
      suggestionBinding: {
        ...taskSnapshot,
        memoVersionId: "version-2",
      },
    }),
    { kind: "preserve" },
    "a mismatched suggestion snapshot must preserve storage",
  );
  assert.deepEqual(
    wordMemoReviewPointerPersistenceDecision({
      ...validInput,
      suggestionChatId: "different-chat",
    }),
    { kind: "preserve" },
  );
  assert.deepEqual(
    wordMemoReviewPointerPersistenceDecision({
      ...validInput,
      reviewRunId: null,
    }),
    { kind: "preserve" },
  );
});

test("only ordinary absent or legacy manifests persist ordinary pointers", () => {
  const ordinaryInput = {
    currentBinding: null,
    suggestionBinding: null,
    selectedProjectId: "matter-1",
    suggestionChatId: "chat-ordinary",
    reviewRunId: null,
  };

  for (const classification of [{ kind: "absent" } as const, legacyManifest]) {
    assert.deepEqual(
      wordMemoReviewPointerPersistenceDecision({
        classification,
        ...ordinaryInput,
      }),
      { kind: "persist-ordinary" },
    );
    assert.deepEqual(
      wordMemoReviewPointerPersistenceDecision({
        classification,
        ...ordinaryInput,
        suggestionBinding: {
          taskId: binding.taskId,
          projectId: binding.projectId,
          executionChatId: binding.executionChatId,
          memoDocumentId: binding.memoDocumentId,
          memoVersionId: binding.memoVersionId,
        },
      }),
      { kind: "preserve" },
      "a Task snapshot must never downgrade to an ordinary pointer",
    );
  }
});

test("verifier status label does not claim approval", () => {
  assert.match(
    wordMemoVerifierStatusLabel("passed"),
    /review each finding before approval/,
  );
  assert.equal(
    wordMemoVerifierStatusLabel("running"),
    "Running for this Version",
  );
  assert.equal(wordMemoVerifierStatusLabel("stale"), "Not current");
});

test("saved message reflects running and passed verifier states", () => {
  assert.match(
    wordMemoSavedMessage({
      memoFilename: "Memo.docx",
      memoVersionNumber: 2,
      verifierStatus: "running",
    }),
    /Verification is running/,
  );
  assert.match(
    wordMemoSavedMessage({
      memoFilename: "Memo.docx",
      memoVersionNumber: 2,
      verifierStatus: "passed",
    }),
    /review each finding before approval/,
  );
});

test("export requirement text keeps approval in the Task", () => {
  assert.match(
    wordMemoExportRequirementText(),
    /lawyer review.*approval in the Task/,
  );
});
