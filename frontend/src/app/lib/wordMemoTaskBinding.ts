import type { AgentTaskStatus } from "@/app/types/agent";
import {
  isCitation,
  type BoundWordMemoSourceManifest,
  type WordMemoSourceCitation,
} from "./wordMemoSourceManifest";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

const VERIFIER_STATUS = ["passed", "running", "stale"] as const;
export type WordMemoTaskBindingVerifierStatus =
  (typeof VERIFIER_STATUS)[number];

export type WordMemoTaskSource = {
  documentId: string;
  versionId: string;
  filename: string;
  fileType: string;
  role: "source" | "authority";
};

export type WordMemoTaskBinding = {
  taskId: string;
  taskStatus: AgentTaskStatus;
  projectId: string;
  reviewId: string;
  memoDocumentId: string;
  memoVersionId: string;
  memoVersionNumber: number;
  memoFilename: string;
  executionChatId: string;
  inputDigest: string;
  reviewTitle: string;
  matterName: string;
  verifierStatus: WordMemoTaskBindingVerifierStatus;
  citations: WordMemoSourceCitation[];
  sources: WordMemoTaskSource[];
};

export type WordMemoTaskApiDependencies = {
  apiBase?: string;
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string | null | undefined>;
};

export class WordMemoTaskApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "WordMemoTaskApiError";
  }
}

async function defaultAccessToken() {
  const { supabase } = await import("@/app/lib/supabase");
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

function identityParams(manifest: BoundWordMemoSourceManifest) {
  return {
    task_id: manifest.taskId,
    project_id: manifest.projectId,
    memo_document_id: manifest.memoDocumentId,
    memo_version_id: manifest.memoVersionId,
    input_digest: manifest.inputDigest,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAgentTaskStatus(value: unknown): value is AgentTaskStatus {
  return (
    typeof value === "string" &&
    [
      "queued",
      "running",
      "waiting_input",
      "verifying",
      "paused",
      "completed",
      "failed",
    ].includes(value)
  );
}

function isVerifierStatus(
  value: unknown,
): value is WordMemoTaskBindingVerifierStatus {
  return (
    typeof value === "string" &&
    VERIFIER_STATUS.includes(value as WordMemoTaskBindingVerifierStatus)
  );
}

function isTaskSource(value: unknown): value is WordMemoTaskSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<WordMemoTaskSource>;
  return (
    isNonEmptyString(source.documentId) &&
    isNonEmptyString(source.versionId) &&
    isNonEmptyString(source.filename) &&
    isNonEmptyString(source.fileType) &&
    (source.role === "source" || source.role === "authority")
  );
}

function isValidTaskBinding(value: unknown): value is WordMemoTaskBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<WordMemoTaskBinding>;
  const memoVersionNumber = binding.memoVersionNumber;
  return (
    isNonEmptyString(binding.taskId) &&
    isAgentTaskStatus(binding.taskStatus) &&
    isNonEmptyString(binding.projectId) &&
    isNonEmptyString(binding.reviewId) &&
    isNonEmptyString(binding.memoDocumentId) &&
    isNonEmptyString(binding.memoVersionId) &&
    typeof memoVersionNumber === "number" &&
    Number.isSafeInteger(memoVersionNumber) &&
    memoVersionNumber > 0 &&
    isNonEmptyString(binding.memoFilename) &&
    isNonEmptyString(binding.executionChatId) &&
    isNonEmptyString(binding.inputDigest) &&
    isNonEmptyString(binding.reviewTitle) &&
    isNonEmptyString(binding.matterName) &&
    isVerifierStatus(binding.verifierStatus) &&
    Array.isArray(binding.citations) &&
    binding.citations.every(isCitation) &&
    Array.isArray(binding.sources) &&
    binding.sources.length > 0 &&
    binding.sources.every(isTaskSource) &&
    new Set(binding.sources.map((source) => source.documentId)).size ===
      binding.sources.length
  );
}

function citationsMatch(
  a: readonly WordMemoSourceCitation[],
  b: readonly WordMemoSourceCitation[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((citation, index) => {
    const other = b[index];
    return (
      citation.reference === other.reference &&
      citation.documentId === other.documentId &&
      citation.versionId === other.versionId &&
      citation.filename === other.filename &&
      citation.page === other.page &&
      citation.locator === other.locator &&
      citation.quote === other.quote
    );
  });
}

/**
 * React effects clear and reload a binding after a Word document identity
 * changes. Render-time gates must still reject the previous binding during the
 * intervening frame instead of treating any non-null binding as authoritative.
 */
export function wordMemoTaskBindingMatchesManifest(
  manifest: BoundWordMemoSourceManifest,
  binding: WordMemoTaskBinding | null,
): binding is WordMemoTaskBinding {
  return Boolean(
    binding &&
    binding.taskId === manifest.taskId &&
    binding.projectId === manifest.projectId &&
    binding.reviewId === manifest.reviewId &&
    binding.memoDocumentId === manifest.memoDocumentId &&
    binding.memoVersionId === manifest.memoVersionId &&
    binding.inputDigest === manifest.inputDigest &&
    citationsMatch(binding.citations, manifest.citations),
  );
}

export function assertWordMemoTaskBinding(
  manifest: BoundWordMemoSourceManifest,
  binding: unknown,
): WordMemoTaskBinding {
  if (!isValidTaskBinding(binding)) {
    throw new Error("The server returned a malformed Memo binding.");
  }
  if (
    binding.taskId !== manifest.taskId ||
    binding.projectId !== manifest.projectId ||
    binding.reviewId !== manifest.reviewId ||
    binding.memoDocumentId !== manifest.memoDocumentId ||
    binding.inputDigest !== manifest.inputDigest
  ) {
    throw new Error(
      "The server Memo binding does not match this Word manifest.",
    );
  }
  if (!citationsMatch(binding.citations, manifest.citations)) {
    throw new Error(
      "The server Memo binding citations do not match this Word manifest.",
    );
  }
  if (binding.memoVersionId !== manifest.memoVersionId) {
    throw new Error(
      "This Word file is not the current Memo Version. Reopen the current Memo from its Matter.",
    );
  }
  return binding;
}

async function requestWordMemoBinding(
  manifest: BoundWordMemoSourceManifest,
  endpoint: string,
  init: RequestInit | undefined,
  dependencies: WordMemoTaskApiDependencies,
  options?: { allowSuccessorVersion?: boolean },
) {
  const accessToken = await (
    dependencies.getAccessToken ?? defaultAccessToken
  )();
  if (!accessToken) throw new Error("Authentication required");
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await (dependencies.fetch ?? fetch)(
    `${dependencies.apiBase ?? API_BASE}/tabular-review/${encodeURIComponent(manifest.reviewId)}/${endpoint}`,
    {
      cache: "no-store",
      ...init,
      headers,
    },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new WordMemoTaskApiError(
      payload?.detail ?? `Word Memo Task request failed (${response.status})`,
      response.status,
    );
  }
  const body = (await response.json()) as unknown;
  if (options?.allowSuccessorVersion) {
    if (!isValidTaskBinding(body)) {
      throw new Error("The server returned a malformed Memo binding.");
    }
    if (
      body.taskId !== manifest.taskId ||
      body.projectId !== manifest.projectId ||
      body.reviewId !== manifest.reviewId ||
      body.memoDocumentId !== manifest.memoDocumentId ||
      body.inputDigest !== manifest.inputDigest ||
      !citationsMatch(body.citations, manifest.citations)
    ) {
      throw new Error(
        "The server Memo binding does not match this Word manifest.",
      );
    }
    return body;
  }
  return assertWordMemoTaskBinding(manifest, body);
}

export function loadWordMemoTaskBinding(
  manifest: BoundWordMemoSourceManifest,
  dependencies: WordMemoTaskApiDependencies = {},
) {
  const query = new URLSearchParams(identityParams(manifest));
  return requestWordMemoBinding(
    manifest,
    `memo-context?${query.toString()}`,
    undefined,
    dependencies,
  );
}

export async function saveBoundWordMemoTaskFile(
  input: {
    manifest: BoundWordMemoSourceManifest;
    baseVersionId: string;
    file: File;
    filename?: string;
  },
  dependencies: WordMemoTaskApiDependencies = {},
) {
  if (input.baseVersionId !== input.manifest.memoVersionId) {
    throw new Error(
      "The open Word file Version does not match the requested Memo base. Reopen the current Memo from its Matter.",
    );
  }
  const body = new FormData();
  for (const [name, value] of Object.entries(identityParams(input.manifest))) {
    body.append(name, value);
  }
  body.append("base_version_id", input.baseVersionId);
  body.append("file", input.file, input.filename ?? input.file.name);
  return requestWordMemoBinding(
    input.manifest,
    "memo-task/word-file",
    { method: "PUT", body },
    dependencies,
    { allowSuccessorVersion: true },
  );
}
