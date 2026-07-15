/**
 * Vera local adapter for Mike workflow CRUD wire compatibility.
 *
 * Direct/adapt provenance: Open-Legal-Products/mike
 * e32daad5a4c64a5561e04c53ee12411e3c5e7238
 * frontend/src/app/lib/mikeApi.ts (workflow CRUD section).
 *
 * AGPL-3.0-only. This module intentionally owns the workflow-specific
 * transport validation rather than accepting a client-side fallback shape.
 */

import {
  VeraApiError,
  veraApiRequest,
  type VeraApiRequestOptions,
} from "./veraApi";

export const VERA_WORKFLOW_FORMATS = [
  "text",
  "bulleted_list",
  "number",
  "currency",
  "yes_no",
  "date",
  "tag",
  "percentage",
  "monetary_amount",
] as const;

export type VeraWorkflowFormat = (typeof VERA_WORKFLOW_FORMATS)[number];
export type VeraWorkflowType = "assistant" | "tabular";
export type VeraWorkflowJson =
  | null
  | boolean
  | number
  | string
  | VeraWorkflowJson[]
  | { [key: string]: VeraWorkflowJson };

export const VERA_WORKFLOW_RUN_STATUSES = [
  "queued",
  "waiting",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type VeraWorkflowRunStatus =
  (typeof VERA_WORKFLOW_RUN_STATUSES)[number];
export type VeraWorkflowStepStatus =
  | VeraWorkflowRunStatus
  | "skipped";

export interface VeraWorkflowExecutionCapabilities {
  execution_enabled: boolean;
  assistant_runs: true;
  tabular_runs: false;
}

export type VeraWorkflowStepDefinition =
  | {
      id: string;
      kind: "prompt";
      title: string;
      prompt: string;
      model_profile_id?: string;
    }
  | {
      id: string;
      kind: "document_context";
      title: string;
      max_documents: number;
      max_chunks_per_document: number;
      query_template?: string;
      result_limit?: number;
    }
  | {
      id: string;
      kind: "tabular_column";
      title: string;
      output_type: string;
      prompt: string;
      enum_values?: string[];
    }
  | {
      id: string;
      kind: "output";
      title: string;
      format: "text" | "json";
    };

export type VeraWorkflowDefinitionStep =
  | {
      id: string;
      type: "prompt";
      name: string;
      prompt: string;
      model_profile_id?: string;
      /** Reserved by the runtime; only the empty mapping is accepted. */
      input_mapping?: Record<string, never>;
    }
  | {
      id: string;
      type: "document_retrieval";
      name: string;
      query_template: string;
      limit: number;
    }
  | {
      id: string;
      type: "output";
      name: string;
      format: "text" | "json";
    };

export interface VeraWorkflowDefinition {
  id: string;
  type: "assistant";
  name: string;
  description: string | null;
  project_id: string | null;
  steps: VeraWorkflowDefinitionStep[];
  updated_at: string;
}

export interface VeraWorkflowDefinitionUpdate {
  name: string;
  description: string | null;
  project_id: string | null;
  steps: VeraWorkflowDefinitionStep[];
}

export interface VeraWorkflowStructuredError {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, string | number | boolean | null> | null;
}

export interface VeraWorkflowRun {
  id: string;
  workflow_id: string;
  project_id: string | null;
  status: VeraWorkflowRunStatus;
  model_profile_id: string | null;
  job_id: string | null;
  retry_of_run_id: string | null;
  input: VeraWorkflowJson;
  output: VeraWorkflowJson | null;
  started_at: string | null;
  completed_at: string | null;
  error: VeraWorkflowStructuredError | null;
  created_at: string;
}

export interface VeraWorkflowStepRun {
  id: string;
  workflow_run_id: string;
  ordinal: number;
  attempt: number;
  step: VeraWorkflowStepDefinition;
  status: VeraWorkflowStepStatus;
  input: VeraWorkflowJson;
  output: VeraWorkflowJson | null;
  error: VeraWorkflowStructuredError | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface VeraWorkflowRunDetail {
  run: VeraWorkflowRun;
  steps: VeraWorkflowStepRun[];
}

export interface VeraPreparedWorkflowRun extends VeraWorkflowRunDetail {
  reused: boolean;
}

export interface VeraWorkflowRunPage {
  items: VeraWorkflowRun[];
  next_cursor: string | null;
}

export interface VeraPrepareWorkflowRunInput {
  idempotency_key: string;
  project_id?: string;
  model_profile_id?: string;
  input_binding?: VeraWorkflowJson;
}

export interface VeraWorkflowColumn {
  index: number;
  name: string;
  prompt: string;
  format?: VeraWorkflowFormat;
  tags?: string[];
}

export interface VeraWorkflowContributor {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
}

export interface VeraWorkflow {
  id: string;
  user_id: string | null;
  metadata: {
    title: string;
    description: string | null;
    type: VeraWorkflowType;
    contributors: VeraWorkflowContributor[];
    language: string;
    version: string | null;
    practice: string | null;
    jurisdictions: string[] | null;
  };
  skill_md: string | null;
  columns_config: VeraWorkflowColumn[] | null;
  is_system: boolean;
  created_at: string;
  shared_by_name: string | null;
  allow_edit: boolean;
  is_owner: boolean;
  open_source_submission: null;
}

export interface VeraWorkflowMetadataInput {
  title: string;
  language?: string | null;
  practice?: string | null;
  jurisdictions?: string[] | null;
}

export interface VeraWorkflowCreateInput {
  metadata: VeraWorkflowMetadataInput & { type: VeraWorkflowType };
  skill_md?: string;
  columns_config?: VeraWorkflowColumn[];
}

export interface VeraWorkflowUpdateInput {
  metadata?: Partial<VeraWorkflowMetadataInput>;
  skill_md?: string;
  columns_config?: VeraWorkflowColumn[];
}

type WireRecord = Record<string, unknown>;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRICT_UTC_ISO_MILLISECONDS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCAL_PATH_PATTERN =
  /(?:^|[\s"'(])(?:\/[Uu]sers\/|\/home\/|[A-Za-z]:\\|file:\/\/)/;
const SECRET_TEXT_PATTERN =
  /(?:bearer\s+)[a-z0-9._~+/=-]{8,}|\b(?:sk|key)-[a-z0-9_-]{8,}\b/i;
const MAX_SAFE_JSON_DEPTH = 32;
const MAX_SAFE_JSON_NODES = 100_000;

function normalizedWireKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function sensitiveWorkflowKey(key: string): boolean {
  const normalized = normalizedWireKey(key);
  return (
    normalized === "secret" ||
    normalized.endsWith("_secret") ||
    normalized === "api_key" ||
    normalized.endsWith("_api_key") ||
    normalized === "access_token" ||
    normalized === "authorization" ||
    normalized.includes("credential_ref") ||
    normalized === "credential" ||
    normalized === "storage_path" ||
    normalized === "local_path" ||
    normalized === "absolute_path" ||
    normalized === "file_path" ||
    normalized === "raw_provider" ||
    normalized.startsWith("raw_provider_") ||
    normalized === "provider_response" ||
    normalized === "provider_payload" ||
    normalized === "provider_event"
  );
}

/** Fail closed before rendering or retaining provider, credential or path data. */
export function assertNoVeraWorkflowSensitiveFields(
  value: unknown,
  detail = "The Vera API returned unsafe workflow data.",
): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SAFE_JSON_NODES || depth > MAX_SAFE_JSON_DEPTH) {
      invalidWorkflowWire(detail);
    }
    if (typeof candidate === "string") {
      if (
        candidate.length > 1_000_000 ||
        LOCAL_PATH_PATTERN.test(candidate) ||
        SECRET_TEXT_PATTERN.test(candidate)
      ) {
        invalidWorkflowWire(detail);
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (ancestors.has(candidate)) invalidWorkflowWire(detail);
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, depth + 1));
      ancestors.delete(candidate);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (sensitiveWorkflowKey(key)) invalidWorkflowWire(detail);
      visit(nested, depth + 1);
    }
    ancestors.delete(candidate);
  };
  visit(value, 0);
}

function invalidWorkflowWire(
  detail = "The Vera API returned an invalid workflow response.",
): never {
  throw new VeraApiError({
    status: 200,
    code: "INVALID_RESPONSE",
    message: detail,
  });
}

function record(value: unknown): WireRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidWorkflowWire();
  }
  return value as WireRecord;
}

function exactKeys(value: WireRecord, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidWorkflowWire();
  }
}

function allowedKeys(value: WireRecord, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalidWorkflowWire();
  }
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum)
    invalidWorkflowWire();
  return value;
}

function boundedNonEmptyString(value: unknown, maximum: number): string {
  const text = boundedString(value, maximum);
  if (!text.trim()) invalidWorkflowWire();
  return text;
}

function nullableString(value: unknown, maximum: number): string | null {
  return value === null ? null : boundedString(value, maximum);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidWorkflowWire();
  return value;
}

function nullableStringArray(
  value: unknown,
  maximumItems: number,
): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > maximumItems)
    invalidWorkflowWire();
  return value.map((item) => boundedNonEmptyString(item, 160));
}

function workflowId(value: unknown): string {
  const id = boundedNonEmptyString(value, 240).trim();
  if (!id || /[\\/\u0000-\u001f\u007f]/.test(id)) invalidWorkflowWire();
  return id;
}

function nullableUuid(value: unknown): string | null {
  if (value === null) return null;
  const id = boundedString(value, 36);
  if (!UUID_PATTERN.test(id)) invalidWorkflowWire();
  return id;
}

function uuid(value: unknown): string {
  const parsed = nullableUuid(value);
  if (parsed === null) invalidWorkflowWire();
  return parsed;
}

function canonicalTimestamp(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  const timestamp = boundedString(value, 24);
  if (
    !STRICT_UTC_ISO_MILLISECONDS_PATTERN.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    invalidWorkflowWire();
  }
  return timestamp;
}

function parseColumn(value: unknown): VeraWorkflowColumn {
  const column = record(value);
  allowedKeys(column, ["index", "name", "prompt", "format", "tags"]);
  if (
    !Number.isInteger(column.index) ||
    Number(column.index) < 0 ||
    Number(column.index) > 99
  ) {
    invalidWorkflowWire();
  }
  const format =
    column.format === undefined ? undefined : boundedString(column.format, 32);
  if (
    format !== undefined &&
    !VERA_WORKFLOW_FORMATS.includes(format as VeraWorkflowFormat)
  ) {
    invalidWorkflowWire();
  }
  if (
    column.tags !== undefined &&
    (!Array.isArray(column.tags) || column.tags.length > 100)
  ) {
    invalidWorkflowWire();
  }
  return {
    index: Number(column.index),
    name: boundedNonEmptyString(column.name, 160),
    prompt: boundedNonEmptyString(column.prompt, 20_000),
    ...(format === undefined ? {} : { format: format as VeraWorkflowFormat }),
    ...(column.tags === undefined
      ? {}
      : {
          tags: (column.tags as unknown[]).map((tag) =>
            boundedNonEmptyString(tag, 160),
          ),
        }),
  };
}

function parseContributor(value: unknown): VeraWorkflowContributor {
  const contributor = record(value);
  exactKeys(contributor, ["name", "organisation", "role", "linkedin"]);
  const linkedin = nullableString(contributor.linkedin, 2_000);
  if (linkedin !== null) {
    try {
      const url = new URL(linkedin);
      if (url.protocol !== "https:") invalidWorkflowWire();
    } catch {
      invalidWorkflowWire();
    }
  }
  return {
    name: boundedNonEmptyString(contributor.name, 160),
    organisation:
      contributor.organisation === null
        ? null
        : boundedNonEmptyString(contributor.organisation, 160),
    role:
      contributor.role === null
        ? null
        : boundedNonEmptyString(contributor.role, 160),
    linkedin,
  };
}

/** Strict parser for the fixed Mike e32daad workflow response shape. */
export function parseVeraWorkflow(value: unknown): VeraWorkflow {
  assertNoVeraWorkflowSensitiveFields(value);
  const workflow = record(value);
  exactKeys(workflow, [
    "id",
    "user_id",
    "metadata",
    "skill_md",
    "columns_config",
    "is_system",
    "created_at",
    "shared_by_name",
    "allow_edit",
    "is_owner",
    "open_source_submission",
  ]);
  const metadata = record(workflow.metadata);
  exactKeys(metadata, [
    "title",
    "description",
    "type",
    "contributors",
    "language",
    "version",
    "practice",
    "jurisdictions",
  ]);
  const type = boundedString(metadata.type, 16);
  if (type !== "assistant" && type !== "tabular") invalidWorkflowWire();
  if (
    !Array.isArray(metadata.contributors) ||
    metadata.contributors.length > 25
  ) {
    invalidWorkflowWire();
  }
  if (
    workflow.columns_config !== null &&
    !Array.isArray(workflow.columns_config)
  ) {
    invalidWorkflowWire();
  }
  if (
    workflow.columns_config !== null &&
    (workflow.columns_config as unknown[]).length > 100
  ) {
    invalidWorkflowWire();
  }
  // Mike system templates historically use an empty created_at sentinel.
  // Every durable local timestamp must be canonical UTC with milliseconds.
  const createdAt = boundedString(workflow.created_at, 24);
  if (createdAt !== "") canonicalTimestamp(createdAt);
  if (workflow.open_source_submission !== null) invalidWorkflowWire();

  return {
    id: workflowId(workflow.id),
    user_id: nullableUuid(workflow.user_id),
    metadata: {
      title: boundedNonEmptyString(metadata.title, 200),
      description:
        metadata.description === null
          ? null
          : boundedNonEmptyString(metadata.description, 2_000),
      type,
      contributors: metadata.contributors.map(parseContributor),
      language: boundedNonEmptyString(metadata.language, 160),
      version:
        metadata.version === null
          ? null
          : boundedNonEmptyString(metadata.version, 160),
      practice:
        metadata.practice === null
          ? null
          : boundedNonEmptyString(metadata.practice, 160),
      jurisdictions: nullableStringArray(metadata.jurisdictions, 100),
    },
    skill_md: nullableString(workflow.skill_md, 100_000),
    columns_config:
      workflow.columns_config === null
        ? null
        : (workflow.columns_config as unknown[]).map(parseColumn),
    is_system: boolean(workflow.is_system),
    created_at: createdAt,
    shared_by_name: nullableString(workflow.shared_by_name, 160),
    allow_edit: boolean(workflow.allow_edit),
    is_owner: boolean(workflow.is_owner),
    open_source_submission: null,
  };
}

function parseWorkflowList(value: unknown): VeraWorkflow[] {
  if (!Array.isArray(value) || value.length > 10_000) invalidWorkflowWire();
  return value.map(parseVeraWorkflow);
}

function nonNegativeInteger(value: unknown, maximum = 2_147_483_647): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    invalidWorkflowWire();
  }
  return value;
}

function positiveInteger(value: unknown, maximum = 2_147_483_647): number {
  const parsed = nonNegativeInteger(value, maximum);
  if (parsed < 1) invalidWorkflowWire();
  return parsed;
}

function parseSafeJson(value: unknown): VeraWorkflowJson {
  assertNoVeraWorkflowSensitiveFields(value);
  const visit = (candidate: unknown, depth: number): VeraWorkflowJson => {
    if (depth > MAX_SAFE_JSON_DEPTH) invalidWorkflowWire();
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) invalidWorkflowWire();
      return candidate;
    }
    if (Array.isArray(candidate)) {
      return candidate.map((item) => visit(item, depth + 1));
    }
    if (typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as WireRecord).map(([key, nested]) => [
          key,
          visit(nested, depth + 1),
        ]),
      );
    }
    return invalidWorkflowWire();
  };
  return visit(value, 0);
}

function parseDetails(
  value: unknown,
): VeraWorkflowStructuredError["details"] {
  if (value === null) return null;
  const details = record(value);
  assertNoVeraWorkflowSensitiveFields(details);
  if (Object.keys(details).length > 100) invalidWorkflowWire();
  return Object.fromEntries(
    Object.entries(details).map(([key, detail]) => {
      if (!key.trim() || key.length > 160 || sensitiveWorkflowKey(key)) {
        invalidWorkflowWire();
      }
      if (
        detail !== null &&
        typeof detail !== "string" &&
        typeof detail !== "number" &&
        typeof detail !== "boolean"
      ) {
        invalidWorkflowWire();
      }
      if (typeof detail === "number" && !Number.isFinite(detail)) {
        invalidWorkflowWire();
      }
      return [key, detail] as const;
    }),
  );
}

function parseStructuredError(
  value: unknown,
): VeraWorkflowStructuredError | null {
  if (value === null) return null;
  const error = record(value);
  exactKeys(error, ["code", "message", "retryable", "details"]);
  return {
    code: boundedNonEmptyString(error.code, 160),
    message: boundedNonEmptyString(error.message, 2_000),
    retryable: boolean(error.retryable),
    details: parseDetails(error.details),
  };
}

function parseDefinitionStep(value: unknown): VeraWorkflowDefinitionStep {
  const step = record(value);
  const type = boundedString(step.type, 32);
  if (type === "prompt") {
    allowedKeys(step, [
      "id",
      "type",
      "name",
      "prompt",
      "model_profile_id",
      "input_mapping",
    ]);
    if (
      !Object.hasOwn(step, "id") ||
      !Object.hasOwn(step, "name") ||
      !Object.hasOwn(step, "prompt")
    ) {
      invalidWorkflowWire();
    }
    if (step.input_mapping !== undefined) {
      const mapping = record(step.input_mapping);
      exactKeys(mapping, []);
    }
    return {
      id: uuid(step.id),
      type,
      name: boundedNonEmptyString(step.name, 160),
      prompt: boundedNonEmptyString(step.prompt, 20_000),
      ...(step.model_profile_id === undefined
        ? {}
        : { model_profile_id: uuid(step.model_profile_id) }),
      ...(step.input_mapping === undefined ? {} : { input_mapping: {} }),
    };
  }
  if (type === "document_retrieval") {
    exactKeys(step, ["id", "type", "name", "query_template", "limit"]);
    return {
      id: uuid(step.id),
      type,
      name: boundedNonEmptyString(step.name, 160),
      query_template: boundedNonEmptyString(step.query_template, 2_000),
      limit: positiveInteger(step.limit, 100),
    };
  }
  if (type === "output") {
    exactKeys(step, ["id", "type", "name", "format"]);
    const format = boundedString(step.format, 16);
    if (format !== "text" && format !== "json") invalidWorkflowWire();
    return {
      id: uuid(step.id),
      type,
      name: boundedNonEmptyString(step.name, 160),
      format,
    };
  }
  return invalidWorkflowWire();
}

function validateDefinitionSteps(
  steps: readonly VeraWorkflowDefinitionStep[],
): void {
  const ids = new Set<string>();
  let outputIndex = -1;
  for (const [index, step] of steps.entries()) {
    if (ids.has(step.id)) invalidWorkflowWire();
    ids.add(step.id);
    if (step.type === "output") {
      if (outputIndex !== -1) invalidWorkflowWire();
      outputIndex = index;
    }
  }
  if (outputIndex !== -1) {
    if (outputIndex !== steps.length - 1) invalidWorkflowWire();
    if (!steps.slice(0, outputIndex).some((step) => step.type === "prompt")) {
      invalidWorkflowWire();
    }
  }
}

/** Strict parser for Vera's editable local Assistant workflow definition. */
export function parseVeraWorkflowDefinition(
  value: unknown,
): VeraWorkflowDefinition {
  assertNoVeraWorkflowSensitiveFields(value);
  const definition = record(value);
  exactKeys(definition, [
    "id",
    "type",
    "name",
    "description",
    "project_id",
    "steps",
    "updated_at",
  ]);
  if (definition.type !== "assistant") invalidWorkflowWire();
  if (!Array.isArray(definition.steps) || definition.steps.length > 100) {
    invalidWorkflowWire();
  }
  const steps = definition.steps.map(parseDefinitionStep);
  validateDefinitionSteps(steps);
  return {
    id: uuid(definition.id),
    type: "assistant",
    name: boundedNonEmptyString(definition.name, 200),
    description:
      definition.description === null
        ? null
        : boundedNonEmptyString(definition.description, 2_000),
    project_id: nullableUuid(definition.project_id),
    steps,
    updated_at: canonicalTimestamp(definition.updated_at) as string,
  };
}

function parseStepDefinition(value: unknown): VeraWorkflowStepDefinition {
  const step = record(value);
  const kind = boundedString(step.kind, 32);
  if (kind === "prompt") {
    allowedKeys(step, ["id", "kind", "title", "prompt", "model_profile_id"]);
    if (
      !Object.hasOwn(step, "id") ||
      !Object.hasOwn(step, "title") ||
      !Object.hasOwn(step, "prompt")
    ) {
      invalidWorkflowWire();
    }
    return {
      id: uuid(step.id),
      kind,
      title: boundedNonEmptyString(step.title, 160),
      prompt: boundedNonEmptyString(step.prompt, 20_000),
      ...(step.model_profile_id === undefined
        ? {}
        : { model_profile_id: uuid(step.model_profile_id) }),
    };
  }
  if (kind === "document_context") {
    allowedKeys(step, [
      "id",
      "kind",
      "title",
      "max_documents",
      "max_chunks_per_document",
      "query_template",
      "result_limit",
    ]);
    if (
      !Object.hasOwn(step, "id") ||
      !Object.hasOwn(step, "title") ||
      !Object.hasOwn(step, "max_documents") ||
      !Object.hasOwn(step, "max_chunks_per_document")
    ) {
      invalidWorkflowWire();
    }
    return {
      id: uuid(step.id),
      kind,
      title: boundedNonEmptyString(step.title, 160),
      max_documents: positiveInteger(step.max_documents, 100),
      max_chunks_per_document: positiveInteger(
        step.max_chunks_per_document,
        100,
      ),
      ...(step.query_template === undefined
        ? {}
        : {
            query_template: boundedNonEmptyString(
              step.query_template,
              2_000,
            ),
          }),
      ...(step.result_limit === undefined
        ? {}
        : { result_limit: positiveInteger(step.result_limit, 100) }),
    };
  }
  if (kind === "tabular_column") {
    allowedKeys(step, [
      "id",
      "kind",
      "title",
      "output_type",
      "prompt",
      "enum_values",
    ]);
    if (
      !Object.hasOwn(step, "id") ||
      !Object.hasOwn(step, "title") ||
      !Object.hasOwn(step, "output_type") ||
      !Object.hasOwn(step, "prompt")
    ) {
      invalidWorkflowWire();
    }
    if (
      step.enum_values !== undefined &&
      (!Array.isArray(step.enum_values) || step.enum_values.length > 100)
    ) {
      invalidWorkflowWire();
    }
    const outputType = boundedNonEmptyString(step.output_type, 64);
    if (!["text", "boolean", "enum", "number"].includes(outputType)) {
      invalidWorkflowWire();
    }
    return {
      id: uuid(step.id),
      kind,
      title: boundedNonEmptyString(step.title, 160),
      output_type: outputType,
      prompt: boundedNonEmptyString(step.prompt, 20_000),
      ...(step.enum_values === undefined
        ? {}
        : {
            enum_values: (step.enum_values as unknown[]).map((item) =>
              boundedNonEmptyString(item, 160),
            ),
          }),
    };
  }
  if (kind === "output") {
    exactKeys(step, ["id", "kind", "title", "format"]);
    const format = boundedString(step.format, 16);
    if (format !== "text" && format !== "json") invalidWorkflowWire();
    return {
      id: uuid(step.id),
      kind,
      title: boundedNonEmptyString(step.title, 160),
      format,
    };
  }
  return invalidWorkflowWire();
}

function parseRunStatus(value: unknown): VeraWorkflowRunStatus {
  const status = boundedString(value, 32);
  if (!VERA_WORKFLOW_RUN_STATUSES.includes(status as VeraWorkflowRunStatus)) {
    invalidWorkflowWire();
  }
  return status as VeraWorkflowRunStatus;
}

function parseStepStatus(value: unknown): VeraWorkflowStepStatus {
  const status = boundedString(value, 32);
  if (
    status !== "skipped" &&
    !VERA_WORKFLOW_RUN_STATUSES.includes(status as VeraWorkflowRunStatus)
  ) {
    invalidWorkflowWire();
  }
  return status as VeraWorkflowStepStatus;
}

export function parseVeraWorkflowRun(value: unknown): VeraWorkflowRun {
  assertNoVeraWorkflowSensitiveFields(value);
  const run = record(value);
  exactKeys(run, [
    "id",
    "workflow_id",
    "project_id",
    "status",
    "model_profile_id",
    "job_id",
    "retry_of_run_id",
    "input",
    "output",
    "started_at",
    "completed_at",
    "error",
    "created_at",
  ]);
  return {
    id: uuid(run.id),
    workflow_id: uuid(run.workflow_id),
    project_id: nullableUuid(run.project_id),
    status: parseRunStatus(run.status),
    model_profile_id: nullableUuid(run.model_profile_id),
    job_id: nullableUuid(run.job_id),
    retry_of_run_id: nullableUuid(run.retry_of_run_id),
    input: parseSafeJson(run.input),
    output: run.output === null ? null : parseSafeJson(run.output),
    started_at: canonicalTimestamp(run.started_at, true),
    completed_at: canonicalTimestamp(run.completed_at, true),
    error: parseStructuredError(run.error),
    created_at: canonicalTimestamp(run.created_at) as string,
  };
}

export function parseVeraWorkflowStepRun(
  value: unknown,
): VeraWorkflowStepRun {
  assertNoVeraWorkflowSensitiveFields(value);
  const step = record(value);
  exactKeys(step, [
    "id",
    "workflow_run_id",
    "ordinal",
    "attempt",
    "step",
    "status",
    "input",
    "output",
    "error",
    "started_at",
    "completed_at",
  ]);
  return {
    id: uuid(step.id),
    workflow_run_id: uuid(step.workflow_run_id),
    ordinal: nonNegativeInteger(step.ordinal, 99),
    attempt: positiveInteger(step.attempt, 100),
    step: parseStepDefinition(step.step),
    status: parseStepStatus(step.status),
    input: parseSafeJson(step.input),
    output: step.output === null ? null : parseSafeJson(step.output),
    error: parseStructuredError(step.error),
    started_at: canonicalTimestamp(step.started_at, true),
    completed_at: canonicalTimestamp(step.completed_at, true),
  };
}

export function parseVeraWorkflowRunDetail(
  value: unknown,
): VeraWorkflowRunDetail {
  const detail = record(value);
  exactKeys(detail, ["run", "steps"]);
  if (!Array.isArray(detail.steps) || detail.steps.length > 300) {
    invalidWorkflowWire();
  }
  const run = parseVeraWorkflowRun(detail.run);
  const steps = detail.steps.map(parseVeraWorkflowStepRun);
  if (
    steps.some((step) => step.workflow_run_id !== run.id) ||
    run.workflow_id.length === 0
  ) {
    invalidWorkflowWire();
  }
  return { run, steps };
}

export function parseVeraPreparedWorkflowRun(
  value: unknown,
): VeraPreparedWorkflowRun {
  const prepared = record(value);
  exactKeys(prepared, ["run", "steps", "reused"]);
  const detail = parseVeraWorkflowRunDetail({
    run: prepared.run,
    steps: prepared.steps,
  });
  return { ...detail, reused: boolean(prepared.reused) };
}

export function parseVeraWorkflowRunPage(
  value: unknown,
): VeraWorkflowRunPage {
  assertNoVeraWorkflowSensitiveFields(value);
  const page = record(value);
  exactKeys(page, ["items", "next_cursor"]);
  if (!Array.isArray(page.items) || page.items.length > 100) {
    invalidWorkflowWire();
  }
  const nextCursor =
    page.next_cursor === null
      ? null
      : boundedNonEmptyString(page.next_cursor, 512);
  if (nextCursor !== null && !/^[A-Za-z0-9_-]+$/.test(nextCursor)) {
    invalidWorkflowWire();
  }
  return { items: page.items.map(parseVeraWorkflowRun), next_cursor: nextCursor };
}

export function parseVeraWorkflowExecutionCapabilities(
  value: unknown,
): VeraWorkflowExecutionCapabilities {
  const capabilities = record(value);
  exactKeys(capabilities, [
    "execution_enabled",
    "assistant_runs",
    "tabular_runs",
  ]);
  if (capabilities.assistant_runs !== true || capabilities.tabular_runs !== false) {
    invalidWorkflowWire();
  }
  return {
    execution_enabled: boolean(capabilities.execution_enabled),
    assistant_runs: true,
    tabular_runs: false,
  };
}

function workflowSegment(workflowId: string): string {
  const id = workflowId.trim();
  if (!id || id.length > 240 || /[\\/\u0000-\u001f\u007f]/.test(id)) {
    throw new VeraApiError({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "工作流标识无效。",
    });
  }
  return encodeURIComponent(id);
}

function requestOptions(signal?: AbortSignal): VeraApiRequestOptions {
  return signal ? { signal } : {};
}

export async function listVeraWorkflows(
  type: VeraWorkflowType,
  signal?: AbortSignal,
): Promise<VeraWorkflow[]> {
  const value = await veraApiRequest<unknown>("/workflows", {
    ...requestOptions(signal),
    query: { type },
  });
  return parseWorkflowList(value);
}

export async function getVeraWorkflow(
  workflowId: string,
  signal?: AbortSignal,
): Promise<VeraWorkflow> {
  return parseVeraWorkflow(
    await veraApiRequest<unknown>(
      `/workflows/${workflowSegment(workflowId)}`,
      requestOptions(signal),
    ),
  );
}

export async function getVeraWorkflowDefinition(
  workflowId: string,
  signal?: AbortSignal,
): Promise<VeraWorkflowDefinition> {
  return parseVeraWorkflowDefinition(
    await veraApiRequest<unknown>(
      `/workflows/${workflowSegment(workflowId)}/definition`,
      requestOptions(signal),
    ),
  );
}

export async function createVeraWorkflow(
  input: VeraWorkflowCreateInput,
): Promise<VeraWorkflow> {
  assertNoVeraWorkflowSensitiveFields(
    input,
    "The workflow mutation contains a secret, credential reference, raw provider field, or local path.",
  );
  return parseVeraWorkflow(
    await veraApiRequest<unknown>("/workflows", {
      method: "POST",
      json: input,
    }),
  );
}

export async function updateVeraWorkflow(
  workflowId: string,
  input: VeraWorkflowUpdateInput,
): Promise<VeraWorkflow> {
  assertNoVeraWorkflowSensitiveFields(
    input,
    "The workflow mutation contains a secret, credential reference, raw provider field, or local path.",
  );
  return parseVeraWorkflow(
    await veraApiRequest<unknown>(`/workflows/${workflowSegment(workflowId)}`, {
      method: "PATCH",
      json: input,
    }),
  );
}

function prepareDefinitionUpdate(
  input: VeraWorkflowDefinitionUpdate,
): VeraWorkflowDefinitionUpdate {
  try {
    assertNoVeraWorkflowSensitiveFields(input);
    const value = record(input);
    exactKeys(value, ["name", "description", "project_id", "steps"]);
    if (!Array.isArray(value.steps) || value.steps.length > 100) {
      throw new Error("invalid steps");
    }
    const steps = value.steps.map(parseDefinitionStep).map((step) => {
      if (step.type === "prompt") {
        return {
          ...step,
          name: step.name.trim(),
          prompt: step.prompt.trim(),
        };
      }
      if (step.type === "document_retrieval") {
        return {
          ...step,
          name: step.name.trim(),
          query_template: step.query_template.trim(),
        };
      }
      return { ...step, name: step.name.trim() };
    });
    validateDefinitionSteps(steps);
    return {
      name: boundedNonEmptyString(value.name, 200).trim(),
      description:
        value.description === null
          ? null
          : boundedNonEmptyString(value.description, 2_000).trim(),
      project_id: nullableUuid(value.project_id),
      steps,
    };
  } catch {
    requestValidationError("工作流定义包含无效或不受支持的字段。");
  }
}

export async function updateVeraWorkflowDefinition(
  workflowId: string,
  input: VeraWorkflowDefinitionUpdate,
  signal?: AbortSignal,
): Promise<VeraWorkflowDefinition> {
  return parseVeraWorkflowDefinition(
    await veraApiRequest<unknown>(
      `/workflows/${workflowSegment(workflowId)}/definition`,
      {
        method: "PUT",
        json: prepareDefinitionUpdate(input),
        ...requestOptions(signal),
      },
    ),
  );
}

export async function deleteVeraWorkflow(workflowId: string): Promise<void> {
  await veraApiRequest<void>(`/workflows/${workflowSegment(workflowId)}`, {
    method: "DELETE",
  });
}

export async function listHiddenVeraWorkflows(
  signal?: AbortSignal,
): Promise<string[]> {
  const value = await veraApiRequest<unknown>(
    "/workflows/hidden",
    requestOptions(signal),
  );
  if (!Array.isArray(value))
    invalidWorkflowWire("The Vera API returned invalid hidden workflow IDs.");
  return value.map(workflowId);
}

export async function hideVeraWorkflow(workflowId: string): Promise<void> {
  workflowSegment(workflowId);
  await veraApiRequest<void>("/workflows/hidden", {
    method: "POST",
    json: { workflow_id: workflowId.trim() },
  });
}

export async function unhideVeraWorkflow(workflowId: string): Promise<void> {
  await veraApiRequest<void>(
    `/workflows/hidden/${workflowSegment(workflowId)}`,
    {
      method: "DELETE",
    },
  );
}

function requestValidationError(message: string): never {
  throw new VeraApiError({
    status: 400,
    code: "VALIDATION_ERROR",
    message,
  });
}

function requestUuid(value: string, label: string): string {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    requestValidationError(`${label}无效。`);
  }
  return normalized;
}

function requestIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    requestValidationError("幂等键无效。");
  }
  return normalized;
}

function prepareRunBody(
  input: VeraPrepareWorkflowRunInput,
): VeraPrepareWorkflowRunInput {
  const actual = Object.keys(input).sort();
  const allowed = [
    "idempotency_key",
    "input_binding",
    "model_profile_id",
    "project_id",
  ];
  if (actual.some((key) => !allowed.includes(key))) {
    requestValidationError("工作流运行参数包含未知字段。");
  }
  let inputBinding: VeraWorkflowJson | undefined;
  if (input.input_binding !== undefined) {
    try {
      inputBinding = parseSafeJson(input.input_binding);
    } catch {
      requestValidationError(
        "工作流输入不能包含凭据、原始 Provider 数据或本地路径。",
      );
    }
  }
  return {
    idempotency_key: requestIdempotencyKey(input.idempotency_key),
    ...(input.project_id === undefined
      ? {}
      : { project_id: requestUuid(input.project_id, "项目标识") }),
    ...(input.model_profile_id === undefined
      ? {}
      : {
          model_profile_id: requestUuid(
            input.model_profile_id,
            "模型配置标识",
          ),
        }),
    ...(inputBinding === undefined ? {} : { input_binding: inputBinding }),
  };
}

export async function getVeraWorkflowExecutionCapabilities(
  signal?: AbortSignal,
): Promise<VeraWorkflowExecutionCapabilities> {
  return parseVeraWorkflowExecutionCapabilities(
    await veraApiRequest<unknown>(
      "/workflows/capabilities",
      requestOptions(signal),
    ),
  );
}

export async function startVeraWorkflowRun(
  workflowId: string,
  input: VeraPrepareWorkflowRunInput,
  signal?: AbortSignal,
): Promise<VeraPreparedWorkflowRun> {
  return parseVeraPreparedWorkflowRun(
    await veraApiRequest<unknown>(
      `/workflows/${workflowSegment(workflowId)}/runs`,
      {
        method: "POST",
        json: prepareRunBody(input),
        ...requestOptions(signal),
      },
    ),
  );
}

export async function listVeraWorkflowRuns(
  workflowId: string,
  input: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<VeraWorkflowRunPage> {
  const cursor = input.cursor?.trim();
  if (
    cursor !== undefined &&
    (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
  ) {
    requestValidationError("运行记录游标无效。");
  }
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    requestValidationError("运行记录条数必须在 1 到 100 之间。");
  }
  return parseVeraWorkflowRunPage(
    await veraApiRequest<unknown>(
      `/workflows/${workflowSegment(workflowId)}/runs`,
      {
        ...requestOptions(signal),
        query: { ...(cursor ? { cursor } : {}), limit },
      },
    ),
  );
}

export async function getVeraWorkflowRun(
  runId: string,
  signal?: AbortSignal,
): Promise<VeraWorkflowRunDetail> {
  return parseVeraWorkflowRunDetail(
    await veraApiRequest<unknown>(
      `/workflow-runs/${requestUuid(runId, "运行标识")}`,
      requestOptions(signal),
    ),
  );
}

export async function cancelVeraWorkflowRun(
  runId: string,
  signal?: AbortSignal,
): Promise<VeraWorkflowRunDetail> {
  return parseVeraWorkflowRunDetail(
    await veraApiRequest<unknown>(
      `/workflow-runs/${requestUuid(runId, "运行标识")}/cancel`,
      { method: "POST", json: {}, ...requestOptions(signal) },
    ),
  );
}

export async function retryVeraWorkflowRun(
  runId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<VeraPreparedWorkflowRun> {
  return parseVeraPreparedWorkflowRun(
    await veraApiRequest<unknown>(
      `/workflow-runs/${requestUuid(runId, "运行标识")}/retry`,
      {
        method: "POST",
        json: { idempotency_key: requestIdempotencyKey(idempotencyKey) },
        ...requestOptions(signal),
      },
    ),
  );
}
