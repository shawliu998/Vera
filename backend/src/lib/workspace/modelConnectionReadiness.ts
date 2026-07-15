export const MODEL_CONNECTION_TEST_ERROR_CODES = [
  "authentication_failed",
  "access_denied",
  "model_unavailable",
  "rate_limited",
  "timeout",
  "network_error",
  "provider_unavailable",
  "invalid_response",
  "configuration_error",
  "credential_unavailable",
] as const;

export const MAX_MODEL_CONNECTION_REVISION = 2_147_483_647;
export const MAX_MODEL_CONNECTION_TEST_LATENCY_MS = 600_000;

export type ModelConnectionTestErrorCode =
  (typeof MODEL_CONNECTION_TEST_ERROR_CODES)[number];

const MODEL_CONNECTION_TEST_ERROR_CODE_SET = new Set<string>(
  MODEL_CONNECTION_TEST_ERROR_CODES,
);

export function isModelConnectionTestErrorCode(
  value: unknown,
): value is ModelConnectionTestErrorCode {
  return (
    typeof value === "string" && MODEL_CONNECTION_TEST_ERROR_CODE_SET.has(value)
  );
}

export function normalizeModelConnectionTestErrorCode(
  value: unknown,
): ModelConnectionTestErrorCode {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (isModelConnectionTestErrorCode(normalized)) return normalized;
  switch (normalized) {
    case "provider_timeout":
      return "timeout";
    case "redirect":
    case "response_too_large":
      return "invalid_response";
    case "hardened_transport_required":
    case "provider_request_failed":
      return "configuration_error";
    case "credential_not_found":
      return "credential_unavailable";
    default:
      return "invalid_response";
  }
}

type StoredModelConnectionTestBase = {
  profileId: string;
  connectionRevision: number;
  latencyMs: number | null;
  testedAt: string;
};

export type StoredModelConnectionTest =
  | (StoredModelConnectionTestBase & {
      status: "passed";
      errorCode: null;
      retryable: false;
    })
  | (StoredModelConnectionTestBase & {
      status: "failed";
      errorCode: ModelConnectionTestErrorCode;
      retryable: boolean;
    });

export type ModelConnectionTestView =
  | {
      status: "untested";
      errorCode: null;
      retryable: false;
      latencyMs: null;
      testedAt: null;
    }
  | {
      status: "stale";
      errorCode: ModelConnectionTestErrorCode | null;
      retryable: boolean;
      latencyMs: number | null;
      testedAt: string;
    }
  | {
      status: "passed";
      errorCode: null;
      retryable: false;
      latencyMs: number | null;
      testedAt: string;
    }
  | {
      status: "failed";
      errorCode: ModelConnectionTestErrorCode;
      retryable: boolean;
      latencyMs: number | null;
      testedAt: string;
    };

export function modelConnectionTestView(
  connectionRevision: number,
  result: StoredModelConnectionTest | null,
): ModelConnectionTestView {
  if (!result) {
    return {
      status: "untested",
      errorCode: null,
      retryable: false,
      latencyMs: null,
      testedAt: null,
    };
  }
  if (result.connectionRevision !== connectionRevision) {
    return {
      status: "stale",
      errorCode: result.errorCode,
      retryable: result.retryable,
      latencyMs: result.latencyMs,
      testedAt: result.testedAt,
    };
  }
  if (result.status === "passed") {
    return {
      status: "passed",
      errorCode: null,
      retryable: false,
      latencyMs: result.latencyMs,
      testedAt: result.testedAt,
    };
  }
  return {
    status: "failed",
    errorCode: result.errorCode,
    retryable: result.retryable,
    latencyMs: result.latencyMs,
    testedAt: result.testedAt,
  };
}
