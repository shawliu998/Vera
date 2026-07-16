import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { ModelProfilePrivacyRepository } from "../lib/workspace/inferencePolicy";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceRuntime } from "../lib/workspace/runtime";
import type { AssistantModelPort } from "../lib/workspace/services/assistantRuntime";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { createVeraApplication } from "../veraApplication";

const NOW = "2026-07-15T12:00:00.000Z";
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const FOREIGN_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "vera-studio-entry-actions-audit-token-0123456789";
const ASSISTANT_CONTENT =
  "# Assistant answer\n\nThis content came from the completed durable message.";
const WORKFLOW_CONTENT =
  "# Workflow result\n\nThis content came from the completed durable run.";

class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(args: Parameters<WorkspaceBlobCodec["encode"]>[0]) {
    return Buffer.from(args.plaintext);
  }
  decode(args: Parameters<WorkspaceBlobCodec["decode"]>[0]) {
    return Buffer.from(args.envelope);
  }
}

function model(outputs: string[]): AssistantModelPort {
  return {
    async registeredCapabilities() {
      return {
        adapterId: "studio-entry-actions-audit",
        streaming: true,
        toolCalling: true,
        reasoning: false,
      };
    },
    async runTurn(input) {
      const content = outputs.shift();
      if (!content) throw new Error("Missing bounded audit model output.");
      await input.onTextDelta(content);
      return { content, toolCalls: [], sources: [] };
    },
  };
}

function seed(database: WorkspaceDatabase) {
  const profiles = new ModelProfilesRepository(database);
  const tests = new ModelConnectionTestsRepository(database);
  profiles.create({
    id: PROFILE_ID,
    name: "Studio entry audit model",
    provider: "openai",
    model: "audit-model",
    baseUrl: null,
    credentialOrigin: null,
    credentialState: "missing",
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
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
  const stored = profiles.requireStored(PROFILE_ID);
  assert.equal(
    tests.storeIfCurrent({
      profileId: PROFILE_ID,
      expectedConnectionRevision: stored.connectionRevision,
      status: "passed",
      errorCode: null,
      retryable: false,
      latencyMs: 1,
      testedAt: NOW,
    }).stored,
    true,
  );
  profiles.update(PROFILE_ID, { enabled: true, now: NOW });
  new ModelProfilePrivacyRepository(database).declare(
    PROFILE_ID,
    {
      executionLocation: "local",
      retention: "zero",
      trainingUse: "prohibited",
      sensitiveDataAllowed: true,
    },
    NOW,
  );
  const projects = new ProjectsRepository(database);
  for (const [id, name] of [
    [PROJECT_ID, "Entry action Project"],
    [FOREIGN_PROJECT_ID, "Foreign Project"],
  ] as const) {
    projects.create({
      id,
      name,
      description: null,
      cmNumber: null,
      practice: null,
      now: NOW,
    });
  }
}

async function listen(app: ReturnType<typeof createVeraApplication>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function waitFor(read: () => Promise<string> | string, expected: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await read()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Durable state did not reach ${expected}.`);
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-studio-entry-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const blobRoot = path.join(root, "blobs");
  let runtime: WorkspaceRuntime | null = null;
  let server: Awaited<ReturnType<typeof listen>> | null = null;
  try {
    const database = new WorkspaceDatabase(databasePath);
    seed(database);
    const outputs = [ASSISTANT_CONTENT, WORKFLOW_CONTENT];
    runtime = new WorkspaceRuntime({
      database,
      dataDir: path.join(root, "runtime"),
      blobs: new LocalWorkspaceBlobStore({
        root: blobRoot,
        codec: new IdentityCodec(),
        allowUnencryptedCodec: true,
      }),
      assistantModel: model(outputs),
    });
    await runtime.start();
    const app = createVeraApplication({
      runtime,
      env: {
        ...process.env,
        NODE_ENV: "test",
        ALETHEIA_AUTH_MODE: "private_token",
        ALETHEIA_PRIVATE_AUTH_TOKEN: TOKEN,
        TRUST_PROXY_HOPS: "0",
        FRONTEND_URL: "http://127.0.0.1:3000",
        RATE_LIMIT_GENERAL_MAX: "1000",
      },
      auditAnchorStatus: () => ({ enabled: false, healthy: true }),
      auditWriteBlocked: () => false,
    });
    server = await listen(app);
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const post = (pathname: string, body: unknown, authenticated = true) =>
      fetch(`${server!.baseUrl}/api/v1${pathname}`, {
        method: "POST",
        headers: authenticated
          ? headers
          : { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const chatCreate = await post("/chat/create", {
      project_id: PROJECT_ID,
      title: "Assistant source conversation",
      model_profile_id: PROFILE_ID,
    });
    assert.equal(chatCreate.status, 201);
    const chatId = String((await json(chatCreate)).id);
    const generation = await post(`/projects/${PROJECT_ID}/chat`, {
      chat_id: chatId,
      model_profile_id: PROFILE_ID,
      messages: [{ role: "user", content: "Prepare a Project memo." }],
    });
    assert.equal(generation.status, 202);
    const generationBody = await json(generation);
    const jobId = String(generationBody.job_id);
    const promptMessageId = String(generationBody.prompt_message_id);
    const outputMessageId = String(generationBody.output_message_id);
    await waitFor(async () => {
      const response = await fetch(
        `${server!.baseUrl}/api/v1/assistant/jobs/${jobId}`,
        { headers },
      );
      assert.equal(response.status, 200);
      return String((await json(response)).status);
    }, "complete");

    const before = Number(
      database.prepare("SELECT count(*) AS count FROM documents").get()?.count,
    );
    const unauthorized = await post(
      `/projects/${PROJECT_ID}/studio/drafts/from-assistant`,
      { chat_id: chatId, assistant_message_id: outputMessageId },
      false,
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(
      Number(
        database.prepare("SELECT count(*) AS count FROM documents").get()
          ?.count,
      ),
      before,
    );
    const clientContent = await post(
      `/projects/${PROJECT_ID}/studio/drafts/from-assistant`,
      {
        chat_id: chatId,
        assistant_message_id: outputMessageId,
        content: "client supplied replacement",
      },
    );
    assert.equal(clientContent.status, 422);
    const incomplete = await post(
      `/projects/${PROJECT_ID}/studio/drafts/from-assistant`,
      { chat_id: chatId, assistant_message_id: promptMessageId },
    );
    assert.equal(incomplete.status, 409);
    const wrongProject = await post(
      `/projects/${FOREIGN_PROJECT_ID}/studio/drafts/from-assistant`,
      { chat_id: chatId, assistant_message_id: outputMessageId },
    );
    assert.equal(wrongProject.status, 404);
    assert.equal(
      Number(
        database.prepare("SELECT count(*) AS count FROM documents").get()
          ?.count,
      ),
      before,
      "failed handoffs never create a partial draft",
    );

    const assistantHandoff = await post(
      `/projects/${PROJECT_ID}/studio/drafts/from-assistant`,
      { chat_id: chatId, assistant_message_id: outputMessageId },
    );
    assert.equal(assistantHandoff.status, 201);
    assert.match(
      assistantHandoff.headers.get("location") ?? "",
      /\/studio\/documents\//,
    );
    const assistantDraft = await json(assistantHandoff);
    assert.equal(assistantDraft.project_id, PROJECT_ID);
    assert.equal(assistantDraft.content, ASSISTANT_CONTENT);
    const assistantVersion = assistantDraft.version as Record<string, unknown>;
    assert.equal(assistantVersion.version_number, 1);
    assert.equal(assistantVersion.source, "assistant_edit");

    const workflow = runtime.workflows.create({
      type: "assistant",
      projectId: PROJECT_ID,
      title: "Durable workflow source",
      skillMarkdown: "Prepare the final Project result.",
      steps: [
        {
          kind: "prompt",
          title: "Prepare result",
          prompt: "Prepare the final Project result.",
        },
      ],
    });
    const prepared = runtime.workflows.prepareRun(workflow.id, {
      idempotencyKey: "studio-entry-actions-workflow",
      projectId: PROJECT_ID,
      modelProfileId: PROFILE_ID,
    });
    await waitFor(
      () => runtime!.workflows.getRun(prepared.detail.run.id).run.status,
      "complete",
    );
    const workflowHandoff = await post(
      `/projects/${PROJECT_ID}/studio/drafts/from-workflow`,
      { workflow_run_id: prepared.detail.run.id },
    );
    assert.equal(workflowHandoff.status, 201);
    const workflowDraft = await json(workflowHandoff);
    assert.equal(workflowDraft.content, WORKFLOW_CONTENT);
    const workflowVersion = workflowDraft.version as Record<string, unknown>;
    assert.equal(workflowVersion.version_number, 1);
    assert.equal(workflowVersion.source, "assistant_edit");
    assert.equal(
      Number(
        database.prepare("SELECT count(*) AS count FROM documents").get()
          ?.count,
      ),
      before + 2,
    );

    const assistantDocumentId = String(assistantDraft.document_id);
    const workflowDocumentId = String(workflowDraft.document_id);
    await server.close();
    server = null;
    await runtime.stop();
    runtime = null;

    const restartedDatabase = new WorkspaceDatabase(databasePath);
    runtime = new WorkspaceRuntime({
      database: restartedDatabase,
      dataDir: path.join(root, "runtime-restarted"),
      blobs: new LocalWorkspaceBlobStore({
        root: blobRoot,
        codec: new IdentityCodec(),
        allowUnencryptedCodec: true,
      }),
      assistantModel: model([]),
    });
    await runtime.start();
    const context = { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID };
    const recoveredAssistant = (await runtime.getStudioDocument(
      context,
      PROJECT_ID,
      assistantDocumentId,
    )) as Record<string, unknown>;
    const recoveredWorkflow = (await runtime.getStudioDocument(
      context,
      PROJECT_ID,
      workflowDocumentId,
    )) as Record<string, unknown>;
    assert.equal(recoveredAssistant.content, ASSISTANT_CONTENT);
    assert.equal(recoveredWorkflow.content, WORKFLOW_CONTENT);
    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-studio-entry-actions",
          checks: [
            "explicit authenticated Assistant and Workflow handoffs",
            "identity-only request bodies and server-owned content",
            "completed durable state and Project scope fail closed",
            "content-bearing immutable version 1 with assistant_edit provenance",
            "restart recovery through the existing v12 Studio service",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (server) await server.close().catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
