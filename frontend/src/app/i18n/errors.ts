import type { MessageKey, Translate } from "./messages.ts";

export const WORKSPACE_BACKEND_ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "JOB_FAILED",
  "INTERNAL_ERROR",
] as const;

export type WorkspaceBackendErrorCode =
  (typeof WORKSPACE_BACKEND_ERROR_CODES)[number];

export const WORKSPACE_ERROR_MESSAGE_KEYS = {
  VALIDATION_ERROR: "errors.validation",
  NOT_FOUND: "errors.notFound",
  CONFLICT: "errors.conflict",
  PRECONDITION_FAILED: "errors.precondition",
  UNAUTHORIZED: "errors.unauthorized",
  FORBIDDEN: "errors.forbidden",
  RATE_LIMITED: "errors.rateLimited",
  JOB_FAILED: "errors.jobFailed",
  INTERNAL_ERROR: "errors.internal",
} as const satisfies Record<WorkspaceBackendErrorCode, MessageKey>;

const COMPATIBILITY_ERROR_MESSAGE_KEYS = {
  INVALID_DOCUMENT_UPLOAD: "documents.errors.upload",
  UNSUPPORTED_DOCUMENT_TYPE: "documents.errors.unsupported",
  INVALID_RESPONSE: "errors.invalidResponse",
  LOCAL_CONTROL_ERROR: "errors.localControl",
  LOCAL_MODEL_ERROR: "errors.modelUnavailable",
  MODEL_NOT_READY_OR_IMMUTABLE: "errors.modelUnavailable",
  REMOTE_PROVIDER_DISABLED: "errors.remoteDisabled",
  NETWORK_ERROR: "errors.network",
  UNSUPPORTED: "errors.unsupported",
  FAILED: "errors.jobFailed",
  STEP_FAILED: "errors.jobFailed",
  UNKNOWN: "errors.unknown",
} as const satisfies Record<string, MessageKey>;

const STATUS_MESSAGE_KEYS: Readonly<Record<number, MessageKey>> = {
  400: "errors.validation",
  401: "errors.unauthorized",
  403: "errors.forbidden",
  404: "errors.notFound",
  409: "errors.conflict",
  412: "errors.precondition",
  429: "errors.rateLimited",
  500: "errors.internal",
  502: "errors.localControl",
  503: "errors.localControl",
  504: "errors.localControl",
};

const ERROR_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  ...WORKSPACE_ERROR_MESSAGE_KEYS,
  ...COMPATIBILITY_ERROR_MESSAGE_KEYS,
};

export interface BackendErrorDescriptor {
  readonly code?: string | null;
  readonly status?: number | null;
  readonly message?: unknown;
}

export function backendErrorMessageKey(
  error: BackendErrorDescriptor | string | null | undefined,
): MessageKey {
  const descriptor = typeof error === "string" ? { code: error } : error;
  const normalizedCode = descriptor?.code?.trim().toUpperCase();
  if (normalizedCode && ERROR_MESSAGE_KEYS[normalizedCode]) {
    return ERROR_MESSAGE_KEYS[normalizedCode];
  }
  if (descriptor?.status && STATUS_MESSAGE_KEYS[descriptor.status]) {
    return STATUS_MESSAGE_KEYS[descriptor.status];
  }
  return "errors.unknown";
}

export function localizeBackendError(
  error: BackendErrorDescriptor | string | null | undefined,
  translate: Translate,
): string {
  return translate(backendErrorMessageKey(error));
}
