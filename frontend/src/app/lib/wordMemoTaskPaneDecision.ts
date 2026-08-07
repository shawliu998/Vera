import type {
  WordMemoSourceManifest,
  WordMemoSourceManifestClassification,
} from "./wordMemoSourceManifest";
import {
  wordMemoTaskBindingMatchesManifest,
  type WordMemoTaskBinding,
} from "./wordMemoTaskBinding";

/**
 * Returns the manifest whose citations may be rendered as evidence links.
 *
 * - Legacy manifests were produced before the Task-bound Word edit flow and
 *   carry no server-verified identity, so their citations are shown directly.
 * - Bound manifests require server-side identity verification before any
 *   evidence link is rendered; an unverified bound manifest must not leak
 *   citation UI. Once verified, the binding's authoritative citations are used
 *   instead of the local manifest copy.
 */
export function wordMemoEvidenceManifest(
  classification: WordMemoSourceManifestClassification,
  binding: WordMemoTaskBinding | null,
): WordMemoSourceManifest | null {
  if (classification.kind === "legacy") return classification.manifest;
  if (
    classification.kind === "bound" &&
    wordMemoTaskBindingMatchesManifest(classification.manifest, binding)
  ) {
    return { ...classification.manifest, citations: binding.citations };
  }
  return null;
}

/**
 * Returns true when the Word pane must block generic Matter save paths.
 *
 * - Invalid manifests are corrupt or partially bound and must fail closed.
 * - Bound manifests whose server binding has not been verified (or failed
 *   with 404/409/network) cannot safely choose a Matter target.
 * - While the manifest is still being read or the read failed, save is blocked.
 */
export function wordMemoSaveBlocked(
  classification: WordMemoSourceManifestClassification,
  binding: WordMemoTaskBinding | null,
): boolean {
  return (
    classification.kind === "invalid" ||
    classification.kind === "checking" ||
    classification.kind === "read-error" ||
    (classification.kind === "bound" &&
      !wordMemoTaskBindingMatchesManifest(classification.manifest, binding))
  );
}

/**
 * Returns true when generate must not call the model.
 *
 * - Invalid/checking/read-error classifications are not safe to generate from.
 * - Bound Memo work must continue in its existing Task execution chat with a
 *   verified, current binding. Generation is blocked while the Task is
 *   verifying or the binding/version is not current.
 */
export function wordMemoGenerateBlocked(
  classification: WordMemoSourceManifestClassification,
  binding: WordMemoTaskBinding | null = null,
): boolean {
  if (
    classification.kind === "invalid" ||
    classification.kind === "checking" ||
    classification.kind === "read-error"
  ) {
    return true;
  }
  if (classification.kind === "bound") {
    if (!wordMemoTaskBindingMatchesManifest(classification.manifest, binding)) {
      return true;
    }
    if (binding.taskStatus !== "completed") {
      return true;
    }
    return false;
  }
  return false;
}

export type WordMemoRestoreDisposition =
  "standalone" | "bound" | "wait" | "blocked";

/**
 * Decides whether a saved local pointer may be read. This keeps the React
 * effect from racing Word custom-property and server-binding reads.
 */
export function wordMemoRestoreDisposition(
  classification: WordMemoSourceManifestClassification,
  binding: WordMemoTaskBinding | null,
  pointerIsTaskBound: boolean,
): WordMemoRestoreDisposition {
  if (classification.kind === "checking") return "wait";
  if (
    classification.kind === "invalid" ||
    classification.kind === "read-error"
  ) {
    return "blocked";
  }
  if (classification.kind === "bound") {
    if (!wordMemoTaskBindingMatchesManifest(classification.manifest, binding)) {
      return "wait";
    }
    return pointerIsTaskBound ? "bound" : "blocked";
  }
  return pointerIsTaskBound ? "blocked" : "standalone";
}

/**
 * Task-bound Word continuation is a document review against one of the
 * immutable sources already pinned by the Work Task.
 */
export function wordMemoBoundReviewSourceBlocked(input: {
  classification: WordMemoSourceManifestClassification;
  binding: WordMemoTaskBinding | null;
  scope: "selection" | "document";
  selectedDocumentId: string;
}): boolean {
  if (input.classification.kind !== "bound") return false;
  if (wordMemoGenerateBlocked(input.classification, input.binding)) {
    return true;
  }
  return (
    input.scope !== "document" ||
    !input.binding?.sources.some(
      (source) => source.documentId === input.selectedDocumentId,
    )
  );
}

export type WordMemoSuggestionTaskBinding = Pick<
  WordMemoTaskBinding,
  | "taskId"
  | "projectId"
  | "executionChatId"
  | "memoDocumentId"
  | "memoVersionId"
>;

/**
 * A suggestion may write to Word only while the Task/Memo identity it was
 * generated against is still the current verified binding. Saving V1 as V2
 * deliberately makes V1 suggestions stale instead of silently upgrading them.
 */
export function wordMemoSuggestionBindingMatchesCurrent(
  suggestionBinding: WordMemoSuggestionTaskBinding | null,
  currentBinding: WordMemoTaskBinding | null,
): boolean {
  if (!suggestionBinding || !currentBinding) {
    return suggestionBinding === null && currentBinding === null;
  }
  return (
    suggestionBinding.taskId === currentBinding.taskId &&
    suggestionBinding.projectId === currentBinding.projectId &&
    suggestionBinding.executionChatId === currentBinding.executionChatId &&
    suggestionBinding.memoDocumentId === currentBinding.memoDocumentId &&
    suggestionBinding.memoVersionId === currentBinding.memoVersionId
  );
}

export type WordMemoReviewPointerPersistenceDecision =
  | { kind: "preserve" }
  | { kind: "persist-ordinary" }
  | {
      kind: "persist-task";
      taskBinding: WordMemoSuggestionTaskBinding;
    };

/**
 * Decides whether the current suggestion may replace the saved review
 * pointer. "Preserve" means exactly that: do not persist, clear, or upgrade
 * the existing pointer while Word or the server binding is unresolved.
 */
export function wordMemoReviewPointerPersistenceDecision(input: {
  classification: WordMemoSourceManifestClassification;
  currentBinding: WordMemoTaskBinding | null;
  suggestionBinding: WordMemoSuggestionTaskBinding | null;
  selectedProjectId: string;
  suggestionChatId: string;
  reviewRunId: string | null;
}): WordMemoReviewPointerPersistenceDecision {
  const {
    classification,
    currentBinding,
    suggestionBinding,
    selectedProjectId,
    suggestionChatId,
    reviewRunId,
  } = input;

  if (
    classification.kind === "checking" ||
    classification.kind === "read-error" ||
    classification.kind === "invalid"
  ) {
    return { kind: "preserve" };
  }

  if (classification.kind === "bound") {
    if (
      !wordMemoTaskBindingMatchesManifest(
        classification.manifest,
        currentBinding,
      ) ||
      !suggestionBinding ||
      !wordMemoSuggestionBindingMatchesCurrent(
        suggestionBinding,
        currentBinding,
      ) ||
      selectedProjectId !== suggestionBinding.projectId ||
      suggestionChatId !== suggestionBinding.executionChatId ||
      !reviewRunId ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(reviewRunId)
    ) {
      return { kind: "preserve" };
    }
    return { kind: "persist-task", taskBinding: suggestionBinding };
  }

  if (currentBinding || suggestionBinding) {
    // Never downgrade a Task-bound pointer while the manifest is absent
    // or legacy; only a genuinely ordinary suggestion may replace it.
    return { kind: "preserve" };
  }
  return { kind: "persist-ordinary" };
}

/**
 * Human-facing Verifier status that does not imply final approval.
 */
export function wordMemoVerifierStatusLabel(
  status: WordMemoTaskBinding["verifierStatus"],
): string {
  if (status === "passed") {
    return "Passed for this Version · review each finding before approval";
  }
  if (status === "running") return "Running for this Version";
  return "Not current";
}

/**
 * Human-facing export gate notice that keeps approval separate from the pane.
 */
export function wordMemoExportRequirementText(): string {
  return "Requires current verification, lawyer review, and approval in the Task";
}

/**
 * Human-facing save confirmation that reflects the new Verifier state.
 */
export function wordMemoSavedMessage(input: {
  memoFilename: string;
  memoVersionNumber: number;
  verifierStatus: WordMemoTaskBinding["verifierStatus"];
}): string {
  const base = `Saved ${input.memoFilename} as V${input.memoVersionNumber}.`;
  if (input.verifierStatus === "running") {
    return `${base} Verification is running for this Version; export remains separate.`;
  }
  if (input.verifierStatus === "passed") {
    return `${base} Verification passed for this Version; review each finding before approval.`;
  }
  return `${base} Save recorded; verify to refresh the approval gate.`;
}
