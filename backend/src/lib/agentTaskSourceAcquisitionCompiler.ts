import { z } from "zod";

import type { ReadOnlySourceConnectorPinV1 } from "./agent-kernel/connectors/readOnlySourceContract";
import {
  PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION,
  type ProviderSourceAcquisitionSpecV1,
} from "./providerSourceAcquisition";
import {
  createProviderSourceAcquisitionState,
  type ProviderSourceAcquisitionStateV1,
} from "./providerSourceAcquisitionState";
import { resolveRegisteredProviderSourcePin } from "./providerSourceRuntime";
import type { SkillManifestV1 } from "./systemWorkflows";

const requirementSchema = z
  .object({
    schema_version: z.literal("provider_source_acquisition_requirement_v1"),
    connector_id: z.string().trim().min(1).max(160),
    maximum_pages: z.number().int().min(1).max(100),
    page_size: z.number().int().min(1).max(200),
    maximum_selections: z.number().int().min(1).max(20),
  })
  .strict();

const requestSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/.test(value),
        "query cannot contain control characters",
      ),
    jurisdiction: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .transform((value) => value.toUpperCase()),
    as_of_date: z.string().trim(),
  })
  .strict();

export type AgentTaskSourceAcquisitionInputErrorCode =
  | "source_acquisition_required"
  | "source_acquisition_unexpected"
  | "source_acquisition_invalid"
  | "source_acquisition_missing_target";

export class AgentTaskSourceAcquisitionInputError extends Error {
  constructor(
    readonly code: AgentTaskSourceAcquisitionInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentTaskSourceAcquisitionInputError";
  }
}

export type CompiledAgentTaskSourceAcquisition = {
  spec: ProviderSourceAcquisitionSpecV1;
  state: ProviderSourceAcquisitionStateV1;
  pin: ReadOnlySourceConnectorPinV1;
  jurisdictions: string[];
  asOfDate: string;
};

export function compileAgentTaskSourceAcquisition(input: {
  manifest: Pick<
    SkillManifestV1,
    "input_contract" | "source_acquisition"
  > | null;
  request: unknown;
  documentCount: number;
  dependencies?: {
    resolvePin?: typeof resolveRegisteredProviderSourcePin;
  };
}): CompiledAgentTaskSourceAcquisition | null {
  const manifest = input.manifest;
  const requirementValue = manifest?.source_acquisition;
  if (!manifest || !requirementValue) {
    if (input.request !== undefined && input.request !== null) {
      throw new AgentTaskSourceAcquisitionInputError(
        "source_acquisition_unexpected",
        "This Workflow does not accept a source_acquisition request",
      );
    }
    return null;
  }
  if (input.documentCount < manifest.input_contract.minimum_documents) {
    throw new AgentTaskSourceAcquisitionInputError(
      "source_acquisition_missing_target",
      `This source-acquisition Workflow requires at least ${manifest.input_contract.minimum_documents} pinned target document`,
    );
  }
  if (input.request === undefined || input.request === null) {
    throw new AgentTaskSourceAcquisitionInputError(
      "source_acquisition_required",
      "source_acquisition is required for this Workflow",
    );
  }
  const requirement = requirementSchema.parse(requirementValue);
  const request = requestSchema.safeParse(input.request);
  if (!request.success) {
    throw new AgentTaskSourceAcquisitionInputError(
      "source_acquisition_invalid",
      "source_acquisition must contain only query, jurisdiction, and as_of_date",
    );
  }
  const pin = (
    input.dependencies?.resolvePin ?? resolveRegisteredProviderSourcePin
  )(requirement.connector_id);
  const spec = {
    schema_version: PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION,
    connector_id: requirement.connector_id,
    query: request.data.query,
    jurisdiction: request.data.jurisdiction,
    as_of_date: request.data.as_of_date,
    maximum_pages: requirement.maximum_pages,
    page_size: requirement.page_size,
    maximum_selections: requirement.maximum_selections,
  };
  try {
    const state = createProviderSourceAcquisitionState({ spec, pin });
    return {
      spec: state.spec,
      state,
      pin,
      jurisdictions: [state.spec.jurisdiction],
      asOfDate: state.spec.as_of_date,
    };
  } catch {
    throw new AgentTaskSourceAcquisitionInputError(
      "source_acquisition_invalid",
      "source_acquisition exceeds the registered connector scope",
    );
  }
}
