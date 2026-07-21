import assert from "node:assert/strict";
import { verifierRepairAlreadyAttempted } from "../src/lib/agentTasks";
import { selectActiveTools } from "../src/lib/chat/streaming";

function main() {
  const baseTools = [{ name: "read_document" }];
  const mcpTools = [{ name: "mcp_search" }];
  const extraTools = [{ name: "custom_tool" }];

  assert.deepEqual(
    selectActiveTools({
      disableTools: true,
      baseTools,
      mcpTools,
      extraTools,
    }),
    [],
    "the verifier must receive no built-in, MCP, or extra tools",
  );
  assert.deepEqual(
    selectActiveTools({
      disableTools: false,
      baseTools,
      mcpTools,
      extraTools,
    }),
    [...baseTools, ...mcpTools, ...extraTools],
    "ordinary steps must retain their configured tools",
  );

  assert.equal(
    verifierRepairAlreadyAttempted({
      latest_checkpoint: {
        summary: "Verifier repair 1/1 started: missing risk matrix.",
      },
    }),
    true,
  );
  assert.equal(
    verifierRepairAlreadyAttempted({
      latest_checkpoint: {
        summary:
          "Provider queue during verifier repair 1/1: request timed out.",
      },
    }),
    true,
    "a provider interruption must not reset the repair allowance",
  );
  assert.equal(
    verifierRepairAlreadyAttempted({
      latest_checkpoint: { summary: "Verifier completed with four PASS." },
    }),
    false,
  );
  assert.equal(verifierRepairAlreadyAttempted({}), false);

  console.log(
    JSON.stringify({ ok: true, suite: "verifier-guards-smoke-v1" }, null, 2),
  );
}

main();
