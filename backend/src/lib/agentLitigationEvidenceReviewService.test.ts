import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Evidence Inventory review loading reads only persisted task columns", async () => {
  const source = await readFile(
    new URL("./agentLitigationEvidenceReviewService.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\.from\("agent_tasks"\)\s*\.select\("id,user_id,matter_id,status,current_step,latest_checkpoint"\)/,
  );
  assert.doesNotMatch(
    source,
    /\.from\("agent_tasks"\)[\s\S]{0,180}\.select\([^)]*current_plan/,
  );
});

test("Evidence Inventory correction reads its fixed Step from agent_steps", async () => {
  const source = await readFile(
    new URL("./agentLitigationEvidenceReviewService.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\.from\("agent_steps"\)\s*\.select\("id,task_id,status,attempt,capability"\)\s*\.eq\("task_id", input\.taskId\)\s*\.eq\("id", input\.receipt\.step_id\)\s*\.maybeSingle\(\)/,
  );
  assert.match(source, /step\.data\.capability !== "create_tabular"/);
  assert.match(source, /step\.data\.attempt !== input\.receipt\.attempt/);
});
