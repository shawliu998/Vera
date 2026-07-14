import {
  buildVeraApiUrl,
  getVeraAuthorizationHeaders,
  veraApiPathFromWireUrl,
  VeraRuntimeConfigurationError,
  type VeraQuery,
} from "./veraRuntime";
import {
  DOCUMENT_UPLOAD_ERROR_CODES,
  isSupportedDocumentFile,
  MAX_DOCUMENT_FILENAME_LENGTH,
  type DocumentUploadErrorCode,
} from "./documentUploadValidation";
import type {
  VeraApiErrorWire,
  VeraDocumentJobWire,
  VeraDocumentMutationWire,
  VeraDocumentReadWire,
  VeraDocumentRetryWire,
  VeraDocumentVersionWire,
  VeraDocumentVersionsWire,
  VeraDocumentWire,
  VeraDownloadCapabilityWire,
  VeraFolderCreateWire,
  VeraFolderUpdateWire,
  VeraFolderWire,
  VeraProjectCreateWire,
  VeraProjectUpdateWire,
  VeraProjectWire,
} from "./veraWireTypes";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

export class VeraApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(args: {
    message: string;
    status: number;
    code?: string | null;
    retryable?: boolean;
  }) {
    super(args.message);
    this.name = "VeraApiError";
    this.status = args.status;
    this.code = args.code ?? null;
    this.retryable = args.retryable ?? false;
  }
}

export interface VeraApiRequestOptions extends Omit<
  RequestInit,
  "body" | "cache" | "credentials" | "headers" | "redirect" | "referrerPolicy"
> {
  query?: VeraQuery;
  headers?: HeadersInit;
  json?: unknown;
  body?: BodyInit | null;
}

export interface VeraBlobResponse {
  blob: Blob;
  filename: string | null;
}

function safeHeaderEntries(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  for (const forbidden of [
    "authorization",
    "cookie",
    "host",
    "origin",
    "proxy-authorization",
  ]) {
    if (headers.has(forbidden)) {
      throw new VeraRuntimeConfigurationError(
        `The ${forbidden} header is managed by Vera.`,
      );
    }
  }
  return headers;
}

function requestBody(
  options: VeraApiRequestOptions,
  headers: Headers,
): BodyInit | null | undefined {
  if (options.json !== undefined && options.body !== undefined) {
    throw new VeraRuntimeConfigurationError(
      "A Vera request cannot include both json and body.",
    );
  }
  if (options.json !== undefined) {
    if (headers.has("content-type")) {
      throw new VeraRuntimeConfigurationError(
        "Vera manages the JSON content type.",
      );
    }
    headers.set("Content-Type", "application/json");
    try {
      const serialized = JSON.stringify(options.json);
      if (serialized === undefined) throw new Error("not serializable");
      return serialized;
    } catch {
      throw new VeraRuntimeConfigurationError(
        "The Vera JSON request body is invalid.",
      );
    }
  }
  return options.body;
}

function nativeRequestInit(options: VeraApiRequestOptions): RequestInit {
  const init = { ...options };
  delete init.query;
  delete init.headers;
  delete init.json;
  delete init.body;
  return init;
}

export async function veraApiFetch(
  path: string,
  options: VeraApiRequestOptions = {},
): Promise<Response> {
  const { query, headers: inputHeaders } = options;
  const init = nativeRequestInit(options);
  const [url, authHeaders] = await Promise.all([
    buildVeraApiUrl(path, query),
    getVeraAuthorizationHeaders(),
  ]);
  const headers = safeHeaderEntries(inputHeaders);
  for (const [name, value] of Object.entries(authHeaders)) {
    headers.set(name, value);
  }
  if (!headers.has("accept")) headers.set("Accept", "application/json");
  const body = requestBody(options, headers);
  const method = (options.method ?? "GET").toUpperCase();
  if ((method === "GET" || method === "HEAD") && body != null) {
    throw new VeraRuntimeConfigurationError(
      `${method} Vera requests cannot include a body.`,
    );
  }

  return fetch(url, {
    ...init,
    method,
    body,
    headers,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
}

async function readBoundedText(
  response: Response,
  limit: number,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let output = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The original decoding/read failure is the useful signal.
    }
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function veraApiErrorFromResponse(
  response: Response,
): Promise<VeraApiError> {
  const fallback = `Vera API request failed with status ${response.status}.`;
  const text = await readBoundedText(response, MAX_ERROR_BYTES);
  if (text === null) {
    return new VeraApiError({ status: response.status, message: fallback });
  }

  let payload: VeraApiErrorWire;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    payload = parsed as VeraApiErrorWire;
  } catch {
    return new VeraApiError({ status: response.status, message: fallback });
  }

  const nested =
    typeof payload.error === "object" && payload.error !== null
      ? payload.error
      : undefined;
  const detail = nonEmptyString(payload.detail);
  const nestedMessage = nonEmptyString(nested?.message);
  const topCode = nonEmptyString(payload.code);
  const nestedCode = nonEmptyString(nested?.code);

  return new VeraApiError({
    status: response.status,
    code: topCode ?? nestedCode,
    message: detail ?? nestedMessage ?? fallback,
    retryable: nested?.retryable === true,
  });
}

function responseHasNoBody(response: Response): boolean {
  return (
    response.status === 204 ||
    response.status === 205 ||
    response.headers.get("content-length") === "0"
  );
}

export async function veraApiRequest<T>(
  path: string,
  options: VeraApiRequestOptions = {},
): Promise<T> {
  const response = await veraApiFetch(path, options);
  if (!response.ok) throw await veraApiErrorFromResponse(response);
  if (responseHasNoBody(response)) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new VeraApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The Vera API returned an invalid response.",
    });
  }
  const text = await readBoundedText(response, MAX_JSON_BYTES);
  if (text === null || text.length === 0) {
    throw new VeraApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The Vera API returned an invalid response.",
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new VeraApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The Vera API returned invalid JSON.",
    });
  }
}

function safeDownloadFilename(response: Response): string | null {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(
    /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i,
  )?.[1];
  const plain = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
  let value: string | undefined;
  if (encoded) {
    try {
      value = decodeURIComponent(encoded);
    } catch {
      return null;
    }
  } else {
    value = plain;
  }
  if (
    !value ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f\\/]/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    return null;
  }
  return value;
}

export async function veraApiBlobRequest(
  path: string,
  options: VeraApiRequestOptions = {},
): Promise<VeraBlobResponse> {
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("Accept", "application/octet-stream");
  const response = await veraApiFetch(path, { ...options, headers });
  if (!response.ok) throw await veraApiErrorFromResponse(response);
  if (responseHasNoBody(response)) {
    throw new VeraApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The Vera API returned an empty download.",
    });
  }
  return {
    blob: await response.blob(),
    filename: safeDownloadFilename(response),
  };
}

function safeId(value: string, label: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new VeraRuntimeConfigurationError(`The Vera ${label} is invalid.`);
  }
  return value;
}

const VERA_FILE_TYPES = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xlsm",
  "xls",
  "pptx",
  "ppt",
  "txt",
  "md",
]);
const VERA_LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";

function invalidWire(label: string): never {
  throw new VeraApiError({
    status: 200,
    code: "INVALID_RESPONSE",
    message: `The Vera API returned an invalid ${label}.`,
  });
}

function wireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidWire(label);
  }
  return value as Record<string, unknown>;
}

function exactWireKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    invalidWire(label);
}

function wireString(value: unknown, label: string): string {
  if (typeof value !== "string") return invalidWire(label);
  return value;
}

function wireNullableString(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string") return invalidWire(label);
  return value as string | null;
}

function wireUuid(value: unknown, label: string): string {
  const id = wireString(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    return invalidWire(label);
  }
  return id;
}

function wireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalidWire(label);
  return value;
}

function wireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    return invalidWire(label);
  return Number(value);
}

function wireNullableNonNegativeInteger(
  value: unknown,
  label: string,
): number | null {
  return value === null ? null : wireNonNegativeInteger(value, label);
}

function parseVeraFolderWire(value: unknown): VeraFolderWire {
  const wire = wireRecord(value, "folder response");
  exactWireKeys(
    wire,
    [
      "id",
      "project_id",
      "user_id",
      "name",
      "parent_folder_id",
      "created_at",
      "updated_at",
    ],
    "folder response",
  );
  wireUuid(wire.id, "folder id");
  wireUuid(wire.project_id, "folder project id");
  if (wireUuid(wire.user_id, "folder user id") !== VERA_LOCAL_USER_ID) {
    invalidWire("folder user projection");
  }
  wireString(wire.name, "folder name");
  if (wire.parent_folder_id !== null) {
    wireUuid(wire.parent_folder_id, "parent folder id");
  }
  wireString(wire.created_at, "folder created timestamp");
  wireString(wire.updated_at, "folder updated timestamp");
  return wire as unknown as VeraFolderWire;
}

function parseVeraDocumentWire(value: unknown): VeraDocumentWire {
  const wire = wireRecord(value, "document response");
  exactWireKeys(
    wire,
    [
      "id",
      "user_id",
      "project_id",
      "folder_id",
      "filename",
      "owner_email",
      "owner_display_name",
      "file_type",
      "storage_path",
      "pdf_storage_path",
      "size_bytes",
      "page_count",
      "structure_tree",
      "status",
      "created_at",
      "updated_at",
      "active_version_number",
      "latest_version_number",
    ],
    "document response",
  );
  wireUuid(wire.id, "document id");
  if (wireUuid(wire.user_id, "document user id") !== VERA_LOCAL_USER_ID) {
    invalidWire("document user projection");
  }
  if (wire.project_id !== null)
    wireUuid(wire.project_id, "document project id");
  if (wire.folder_id !== null) wireUuid(wire.folder_id, "document folder id");
  wireString(wire.filename, "document filename");
  if (wire.owner_email !== null) invalidWire("document owner projection");
  wireNullableString(wire.owner_display_name, "document owner name");
  if (wire.file_type !== null) {
    const fileType = wireString(wire.file_type, "document file type");
    if (!VERA_FILE_TYPES.has(fileType)) invalidWire("document file type");
  }
  if (wire.storage_path !== null) invalidWire("document storage projection");
  if (
    wire.pdf_storage_path !== null &&
    wire.pdf_storage_path !== "local-preview"
  ) {
    invalidWire("document preview projection");
  }
  if (wire.structure_tree !== null)
    invalidWire("document structure projection");
  wireNullableNonNegativeInteger(wire.size_bytes, "document size");
  wireNullableNonNegativeInteger(wire.page_count, "document page count");
  if (
    !["pending", "processing", "ready", "error"].includes(String(wire.status))
  ) {
    invalidWire("document status");
  }
  if (wire.created_at !== null)
    wireString(wire.created_at, "document created timestamp");
  if (wire.updated_at !== null)
    wireString(wire.updated_at, "document updated timestamp");
  wireNullableNonNegativeInteger(
    wire.active_version_number,
    "document active version",
  );
  wireNullableNonNegativeInteger(
    wire.latest_version_number,
    "document latest version",
  );
  return wire as unknown as VeraDocumentWire;
}

function parseVeraProjectWire(value: unknown): VeraProjectWire {
  const wire = wireRecord(value, "project response");
  exactWireKeys(
    wire,
    [
      "id",
      "user_id",
      "name",
      "description",
      "cm_number",
      "practice",
      "shared_with",
      "created_at",
      "updated_at",
      "is_owner",
      "owner_display_name",
      "owner_email",
      "documents",
      "folders",
      "document_count",
      "chat_count",
      "review_count",
      "workflow_count",
      "status",
      "archived_at",
      "default_model_profile_id",
    ],
    "project response",
  );
  wireUuid(wire.id, "project id");
  if (wireUuid(wire.user_id, "project user id") !== VERA_LOCAL_USER_ID) {
    invalidWire("project user projection");
  }
  wireString(wire.name, "project name");
  wireNullableString(wire.description, "project description");
  wireNullableString(wire.cm_number, "project CM number");
  wireNullableString(wire.practice, "project practice");
  if (!Array.isArray(wire.shared_with) || wire.shared_with.length !== 0) {
    invalidWire("project sharing projection");
  }
  wireString(wire.created_at, "project created timestamp");
  wireString(wire.updated_at, "project updated timestamp");
  if (!wireBoolean(wire.is_owner, "project ownership projection")) {
    invalidWire("project ownership projection");
  }
  wireNullableString(wire.owner_display_name, "project owner name");
  if (wire.owner_email !== null) invalidWire("project owner projection");
  if (!Array.isArray(wire.documents)) invalidWire("project documents");
  wire.documents.forEach(parseVeraDocumentWire);
  if (!Array.isArray(wire.folders)) invalidWire("project folders");
  wire.folders.forEach(parseVeraFolderWire);
  wireNonNegativeInteger(wire.document_count, "project document count");
  wireNonNegativeInteger(wire.chat_count, "project chat count");
  wireNonNegativeInteger(wire.review_count, "project review count");
  wireNonNegativeInteger(wire.workflow_count, "project workflow count");
  if (!["active", "archived", "deleted"].includes(String(wire.status))) {
    invalidWire("project status");
  }
  wireNullableString(wire.archived_at, "project archived timestamp");
  if (wire.default_model_profile_id !== null) {
    wireUuid(wire.default_model_profile_id, "project default model profile id");
  }
  return wire as unknown as VeraProjectWire;
}

function parseVeraDocumentVersionWire(value: unknown): VeraDocumentVersionWire {
  const wire = wireRecord(value, "document version response");
  exactWireKeys(
    wire,
    [
      "id",
      "version_number",
      "source",
      "created_at",
      "filename",
      "file_type",
      "size_bytes",
      "page_count",
      "deleted_at",
      "deleted_by",
    ],
    "document version response",
  );
  wireUuid(wire.id, "document version id");
  wireNullableNonNegativeInteger(
    wire.version_number,
    "document version number",
  );
  wireString(wire.source, "document version source");
  wireString(wire.created_at, "document version timestamp");
  wireNullableString(wire.filename, "document version filename");
  if (wire.file_type !== undefined && wire.file_type !== null) {
    const fileType = wireString(wire.file_type, "document version file type");
    if (!VERA_FILE_TYPES.has(fileType))
      invalidWire("document version file type");
  }
  if (wire.size_bytes !== undefined) {
    wireNullableNonNegativeInteger(wire.size_bytes, "document version size");
  }
  if (wire.page_count !== undefined) {
    wireNullableNonNegativeInteger(
      wire.page_count,
      "document version page count",
    );
  }
  if (wire.deleted_at !== undefined) {
    wireNullableString(wire.deleted_at, "document version deletion timestamp");
  }
  if (wire.deleted_by !== undefined) {
    wireNullableString(wire.deleted_by, "document version deleter");
  }
  return wire as unknown as VeraDocumentVersionWire;
}

function parseVeraDocumentJobWire(value: unknown): VeraDocumentJobWire {
  const wire = wireRecord(value, "document job response");
  exactWireKeys(
    wire,
    [
      "id",
      "type",
      "status",
      "attempt",
      "max_attempts",
      "retryable",
      "created_at",
      "scheduled_at",
      "started_at",
      "completed_at",
    ],
    "document job response",
  );
  wireUuid(wire.id, "document job id");
  if (wire.type !== "document_parse") invalidWire("document job type");
  if (
    ![
      "queued",
      "running",
      "complete",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(String(wire.status))
  ) {
    invalidWire("document job status");
  }
  wireNonNegativeInteger(wire.attempt, "document job attempt");
  wireNonNegativeInteger(wire.max_attempts, "document job max attempts");
  wireBoolean(wire.retryable, "document job retryable value");
  wireString(wire.created_at, "document job created timestamp");
  wireString(wire.scheduled_at, "document job scheduled timestamp");
  wireNullableString(wire.started_at, "document job started timestamp");
  wireNullableString(wire.completed_at, "document job completed timestamp");
  return wire as unknown as VeraDocumentJobWire;
}

function parseVeraDocumentMutationWire(
  value: unknown,
): VeraDocumentMutationWire {
  const wire = wireRecord(value, "document mutation response");
  exactWireKeys(
    wire,
    ["document", "version", "job"],
    "document mutation response",
  );
  return {
    document: parseVeraDocumentWire(wire.document),
    version: parseVeraDocumentVersionWire(wire.version),
    job: parseVeraDocumentJobWire(wire.job),
  };
}

function parseVeraDocumentRetryWire(value: unknown): VeraDocumentRetryWire {
  const wire = wireRecord(value, "document retry response");
  exactWireKeys(wire, ["job"], "document retry response");
  return { job: parseVeraDocumentJobWire(wire.job) };
}

function parseWireArray<T>(
  value: unknown,
  label: string,
  parse: (entry: unknown) => T,
): T[] {
  if (!Array.isArray(value)) invalidWire(label);
  return value.map(parse);
}

function parseVeraDocumentVersionsWire(
  value: unknown,
): VeraDocumentVersionsWire {
  const wire = wireRecord(value, "document versions response");
  exactWireKeys(
    wire,
    ["current_version_id", "versions"],
    "document versions response",
  );
  if (wire.current_version_id !== null) {
    wireUuid(wire.current_version_id, "current document version id");
  }
  return {
    current_version_id: wire.current_version_id as string | null,
    versions: parseWireArray(
      wire.versions,
      "document version list response",
      parseVeraDocumentVersionWire,
    ),
  };
}

export interface VeraPageQuery {
  cursor?: string;
  limit?: number;
}

export interface VeraDocumentListQuery extends VeraPageQuery {
  project_id?: string | null;
  folder_id?: string | null;
  status?: "pending" | "processing" | "ready" | "error";
}

export interface VeraDocumentUploadInput {
  file: File;
  projectId?: string | null;
  folderId?: string | null;
}

export interface VeraDocumentMutationScope {
  /** `null` is explicitly standalone; omission uses the generic route. */
  projectId?: string | null;
}

function toPageQuery(page: VeraPageQuery): VeraQuery {
  return { cursor: page.cursor, limit: page.limit };
}

function toDocumentQuery(filters: VeraDocumentListQuery): VeraQuery {
  return {
    ...toPageQuery(filters),
    project_id:
      typeof filters.project_id === "string"
        ? safeId(filters.project_id, "project id")
        : filters.project_id,
    folder_id:
      typeof filters.folder_id === "string"
        ? safeId(filters.folder_id, "folder id")
        : filters.folder_id,
    status: filters.status,
  };
}

function documentUploadError(
  code: DocumentUploadErrorCode,
): VeraRuntimeConfigurationError & { readonly code: DocumentUploadErrorCode } {
  return Object.assign(
    new VeraRuntimeConfigurationError("The Vera document upload is invalid."),
    { code },
  );
}

const blobSlice = Blob.prototype.slice;

function isFormDataUploadFile(file: unknown, filename: string): file is File {
  try {
    // Calling the platform intrinsic validates Blob internal slots without an
    // instanceof check, so genuine Files from another realm remain valid while
    // objects that only spoof File properties or Symbol.toStringTag fail closed.
    blobSlice.call(file, 0, 0);
    const probe = new FormData();
    // Supplying filename selects the Blob overload. Invalid lookalikes throw
    // instead of being silently stringified; native cross-realm Files remain
    // acceptable to the browser's own FormData implementation.
    probe.append("file", file as Blob, filename);
    return true;
  } catch {
    return false;
  }
}

function safeUploadFile(file: File): { file: File; filename: string } {
  const name =
    typeof file === "object" && file !== null && "name" in file
      ? (file as { name?: unknown }).name
      : undefined;
  const filename = typeof name === "string" ? name.trim() : "";
  if (
    !filename ||
    filename.length > MAX_DOCUMENT_FILENAME_LENGTH ||
    filename === "." ||
    filename === ".." ||
    /[\u0000-\u001f\u007f\\/]/.test(filename) ||
    !isFormDataUploadFile(file, filename)
  ) {
    throw documentUploadError(DOCUMENT_UPLOAD_ERROR_CODES.invalidFile);
  }
  if (!isSupportedDocumentFile({ name: filename })) {
    throw documentUploadError(DOCUMENT_UPLOAD_ERROR_CODES.unsupportedType);
  }
  return { file, filename };
}

function documentCollectionPath(projectId: string | null | undefined): string {
  if (typeof projectId === "string") {
    return `/projects/${safeId(projectId, "project id")}/documents`;
  }
  return projectId === null ? "/single-documents" : "/documents";
}

function scopedDocumentPath(
  documentId: string,
  scope: VeraDocumentMutationScope,
): string {
  const id = safeId(documentId, "document id");
  if (typeof scope.projectId === "string") {
    return `/projects/${safeId(scope.projectId, "project id")}/documents/${id}`;
  }
  return scope.projectId === null
    ? `/single-documents/${id}`
    : `/documents/${id}`;
}

export async function uploadVeraDocument(
  input: VeraDocumentUploadInput,
  signal?: AbortSignal,
): Promise<VeraDocumentMutationWire> {
  const upload = safeUploadFile(input.file);
  if (input.folderId != null && typeof input.projectId !== "string") {
    throw new VeraRuntimeConfigurationError(
      "A Vera project id is required for a document folder.",
    );
  }
  const form = new FormData();
  form.append("file", upload.file, upload.filename);
  if (typeof input.folderId === "string") {
    form.append("folder_id", safeId(input.folderId, "folder id"));
  }
  return parseVeraDocumentMutationWire(
    await veraApiRequest<unknown>(documentCollectionPath(input.projectId), {
      method: "POST",
      body: form,
      signal,
    }),
  );
}

export async function uploadVeraDocumentVersion(
  documentId: string,
  file: File,
  scope: VeraDocumentMutationScope = {},
  signal?: AbortSignal,
): Promise<VeraDocumentMutationWire> {
  const upload = safeUploadFile(file);
  const form = new FormData();
  form.append("file", upload.file, upload.filename);
  return parseVeraDocumentMutationWire(
    await veraApiRequest<unknown>(
      `${scopedDocumentPath(documentId, scope)}/versions`,
      { method: "POST", body: form, signal },
    ),
  );
}

export async function retryVeraDocumentParse(
  documentId: string,
  scope: VeraDocumentMutationScope = {},
  signal?: AbortSignal,
): Promise<VeraDocumentRetryWire> {
  return parseVeraDocumentRetryWire(
    await veraApiRequest<unknown>(
      `${scopedDocumentPath(documentId, scope)}/retry`,
      { method: "POST", signal },
    ),
  );
}

export function deleteVeraDocument(
  documentId: string,
  scope: VeraDocumentMutationScope = {},
  signal?: AbortSignal,
): Promise<void> {
  return veraApiRequest(scopedDocumentPath(documentId, scope), {
    method: "DELETE",
    signal,
  });
}

export interface VeraProjectPage {
  items: VeraProjectWire[];
  next_cursor: string | null;
}

// Mike-compatible project/folder/document vertical. The no-pagination list
// deliberately retains Mike's Project[] response shape; cursor callers opt in
// through the separately named page helper.
export async function listVeraProjects(
  signal?: AbortSignal,
): Promise<VeraProjectWire[]> {
  const value = await veraApiRequest<unknown>("/projects", { signal });
  if (!Array.isArray(value)) invalidWire("project list response");
  return value.map(parseVeraProjectWire);
}

export async function listVeraProjectPage(
  page: VeraPageQuery,
  signal?: AbortSignal,
): Promise<VeraProjectPage> {
  const value = wireRecord(
    await veraApiRequest<unknown>("/projects", {
      query: toPageQuery(page),
      signal,
    }),
    "project page response",
  );
  exactWireKeys(value, ["items", "next_cursor"], "project page response");
  if (!Array.isArray(value.items)) invalidWire("project page items");
  if (value.next_cursor !== null && typeof value.next_cursor !== "string") {
    invalidWire("project page cursor");
  }
  return {
    items: value.items.map(parseVeraProjectWire),
    next_cursor: value.next_cursor as string | null,
  };
}

export async function createVeraProject(
  input: VeraProjectCreateWire,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return parseVeraProjectWire(
    await veraApiRequest<unknown>("/projects", {
      method: "POST",
      json: input,
      signal,
    }),
  );
}

export async function getVeraProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return parseVeraProjectWire(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}`,
      { signal },
    ),
  );
}

export async function updateVeraProject(
  projectId: string,
  input: VeraProjectUpdateWire,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return parseVeraProjectWire(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}`,
      { method: "PATCH", json: input, signal },
    ),
  );
}

export async function archiveVeraProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return parseVeraProjectWire(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/archive`,
      { method: "POST", signal },
    ),
  );
}

export async function unarchiveVeraProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return parseVeraProjectWire(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/unarchive`,
      { method: "POST", signal },
    ),
  );
}

export function deleteVeraProject(
  projectId: string,
  confirmName: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!confirmName.trim() || confirmName.length > 240) {
    throw new VeraRuntimeConfigurationError(
      "The Vera project delete confirmation is invalid.",
    );
  }
  return veraApiRequest(`/projects/${safeId(projectId, "project id")}`, {
    method: "DELETE",
    json: { confirm_name: confirmName },
    signal,
  });
}

export async function listVeraProjectFolders(
  projectId: string,
  page: VeraPageQuery = {},
  signal?: AbortSignal,
): Promise<VeraFolderWire[]> {
  return parseWireArray(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/folders`,
      { query: toPageQuery(page), signal },
    ),
    "project folder list response",
    parseVeraFolderWire,
  );
}

export async function createVeraProjectFolder(
  projectId: string,
  input: VeraFolderCreateWire,
  signal?: AbortSignal,
): Promise<VeraFolderWire> {
  return parseVeraFolderWire(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/folders`,
      { method: "POST", json: input, signal },
    ),
  );
}

export async function updateVeraProjectFolder(
  projectId: string,
  folderId: string,
  input: VeraFolderUpdateWire,
  signal?: AbortSignal,
): Promise<VeraFolderWire> {
  return parseVeraFolderWire(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/folders/${safeId(folderId, "folder id")}`,
      { method: "PATCH", json: input, signal },
    ),
  );
}

export function deleteVeraProjectFolder(
  projectId: string,
  folderId: string,
  signal?: AbortSignal,
): Promise<void> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/folders/${safeId(folderId, "folder id")}`,
    { method: "DELETE", signal },
  );
}

export async function listVeraProjectDocuments(
  projectId: string,
  page: VeraPageQuery = {},
  signal?: AbortSignal,
): Promise<VeraDocumentWire[]> {
  return parseWireArray(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/documents`,
      { query: toPageQuery(page), signal },
    ),
    "project document list response",
    parseVeraDocumentWire,
  );
}

export async function attachVeraProjectDocument(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<VeraDocumentWire> {
  return parseVeraDocumentWire(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/documents/${safeId(documentId, "document id")}`,
      { method: "POST", signal },
    ),
  );
}

export async function renameVeraProjectDocument(
  projectId: string,
  documentId: string,
  filename: string,
  signal?: AbortSignal,
): Promise<VeraDocumentWire> {
  return parseVeraDocumentWire(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/documents/${safeId(documentId, "document id")}`,
      { method: "PATCH", json: { filename }, signal },
    ),
  );
}

export async function moveVeraProjectDocument(
  projectId: string,
  documentId: string,
  folderId: string | null,
  signal?: AbortSignal,
): Promise<VeraDocumentWire> {
  return parseVeraDocumentWire(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/documents/${safeId(documentId, "document id")}/folder`,
      {
        method: "PATCH",
        json: {
          folder_id: folderId === null ? null : safeId(folderId, "folder id"),
        },
        signal,
      },
    ),
  );
}

export async function listVeraDocuments(
  filters: VeraDocumentListQuery = {},
  signal?: AbortSignal,
): Promise<VeraDocumentWire[]> {
  return parseWireArray(
    await veraApiRequest<unknown>("/documents", {
      query: toDocumentQuery(filters),
      signal,
    }),
    "document list response",
    parseVeraDocumentWire,
  );
}

export async function listVeraStandaloneDocuments(
  filters: Pick<VeraDocumentListQuery, "cursor" | "limit" | "status"> = {},
  signal?: AbortSignal,
): Promise<VeraDocumentWire[]> {
  return parseWireArray(
    await veraApiRequest<unknown>("/single-documents", {
      query: {
        cursor: filters.cursor,
        limit: filters.limit,
        status: filters.status,
      },
      signal,
    }),
    "standalone document list response",
    parseVeraDocumentWire,
  );
}

export async function getVeraDocument(
  documentId: string,
  signal?: AbortSignal,
): Promise<VeraDocumentWire> {
  return parseVeraDocumentWire(
    await veraApiRequest<unknown>(
      `/documents/${safeId(documentId, "document id")}`,
      { signal },
    ),
  );
}

export async function listVeraDocumentVersions(
  documentId: string,
  signal?: AbortSignal,
): Promise<VeraDocumentVersionsWire> {
  return parseVeraDocumentVersionsWire(
    await veraApiRequest<unknown>(
      `/documents/${safeId(documentId, "document id")}/versions`,
      { signal },
    ),
  );
}

export function readVeraDocument(
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraDocumentReadWire> {
  return veraApiRequest(
    `/documents/${safeId(documentId, "document id")}/read`,
    {
      query: versionId ? { version_id: safeId(versionId, "version id") } : {},
      signal,
    },
  );
}

export function getVeraDocumentDownloadCapability(
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraDownloadCapabilityWire> {
  return veraApiRequest(`/documents/${safeId(documentId, "document id")}/url`, {
    query: versionId ? { version_id: safeId(versionId, "version id") } : {},
    signal,
  });
}

export function getVeraDocumentVersionFileCapability(
  documentId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<VeraDownloadCapabilityWire> {
  return veraApiRequest(
    `/documents/${safeId(documentId, "document id")}/versions/${safeId(versionId, "version id")}/file`,
    { signal },
  );
}

/** Authenticated inline preview bytes; unlike `/read`, this is never JSON text. */
export function displayVeraDocument(
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraBlobResponse> {
  return veraApiBlobRequest(
    `/documents/${safeId(documentId, "document id")}/display`,
    {
      query: versionId ? { version_id: safeId(versionId, "version id") } : {},
      signal,
    },
  );
}

export function downloadVeraCapability(
  capability: VeraDownloadCapabilityWire,
  signal?: AbortSignal,
): Promise<VeraBlobResponse> {
  return veraApiBlobRequest(
    veraApiPathFromWireUrl(capability.download_url ?? capability.url),
    { signal },
  );
}
