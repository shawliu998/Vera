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
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    invalidWorkflowWire();
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
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    invalidWorkflowWire();
  }
  return id;
}

function parseColumn(value: unknown): VeraWorkflowColumn {
  const column = record(value);
  exactKeys(column, ["index", "name", "prompt", "format", "tags"]);
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
  const createdAt = boundedString(workflow.created_at, 64);
  if (createdAt !== "" && Number.isNaN(Date.parse(createdAt)))
    invalidWorkflowWire();
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

export async function createVeraWorkflow(
  input: VeraWorkflowCreateInput,
): Promise<VeraWorkflow> {
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
  return parseVeraWorkflow(
    await veraApiRequest<unknown>(`/workflows/${workflowSegment(workflowId)}`, {
      method: "PATCH",
      json: input,
    }),
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
