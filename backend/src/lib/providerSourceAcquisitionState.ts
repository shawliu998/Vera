import { z } from "zod";

import {
  readOnlySourceCoverageSchema,
  readOnlySourceDiscoverySchema,
  readOnlySourceReceiptSchema,
  readOnlySourceRequestSchema,
} from "./agent-kernel/connectors/readOnlySourceContract";
import {
  compileProviderSourceSearchRequest,
  compileProviderSourceSelectedReadRequest,
  providerSourceAcquisitionSpecSchema,
  validateProviderSourceAcquisitionSpec,
} from "./providerSourceAcquisition";
import type { ProviderSourcePipelineOutcomeV1 } from "./providerSourcePipeline";
import { providerSourceImportReceiptSchema } from "./providerSourceImport";

export const PROVIDER_SOURCE_ACQUISITION_CHECKPOINT_KEY =
  "source_acquisition" as const;
export const PROVIDER_SOURCE_ACQUISITION_STATE_VERSION =
  "provider_source_acquisition_state_v1" as const;
export const PROVIDER_SOURCE_SELECTION_CHECKPOINT_VERSION =
  "provider_source_selection_v1" as const;

export const providerSourceSelectionCheckpointSchema = z
  .object({
    schema_version: z.literal(PROVIDER_SOURCE_SELECTION_CHECKPOINT_VERSION),
    submission_id: z.string().trim().min(1).max(200),
    selected_discovery_refs: z
      .array(z.string().trim().min(1).max(160))
      .min(1)
      .max(20),
    submitted_at: z.string().datetime(),
  })
  .strict()
  .superRefine((selection, context) => {
    if (
      new Set(selection.selected_discovery_refs).size !==
      selection.selected_discovery_refs.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_discovery_refs"],
        message: "Selected discovery refs must be unique",
      });
    }
  });

const issueSchema = z
  .object({
    code: z.enum([
      "no_results",
      "pagination_truncated",
      "snapshot_unavailable",
    ]),
    detail: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const providerSourceAcquisitionStateSchema = z
  .object({
    schema_version: z.literal(PROVIDER_SOURCE_ACQUISITION_STATE_VERSION),
    spec: providerSourceAcquisitionSpecSchema,
    phase: z.enum([
      "search_pending",
      "selection_required",
      "read_pending",
      "completed",
      "review_required",
    ]),
    next_page: z.number().int().min(1).max(100).nullable(),
    discoveries: z.array(readOnlySourceDiscoverySchema).max(200),
    selected_discovery_refs: z.array(z.string().trim().min(1).max(160)).max(20),
    search_receipts: z.array(readOnlySourceReceiptSchema).max(100),
    search_coverage: z.array(readOnlySourceCoverageSchema).max(100),
    read_receipts: z.array(readOnlySourceReceiptSchema).max(20),
    import_receipts: z.array(providerSourceImportReceiptSchema).max(20),
    issues: z.array(issueSchema).max(20),
  })
  .strict()
  .superRefine((state, context) => {
    const discoveryRefs = state.discoveries.map(
      (discovery) => discovery.discovery_ref,
    );
    if (new Set(discoveryRefs).size !== discoveryRefs.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discoveries"],
        message: "Acquisition discovery refs must be unique",
      });
    }
    if (
      new Set(state.selected_discovery_refs).size !==
      state.selected_discovery_refs.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_discovery_refs"],
        message: "Selected discovery refs must be unique",
      });
    }
    if (
      state.selected_discovery_refs.some(
        (selected) => !discoveryRefs.includes(selected),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_discovery_refs"],
        message: "A selection must bind an existing discovery",
      });
    }
    if (state.selected_discovery_refs.length > state.spec.maximum_selections) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_discovery_refs"],
        message: "Selections exceed the fixed acquisition scope",
      });
    }
    if ((state.phase === "search_pending") !== (state.next_page !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["next_page"],
        message: "Only a pending search may have a next page",
      });
    }
    if (
      state.phase === "selection_required" &&
      (!state.discoveries.length || state.selected_discovery_refs.length)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phase"],
        message: "Selection requires discoveries and no prior selection",
      });
    }
    if (
      state.phase === "read_pending" &&
      state.selected_discovery_refs.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phase"],
        message: "A pending read requires an exact lawyer selection",
      });
    }
    const pagesExamined = state.search_coverage.reduce(
      (sum, coverage) => sum + coverage.pages_examined,
      0,
    );
    const itemsExamined = state.search_coverage.reduce(
      (sum, coverage) => sum + coverage.items_examined,
      0,
    );
    if (
      ["selection_required", "read_pending", "completed"].includes(
        state.phase,
      ) &&
      state.search_coverage.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["search_coverage"],
        message: "A completed search phase requires bounded coverage facts",
      });
    }
    if (
      pagesExamined > state.spec.maximum_pages ||
      itemsExamined > state.spec.maximum_pages * state.spec.page_size
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["search_coverage"],
        message: "Search coverage exceeds the fixed acquisition scope",
      });
    }
    const selectedExternalIds = new Set(
      state.discoveries
        .filter((discovery) =>
          state.selected_discovery_refs.includes(discovery.discovery_ref),
        )
        .map((discovery) => discovery.external_id),
    );
    const importedExternalIds = state.import_receipts.map(
      (receipt) => receipt.external_id,
    );
    if (
      new Set(importedExternalIds).size !== importedExternalIds.length ||
      importedExternalIds.some(
        (externalId) => !selectedExternalIds.has(externalId),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["import_receipts"],
        message: "Imported sources must uniquely match selected discoveries",
      });
    }
    if (
      state.phase === "completed" &&
      state.import_receipts.length !== state.selected_discovery_refs.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phase"],
        message: "Completed acquisition requires every selected import",
      });
    }
  });

export type ProviderSourceAcquisitionStateV1 = z.infer<
  typeof providerSourceAcquisitionStateSchema
>;

export function createProviderSourceAcquisitionState(input: {
  spec: unknown;
  pin: unknown;
}) {
  const { spec } = validateProviderSourceAcquisitionSpec(input.spec, input.pin);
  return providerSourceAcquisitionStateSchema.parse({
    schema_version: PROVIDER_SOURCE_ACQUISITION_STATE_VERSION,
    spec,
    phase: "search_pending",
    next_page: 1,
    discoveries: [],
    selected_discovery_refs: [],
    search_receipts: [],
    search_coverage: [],
    read_receipts: [],
    import_receipts: [],
    issues: [],
  });
}

export function appendProviderSourceSearchPage(input: {
  state: unknown;
  pin: unknown;
  request: unknown;
  outcome: ProviderSourcePipelineOutcomeV1;
}) {
  const state = providerSourceAcquisitionStateSchema.parse(input.state);
  const request = readOnlySourceRequestSchema.parse(input.request);
  const fixed = validateProviderSourceAcquisitionSpec(state.spec, input.pin);
  if (request.operation !== "search" || request.page === null) {
    throw new Error("Provider source acquisition expected a search request");
  }
  const requestInScope = compileProviderSourceSearchRequest({
    spec: state.spec,
    pin: input.pin,
    requestRef: request.request_ref,
    page: request.page,
  });
  if (JSON.stringify(request) !== JSON.stringify(requestInScope)) {
    throw new Error("Provider source search request drifted from fixed scope");
  }
  const replayIndex = state.search_receipts.findIndex(
    (receipt) => receipt.request_ref === request.request_ref,
  );
  if (replayIndex >= 0) {
    const knownDiscoveries = new Map(
      state.discoveries.map((discovery) => [
        discovery.discovery_ref,
        discovery,
      ]),
    );
    if (
      input.outcome.kind === "completed" &&
      input.outcome.operation === "search" &&
      JSON.stringify(state.search_receipts[replayIndex]) ===
        JSON.stringify(input.outcome.receipt) &&
      JSON.stringify(state.search_coverage[replayIndex]) ===
        JSON.stringify(input.outcome.coverage) &&
      input.outcome.discoveries.every(
        (discovery) =>
          JSON.stringify(knownDiscoveries.get(discovery.discovery_ref)) ===
          JSON.stringify(discovery),
      )
    ) {
      return state;
    }
    throw new Error("Provider source search replay drifted after commit");
  }
  if (state.phase !== "search_pending" || state.next_page === null) {
    throw new Error("Provider source acquisition is not waiting for search");
  }
  const expected = compileProviderSourceSearchRequest({
    spec: state.spec,
    pin: input.pin,
    requestRef: request.request_ref,
    page: state.next_page,
  });
  if (JSON.stringify(request) !== JSON.stringify(expected)) {
    throw new Error("Provider source search request drifted from fixed scope");
  }
  if (
    input.outcome.kind !== "completed" ||
    input.outcome.operation !== "search" ||
    JSON.stringify(input.outcome.receipt.connector_pin) !==
      JSON.stringify(fixed.pin) ||
    input.outcome.receipt.operation !== "search" ||
    input.outcome.receipt.request_ref !== request.request_ref ||
    input.outcome.coverage.request_ref !== request.request_ref
  ) {
    throw new Error(
      "Provider source search outcome does not match its request",
    );
  }
  const returnedRefs = input.outcome.discoveries.map(
    (discovery) => discovery.discovery_ref,
  );
  if (
    JSON.stringify(input.outcome.receipt.returned_discovery_refs) !==
      JSON.stringify(returnedRefs) ||
    input.outcome.receipt.returned_snapshot_refs.length !== 0
  ) {
    throw new Error(
      "Provider source search receipt does not match discoveries",
    );
  }
  const byRef = new Map(
    state.discoveries.map((discovery) => [discovery.discovery_ref, discovery]),
  );
  for (const discovery of input.outcome.discoveries) {
    const normalized = readOnlySourceDiscoverySchema.parse(discovery);
    const current = byRef.get(normalized.discovery_ref);
    if (current && JSON.stringify(current) !== JSON.stringify(normalized)) {
      throw new Error("Provider discovery identity drifted across pages");
    }
    byRef.set(normalized.discovery_ref, normalized);
  }
  const discoveries = [...byRef.values()];
  if (discoveries.length > 200) {
    throw new Error("Provider source acquisition exceeded checkpoint bounds");
  }
  const page = state.next_page;
  const continueSearch =
    input.outcome.coverage.truncated && page < state.spec.maximum_pages;
  const issues = [
    ...state.issues,
    ...(!continueSearch && input.outcome.coverage.truncated
      ? [
          {
            code: "pagination_truncated" as const,
            detail:
              "The fixed acquisition page limit was reached while more provider results remained.",
          },
        ]
      : []),
  ];
  return providerSourceAcquisitionStateSchema.parse({
    ...state,
    phase: continueSearch
      ? "search_pending"
      : discoveries.length
        ? "selection_required"
        : "review_required",
    next_page: continueSearch ? page + 1 : null,
    discoveries,
    search_receipts: [...state.search_receipts, input.outcome.receipt],
    search_coverage: [...state.search_coverage, input.outcome.coverage],
    issues:
      discoveries.length || continueSearch
        ? issues
        : [
            ...issues,
            {
              code: "no_results" as const,
              detail:
                "The fixed provider search returned no selectable results.",
            },
          ],
  });
}

export function selectProviderSourceDiscoveries(input: {
  state: unknown;
  discoveryRefs: string[];
}) {
  const state = providerSourceAcquisitionStateSchema.parse(input.state);
  if (state.phase !== "selection_required") {
    throw new Error("Provider source acquisition is not waiting for selection");
  }
  const selected = Array.from(
    new Set(input.discoveryRefs.map((value) => value.trim()).filter(Boolean)),
  );
  if (!selected.length || selected.length > state.spec.maximum_selections) {
    throw new Error("Provider source selection exceeds fixed scope");
  }
  const allowed = new Set(
    state.discoveries.map((discovery) => discovery.discovery_ref),
  );
  if (selected.some((reference) => !allowed.has(reference))) {
    throw new Error("Provider source selection is not a returned discovery");
  }
  return providerSourceAcquisitionStateSchema.parse({
    ...state,
    phase: "read_pending",
    selected_discovery_refs: selected,
  });
}

export function selectedProviderSourceDiscoveries(stateValue: unknown) {
  const state = providerSourceAcquisitionStateSchema.parse(stateValue);
  const selected = new Set(state.selected_discovery_refs);
  return state.discoveries.filter((discovery) =>
    selected.has(discovery.discovery_ref),
  );
}

export function compileNextProviderSourceSelectedRead(input: {
  state: unknown;
  pin: unknown;
  requestRef: string;
}) {
  const state = providerSourceAcquisitionStateSchema.parse(input.state);
  if (state.phase !== "read_pending") {
    throw new Error("Provider source acquisition is not waiting for a read");
  }
  const imported = new Set(
    state.import_receipts.map((receipt) => receipt.external_id),
  );
  const discovery = selectedProviderSourceDiscoveries(state).find(
    (candidate) => !imported.has(candidate.external_id),
  );
  if (!discovery) {
    throw new Error("Provider source acquisition has no pending selected read");
  }
  return compileProviderSourceSelectedReadRequest({
    spec: state.spec,
    pin: input.pin,
    requestRef: input.requestRef,
    discovery,
  });
}

export function recordProviderSourceSelectedRead(input: {
  state: unknown;
  pin: unknown;
  request: unknown;
  outcome: ProviderSourcePipelineOutcomeV1;
}) {
  const state = providerSourceAcquisitionStateSchema.parse(input.state);
  const request = readOnlySourceRequestSchema.parse(input.request);
  const discovery = selectedProviderSourceDiscoveries(state).find(
    (candidate) => candidate.external_id === request.external_id,
  );
  if (!discovery) {
    throw new Error("Selected read does not match a lawyer-selected discovery");
  }
  const expected = compileProviderSourceSelectedReadRequest({
    spec: state.spec,
    pin: input.pin,
    requestRef: request.request_ref,
    discovery,
  });
  if (JSON.stringify(request) !== JSON.stringify(expected)) {
    throw new Error("Selected read request drifted from fixed scope");
  }
  const fixed = validateProviderSourceAcquisitionSpec(state.spec, input.pin);
  if (
    input.outcome.kind !== "completed" ||
    input.outcome.operation !== "read_snapshot" ||
    input.outcome.receipt.operation !== "read_snapshot" ||
    input.outcome.receipt.request_ref !== request.request_ref ||
    JSON.stringify(input.outcome.receipt.connector_pin) !==
      JSON.stringify(fixed.pin) ||
    input.outcome.coverage.request_ref !== request.request_ref
  ) {
    throw new Error("Selected read outcome does not match its fixed request");
  }
  if (input.outcome.imports.length === 0) {
    const replay = state.read_receipts.find(
      (receipt) => receipt.request_ref === request.request_ref,
    );
    if (replay) {
      if (JSON.stringify(replay) === JSON.stringify(input.outcome.receipt)) {
        return state;
      }
      throw new Error("Selected read replay drifted after commit");
    }
    if (state.phase !== "read_pending") {
      throw new Error("Provider source acquisition is not waiting for a read");
    }
    return providerSourceAcquisitionStateSchema.parse({
      ...state,
      phase: "review_required",
      read_receipts: [...state.read_receipts, input.outcome.receipt],
      issues: [
        ...state.issues,
        {
          code: "snapshot_unavailable",
          detail:
            "The selected provider record had no importable source snapshot.",
        },
      ],
    });
  }
  if (input.outcome.imports.length !== 1) {
    throw new Error("One selected read must produce at most one source import");
  }
  const imported = providerSourceImportReceiptSchema.parse(
    input.outcome.imports[0],
  );
  if (
    imported.provider_id !== discovery.provider_id ||
    imported.external_id !== discovery.external_id ||
    !input.outcome.receipt.returned_snapshot_refs.includes(
      imported.snapshot_ref,
    )
  ) {
    throw new Error("Imported source does not match the selected discovery");
  }
  const existingImport = state.import_receipts.find(
    (receipt) => receipt.external_id === imported.external_id,
  );
  const existingRead = state.read_receipts.find(
    (receipt) => receipt.request_ref === request.request_ref,
  );
  if (existingImport || existingRead) {
    if (
      existingImport &&
      existingRead &&
      JSON.stringify(existingImport) === JSON.stringify(imported) &&
      JSON.stringify(existingRead) === JSON.stringify(input.outcome.receipt)
    ) {
      return state;
    }
    throw new Error("Selected source import replay drifted after commit");
  }
  if (state.phase !== "read_pending") {
    throw new Error("Provider source acquisition is not waiting for a read");
  }
  const importReceipts = [...state.import_receipts, imported];
  return providerSourceAcquisitionStateSchema.parse({
    ...state,
    phase:
      importReceipts.length === state.selected_discovery_refs.length
        ? "completed"
        : "read_pending",
    read_receipts: [...state.read_receipts, input.outcome.receipt],
    import_receipts: importReceipts,
  });
}
