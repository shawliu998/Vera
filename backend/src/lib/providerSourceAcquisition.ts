import { z } from "zod";

import type { AgentStepCapabilityGrantV2 } from "./agent-kernel/capability/stepCapability";
import {
  READ_ONLY_SOURCE_REQUEST_VERSION,
  readOnlySourceDiscoverySchema,
  readOnlySourceRequestSchema,
  validateReadOnlySourceConnectorPin,
  type ReadOnlySourceConnectorPinV1,
  type ReadOnlySourceDiscoveryV1,
  type ReadOnlySourceRequestV1,
} from "./agent-kernel/connectors/readOnlySourceContract";
import type {
  ReadOnlySourceExecutionContextV1,
  ReadOnlySourceExecutionOutcomeV1,
} from "./agent-kernel/connectors/readOnlySourceExecution";
import {
  executeProviderSourcePipeline,
  type ProviderSourcePipelineOutcomeV1,
} from "./providerSourcePipeline";
import {
  resolveProviderSourceRuntime,
  type ProviderSourceRuntimeV1,
} from "./providerSourceRuntime";
import type { ProviderSourceImportDb } from "./providerSourceImport";

type SupportedOperation = Extract<
  ReadOnlySourceRequestV1["operation"],
  "search" | "read_snapshot"
>;

export const PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION =
  "provider_source_acquisition_spec_v1" as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "as_of_date must be a real ISO date");

export const providerSourceAcquisitionSpecSchema = z
  .object({
    schema_version: z.literal(PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION),
    connector_id: z.string().trim().min(1).max(160),
    query: z.string().trim().min(1).max(10_000),
    jurisdiction: z.string().trim().min(1).max(120),
    as_of_date: isoDate,
    maximum_pages: z.number().int().min(1).max(100),
    page_size: z.number().int().min(1).max(200),
    maximum_selections: z.number().int().min(1).max(20),
  })
  .strict();

export type ProviderSourceAcquisitionSpecV1 = z.infer<
  typeof providerSourceAcquisitionSpecSchema
>;

export function validateProviderSourceAcquisitionSpec(
  value: unknown,
  pinValue: unknown,
) {
  const spec = providerSourceAcquisitionSpecSchema.parse(value);
  const pin = validateReadOnlySourceConnectorPin(pinValue);
  if (
    spec.connector_id !== pin.connector_id ||
    !pin.allowed_operations.includes("search") ||
    !pin.allowed_operations.includes("read_snapshot") ||
    !pin.allowed_jurisdictions.includes(spec.jurisdiction) ||
    spec.maximum_pages > pin.limits.maximum_pages ||
    spec.page_size > pin.limits.maximum_items_per_page ||
    spec.query.length > pin.limits.maximum_query_chars ||
    spec.maximum_selections >
      spec.maximum_pages * spec.page_size
  ) {
    throw new Error("Provider source acquisition scope exceeds its fixed pin");
  }
  return { spec, pin };
}

export function compileProviderSourceSearchRequest(input: {
  spec: unknown;
  pin: unknown;
  requestRef: string;
  page: number;
}) {
  const { spec, pin } = validateProviderSourceAcquisitionSpec(
    input.spec,
    input.pin,
  );
  if (!Number.isInteger(input.page) || input.page < 1 || input.page > spec.maximum_pages) {
    throw new Error("Provider source acquisition page exceeds fixed scope");
  }
  return readOnlySourceRequestSchema.parse({
    schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
    request_ref: input.requestRef,
    operation: "search",
    query: spec.query,
    external_id: null,
    jurisdiction: spec.jurisdiction,
    as_of_date: spec.as_of_date,
    page: input.page,
    page_size: spec.page_size,
  });
}

export function compileProviderSourceSelectedReadRequest(input: {
  spec: unknown;
  pin: unknown;
  requestRef: string;
  discovery: unknown;
}) {
  const { spec, pin } = validateProviderSourceAcquisitionSpec(
    input.spec,
    input.pin,
  );
  const discovery = readOnlySourceDiscoverySchema.parse(input.discovery);
  if (
    discovery.provider_id !== pin.provider_id ||
    !pin.allowed_source_hosts.includes(
      new URL(discovery.canonical_url).hostname,
    )
  ) {
    throw new Error("Selected discovery does not match the fixed connector");
  }
  return readOnlySourceRequestSchema.parse({
    schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
    request_ref: input.requestRef,
    operation: "read_snapshot",
    query: null,
    external_id: discovery.external_id,
    jurisdiction: spec.jurisdiction,
    as_of_date: spec.as_of_date,
    page: null,
    page_size: null,
  });
}

/**
 * Task-aware, current-user bridge from one fixed connector request to the
 * body-consuming Matter importer. It does not choose a connector, query,
 * jurisdiction, date, result, or mutation target.
 */
export async function executeCurrentUserProviderSourceAcquisition(input: {
  db: ProviderSourceImportDb;
  userId: string;
  matterId: string;
  connectorId: string;
  operation: SupportedOperation;
  context: ReadOnlySourceExecutionContextV1;
  grant: AgentStepCapabilityGrantV2;
  request: ReadOnlySourceRequestV1;
  now?: () => string;
  dependencies?: {
    resolveRuntime?: typeof resolveProviderSourceRuntime;
    executePipeline?: typeof executeProviderSourcePipeline;
  };
}): Promise<ProviderSourcePipelineOutcomeV1> {
  const resolveRuntime =
    input.dependencies?.resolveRuntime ?? resolveProviderSourceRuntime;
  const executePipeline =
    input.dependencies?.executePipeline ?? executeProviderSourcePipeline;
  const runtime = await resolveRuntime({
    connectorId: input.connectorId,
    operation: input.operation,
    userId: input.userId,
    db: input.db as never,
    now: input.now,
  });
  return executePipeline({
    db: input.db,
    userId: input.userId,
    matterId: input.matterId,
    execution: {
      context: input.context,
      grant: input.grant,
      pin: runtime.pin,
      authorization: runtime.authorization,
      request: input.request,
      invoker: runtime.invoker,
      normalizer: runtime.normalizer,
      now: input.now,
    },
  });
}

export type ProviderSourceAcquisitionInterruptedV1 = Exclude<
  ReadOnlySourceExecutionOutcomeV1,
  { kind: "completed" }
>;
export type { ProviderSourceRuntimeV1 };
export type {
  ReadOnlySourceConnectorPinV1,
  ReadOnlySourceDiscoveryV1,
};
