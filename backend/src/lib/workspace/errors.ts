export const API_ERROR_CODES = [
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

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiError = {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId?: string;
    details?: Array<{ path: string; message: string }>;
  };
};

export class WorkspaceApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: ApiError["error"]["details"];

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: ApiError["error"]["details"],
  ) {
    super(message);
    this.name = "WorkspaceApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toResponse(requestId?: string): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { requestId } : {}),
        ...(this.details?.length ? { details: this.details } : {}),
      },
    };
  }
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  options: {
    status: number;
    details?: ApiError["error"]["details"];
    requestId?: string;
  },
): ApiError {
  return new WorkspaceApiError(options.status, code, message, options.details).toResponse(options.requestId);
}
