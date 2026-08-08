import { z } from "zod";

import {
  readOnlySourceCoverageSchema,
  readOnlySourceDiscoverySchema,
  readOnlySourceReceiptSchema,
  readOnlySourceRequestSchema,
} from "./agent-kernel/connectors/readOnlySourceContract";
import {
  compileProviderSourceSearchRequest,
  providerSourceAcquisitionSpecSchema,
  validateProviderSourceAcquisitionSpec,
} from "./providerSourceAcquisition";
import type { ProviderSourcePipelineOutcomeV1 } from "./providerSourcePipeline";

export const PROVIDER_SOURCE_ACQUISITION_CHECKPOINT_KEY =
  "source_acquisition" as const;
export const PROVIDER_SOURCE_ACQUISITION_STATE_VERSION =
  "provider_source_acquisition_state_v1" as const;

const issueSchema = z
  .object({
    code: z.enum(["no_results", "pagination_truncated"]),
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
      "review_required",
    ]),
    next_page: z.number().int().min(1).max(100).nullable(),
    discoveries: z.array(readOnlySourceDiscoverySchema).max(200),
    selected_discovery_refs: z
      .array(z.string().trim().min(1).max(160))
      .max(20),
    search_receipts: z.array(readOnlySourceReceiptSchema).max(100),
    search_coverage: z.array(readOnlySourceCoverageSchema).max(100),
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
    if (
      state.selected_discovery_refs.length > state.spec.maximum_selections
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_discovery_refs"],
        message: "Selections exceed the fixed acquisition scope",
      });
    }
    if (
      (state.phase === "search_pending") !== (state.next_page !== null)
    ) {
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
  if (state.phase !== "search_pending" || state.next_page === null) {
    throw new Error("Provider source acquisition is not waiting for search");
  }
  const request = readOnlySourceRequestSchema.parse(input.request);
  const fixed = validateProviderSourceAcquisitionSpec(state.spec, input.pin);
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
    throw new Error("Provider source search outcome does not match its request");
  }
  const returnedRefs = input.outcome.discoveries.map(
    (discovery) => discovery.discovery_ref,
  );
  if (
    JSON.stringify(input.outcome.receipt.returned_discovery_refs) !==
      JSON.stringify(returnedRefs) ||
    input.outcome.receipt.returned_snapshot_refs.length !== 0
  ) {
    throw new Error("Provider source search receipt does not match discoveries");
  }
  const byRef = new Map(
    state.discoveries.map((discovery) => [
      discovery.discovery_ref,
      discovery,
    ]),
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
              detail: "The fixed provider search returned no selectable results.",
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
