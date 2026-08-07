import { z } from "zod";

export const READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION =
  "read_only_source_connector_pin_v1" as const;
export const READ_ONLY_SOURCE_REQUEST_VERSION =
  "read_only_source_request_v1" as const;
export const READ_ONLY_SOURCE_AUTHORIZATION_VERSION =
  "read_only_source_authorization_v1" as const;
export const READ_ONLY_SOURCE_SNAPSHOT_VERSION =
  "read_only_source_snapshot_v1" as const;
export const READ_ONLY_SOURCE_COVERAGE_VERSION =
  "read_only_source_coverage_v1" as const;
export const READ_ONLY_SOURCE_RECEIPT_VERSION =
  "read_only_source_receipt_v1" as const;

const boundedToken = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .max(160);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTime = z.string().datetime({ offset: true });
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
  );

export const readOnlySourceOperationSchema = z.enum([
  "search",
  "read_snapshot",
  "read_status",
]);
export type ReadOnlySourceOperationV1 = z.infer<
  typeof readOnlySourceOperationSchema
>;

export const readOnlySourceEgressFieldSchema = z.enum([
  "query",
  "jurisdiction",
  "as_of_date",
  "page",
  "page_size",
  "external_id",
]);
export type ReadOnlySourceEgressFieldV1 = z.infer<
  typeof readOnlySourceEgressFieldSchema
>;

const readOnlySourceConnectorPinBaseSchema = z
  .object({
    schema_version: z.literal(READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION),
    connector_id: boundedToken,
    connector_version: boundedToken,
    provider_id: boundedToken,
    provider_version: boundedToken,
    adapter_id: boundedToken,
    adapter_version: boundedToken,
    binding: z
      .object({
        kind: z.enum(["http", "tool", "fixture"]),
        operation_id: boundedToken,
        operation_version: boundedToken,
        input_schema_version: boundedToken,
        input_schema_digest: sha256,
        output_schema_version: boundedToken,
        output_schema_digest: sha256,
      })
      .strict(),
    allowed_hosts: z.array(host).max(8),
    allowed_source_hosts: z.array(host).min(1).max(16),
    allowed_operations: z.array(readOnlySourceOperationSchema).min(1).max(3),
    allowed_egress_fields: z
      .array(readOnlySourceEgressFieldSchema)
      .max(readOnlySourceEgressFieldSchema.options.length),
    limits: z
      .object({
        timeout_ms: z.number().int().min(250).max(120_000),
        authorization_max_age_ms: z.number().int().min(1_000).max(300_000),
        maximum_pages: z.number().int().min(1).max(100),
        maximum_items_per_page: z.number().int().min(1).max(200),
        maximum_query_chars: z.number().int().min(1).max(10_000),
        maximum_snapshot_chars: z.number().int().min(1).max(2_000_000),
      })
      .strict(),
    fixed: z.literal(true),
    read_only: z.literal(true),
  })
  .strict();

export const readOnlySourceConnectorPinSchema =
  readOnlySourceConnectorPinBaseSchema.superRefine((pin, context) => {
    for (const [path, values] of [
      ["allowed_hosts", pin.allowed_hosts],
      ["allowed_source_hosts", pin.allowed_source_hosts],
      ["allowed_operations", pin.allowed_operations],
      ["allowed_egress_fields", pin.allowed_egress_fields],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: `${path} must be unique`,
        });
      }
    }
    if (pin.binding.kind === "fixture") {
      if (pin.allowed_hosts.length || pin.allowed_egress_fields.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["binding", "kind"],
          message: "A fixture connector cannot authorize network egress",
        });
      }
    } else if (!pin.allowed_hosts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_hosts"],
        message: "An external connector requires an exact host allowlist",
      });
    }
  });

export type ReadOnlySourceConnectorPinV1 = z.infer<
  typeof readOnlySourceConnectorPinSchema
>;

export const readOnlySourceAuthorizationSchema = z
  .object({
    schema_version: z.literal(READ_ONLY_SOURCE_AUTHORIZATION_VERSION),
    connector_id: boundedToken,
    connection: z.enum(["connected", "disconnected"]),
    subscription: z.enum(["verified", "not_required", "unverified"]),
    checked_at: isoDateTime,
  })
  .strict();

export type ReadOnlySourceAuthorizationV1 = z.infer<
  typeof readOnlySourceAuthorizationSchema
>;

export const readOnlySourceRequestSchema = z
  .object({
    schema_version: z.literal(READ_ONLY_SOURCE_REQUEST_VERSION),
    request_ref: boundedToken,
    operation: readOnlySourceOperationSchema,
    query: z.string().trim().min(1).max(10_000).nullable(),
    external_id: z.string().trim().min(1).max(500).nullable(),
    jurisdiction: z.string().trim().min(1).max(120).nullable(),
    as_of_date: isoDate.nullable(),
    page: z.number().int().min(1).max(100).nullable(),
    page_size: z.number().int().min(1).max(200).nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.operation === "search") {
      if (
        !request.query ||
        request.external_id ||
        request.page === null ||
        request.page_size === null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["operation"],
          message: "Search requires a query and cannot select an external id",
        });
      }
    } else if (
      !request.external_id ||
      request.query ||
      request.page !== null ||
      request.page_size !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operation"],
        message: "A read requires one external id and cannot widen the query",
      });
    }
  });

export type ReadOnlySourceRequestV1 = z.infer<
  typeof readOnlySourceRequestSchema
>;

const metadataValue = z.union([
  z.string().max(4_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(1_000)).max(100),
]);

/**
 * Import-only immutable source material. It is deliberately separate from the
 * body-free connector receipt and must never be copied into Step result_data.
 * The central Matter Document/Version importer assigns Vera identities.
 */
export const readOnlySourceSnapshotSchema = z
  .object({
    schema_version: z.literal(READ_ONLY_SOURCE_SNAPSHOT_VERSION),
    snapshot_ref: boundedToken,
    provider_id: boundedToken,
    external_id: z.string().trim().min(1).max(500),
    source_kind: boundedToken,
    title: z.string().trim().min(1).max(1_000),
    canonical_url: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:"),
    retrieved_at: isoDateTime,
    as_of_date: isoDate.nullable(),
    content_type: z.enum(["text/plain", "application/json", "application/xml"]),
    content_sha256: sha256,
    source_body: z.string().min(1).max(2_000_000),
    metadata: z.record(z.string().max(120), metadataValue),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const keys = Object.keys(snapshot.metadata);
    if (keys.length > 40) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        path: ["metadata"],
        type: "array",
        maximum: 40,
        inclusive: true,
        exact: false,
        message: "Snapshot metadata is bounded to 40 fields",
      });
    }
    const reservedIdentityKeys = new Set([
      "documentid",
      "documentversionid",
      "matterid",
      "projectid",
      "artifactid",
      "citationid",
    ]);
    const reserved = keys.filter((key) =>
      reservedIdentityKeys.has(key.replace(/[_-]/g, "").toLowerCase()),
    );
    if (reserved.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadata"],
        message: "A provider snapshot cannot supply Vera object identities",
      });
    }
  });

export type ReadOnlySourceSnapshotV1 = z.infer<
  typeof readOnlySourceSnapshotSchema
>;

export const readOnlySourceGapCodeSchema = z.enum([
  "provider_unavailable",
  "subscription_unverified",
  "scope_unsupported",
  "schema_drift",
  "pagination_truncated",
  "result_limit_reached",
  "snapshot_unavailable",
  "status_unavailable",
  "provider_error",
]);

export const readOnlySourceCoverageSchema = z
  .object({
    schema_version: z.literal(READ_ONLY_SOURCE_COVERAGE_VERSION),
    request_ref: boundedToken,
    status: z.enum(["complete", "incomplete"]),
    pages_examined: z.number().int().min(0).max(100),
    items_examined: z.number().int().min(0).max(20_000),
    truncated: z.boolean(),
    gaps: z
      .array(
        z
          .object({
            code: readOnlySourceGapCodeSchema,
            detail: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((coverage, context) => {
    const incomplete = coverage.truncated || coverage.gaps.length > 0;
    if ((coverage.status === "complete") === incomplete) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Coverage cannot be complete while any bounded gap remains",
      });
    }
  });

export type ReadOnlySourceCoverageV1 = z.infer<
  typeof readOnlySourceCoverageSchema
>;

export const readOnlySourceReceiptSchema = z
  .object({
    schema_version: z.literal(READ_ONLY_SOURCE_RECEIPT_VERSION),
    task_id: boundedToken,
    step_id: boundedToken,
    step_position: z.number().int().min(0).max(5),
    attempt: z.number().int().min(1),
    matter_id: boundedToken,
    source_version_ids: z.array(boundedToken).max(100),
    connector_pin: readOnlySourceConnectorPinSchema,
    authorization: readOnlySourceAuthorizationSchema,
    request_ref: boundedToken,
    operation: readOnlySourceOperationSchema,
    egress_fields_sent: z
      .array(readOnlySourceEgressFieldSchema)
      .max(readOnlySourceEgressFieldSchema.options.length),
    external_call_attempted: z.boolean(),
    external_side_effect: z.literal("none"),
    status: z.enum(["ok", "error", "rejected"]),
    error_category: z.string().trim().min(1).max(120).nullable(),
    returned_snapshot_refs: z.array(boundedToken).max(200),
    started_at: isoDateTime,
    completed_at: isoDateTime,
    idempotency_key: boundedToken,
  })
  .strict();

export type ReadOnlySourceReceiptV1 = z.infer<
  typeof readOnlySourceReceiptSchema
>;

export function validateReadOnlySourceConnectorPin(value: unknown) {
  return readOnlySourceConnectorPinSchema.parse(value);
}

export function validateReadOnlySourceRequest(value: unknown) {
  return readOnlySourceRequestSchema.parse(value);
}

export function validateReadOnlySourceSnapshot(value: unknown) {
  return readOnlySourceSnapshotSchema.parse(value);
}

export function validateReadOnlySourceCoverage(value: unknown) {
  return readOnlySourceCoverageSchema.parse(value);
}
