#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

const requiredCycle = ["Observe", "Plan", "Act", "Persist", "Gate", "Report"];
const requiredWorkflowNodes = [
  "extract_evidence",
  "map_risks",
  "draft_memo",
  "review",
  "gates",
  "audit",
  "eval",
];
const canonicalStatusFields = [
  "agent",
  "updatedAt",
  "status",
  "scope",
  "summary",
  "contractsChanged",
  "testsRun",
  "risks",
  "needs",
];
const canonicalStatusValues = new Set(["progress", "blocked", "conflict", "done"]);
const legacyStatusFields = [
  "last_cycle_summary",
  "files_changed",
  "tests_run",
  "blockers",
  "next_actions",
];

function readJson(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`${relativePath}: ${error.message}`);
  }
}

function assert(condition, message, errors) {
  if (!condition) {
    errors.push(message);
  }
}

function arrayEquals(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function validateStatusFile(relativePath, status, errors, warnings) {
  const missing = canonicalStatusFields.filter((field) => !(field in status));
  const hasLegacyShape = legacyStatusFields.some((field) => field in status);

  if (missing.length === 0) {
    assert(
      canonicalStatusValues.has(status.status),
      `${relativePath}: status must be one of ${Array.from(canonicalStatusValues).join(", ")}`,
      errors,
    );
    for (const field of ["scope", "contractsChanged", "testsRun", "risks", "needs"]) {
      assert(Array.isArray(status[field]), `${relativePath}: ${field} must be an array`, errors);
    }
    assert(
      typeof status.summary === "string" && status.summary.trim().length > 0,
      `${relativePath}: summary must be a non-empty string`,
      errors,
    );
    return;
  }

  if (hasLegacyShape) {
    warnings.push(
      `${relativePath}: legacy status shape accepted for compatibility; next owner update should add canonical fields: ${missing.join(", ")}`,
    );
    return;
  }

  errors.push(`${relativePath}: missing canonical fields ${missing.join(", ")}`);
}

function validateStatuses(errors, warnings) {
  const statusDir = path.join(repoRoot, ".agentops/status");
  const files = fs
    .readdirSync(statusDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  assert(files.includes("workflow-scheduler.json"), ".agentops/status/workflow-scheduler.json is required", errors);

  for (const file of files) {
    const relativePath = `.agentops/status/${file}`;
    validateStatusFile(relativePath, readJson(relativePath), errors, warnings);
  }
}

function validateWorkflow(workflow, registry, errors) {
  assert(workflow.schemaVersion === "agentops.workflow.v1", "workflow schemaVersion must be agentops.workflow.v1", errors);
  assert(workflow.workflowId === "red_flag_memo", "workflowId must be red_flag_memo", errors);
  assert(arrayEquals(workflow.productLoop, ["Evidence", "Issue/Risk", "Draft", "Review", "Gate", "Audit", "Eval"]), "workflow productLoop must match Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval", errors);
  assert(workflow.runtimePosture?.backgroundDaemon === false, "workflow must not start a background daemon", errors);
  assert(workflow.runtimePosture?.externalServices === "disallowed", "workflow must disallow external services", errors);

  const nodeIds = workflow.nodes?.map((node) => node.id) ?? [];
  assert(arrayEquals(nodeIds, requiredWorkflowNodes), `workflow nodes must be ordered as ${requiredWorkflowNodes.join(" -> ")}`, errors);

  const agentIds = new Set((registry.agents ?? []).map((agent) => agent.id));
  for (const node of workflow.nodes ?? []) {
    assert(agentIds.has(node.agentId), `workflow node ${node.id} references missing agent ${node.agentId}`, errors);
    assert(Array.isArray(node.outputs) && node.outputs.includes("agent_run"), `workflow node ${node.id} must output agent_run`, errors);
    assert(Array.isArray(node.gates) && node.gates.length > 0, `workflow node ${node.id} must declare gates`, errors);
    assert(typeof node.humanCheckpoint === "string" && node.humanCheckpoint.length > 0, `workflow node ${node.id} must declare humanCheckpoint`, errors);
  }

  const edgePairs = new Set((workflow.edges ?? []).map((edge) => `${edge.from}->${edge.to}`));
  for (let index = 0; index < requiredWorkflowNodes.length - 1; index += 1) {
    const pair = `${requiredWorkflowNodes[index]}->${requiredWorkflowNodes[index + 1]}`;
    assert(edgePairs.has(pair), `workflow edge ${pair} is required`, errors);
  }
}

function validateRegistry(registry, errors) {
  assert(registry.schemaVersion === "agentops.agent_registry.v1", "agent registry schemaVersion must be agentops.agent_registry.v1", errors);
  const agents = registry.agents ?? [];
  assert(agents.length >= 8, "agent registry must include scheduler plus workflow agents", errors);
  for (const agent of agents) {
    assert(typeof agent.id === "string" && agent.id.length > 0, "registry agent id must be non-empty", errors);
    assert(Array.isArray(agent.allowedTools), `registry agent ${agent.id} must declare allowedTools`, errors);
    assert(Array.isArray(agent.disallowedTools), `registry agent ${agent.id} must declare disallowedTools`, errors);
    assert(
      agent.disallowedTools.includes("external_network") ||
        agent.disallowedTools.includes("final_memo_export") ||
        agent.disallowedTools.includes("bypass_failed_gate") ||
        agent.disallowedTools.includes("auto_approve_skill"),
      `registry agent ${agent.id} must declare a meaningful high-risk disallowed tool`,
      errors,
    );
  }
}

function validateScheduler(scheduler, errors) {
  assert(scheduler.schemaVersion === "agentops.scheduler.v1", "scheduler schemaVersion must be agentops.scheduler.v1", errors);
  assert(scheduler.intervalSeconds === 300, "scheduler intervalSeconds must be 300", errors);
  assert(scheduler.mode === "manual_tick_simulation", "scheduler mode must be manual_tick_simulation", errors);
  assert(scheduler.startsBackgroundProcess === false, "scheduler must not start a background process", errors);
  assert(arrayEquals((scheduler.cycle ?? []).map((item) => item.phase), requiredCycle), `scheduler cycle must be ${requiredCycle.join(" -> ")}`, errors);
}

function validateRunManager(runManager, errors) {
  assert(runManager.schemaVersion === "agentops.run_manager.v1", "run manager schemaVersion must be agentops.run_manager.v1", errors);
  assert(runManager.p0DemoRun?.workflowId === "red_flag_memo", "run manager p0DemoRun.workflowId must be red_flag_memo", errors);
  assert(runManager.p0DemoRun?.expectedTerminalState === "waiting_for_approval", "P0 demo terminal state must be waiting_for_approval", errors);
  assert(runManager.budgetPolicy?.maxExternalToolCalls === 0, "run manager must keep maxExternalToolCalls at 0 for local deterministic simulation", errors);
  assert(
    runManager.persistenceSemanticsPolicy?.mode === "read_only_provenance_until_mapped_to_aletheia_records",
    "run manager persistenceSemanticsPolicy.mode must keep helper outputs read-only until mapped to Aletheia records",
    errors,
  );
  for (const helperContract of [
    "gate_provenance",
    "big_at_reference_audit_candidate",
    "typed_handoff_provenance",
    "eval_snapshot",
    "audit_export_package",
  ]) {
    assert(
      runManager.persistenceSemanticsPolicy?.viewLayerOnlyUntilPersisted?.includes(helperContract),
      `run manager persistenceSemanticsPolicy.viewLayerOnlyUntilPersisted must include ${helperContract}`,
      errors,
    );
  }
  for (const sourceRecordLink of [
    "matter_id",
    "evidence_id",
    "work_product_id",
    "review_comment_id",
    "approval_checkpoint_id",
    "audit_event_id",
    "agent_run_id",
  ]) {
    assert(
      runManager.persistenceSemanticsPolicy?.requiredSourceRecordLinks?.includes(sourceRecordLink),
      `run manager persistenceSemanticsPolicy.requiredSourceRecordLinks must include ${sourceRecordLink}`,
      errors,
    );
  }
}

function validateTrace(trace, workflow, registry, errors) {
  assert(trace.schemaVersion === "agentops.run_trace.v1", "run trace schemaVersion must be agentops.run_trace.v1", errors);
  assert(trace.workflowId === workflow.workflowId, "run trace workflowId must match workflow", errors);
  assert(trace.status === "waiting_for_approval", "demo run trace status must be waiting_for_approval", errors);
  assert(arrayEquals(trace.cycle, requiredCycle), `run trace cycle must be ${requiredCycle.join(" -> ")}`, errors);
  assert(arrayEquals(trace.workflowNodes, requiredWorkflowNodes), `run trace workflowNodes must be ${requiredWorkflowNodes.join(" -> ")}`, errors);

  const agentIds = new Set((registry.agents ?? []).map((agent) => agent.id));
  const stepNodeIds = new Set();
  for (const step of trace.steps ?? []) {
    assert(agentIds.has(step.agentId), `trace step ${step.id} references missing agent ${step.agentId}`, errors);
    assert(requiredCycle.includes(step.phase), `trace step ${step.id} has invalid phase ${step.phase}`, errors);
    assert(Array.isArray(step.inputArtifacts), `trace step ${step.id} must include inputArtifacts`, errors);
    assert(Array.isArray(step.outputArtifacts), `trace step ${step.id} must include outputArtifacts`, errors);
    assert(Array.isArray(step.gateRefs), `trace step ${step.id} must include gateRefs`, errors);
    if (requiredWorkflowNodes.includes(step.workflowNodeId)) {
      stepNodeIds.add(step.workflowNodeId);
    }
  }
  for (const nodeId of requiredWorkflowNodes) {
    assert(stepNodeIds.has(nodeId), `run trace must include a step for workflow node ${nodeId}`, errors);
  }

  const warningGates = trace.artifacts?.gateResults?.filter((gate) => gate.status === "warning" || gate.status === "failed") ?? [];
  for (const gate of warningGates) {
    assert(typeof gate.required_action === "string" && gate.required_action.length > 0, `gate ${gate.id} must include required_action`, errors);
  }
  assert((trace.artifacts?.auditEvents ?? []).every((event) => event.after_hash), "all audit events must include after_hash", errors);
  assert((trace.artifacts?.evalCases ?? []).length > 0, "run trace must include at least one eval case for the P0 handoff", errors);
}

const errors = [];
const warnings = [];

const workflow = readJson(".agentops/workflows/red_flag_memo.v1.json");
const registry = readJson(".agentops/orchestration/agent-registry.json");
const scheduler = readJson(".agentops/orchestration/scheduler.json");
const runManager = readJson(".agentops/orchestration/run-manager-contract.json");
const trace = readJson(".agentops/runs/red_flag_memo.demo.trace.json");

validateStatuses(errors, warnings);
validateRegistry(registry, errors);
validateWorkflow(workflow, registry, errors);
validateScheduler(scheduler, errors);
validateRunManager(runManager, errors);
validateTrace(trace, workflow, registry, errors);

for (const warning of warnings) {
  console.warn(`WARN ${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`ERROR ${error}`);
  }
  process.exit(1);
}

console.log("AgentOps orchestration contracts valid.");
