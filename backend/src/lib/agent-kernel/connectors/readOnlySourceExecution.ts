import { createHash } from "node:crypto";

import type { AgentStepCapabilityGrantV2 } from "../capability/stepCapability";
import type { AgentTaskExecutionPauseClassification } from "../outcomes/executionOutcome";
import {
  READ_ONLY_SOURCE_RECEIPT_VERSION,
  readOnlySourceAuthorizationSchema,
  readOnlySourceCoverageSchema,
  readOnlySourceDiscoverySchema,
  readOnlySourceReceiptSchema,
  readOnlySourceRequestSchema,
  readOnlySourceSnapshotSchema,
  validateReadOnlySourceConnectorPin,
  type ReadOnlySourceConnectorPinV1,
  type ReadOnlySourceAuthorizationV1,
  type ReadOnlySourceCoverageV1,
  type ReadOnlySourceDiscoveryV1,
  type ReadOnlySourceEgressFieldV1,
  type ReadOnlySourceReceiptV1,
  type ReadOnlySourceRequestV1,
  type ReadOnlySourceSnapshotV1,
} from "./readOnlySourceContract";

export type ReadOnlySourceExecutionContextV1 = {
  taskId: string;
  stepId: string;
  stepPosition: number;
  attempt: number;
  matterId: string;
  sourceVersionIds: string[];
};

export type ReadOnlySourceBoundInvokerV1 = {
  readonly connectorId: string;
  readonly host: string | null;
  readonly binding: ReadOnlySourceConnectorPinV1["binding"];
  /** Provider-specific identity binding that must pass before network egress. */
  acceptsRequest?(request: Readonly<ReadOnlySourceRequestV1>): boolean;
  invoke(
    payload: Readonly<Record<string, string | number>>,
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<unknown>;
};

export type ReadOnlySourceNormalizerV1 = {
  readonly pin: ReadOnlySourceConnectorPinV1;
  normalize(input: {
    raw: unknown;
    request: ReadOnlySourceRequestV1;
  }): Promise<{
    discoveries: unknown[];
    importCandidates: unknown[];
    coverage: unknown;
  }>;
};

type ReadOnlySourceInvocationPauseClassificationV1 = Extract<
  AgentTaskExecutionPauseClassification,
  | "provider_capacity"
  | "provider_configuration"
  | "provider_network"
  | "provider_protocol"
>;

/**
 * Provider adapters may expose only this server-owned classification across
 * the Kernel boundary. Provider messages, credentials and response bodies are
 * deliberately not carried into receipts or Task state.
 */
export class ReadOnlySourceInvocationError extends Error {
  readonly classification: ReadOnlySourceInvocationPauseClassificationV1;

  constructor(classification: ReadOnlySourceInvocationPauseClassificationV1) {
    super(`read_only_source_invocation_${classification}`);
    this.name = "ReadOnlySourceInvocationError";
    this.classification = classification;
  }
}

export type ReadOnlySourceExecutionOutcomeV1 =
  | {
      kind: "completed";
      /** Search-only candidates; never treat these as citations or sources. */
      discoveries: ReadOnlySourceDiscoveryV1[];
      /** Import-only; never serialize this body-bearing channel as result_data. */
      importCandidates: ReadOnlySourceSnapshotV1[];
      coverage: ReadOnlySourceCoverageV1;
      receipt: ReadOnlySourceReceiptV1;
    }
  | {
      kind: "provider_pause";
      classification: AgentTaskExecutionPauseClassification;
      receipt: ReadOnlySourceReceiptV1;
    }
  | {
      kind: "rejected";
      code: string;
      receipt: ReadOnlySourceReceiptV1;
    };

function pinIdentity(pin: ReadOnlySourceConnectorPinV1) {
  return JSON.stringify(validateReadOnlySourceConnectorPin(pin));
}

function samePin(
  left: ReadOnlySourceConnectorPinV1,
  right: ReadOnlySourceConnectorPinV1,
) {
  return pinIdentity(left) === pinIdentity(right);
}

function sentFields(request: ReadOnlySourceRequestV1) {
  const fields: ReadOnlySourceEgressFieldV1[] = [];
  if (request.query !== null) fields.push("query");
  if (request.jurisdiction !== null) fields.push("jurisdiction");
  if (request.as_of_date !== null) fields.push("as_of_date");
  if (request.page !== null) fields.push("page");
  if (request.page_size !== null) fields.push("page_size");
  if (request.external_id !== null) fields.push("external_id");
  return fields;
}

function egressPayload(
  request: ReadOnlySourceRequestV1,
): Record<string, string | number> {
  return Object.fromEntries(
    sentFields(request).map((field) => [
      field,
      field === "as_of_date"
        ? request.as_of_date!
        : field === "external_id"
          ? request.external_id!
          : field === "query"
            ? request.query!
            : field === "jurisdiction"
              ? request.jurisdiction!
              : field === "page"
                ? request.page!
                : request.page_size!,
    ]),
  );
}

function idempotencyKey(input: {
  context: ReadOnlySourceExecutionContextV1;
  pin: ReadOnlySourceConnectorPinV1;
  request: ReadOnlySourceRequestV1;
}) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        taskId: input.context.taskId,
        stepId: input.context.stepId,
        attempt: input.context.attempt,
        pin: input.pin,
        request: input.request,
      }),
    )
    .digest("hex");
  return `source:${digest}`;
}

function makeReceipt(input: {
  context: ReadOnlySourceExecutionContextV1;
  pin: ReadOnlySourceConnectorPinV1;
  authorization: ReadOnlySourceAuthorizationV1;
  request: ReadOnlySourceRequestV1;
  egressFields: ReadOnlySourceEgressFieldV1[];
  externalCallAttempted: boolean;
  status: "ok" | "error" | "rejected";
  errorCategory: string | null;
  discoveryRefs: string[];
  snapshotRefs: string[];
  startedAt: string;
  completedAt: string;
}) {
  return readOnlySourceReceiptSchema.parse({
    schema_version: READ_ONLY_SOURCE_RECEIPT_VERSION,
    task_id: input.context.taskId,
    step_id: input.context.stepId,
    step_position: input.context.stepPosition,
    attempt: input.context.attempt,
    matter_id: input.context.matterId,
    source_version_ids: input.context.sourceVersionIds,
    connector_pin: input.pin,
    authorization: input.authorization,
    request_ref: input.request.request_ref,
    operation: input.request.operation,
    egress_fields_sent: input.egressFields,
    external_call_attempted: input.externalCallAttempted,
    external_side_effect: "none",
    status: input.status,
    error_category: input.errorCategory,
    returned_discovery_refs: input.discoveryRefs,
    returned_snapshot_refs: input.snapshotRefs,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    idempotency_key: idempotencyKey({
      context: input.context,
      pin: input.pin,
      request: input.request,
    }),
  });
}

function preflight(input: {
  grant: AgentStepCapabilityGrantV2;
  pin: ReadOnlySourceConnectorPinV1;
  authorization: ReadOnlySourceAuthorizationV1;
  invoker: ReadOnlySourceBoundInvokerV1;
  normalizer: ReadOnlySourceNormalizerV1;
  request: ReadOnlySourceRequestV1;
  startedAt: string;
}) {
  if (
    !input.grant.research_tools_allowed ||
    input.grant.capability !== "read_sources" ||
    input.grant.operation !== "read" ||
    input.grant.consequential_actions_allowed
  ) {
    return "connector_grant_not_authorized";
  }
  if (
    !input.grant.read_only_connector_pins.some((granted) =>
      samePin(granted, input.pin),
    )
  ) {
    return "connector_pin_not_granted";
  }
  if (!samePin(input.normalizer.pin, input.pin)) {
    return "connector_adapter_pin_mismatch";
  }
  if (
    input.invoker.connectorId !== input.pin.connector_id ||
    JSON.stringify(input.invoker.binding) !== JSON.stringify(input.pin.binding)
  ) {
    return "connector_invoker_binding_mismatch";
  }
  if (input.invoker.acceptsRequest) {
    try {
      if (!input.invoker.acceptsRequest(input.request)) {
        return "connector_request_not_bound";
      }
    } catch {
      return "connector_request_not_bound";
    }
  }
  if (
    (input.pin.binding.kind === "fixture" && input.invoker.host !== null) ||
    (input.pin.binding.kind !== "fixture" &&
      (!input.invoker.host ||
        !input.pin.allowed_hosts.includes(input.invoker.host)))
  ) {
    return "connector_invoker_host_not_allowed";
  }
  if (
    input.authorization.connector_id !== input.pin.connector_id ||
    input.authorization.connection !== "connected"
  ) {
    return "connector_disconnected";
  }
  if (input.authorization.subscription === "unverified") {
    return "connector_subscription_unverified";
  }
  const authorizationAge =
    new Date(input.startedAt).getTime() -
    new Date(input.authorization.checked_at).getTime();
  if (
    !Number.isFinite(authorizationAge) ||
    authorizationAge < -5_000 ||
    authorizationAge > input.pin.limits.authorization_max_age_ms
  ) {
    return "connector_authorization_stale";
  }
  if (!input.pin.allowed_operations.includes(input.request.operation)) {
    return "connector_operation_not_allowed";
  }
  if (
    !input.request.jurisdiction ||
    !input.pin.allowed_jurisdictions.includes(input.request.jurisdiction)
  ) {
    return "connector_jurisdiction_not_allowed";
  }
  if (
    input.request.page !== null &&
    input.request.page > input.pin.limits.maximum_pages
  ) {
    return "connector_page_limit_exceeded";
  }
  if (
    input.request.page_size !== null &&
    input.request.page_size > input.pin.limits.maximum_items_per_page
  ) {
    return "connector_page_size_exceeded";
  }
  if (
    input.request.query &&
    input.request.query.length > input.pin.limits.maximum_query_chars
  ) {
    return "connector_query_limit_exceeded";
  }
  const allowedEgress = new Set(input.pin.allowed_egress_fields);
  if (sentFields(input.request).some((field) => !allowedEgress.has(field))) {
    return "connector_egress_field_not_allowed";
  }
  return null;
}

function validateNormalizedResult(input: {
  pin: ReadOnlySourceConnectorPinV1;
  request: ReadOnlySourceRequestV1;
  discoveries: unknown[];
  importCandidates: unknown[];
  coverage: unknown;
}) {
  const discoveries = input.discoveries.map((discovery) =>
    readOnlySourceDiscoverySchema.parse(discovery),
  );
  const importCandidates = input.importCandidates.map((snapshot) =>
    readOnlySourceSnapshotSchema.parse(snapshot),
  );
  const coverage = readOnlySourceCoverageSchema.parse(input.coverage);
  const maximumSnapshots =
    input.request.operation === "search" ? input.request.page_size! : 1;
  const maximumDiscoveries =
    input.request.operation === "search" ? input.request.page_size! : 1;
  if (discoveries.length > maximumDiscoveries) {
    throw new Error("connector_discovery_count_exceeded");
  }
  if (importCandidates.length > maximumSnapshots) {
    throw new Error("connector_snapshot_count_exceeded");
  }
  if (coverage.pages_examined > input.pin.limits.maximum_pages) {
    throw new Error("connector_coverage_page_limit_exceeded");
  }
  if (
    coverage.items_examined >
    input.pin.limits.maximum_pages *
      input.pin.limits.maximum_items_per_page
  ) {
    throw new Error("connector_coverage_item_limit_exceeded");
  }
  if (coverage.request_ref !== input.request.request_ref) {
    throw new Error("connector_coverage_request_mismatch");
  }
  const refs = importCandidates.map((snapshot) => snapshot.snapshot_ref);
  if (new Set(refs).size !== refs.length) {
    throw new Error("connector_snapshot_refs_not_unique");
  }
  const allowedSourceHosts = new Set(input.pin.allowed_source_hosts);
  const discoveryRefs = discoveries.map((discovery) => discovery.discovery_ref);
  if (new Set(discoveryRefs).size !== discoveryRefs.length) {
    throw new Error("connector_discovery_refs_not_unique");
  }
  for (const discovery of discoveries) {
    if (discovery.provider_id !== input.pin.provider_id) {
      throw new Error("connector_discovery_provider_mismatch");
    }
    if (!allowedSourceHosts.has(new URL(discovery.canonical_url).hostname)) {
      throw new Error("connector_discovery_host_not_allowed");
    }
  }
  for (const snapshot of importCandidates) {
    if (snapshot.provider_id !== input.pin.provider_id) {
      throw new Error("connector_snapshot_provider_mismatch");
    }
    if (!allowedSourceHosts.has(new URL(snapshot.canonical_url).hostname)) {
      throw new Error("connector_snapshot_host_not_allowed");
    }
    if (snapshot.source_body.length > input.pin.limits.maximum_snapshot_chars) {
      throw new Error("connector_snapshot_limit_exceeded");
    }
    const digest = `sha256:${createHash("sha256")
      .update(snapshot.source_body)
      .digest("hex")}`;
    if (digest !== snapshot.content_sha256) {
      throw new Error("connector_snapshot_digest_mismatch");
    }
  }
  return { discoveries, importCandidates, coverage };
}

export async function executeReadOnlySourceConnector(input: {
  context: ReadOnlySourceExecutionContextV1;
  grant: AgentStepCapabilityGrantV2;
  pin: unknown;
  authorization: unknown;
  request: unknown;
  normalizer: ReadOnlySourceNormalizerV1;
  invoker: ReadOnlySourceBoundInvokerV1;
  now?: () => string;
}): Promise<ReadOnlySourceExecutionOutcomeV1> {
  const pin = validateReadOnlySourceConnectorPin(input.pin);
  const authorization = readOnlySourceAuthorizationSchema.parse(
    input.authorization,
  );
  const request = readOnlySourceRequestSchema.parse(input.request);
  const now = input.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const egressFields = sentFields(request);
  const rejection = preflight({
    grant: input.grant,
    pin,
    authorization,
    invoker: input.invoker,
    normalizer: input.normalizer,
    request,
    startedAt,
  });
  if (rejection) {
    return {
      kind: "rejected",
      code: rejection,
      receipt: makeReceipt({
        context: input.context,
        pin,
        authorization,
        request,
        egressFields: [],
        externalCallAttempted: false,
        status: "rejected",
        errorCategory: rejection,
        discoveryRefs: [],
        snapshotRefs: [],
        startedAt,
        completedAt: now(),
      }),
    };
  }

  const externalCallAttempted = pin.binding.kind !== "fixture";
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let raw: unknown;
  try {
    raw = await Promise.race([
      input.invoker.invoke(egressPayload(request), {
        timeoutMs: pin.limits.timeout_ms,
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("connector_timeout"));
        }, pin.limits.timeout_ms);
      }),
    ]);
  } catch (error) {
    const classification: AgentTaskExecutionPauseClassification = timedOut
      ? "provider_timeout"
      : error instanceof ReadOnlySourceInvocationError
        ? error.classification
        : "provider_network";
    return {
      kind: "provider_pause",
      classification,
      receipt: makeReceipt({
        context: input.context,
        pin,
        authorization,
        request,
        egressFields,
        externalCallAttempted,
        status: "error",
        errorCategory: classification,
        discoveryRefs: [],
        snapshotRefs: [],
        startedAt,
        completedAt: now(),
      }),
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  try {
    const normalized = await input.normalizer.normalize({ raw, request });
    const result = validateNormalizedResult({
      pin,
      request,
      discoveries: normalized.discoveries,
      importCandidates: normalized.importCandidates,
      coverage: normalized.coverage,
    });
    return {
      kind: "completed",
      ...result,
      receipt: makeReceipt({
        context: input.context,
        pin,
        authorization,
        request,
        egressFields,
        externalCallAttempted,
        status: "ok",
        errorCategory: null,
        discoveryRefs: result.discoveries.map(
          (discovery) => discovery.discovery_ref,
        ),
        snapshotRefs: result.importCandidates.map(
          (snapshot) => snapshot.snapshot_ref,
        ),
        startedAt,
        completedAt: now(),
      }),
    };
  } catch {
    return {
      kind: "provider_pause",
      classification: "provider_structured_output",
      receipt: makeReceipt({
        context: input.context,
        pin,
        authorization,
        request,
        egressFields,
        externalCallAttempted,
        status: "error",
        errorCategory: "provider_structured_output",
        discoveryRefs: [],
        snapshotRefs: [],
        startedAt,
        completedAt: now(),
      }),
    };
  }
}
