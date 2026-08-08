import type {
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  Provider,
} from "./types";

const REQUIRED_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const PROVIDER_LABELS: Record<Provider, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  zhipu: "Zhipu",
};

const FORCED_NAMED_TOOL_PROVIDERS = new Set<Provider>([
  "claude",
  "gemini",
  "openai",
  "deepseek",
]);

export type RequiredToolProtocolIssueCode =
  | "required_tool_name_invalid"
  | "required_tool_not_registered"
  | "required_tool_registration_ambiguous"
  | "required_tool_dispatch_unavailable"
  | "provider_forced_tool_unsupported"
  | "required_tool_call_missing"
  | "required_tool_call_multiple"
  | "required_tool_call_wrong"
  | "required_tool_call_incomplete";

export class RequiredToolProtocolError extends Error {
  constructor(
    readonly issueCode: RequiredToolProtocolIssueCode,
    readonly provider: Provider,
    readonly requiredToolName: string,
    readonly facts: Readonly<Record<string, unknown>> = {},
  ) {
    const label = PROVIDER_LABELS[provider];
    const message =
      issueCode === "required_tool_call_missing"
        ? `${label} did not return the required ${requiredToolName} tool call for this iteration.`
        : `${label} could not complete exactly one required ${requiredToolName} tool call (${issueCode}).`;
    super(message);
    this.name = "RequiredToolProtocolError";
  }
}

export function isRequiredToolProtocolError(
  error: unknown,
): error is RequiredToolProtocolError {
  if (error instanceof RequiredToolProtocolError) return true;
  if (!error || typeof error !== "object") return false;
  const row = error as {
    name?: unknown;
    issueCode?: unknown;
    provider?: unknown;
    requiredToolName?: unknown;
  };
  return (
    row.name === "RequiredToolProtocolError" &&
    typeof row.issueCode === "string" &&
    typeof row.provider === "string" &&
    typeof row.requiredToolName === "string"
  );
}

export type PreparedRequiredToolContract = {
  provider: Provider;
  providerLabel: string;
  requiredToolName: string;
};

export function providerSupportsForcedNamedTool(provider: Provider) {
  return FORCED_NAMED_TOOL_PROVIDERS.has(provider);
}

export function prepareRequiredToolContract(input: {
  provider: Provider;
  requiredToolName?: string;
  tools: OpenAIToolSchema[];
  runTools?: (
    calls: NormalizedToolCall[],
  ) => Promise<NormalizedToolResult[]>;
}): PreparedRequiredToolContract | null {
  if (input.requiredToolName === undefined) return null;
  const requiredToolName = input.requiredToolName.trim();
  if (
    requiredToolName !== input.requiredToolName ||
    !REQUIRED_TOOL_NAME_PATTERN.test(requiredToolName)
  ) {
    throw new RequiredToolProtocolError(
      "required_tool_name_invalid",
      input.provider,
      requiredToolName || "invalid_tool",
    );
  }
  const registrations = input.tools.filter(
    (tool) => tool.function.name === requiredToolName,
  );
  if (registrations.length === 0) {
    throw new RequiredToolProtocolError(
      "required_tool_not_registered",
      input.provider,
      requiredToolName,
    );
  }
  if (registrations.length !== 1) {
    throw new RequiredToolProtocolError(
      "required_tool_registration_ambiguous",
      input.provider,
      requiredToolName,
      { registration_count: registrations.length },
    );
  }
  if (!input.runTools) {
    throw new RequiredToolProtocolError(
      "required_tool_dispatch_unavailable",
      input.provider,
      requiredToolName,
    );
  }
  if (!providerSupportsForcedNamedTool(input.provider)) {
    throw new RequiredToolProtocolError(
      "provider_forced_tool_unsupported",
      input.provider,
      requiredToolName,
    );
  }
  return {
    provider: input.provider,
    providerLabel: PROVIDER_LABELS[input.provider],
    requiredToolName,
  };
}

export function requiredToolChoiceForProvider(
  contract: PreparedRequiredToolContract,
): Record<string, unknown> {
  switch (contract.provider) {
    case "claude":
      return {
        type: "tool",
        name: contract.requiredToolName,
        disable_parallel_tool_use: true,
      };
    case "gemini":
      return {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [contract.requiredToolName],
        },
      };
    case "openai":
      return { type: "function", name: contract.requiredToolName };
    case "deepseek":
      return {
        type: "function",
        function: { name: contract.requiredToolName },
      };
    case "kimi":
    case "zhipu":
      throw new RequiredToolProtocolError(
        "provider_forced_tool_unsupported",
        contract.provider,
        contract.requiredToolName,
      );
  }
}

export function validateRequiredToolCalls(
  contract: PreparedRequiredToolContract | null,
  calls: NormalizedToolCall[],
) {
  if (!contract) return calls;
  if (calls.length === 0) {
    throw new RequiredToolProtocolError(
      "required_tool_call_missing",
      contract.provider,
      contract.requiredToolName,
    );
  }
  if (calls.length !== 1) {
    throw new RequiredToolProtocolError(
      "required_tool_call_multiple",
      contract.provider,
      contract.requiredToolName,
      { call_count: calls.length, returned_names: calls.map((call) => call.name) },
    );
  }
  const call = calls[0];
  if (call.name !== contract.requiredToolName) {
    throw new RequiredToolProtocolError(
      "required_tool_call_wrong",
      contract.provider,
      contract.requiredToolName,
      { returned_name: call.name },
    );
  }
  if (
    typeof call.id !== "string" ||
    !call.id.trim() ||
    !call.input ||
    typeof call.input !== "object" ||
    Array.isArray(call.input)
  ) {
    throw new RequiredToolProtocolError(
      "required_tool_call_incomplete",
      contract.provider,
      contract.requiredToolName,
    );
  }
  return calls;
}
