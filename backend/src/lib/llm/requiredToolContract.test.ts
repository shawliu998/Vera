import assert from "node:assert/strict";
import test from "node:test";
import type { OpenAIToolSchema, Provider } from "./types";
import {
  PreparedRequiredToolContract,
  RequiredToolProtocolError,
  prepareRequiredToolContract,
  providerSupportsForcedNamedTool,
  requiredToolChoiceForProvider,
  validateRequiredToolCalls,
} from "./requiredToolContract";

function tool(name: string): OpenAIToolSchema {
  return {
    type: "function",
    function: {
      name,
      description: `${name} test tool`,
      parameters: { type: "object", properties: {} },
    },
  };
}

function prepare(provider: Provider): PreparedRequiredToolContract {
  return prepareRequiredToolContract({
    provider,
    requiredToolName: "generate_docx",
    tools: [tool("generate_docx")],
    runTools: async () => [],
  })!;
}

test("prechecks an exact, unique, dispatchable required tool", () => {
  assert.equal(
    prepareRequiredToolContract({
      provider: "gemini",
      tools: [tool("generate_docx")],
    }),
    null,
  );
  assert.equal(prepare("gemini").requiredToolName, "generate_docx");

  for (const [requiredToolName, tools, expectedCode] of [
    [" generate_docx", [tool("generate_docx")], "required_tool_name_invalid"],
    ["generate_docx", [], "required_tool_not_registered"],
    [
      "generate_docx",
      [tool("generate_docx"), tool("generate_docx")],
      "required_tool_registration_ambiguous",
    ],
  ] as const) {
    assert.throws(
      () =>
        prepareRequiredToolContract({
          provider: "gemini",
          requiredToolName,
          tools: [...tools],
          runTools: async () => [],
        }),
      (error: unknown) =>
        error instanceof RequiredToolProtocolError &&
        error.issueCode === expectedCode,
    );
  }
  assert.throws(
    () =>
      prepareRequiredToolContract({
        provider: "gemini",
        requiredToolName: "generate_docx",
        tools: [tool("generate_docx")],
      }),
    (error: unknown) =>
      error instanceof RequiredToolProtocolError &&
      error.issueCode === "required_tool_dispatch_unavailable",
  );
});

test("forces only providers whose documented API supports an exact named tool", () => {
  for (const provider of ["claude", "gemini", "openai", "deepseek"] as const) {
    assert.equal(providerSupportsForcedNamedTool(provider), true);
  }
  for (const provider of ["kimi", "zhipu"] as const) {
    assert.equal(providerSupportsForcedNamedTool(provider), false);
    assert.throws(
      () => prepare(provider),
      (error: unknown) =>
        error instanceof RequiredToolProtocolError &&
        error.issueCode === "provider_forced_tool_unsupported",
    );
  }
});

test("maps the shared contract to each supported provider's native choice", () => {
  assert.deepEqual(requiredToolChoiceForProvider(prepare("claude")), {
    type: "tool",
    name: "generate_docx",
    disable_parallel_tool_use: true,
  });
  assert.deepEqual(requiredToolChoiceForProvider(prepare("gemini")), {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: ["generate_docx"],
    },
  });
  assert.deepEqual(requiredToolChoiceForProvider(prepare("openai")), {
    type: "function",
    name: "generate_docx",
  });
  assert.deepEqual(requiredToolChoiceForProvider(prepare("deepseek")), {
    type: "function",
    function: { name: "generate_docx" },
  });
});

test("validates one completed exact call before dispatch", () => {
  const contract = prepare("gemini");
  const exact = [{ id: "call-1", name: "generate_docx", input: {} }];
  assert.equal(validateRequiredToolCalls(contract, exact), exact);

  for (const [calls, expectedCode] of [
    [[], "required_tool_call_missing"],
    [
      [
        { id: "call-1", name: "generate_docx", input: {} },
        { id: "call-2", name: "generate_docx", input: {} },
      ],
      "required_tool_call_multiple",
    ],
    [[{ id: "call-1", name: "read_document", input: {} }], "required_tool_call_wrong"],
    [[{ id: "", name: "generate_docx", input: {} }], "required_tool_call_incomplete"],
  ] as const) {
    assert.throws(
      () => validateRequiredToolCalls(contract, [...calls]),
      (error: unknown) =>
        error instanceof RequiredToolProtocolError &&
        error.issueCode === expectedCode,
    );
  }
});
