import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import express from "express";

import {
  WORKSPACE_MIGRATIONS,
  WorkspaceDatabase,
} from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import { WorkflowDocumentContextRepository } from "../lib/workspace/repositories/workflowDocumentContext";
import { WorkflowsRepository } from "../lib/workspace/repositories/workflows";
import type { AssistantModelPort } from "../lib/workspace/services/assistantRuntime";
import { WorkspaceJobEnqueuerAdapter } from "../lib/workspace/services/jobEnqueuer";
import {
  WorkspaceJobAbortRegistry,
  WorkspaceJobRuntime,
  WorkspaceJobsService,
} from "../lib/workspace/services/jobs";
import { WorkspaceWorkflowStepExecutor } from "../lib/workspace/services/workflowExecutor";
import { WorkspaceWorkflowRuntime } from "../lib/workspace/services/workflowRuntime";
import { WorkflowsService } from "../lib/workspace/services/workflows";
import {
  MikeWorkflowCrudPortAdapter,
  VeraWorkflowDefinitionWireSchema,
  parseMikeWorkflowCreate,
  parseVeraWorkflowDefinitionUpdate,
  seedPinnedMikeSystemWorkflows,
} from "../lib/workspace/workflowCompatibility";
import {
  WorkspacePreparedWorkflowRunWireSchema,
  WorkspaceWorkflowRunDetailWireSchema,
  WorkspaceWorkflowRunWireSchema,
  createWorkspaceWorkflowRunsV1Router,
  createWorkspaceWorkflowsV1Router,
} from "../routes/workspaceWorkflowsV1";

const NOW = "2026-07-15T08:00:00.000Z";
const PROJECT = "11000000-0000-4000-8000-000000000001";
const MODEL = "22000000-0000-4000-8000-000000000001";

let tick = 0;
function clock() {
  return new Date(Date.parse(NOW) + tick++ * 1_000);
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function expectWorkspaceError(
  operation: () => unknown,
  status: number,
  pattern?: RegExp,
) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof WorkspaceApiError);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function seedProject(database: WorkspaceDatabase) {
  database
    .prepare(
      `INSERT INTO projects
        (id,name,status,created_at,updated_at)
       VALUES (?,'Workflow Project','active',?,?)`,
    )
    .run(PROJECT, NOW, NOW);
}

function seedProfile(database: WorkspaceDatabase) {
  const profiles = new ModelProfilesRepository(database);
  profiles.create({
    id: MODEL,
    name: "Workflow model",
    provider: "openai_compatible",
    model: "workflow-model",
    baseUrl: "https://workflow-model.example/v1",
    credentialOrigin: "https://workflow-model.example",
    credentialState: "missing",
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
    enabled: false,
    isDefault: false,
    capabilities: {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
    },
    now: NOW,
  });
  markProfilePassed(database);
  database
    .prepare(
      `UPDATE workspace_settings
          SET default_project_id=?,default_model_profile_id=?,updated_at=?
        WHERE id='workspace'`,
    )
    .run(PROJECT, MODEL, NOW);
  database
    .prepare(
      "UPDATE projects SET default_model_profile_id=?,updated_at=? WHERE id=?",
    )
    .run(MODEL, NOW, PROJECT);
}

function markProfilePassed(database: WorkspaceDatabase) {
  const profiles = new ModelProfilesRepository(database);
  const stored = profiles.requireStored(MODEL);
  const result = new ModelConnectionTestsRepository(database).storeIfCurrent({
    profileId: MODEL,
    expectedConnectionRevision: stored.connectionRevision,
    status: "passed",
    errorCode: null,
    retryable: false,
    latencyMs: 1,
    testedAt: NOW,
  });
  assert.equal(result.stored, true);
  profiles.update(MODEL, { enabled: true, now: NOW });
}

function seedDocument(database: WorkspaceDatabase) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const text =
    "Section 9 permits termination after a change of control on thirty days written notice. Internal note Bearer local-document-secret at /Users/alice/private-contract.pdf";
  database
    .prepare(
      `INSERT INTO documents
        (id,project_id,title,filename,mime_type,size_bytes,parse_status,created_at,updated_at)
       VALUES (?,?,'Change Control Agreement','agreement.txt','text/plain',?,'ready',?,?)`,
    )
    .run(documentId, PROJECT, Buffer.byteLength(text), NOW, NOW);
  database
    .prepare(
      `INSERT INTO document_versions
        (id,document_id,version_number,source,filename,mime_type,size_bytes,
         content_sha256,storage_key,created_at)
       VALUES (?,?,1,'upload','agreement.txt','text/plain',?,?,?,?)`,
    )
    .run(
      versionId,
      documentId,
      Buffer.byteLength(text),
      sha(text),
      `documents/${documentId}/versions/${versionId}/original`,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO document_chunks
        (id,document_id,version_id,ordinal,text,start_offset,end_offset,
         page_start,page_end,content_sha256,metadata_json,created_at)
       VALUES (?,?,?,0,?,0,?,1,1,?,'{}',?)`,
    )
    .run(
      randomUUID(),
      documentId,
      versionId,
      text,
      text.length,
      sha(text),
      NOW,
    );
  database
    .prepare(
      "UPDATE documents SET current_version_id=?,updated_at=? WHERE id=?",
    )
    .run(versionId, NOW, documentId);
  return { documentId, versionId, text };
}

class RetryableModelFailure extends Error {
  readonly code = "assistant_timeout";
  readonly retryable = true;
}

type ModelBehavior =
  | { type: "answer"; content: string }
  | { type: "fail" }
  | { type: "wait_for_abort" };

class AuditedModel implements AssistantModelPort {
  readonly calls: Array<Parameters<AssistantModelPort["runTurn"]>[0]> = [];
  readonly behaviors: ModelBehavior[] = [];
  private waitStartedResolve: (() => void) | null = null;
  waitStarted = new Promise<void>((resolve) => {
    this.waitStartedResolve = resolve;
  });

  resetWait() {
    this.waitStarted = new Promise<void>((resolve) => {
      this.waitStartedResolve = resolve;
    });
  }

  async registeredCapabilities() {
    return {
      adapterId: "audited-workspace-assistant-model",
      streaming: true,
      toolCalling: true,
      reasoning: false,
    };
  }

  async runTurn(
    input: Parameters<AssistantModelPort["runTurn"]>[0],
  ): Promise<Awaited<ReturnType<AssistantModelPort["runTurn"]>>> {
    this.calls.push(input);
    const behavior = this.behaviors.shift() ?? {
      type: "answer" as const,
      content: `Workflow answer ${this.calls.length}`,
    };
    if (behavior.type === "fail") throw new RetryableModelFailure();
    if (behavior.type === "wait_for_abort") {
      this.waitStartedResolve?.();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          const error = new Error("provider request aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (input.signal.aborted) abort();
        else input.signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (behavior.type !== "answer") throw new Error("unreachable model state");
    await input.onTextDelta(behavior.content);
    return { content: behavior.content, toolCalls: [], sources: [] };
  }
}

function createClaimedContext(
  repository: WorkspaceJobsRepository,
  jobId: string,
) {
  const at = clock();
  const claimed = repository.claimNextQueuedForTypes(
    at.toISOString(),
    ["workflow_run"],
    `workflow-execution-audit:${jobId}`,
    new Date(at.getTime() + 60_000).toISOString(),
  );
  assert.ok(claimed);
  assert.equal(claimed.id, jobId);
  assert.ok(claimed.leaseOwner);
  return {
    signal: new AbortController().signal,
    job: claimed,
    claim: { leaseOwner: claimed.leaseOwner, attempt: claimed.attempt },
  };
}

async function withServer(
  app: express.Express,
  operation: (base: string) => Promise<void>,
) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as AddressInfo;
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-workflow-execution-"));
  const database = new WorkspaceDatabase(path.join(root, "workspace.sqlite"), {
    migrations: WORKSPACE_MIGRATIONS,
  });
  try {
    seedProject(database);
    seedProfile(database);
    new ModelProfilePrivacyRepository(database).declare(
      MODEL,
      {
        executionLocation: "local",
        retention: "zero",
        trainingUse: "prohibited",
        sensitiveDataAllowed: true,
      },
      NOW,
    );
    const inferencePolicy = new WorkspaceInferencePolicy(database);
    const document = seedDocument(database);
    const abortRegistry = new WorkspaceJobAbortRegistry();
    const jobsRepository = new WorkspaceJobsRepository(database);
    const jobs = new WorkspaceJobsService(jobsRepository, {
      abortRegistry,
      now: clock,
    });
    const workflows = new WorkflowsService(
      new WorkflowsRepository(database),
      new WorkspaceJobEnqueuerAdapter(jobs),
      clock,
      undefined,
      { inferencePolicy },
    );
    const model = new AuditedModel();
    const executor = new WorkspaceWorkflowStepExecutor(
      model,
      new WorkflowDocumentContextRepository(database),
    );
    const runtime = new WorkspaceWorkflowRuntime(
      workflows,
      jobsRepository,
      executor,
      clock,
    );

    // A workflow with no Prompt step is genuinely non-inference-only: it does
    // not require a model/default/privacy declaration or a policy decision.
    const localOnly = workflows.create({
      type: "assistant",
      projectId: PROJECT,
      title: "Local document context only",
      skillMarkdown: "Retrieve the selected local document.",
      steps: [
        {
          kind: "document_context",
          title: "Retrieve termination language",
          maxDocuments: 4,
          maxChunksPerDocument: 4,
        },
      ],
    });
    database
      .prepare(
        "UPDATE workspace_settings SET default_model_profile_id = NULL WHERE id = 'workspace'",
      )
      .run();
    database
      .prepare("UPDATE projects SET default_model_profile_id = NULL WHERE id = ?")
      .run(PROJECT);
    database
      .prepare("UPDATE model_profiles SET enabled = 0 WHERE id = ?")
      .run(MODEL);
    const decisionsBeforeLocalOnly = Number(
      database
        .prepare("SELECT count(*) AS count FROM inference_policy_decisions")
        .get()?.count ?? 0,
    );
    const localOnlyRun = workflows.prepareRun(localOnly.id, {
      idempotencyKey: "local-document-context-only",
      projectId: PROJECT,
      inputBinding: { document_ids: [document.documentId] },
    });
    assert.equal(localOnlyRun.detail.run.modelProfileId, null);
    assert.equal(localOnlyRun.snapshot.modelProfileId, null);
    assert.equal(
      (localOnlyRun.snapshot.config as Record<string, unknown>).modelProfile,
      null,
    );
    await runtime.handle(
      createClaimedContext(jobsRepository, localOnlyRun.detail.run.jobId!),
    );
    assert.equal(workflows.getRun(localOnlyRun.detail.run.id).run.status, "complete");
    assert.equal(model.calls.length, 0);
    assert.equal(
      Number(
        database
          .prepare("SELECT count(*) AS count FROM inference_policy_decisions")
          .get()?.count ?? 0,
      ),
      decisionsBeforeLocalOnly,
    );
    database
      .prepare(
        "UPDATE workspace_settings SET default_model_profile_id = ? WHERE id = 'workspace'",
      )
      .run(MODEL);
    database
      .prepare("UPDATE projects SET default_model_profile_id = ? WHERE id = ?")
      .run(MODEL, PROJECT);
    database
      .prepare("UPDATE model_profiles SET enabled = 1 WHERE id = ?")
      .run(MODEL);

    const skillOnly = workflows.create(
      parseMikeWorkflowCreate({
        metadata: { title: "Skill only", type: "assistant" },
        skill_md: "Review change of control termination rights.",
      }),
    );
    const skillRun = workflows.prepareRun(skillOnly.id, {
      idempotencyKey: "skill-only",
      projectId: PROJECT,
      modelProfileId: MODEL,
      inputBinding: { additional_instructions: "Be concise." },
    });
    assert.equal(skillOnly.steps.length, 0);
    assert.equal(skillRun.snapshot.steps.length, 1);
    assert.equal(skillRun.detail.steps.length, 1);
    assert.equal(skillRun.snapshot.steps[0]?.kind, "prompt");
    model.behaviors.push({ type: "answer", content: "Skill-only answer" });
    await runtime.handle(
      createClaimedContext(jobsRepository, skillRun.detail.run.jobId!),
    );
    assert.equal(
      workflows.getRun(skillRun.detail.run.id).run.status,
      "complete",
    );
    assert.equal(
      (
        workflows.getRun(skillRun.detail.run.id).run.output as Record<
          string,
          unknown
        >
      ).content,
      "Skill-only answer",
    );
    assert.match(model.calls[0]!.systemPrompt, /Review change of control/);
    assert.match(model.calls[0]!.messages[0]!.content, /Be concise/);

    const sequential = workflows.create({
      type: "assistant",
      projectId: PROJECT,
      title: "Sequential review",
      skillMarkdown: "Use only evidence about termination rights.",
      steps: [
        {
          kind: "document_context",
          title: "Find termination language",
          maxDocuments: 4,
          maxChunksPerDocument: 4,
        },
        {
          kind: "prompt",
          title: "Initial analysis",
          prompt: "Summarize the termination right and notice period.",
        },
        {
          kind: "prompt",
          title: "Quality check",
          prompt: "Check the prior answer against the evidence.",
        },
      ],
    });
    expectWorkspaceError(
      () =>
        workflows.prepareRun(
          sequential.id,
          {
            idempotencyKey: "limit-steps",
            projectId: PROJECT,
            modelProfileId: MODEL,
          },
          { maxSteps: 2 },
        ),
      409,
      /limits/i,
    );
    expectWorkspaceError(
      () =>
        workflows.prepareRun(
          sequential.id,
          {
            idempotencyKey: "limit-calls",
            projectId: PROJECT,
            modelProfileId: MODEL,
          },
          { maxModelCalls: 1 },
        ),
      409,
      /limits/i,
    );
    expectWorkspaceError(
      () =>
        workflows.prepareRun(sequential.id, {
          idempotencyKey: "secret-input",
          projectId: PROJECT,
          modelProfileId: MODEL,
          inputBinding: { note: "Bearer local-secret-value" },
        }),
      400,
    );
    expectWorkspaceError(
      () =>
        workflows.prepareRun(sequential.id, {
          idempotencyKey: "path-input",
          projectId: PROJECT,
          modelProfileId: MODEL,
          inputBinding: { note: "/Users/alice/private-contract.pdf" },
        }),
      400,
    );
    assert.throws(() =>
      workflows.create({
        type: "assistant",
        title: "Unsafe dynamic step",
        skillMarkdown: "Do not run.",
        steps: [{ kind: "shell", command: "pwd" }],
      }),
    );

    const sequentialRun = workflows.prepareRun(sequential.id, {
      idempotencyKey: "sequential-run",
      projectId: PROJECT,
      modelProfileId: MODEL,
      inputBinding: {
        additional_instructions: "State the notice period.",
        document_ids: [document.documentId],
      },
    });
    model.behaviors.push(
      {
        type: "answer",
        content: "The clause permits termination on 30 days notice.",
      },
      { type: "answer", content: "Quality checked: 30 days written notice." },
    );
    await runtime.handle(
      createClaimedContext(jobsRepository, sequentialRun.detail.run.jobId!),
    );
    const sequentialDone = workflows.getRun(sequentialRun.detail.run.id);
    assert.equal(sequentialDone.run.status, "complete");
    assert.equal(sequentialDone.steps[0]?.status, "complete");
    assert.match(
      JSON.stringify(sequentialDone.steps[0]?.output),
      /thirty days written notice/,
    );
    assert.doesNotMatch(
      JSON.stringify(sequentialDone.steps[0]?.output),
      /local-document-secret|\/Users\/alice/,
    );
    const promptCalls = model.calls.slice(-2);
    assert.match(promptCalls[0]!.systemPrompt, /Use only evidence/);
    assert.match(
      promptCalls[0]!.messages[0]!.content,
      /thirty days written notice/,
    );
    assert.match(
      promptCalls[1]!.messages[0]!.content,
      /The clause permits termination on 30 days notice/,
    );
    assert.equal(
      (sequentialDone.run.output as Record<string, unknown>).content,
      "Quality checked: 30 days written notice.",
    );

    // A document_context result is durable and may outlive the source's
    // payload-retention window. Simulate a tombstone taking effect between
    // retrieval and the final prompt boundary: the persisted evidence remains
    // auditable, but the provider must receive zero calls.
    const retentionPreflightWorkflow = workflows.create({
      type: "assistant",
      projectId: PROJECT,
      title: "Retention preflight",
      skillMarkdown: "Use only current, policy-allowed evidence.",
      steps: [
        {
          kind: "document_context",
          title: "Persist evidence",
          queryTemplate: "termination written notice",
          maxDocuments: 1,
          maxChunksPerDocument: 1,
        },
        {
          kind: "prompt",
          title: "Do not call a provider after tombstone",
          prompt: "Analyze the persisted evidence.",
        },
      ],
    });
    const retentionPreflightRun = workflows.prepareRun(
      retentionPreflightWorkflow.id,
      {
        idempotencyKey: "retention-preflight",
        projectId: PROJECT,
        modelProfileId: MODEL,
        inputBinding: { document_ids: [document.documentId] },
      },
    );
    const retentionChecks: Array<{
      projectId: string;
      documentId: string;
      versionId: string;
    }> = [];
    const retentionExecutor = new WorkspaceWorkflowStepExecutor(
      model,
      new WorkflowDocumentContextRepository(database),
      {
        assertModelUse(input) {
          retentionChecks.push(input);
          throw new WorkspaceApiError(
            409,
            "PRECONDITION_FAILED",
            "Source payload access is unavailable because the source is tombstoned.",
          );
        },
      },
    );
    const retentionRuntime = new WorkspaceWorkflowRuntime(
      workflows,
      jobsRepository,
      retentionExecutor,
      clock,
    );
    const providerCallsBeforeRetentionPreflight = model.calls.length;
    await retentionRuntime.handle(
      createClaimedContext(
        jobsRepository,
        retentionPreflightRun.detail.run.jobId!,
      ),
    );
    const retentionPreflightDone = workflows.getRun(
      retentionPreflightRun.detail.run.id,
    );
    assert.equal(retentionPreflightDone.run.status, "failed");
    assert.equal(retentionPreflightDone.steps[0]?.status, "complete");
    assert.match(
      JSON.stringify(retentionPreflightDone.steps[0]?.output),
      /thirty days written notice/,
    );
    assert.equal(retentionPreflightDone.steps[1]?.status, "failed");
    assert.equal(
      retentionPreflightDone.steps[1]?.error?.code,
      "precondition_failed",
    );
    assert.deepEqual(retentionChecks, [
      {
        projectId: PROJECT,
        documentId: document.documentId,
        versionId: document.versionId,
      },
    ]);
    assert.equal(
      model.calls.length - providerCallsBeforeRetentionPreflight,
      0,
      "retention preflight denial must occur before model.runTurn",
    );

    const legacyDefinition = workflows.getAssistantDefinition(sequential.id);
    assert.equal(legacyDefinition.type, "assistant");
    const repairedIds = legacyDefinition.steps.map((step) => step.id);
    assert.equal(repairedIds.length, 3);
    assert.equal(new Set(repairedIds).size, 3);
    repairedIds.forEach((id) => assert.match(id ?? "", /^[0-9a-f-]{36}$/));
    const restartedWorkflows = new WorkflowsService(
      new WorkflowsRepository(database),
      new WorkspaceJobEnqueuerAdapter(jobs),
      clock,
      undefined,
      { inferencePolicy },
    );
    assert.deepEqual(
      restartedWorkflows
        .getAssistantDefinition(sequential.id)
        .steps.map((step) => step.id),
      repairedIds,
    );
    workflows.updateAssistantDefinition(sequential.id, {
      projectId: legacyDefinition.projectId,
      title: legacyDefinition.title,
      description: legacyDefinition.description,
      steps: legacyDefinition.steps,
    });
    assert.deepEqual(
      workflows.get(sequential.id).steps.map((step) => step.id),
      repairedIds,
    );

    const definitionWorkflow = workflows.create(
      parseMikeWorkflowCreate({
        metadata: { title: "Definition draft", type: "assistant" },
        skill_md: "Legacy Mike instructions",
      }),
    );
    const virtualDefinition = workflows.getAssistantDefinition(
      definitionWorkflow.id,
    );
    const virtualAgain = workflows.getAssistantDefinition(
      definitionWorkflow.id,
    );
    assert.equal(virtualDefinition.steps.length, 1);
    assert.equal(virtualDefinition.steps[0]?.id, virtualAgain.steps[0]?.id);

    const retrievalStepId = randomUUID();
    const promptStepId = randomUUID();
    const outputStepId = randomUUID();
    const definitionInput = parseVeraWorkflowDefinitionUpdate({
      name: "Client definition",
      description: "A bounded local document workflow.",
      project_id: PROJECT,
      steps: [
        {
          id: retrievalStepId,
          type: "document_retrieval",
          name: "Find change-control language",
          query_template: "change control termination notice",
          limit: 2,
        },
        {
          id: promptStepId,
          type: "prompt",
          name: "Analyze clause",
          prompt: "Return the termination notice period.",
          model_profile_id: MODEL,
          input_mapping: {},
        },
        {
          id: outputStepId,
          type: "output",
          name: "Final response",
          format: "text",
        },
      ],
    });
    const savedDefinition = workflows.updateAssistantDefinition(
      definitionWorkflow.id,
      definitionInput,
    );
    assert.equal(savedDefinition.type, "assistant");
    if (savedDefinition.type !== "assistant") throw new Error("unreachable");
    assert.equal(savedDefinition.skillMarkdown, "");
    assert.equal(savedDefinition.title, "Client definition");
    assert.deepEqual(
      savedDefinition.steps.map((step) => step.id),
      [retrievalStepId, promptStepId, outputStepId],
    );
    const definitionRun = workflows.prepareRun(definitionWorkflow.id, {
      idempotencyKey: "definition-text-output",
      projectId: PROJECT,
      modelProfileId: MODEL,
      inputBinding: { document_ids: [document.documentId] },
    });
    model.behaviors.push({
      type: "answer",
      content: "The notice period is thirty days.",
    });
    await runtime.handle(
      createClaimedContext(jobsRepository, definitionRun.detail.run.jobId!),
    );
    const definitionDone = workflows.getRun(definitionRun.detail.run.id);
    assert.equal(definitionDone.run.status, "complete");
    assert.equal(definitionDone.steps.length, 3);
    assert.deepEqual(
      definitionDone.steps.map((step) => step.step.id),
      [retrievalStepId, promptStepId, outputStepId],
    );
    assert.equal(
      (definitionDone.steps[0]?.output as Record<string, unknown>).query,
      "change control termination notice",
    );
    assert.ok(
      (
        (definitionDone.steps[0]?.output as Record<string, unknown>)
          .evidence as unknown[]
      ).length <= 2,
    );
    assert.deepEqual(definitionDone.run.output, {
      schema: "vera-workflow-run-result-v1",
      executedStepCount: 3,
      modelCallCount: 1,
      format: "text",
      content: "The notice period is thirty days.",
      sources: [],
    });

    const jsonWorkflow = workflows.create(
      parseMikeWorkflowCreate({
        metadata: { title: "JSON definition", type: "assistant" },
      }),
    );
    const jsonPromptStepId = randomUUID();
    const jsonOutputStepId = randomUUID();
    const jsonDefinition = parseVeraWorkflowDefinitionUpdate({
      name: "JSON definition",
      description: null,
      project_id: PROJECT,
      steps: [
        {
          id: jsonPromptStepId,
          type: "prompt",
          name: "Assess risk",
          prompt: "Return strict JSON with risk and count.",
        },
        {
          id: jsonOutputStepId,
          type: "output",
          name: "Structured result",
          format: "json",
        },
      ],
    });
    workflows.updateAssistantDefinition(jsonWorkflow.id, jsonDefinition);
    const jsonRun = workflows.prepareRun(jsonWorkflow.id, {
      idempotencyKey: "definition-json-output",
      projectId: PROJECT,
      modelProfileId: MODEL,
    });
    model.behaviors.push({
      type: "answer",
      content: '{"risk":"high","count":2}',
    });
    await runtime.handle(
      createClaimedContext(jobsRepository, jsonRun.detail.run.jobId!),
    );
    assert.deepEqual(
      (
        workflows.getRun(jsonRun.detail.run.id).run.output as Record<
          string,
          unknown
        >
      ).value,
      { risk: "high", count: 2 },
    );
    const invalidJsonRun = workflows.prepareRun(jsonWorkflow.id, {
      idempotencyKey: "definition-invalid-json",
      projectId: PROJECT,
      modelProfileId: MODEL,
    });
    model.behaviors.push({ type: "answer", content: "not valid json" });
    await runtime.handle(
      createClaimedContext(jobsRepository, invalidJsonRun.detail.run.jobId!),
    );
    const invalidJsonDone = workflows.getRun(invalidJsonRun.detail.run.id);
    assert.equal(invalidJsonDone.run.status, "failed");
    assert.equal(invalidJsonDone.steps[1]?.error?.code, "validation_error");
    assert.equal(invalidJsonDone.steps[1]?.error?.retryable, false);
    expectWorkspaceError(
      () => workflows.retryPreparedRun(invalidJsonDone.run.id, "json-retry"),
      409,
      /retryable/i,
    );

    assert.throws(() =>
      parseVeraWorkflowDefinitionUpdate({
        name: "Unknown field",
        description: null,
        project_id: PROJECT,
        steps: [],
        unexpected: true,
      }),
    );
    assert.throws(() =>
      parseVeraWorkflowDefinitionUpdate({
        name: "Duplicate ids",
        description: null,
        project_id: PROJECT,
        steps: [
          {
            id: promptStepId,
            type: "prompt",
            name: "One",
            prompt: "One",
          },
          {
            id: promptStepId,
            type: "prompt",
            name: "Two",
            prompt: "Two",
          },
        ],
      }),
    );
    assert.throws(() =>
      parseVeraWorkflowDefinitionUpdate({
        name: "Unsupported mapping",
        description: null,
        project_id: PROJECT,
        steps: [
          {
            id: promptStepId,
            type: "prompt",
            name: "Mapped prompt",
            prompt: "Do work",
            input_mapping: { fake: "binding" },
          },
        ],
      }),
    );
    assert.throws(() =>
      parseVeraWorkflowDefinitionUpdate({
        name: "Invalid output order",
        description: null,
        project_id: PROJECT,
        steps: [
          {
            id: outputStepId,
            type: "output",
            name: "Too soon",
            format: "text",
          },
          {
            id: promptStepId,
            type: "prompt",
            name: "Later prompt",
            prompt: "Too late",
          },
        ],
      }),
    );
    const mismatchedModelDefinition = parseVeraWorkflowDefinitionUpdate({
      name: "JSON definition",
      description: null,
      project_id: PROJECT,
      steps: [
        {
          id: jsonPromptStepId,
          type: "prompt",
          name: "Wrong model",
          prompt: "Return JSON.",
          model_profile_id: randomUUID(),
        },
        {
          id: jsonOutputStepId,
          type: "output",
          name: "Structured result",
          format: "json",
        },
      ],
    });
    workflows.updateAssistantDefinition(
      jsonWorkflow.id,
      mismatchedModelDefinition,
    );
    expectWorkspaceError(
      () =>
        workflows.prepareRun(jsonWorkflow.id, {
          idempotencyKey: "definition-model-mismatch",
          projectId: PROJECT,
          modelProfileId: MODEL,
        }),
      409,
      /must match/i,
    );
    workflows.updateAssistantDefinition(jsonWorkflow.id, jsonDefinition);

    const builtinAssistant = seedPinnedMikeSystemWorkflows(workflows).find(
      (workflow) => workflow.type === "assistant",
    );
    assert.ok(builtinAssistant);
    expectWorkspaceError(
      () => workflows.getAssistantDefinition(builtinAssistant.id),
      403,
      /immutable/i,
    );
    expectWorkspaceError(
      () =>
        workflows.updateAssistantDefinition(
          builtinAssistant.id,
          jsonDefinition,
        ),
      403,
      /immutable/i,
    );
    const tabularDefinitionTarget = workflows.create(
      parseMikeWorkflowCreate({
        metadata: { title: "Tabular definition target", type: "tabular" },
        columns_config: [],
      }),
    );
    expectWorkspaceError(
      () => workflows.getAssistantDefinition(tabularDefinitionTarget.id),
      409,
      /only Assistant/i,
    );

    database
      .prepare("DELETE FROM model_profile_connection_tests WHERE profile_id=?")
      .run(MODEL);
    expectWorkspaceError(
      () =>
        workflows.prepareRun(skillOnly.id, {
          idempotencyKey: "profile-gate",
          projectId: PROJECT,
          modelProfileId: MODEL,
        }),
      409,
      /passed connection test/i,
    );
    markProfilePassed(database);

    const immutableRun = workflows.prepareRun(skillOnly.id, {
      idempotencyKey: "immutable-workflow",
      projectId: PROJECT,
      modelProfileId: MODEL,
      inputBinding: {},
    });
    workflows.update(skillOnly.id, {
      skillMarkdown: "Edited instructions must not affect queued runs.",
    });
    model.behaviors.push({ type: "answer", content: "Immutable answer" });
    await runtime.handle(
      createClaimedContext(jobsRepository, immutableRun.detail.run.jobId!),
    );
    assert.match(model.calls.at(-1)!.systemPrompt, /Review change of control/);
    assert.doesNotMatch(
      model.calls.at(-1)!.systemPrompt,
      /Edited instructions/,
    );

    const profileSnapshotRun = workflows.prepareRun(skillOnly.id, {
      idempotencyKey: "immutable-model-profile",
      projectId: PROJECT,
      modelProfileId: MODEL,
      inputBinding: {},
    });
    const storedProfile = new ModelProfilesRepository(database).requireStored(
      MODEL,
    );
    database
      .prepare(
        "UPDATE model_profiles SET execution_revision=execution_revision+1 WHERE id=?",
      )
      .run(MODEL);
    await runtime.handle(
      createClaimedContext(
        jobsRepository,
        profileSnapshotRun.detail.run.jobId!,
      ),
    );
    assert.equal(
      workflows.getRun(profileSnapshotRun.detail.run.id).run.status,
      "failed",
    );
    database
      .prepare("UPDATE model_profiles SET execution_revision=? WHERE id=?")
      .run(storedProfile.executionRevision, MODEL);

    const failedRun = workflows.prepareRun(sequential.id, {
      idempotencyKey: "retry-parent",
      projectId: PROJECT,
      modelProfileId: MODEL,
      inputBinding: { document_ids: [document.documentId] },
    });
    model.behaviors.push(
      { type: "answer", content: "Persisted first-pass answer" },
      { type: "fail" },
    );
    await runtime.handle(
      createClaimedContext(jobsRepository, failedRun.detail.run.jobId!),
    );
    const failed = workflows.getRun(failedRun.detail.run.id);
    assert.equal(failed.run.status, "failed");
    assert.equal(failed.steps[2]?.error?.code, "assistant_timeout");
    assert.equal(failed.steps[2]?.error?.retryable, true);
    const retry = workflows.retryPreparedRun(failed.run.id, "retry-child");
    assert.equal(retry.detail.run.retryOfRunId, failed.run.id);
    assert.equal(
      retry.snapshot.snapshotSha256,
      failedRun.snapshot.snapshotSha256,
    );
    assert.deepEqual(
      retry.snapshot.steps.map((step) => step.id),
      failedRun.snapshot.steps.map((step) => step.id),
    );
    assert.equal(retry.detail.steps[0]?.status, "skipped");
    assert.equal(retry.detail.steps[1]?.status, "skipped");
    model.behaviors.push({ type: "answer", content: "Recovered final answer" });
    await runtime.handle(
      createClaimedContext(jobsRepository, retry.detail.run.jobId!),
    );
    assert.equal(workflows.getRun(retry.detail.run.id).run.status, "complete");
    assert.match(
      model.calls.at(-1)!.messages[0]!.content,
      /Persisted first-pass answer/,
    );

    const restartWorkflow = workflows.create({
      type: "assistant",
      projectId: PROJECT,
      title: "Restart recovery",
      skillMarkdown: "Resume safely.",
      steps: [
        { kind: "prompt", title: "Resume", prompt: "Complete this step." },
      ],
    });
    const restartRun = workflows.prepareRun(restartWorkflow.id, {
      idempotencyKey: "restart-run",
      projectId: PROJECT,
      modelProfileId: MODEL,
      inputBinding: {},
    });
    const preparedRestartStep = await executor.prepareStep({
      snapshot: restartRun.snapshot,
      step: restartRun.snapshot.steps[0]!,
      ordinal: 0,
      history: [],
    });
    assert.equal(preparedRestartStep.status, "ready");
    if (preparedRestartStep.status !== "ready") throw new Error("unreachable");
    workflows.startStep(restartRun.detail.run.id, 0, preparedRestartStep.input);
    const recoveredJobs = jobsRepository.recoverStaleRunningJobs(
      clock().toISOString(),
    );
    assert.ok(
      recoveredJobs.some((job) => job.id === restartRun.detail.run.jobId),
    );
    assert.equal(
      jobsRepository.getJob(restartRun.detail.run.jobId!)?.status,
      "queued",
    );
    model.behaviors.push({ type: "answer", content: "Restarted safely" });
    await runtime.handle(
      createClaimedContext(jobsRepository, restartRun.detail.run.jobId!),
    );
    assert.equal(
      workflows.getRun(restartRun.detail.run.id).run.status,
      "complete",
    );

    const cancelRun = workflows.prepareRun(restartWorkflow.id, {
      idempotencyKey: "cancel-running",
      projectId: PROJECT,
      modelProfileId: MODEL,
      inputBinding: {},
    });
    model.resetWait();
    model.behaviors.push({ type: "wait_for_abort" });
    const jobRuntime = new WorkspaceJobRuntime(
      jobsRepository,
      { workflow_run: (context) => runtime.handle(context) },
      {
        abortRegistry,
        recoveryMode: "fenced",
        allowedJobTypes: ["workflow_run"],
        manageProcessSignals: false,
        now: clock,
        leaseOwner: "workflow-cancel-audit",
        leaseDurationMs: 60_000,
      },
    );
    await jobRuntime.start();
    const running = jobRuntime.claimAndRun();
    await model.waitStarted;
    const cancelled = workflows.cancelRun(cancelRun.detail.run.id);
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(
      jobsRepository.getJob(cancelRun.detail.run.jobId!)?.status,
      "cancelled",
    );
    await running;
    await jobRuntime.stop();
    assert.equal(
      workflows.getRun(cancelRun.detail.run.id).run.status,
      "cancelled",
    );

    const adapter = new MikeWorkflowCrudPortAdapter(workflows, {
      executionAvailable: () => true,
    });
    const app = express();
    app.use(express.json({ limit: "256kb" }));
    app.use(
      "/unauthenticated/workflows",
      createWorkspaceWorkflowsV1Router(adapter),
    );
    app.use("/api/v1", (_request, response, next) => {
      response.locals.userId = WORKSPACE_LOCAL_PRINCIPAL_ID;
      next();
    });
    app.use("/api/v1/workflows", createWorkspaceWorkflowsV1Router(adapter));
    app.use("/api/v1", createWorkspaceWorkflowRunsV1Router(adapter));
    await withServer(app, async (base) => {
      const unauthenticated = await fetch(
        `${base}/unauthenticated/workflows/capabilities`,
      );
      assert.equal(unauthenticated.status, 401);
      const capability = await fetch(`${base}/api/v1/workflows/capabilities`);
      assert.equal(capability.status, 200);
      assert.deepEqual(await capability.json(), {
        execution_enabled: true,
        assistant_runs: true,
        tabular_runs: false,
      });
      const definitionResponse = await fetch(
        `${base}/api/v1/workflows/${definitionWorkflow.id}/definition`,
      );
      assert.equal(definitionResponse.status, 200);
      const definitionWire = VeraWorkflowDefinitionWireSchema.parse(
        await definitionResponse.json(),
      );
      assert.equal(definitionWire.name, "Client definition");
      assert.deepEqual(
        definitionWire.steps.map((step) => step.id),
        [retrievalStepId, promptStepId, outputStepId],
      );
      const invalidDefinition = await fetch(
        `${base}/api/v1/workflows/${definitionWorkflow.id}/definition`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Invalid definition",
            description: null,
            project_id: PROJECT,
            steps: [],
            unexpected: true,
          }),
        },
      );
      assert.equal(invalidDefinition.status, 422);
      const updatedDefinitionResponse = await fetch(
        `${base}/api/v1/workflows/${definitionWorkflow.id}/definition`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Client definition reordered",
            description: "Saved through the strict definition route.",
            project_id: PROJECT,
            steps: [definitionWire.steps[1], definitionWire.steps[2]],
          }),
        },
      );
      assert.equal(updatedDefinitionResponse.status, 200);
      const updatedDefinition = VeraWorkflowDefinitionWireSchema.parse(
        await updatedDefinitionResponse.json(),
      );
      assert.deepEqual(
        updatedDefinition.steps.map((step) => step.id),
        [promptStepId, outputStepId],
      );
      const unchangedMikeWire = await fetch(
        `${base}/api/v1/workflows/${definitionWorkflow.id}`,
      );
      assert.equal(unchangedMikeWire.status, 200);
      assert.equal(
        ((await unchangedMikeWire.json()) as { metadata: { title: string } })
          .metadata.title,
        "Client definition reordered",
      );
      const invalid = await fetch(
        `${base}/api/v1/workflows/${restartWorkflow.id}/runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotency_key: "route-invalid",
            unexpected: true,
          }),
        },
      );
      assert.equal(invalid.status, 422);
      const accepted = await fetch(
        `${base}/api/v1/workflows/${restartWorkflow.id}/runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotency_key: "route-run",
            project_id: PROJECT,
            model_profile_id: MODEL,
            input_binding: { additional_instructions: "Route execution" },
          }),
        },
      );
      assert.equal(accepted.status, 202);
      const prepared = WorkspacePreparedWorkflowRunWireSchema.parse(
        await accepted.json(),
      );
      assert.equal(prepared.reused, false);
      const listed = await fetch(
        `${base}/api/v1/workflows/${restartWorkflow.id}/runs?limit=10`,
      );
      assert.equal(listed.status, 200);
      const listBody = (await listed.json()) as {
        items: unknown[];
        next_cursor: string | null;
      };
      assert.ok(
        listBody.items
          .map((item) => WorkspaceWorkflowRunWireSchema.parse(item).id)
          .includes(prepared.run.id),
      );
      const detail = await fetch(
        `${base}/api/v1/workflow-runs/${prepared.run.id}`,
      );
      assert.equal(detail.status, 200);
      const routeRunDetail = WorkspaceWorkflowRunDetailWireSchema.parse(
        await detail.json(),
      );
      assert.match(routeRunDetail.steps[0]?.step.id ?? "", /^[0-9a-f-]{36}$/);
      const cancel = await fetch(
        `${base}/api/v1/workflow-runs/${prepared.run.id}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      assert.equal(cancel.status, 200);
      assert.equal(
        WorkspaceWorkflowRunDetailWireSchema.parse(await cancel.json()).run
          .status,
        "cancelled",
      );
    });

    const runtimeSource = readFileSync(
      path.resolve(process.cwd(), "src/lib/workspace/runtime.ts"),
      "utf8",
    );
    const applicationSource = readFileSync(
      path.resolve(process.cwd(), "src/veraApplication.ts"),
      "utf8",
    );
    assert.match(
      runtimeSource,
      /new WorkspaceWorkflowStepExecutor\([\s\S]*?assistantModel[\s\S]*?WorkflowDocumentContextRepository/,
    );
    assert.match(runtimeSource, /workflow_run:\s*\(context\)/);
    assert.match(runtimeSource, /this\.jobs\.repository/);
    assert.match(applicationSource, /createWorkspaceWorkflowRunsV1Router/);

    console.log("vera workspace workflow execution audit passed");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void run();
