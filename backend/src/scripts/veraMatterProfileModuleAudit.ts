import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import express, { type Request } from "express";

import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  WORKSPACE_MIGRATIONS,
  type WorkspaceDatabaseAdapter,
} from "../lib/workspace/migrations";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import { TabularRepository } from "../lib/workspace/repositories/tabular";
import { WorkflowsRepository } from "../lib/workspace/repositories/workflows";
import {
  WorkspaceJobAbortRegistry,
  WorkspaceJobRuntime,
  WorkspaceJobsService,
} from "../lib/workspace/services/jobs";
import { WorkspaceJobEnqueuerAdapter } from "../lib/workspace/services/jobEnqueuer";
import { CanonicalProjectInferenceScopeResolver } from "../lib/workspace/services/projectInferenceScope";
import { WorkflowsService } from "../lib/workspace/services/workflows";
import { WorkspaceInferencePolicy } from "../lib/workspace/inferencePolicy";
import {
  MatterPolicyWireSchema,
  MatterProfileWireSchema,
  MatterViewSchema,
  MatterViewPageWireSchema,
  MatterViewWireSchema,
  toMatterViewWire,
} from "../matter/profile/contracts";
import { createMatterProfileModule } from "../matter/profile";
import { MatterOverviewRepository } from "../matter/profile/overviewRepository";
import { MatterProfileRepository } from "../matter/profile/repository";
import { createMatterProfileV1Router } from "../matter/profile/router";
import {
  createProjectInferenceActivityPort,
  MatterProfileService,
} from "../matter/profile/service";

const NOW = "2026-07-16T10:00:00.000Z";
const SECRET = "sk-audit-secret-value";
const PRIVATE_PATH = "/private/Users/audit/matter.db";
const localContext = { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID };

function expectApiError(
  operation: () => unknown,
  status: number,
  code?: string,
): WorkspaceApiError {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof WorkspaceApiError);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected WorkspaceApiError ${status}.`);
}

function assertRedacted(value: unknown) {
  const encoded = JSON.stringify(value);
  assert.equal(encoded.includes(SECRET), false);
  assert.equal(encoded.includes(PRIVATE_PATH), false);
}

function createProject(
  projects: ProjectsRepository,
  input: {
    id?: string;
    name: string;
    description?: string | null;
    cmNumber?: string | null;
    practice?: string | null;
    now?: string;
  },
) {
  const id = input.id ?? randomUUID();
  projects.create({
    id,
    name: input.name,
    description: input.description ?? null,
    cmNumber: input.cmNumber ?? null,
    practice: input.practice ?? null,
    now: input.now ?? NOW,
  });
  return id;
}

function seedOverviewCounts(database: WorkspaceDatabase, projectId: string) {
  database
    .prepare(
      `INSERT INTO documents (
         id, project_id, title, filename, mime_type, size_bytes
       ) VALUES (?, ?, 'Counted document', 'counted.txt', 'text/plain', 1)`,
    )
    .run(randomUUID(), projectId);
  database
    .prepare(
      `INSERT INTO chats (id, project_id, scope, title)
       VALUES (?, ?, 'project', 'Counted chat')`,
    )
    .run(randomUUID(), projectId);
  database
    .prepare(
      `INSERT INTO tabular_reviews (id, project_id, title)
       VALUES (?, ?, 'Counted review')`,
    )
    .run(randomUUID(), projectId);
  database
    .prepare(
      `INSERT INTO workflows (id, project_id, type, title)
       VALUES (?, ?, 'assistant', 'Counted workflow')`,
    )
    .run(randomUUID(), projectId);
}

type ModelJobType = "assistant_generate" | "workflow_run" | "tabular_cell";
type JobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

function insertScopedJob(
  database: WorkspaceDatabase,
  input: {
    projectId: string;
    type: ModelJobType | "document_parse";
    status: JobStatus;
  },
) {
  const jobId = randomUUID();
  let resourceType: "document" | "chat" | "workflow_run" | "tabular_cell";
  let resourceId: string;

  if (input.type === "assistant_generate") {
    resourceType = "chat";
    resourceId = randomUUID();
    database
      .prepare(
        `INSERT INTO chats (id, project_id, scope, title, created_at, updated_at)
         VALUES (?, ?, 'project', 'Matter conversion job audit', ?, ?)`,
      )
      .run(resourceId, input.projectId, NOW, NOW);
  } else if (input.type === "workflow_run") {
    const workflowId = randomUUID();
    resourceType = "workflow_run";
    resourceId = randomUUID();
    database
      .prepare(
        `INSERT INTO workflows (id, project_id, type, title, created_at, updated_at)
         VALUES (?, ?, 'assistant', 'Matter conversion job audit', ?, ?)`,
      )
      .run(workflowId, input.projectId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO workflow_runs (
           id, workflow_id, project_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(resourceId, workflowId, input.projectId, NOW, NOW);
  } else {
    const documentId = randomUUID();
    database
      .prepare(
        `INSERT INTO documents (
           id, project_id, title, filename, mime_type, size_bytes,
           created_at, updated_at
         ) VALUES (?, ?, 'Matter conversion job audit', 'audit.txt',
                   'text/plain', 1, ?, ?)`,
      )
      .run(documentId, input.projectId, NOW, NOW);
    if (input.type === "document_parse") {
      resourceType = "document";
      resourceId = documentId;
    } else {
      const reviewId = randomUUID();
      const columnId = randomUUID();
      resourceType = "tabular_cell";
      resourceId = randomUUID();
      database
        .prepare(
          `INSERT INTO tabular_reviews (
             id, project_id, title, created_at, updated_at
           ) VALUES (?, ?, 'Matter conversion job audit', ?, ?)`,
        )
        .run(reviewId, input.projectId, NOW, NOW);
      database
        .prepare(
          `INSERT INTO tabular_review_columns (
             id, review_id, key, title, output_type, ordinal,
             created_at, updated_at
           ) VALUES (?, ?, 'audit', 'Audit', 'text', 0, ?, ?)`,
        )
        .run(columnId, reviewId, NOW, NOW);
      database
        .prepare(
          `INSERT INTO tabular_review_documents (
             review_id, document_id, ordinal, created_at
           ) VALUES (?, ?, 0, ?)`,
        )
        .run(reviewId, documentId, NOW);
      database
        .prepare(
          `INSERT INTO tabular_cells (
             id, review_id, document_id, column_id, output_type,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'text', ?, ?)`,
        )
        .run(resourceId, reviewId, documentId, columnId, NOW, NOW);
    }
  }

  database
    .prepare(
      `INSERT INTO jobs (
         id, type, status, resource_type, resource_id, attempt, max_attempts,
         retryable, payload_json, scheduled_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 3, 1, '{}', ?, ?, ?)`,
    )
    .run(
      jobId,
      input.type,
      input.status,
      resourceType,
      resourceId,
      input.status === "running" ? 1 : 0,
      NOW,
      NOW,
      NOW,
    );
  return jobId;
}

function seedResolverModelProfile(database: WorkspaceDatabase) {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO model_profiles (
         id, name, provider, model, credential_status, credential_state,
         capabilities_json, settings_json, enabled, is_default,
         connection_revision, created_at, updated_at
       ) VALUES (?, ?, 'openai', 'resolver-audit', 'not_configured', 'missing',
                 ?, '{}', 1, 0, 0, ?, ?)`,
    )
    .run(
      id,
      `Resolver ${id}`,
      JSON.stringify({
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
      }),
      NOW,
      NOW,
    );
  return id;
}

function seedCapabilityModel(
  database: WorkspaceDatabase,
  executionLocation: "local" | "confidential_remote" = "local",
) {
  const id = seedResolverModelProfile(database);
  database
    .prepare(
      `INSERT INTO model_profile_connection_tests (
         profile_id, connection_revision, status, error_code, retryable,
         latency_ms, tested_at
       ) VALUES (?, 0, 'passed', NULL, 0, 1, ?)`,
    )
    .run(id, NOW);
  database
    .prepare(
      `INSERT INTO model_profile_privacy (
         model_profile_id, execution_location, retention, training_use,
         sensitive_data_allowed, created_at, updated_at
       ) VALUES (?, ?, 'zero', 'prohibited', 1, ?, ?)`,
    )
    .run(id, executionLocation, NOW, NOW);
  return id;
}

function insertDurableRunningJob(
  database: WorkspaceDatabase,
  input: {
    id: string;
    type: ModelJobType;
    resourceType: "chat" | "workflow_run" | "tabular_cell";
    resourceId: string;
    payload: unknown;
  },
) {
  database
    .prepare(
      `INSERT INTO jobs (
         id, type, status, resource_type, resource_id, attempt, max_attempts,
         retryable, payload_json, scheduled_at, queued_at, locked_at,
         started_at, lease_owner, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, 'running', ?, ?, 1, 3, 1, ?, ?, ?, ?, ?,
                 'resolver-audit-owner', '2028-01-01T00:00:00.000Z', ?, ?)`,
    )
    .run(
      input.id,
      input.type,
      input.resourceType,
      input.resourceId,
      JSON.stringify(input.payload),
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
    );
}

type HttpResult = {
  status: number;
  body: unknown;
};

async function requestJson(
  origin: string,
  pathname: string,
  input: {
    method?: string;
    body?: unknown;
    principal?: string | null;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (input.body !== undefined) headers["content-type"] = "application/json";
  if (input.principal !== null) {
    headers["x-audit-principal"] =
      input.principal ?? WORKSPACE_LOCAL_PRINCIPAL_ID;
  }
  const response = await fetch(`${origin}${pathname}`, {
    method: input.method ?? "GET",
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as unknown,
  };
}

async function closeServer(server: Server | null) {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function assertProfileWireKeys(value: unknown) {
  const profile = MatterProfileWireSchema.parse(value);
  assert.deepEqual(Object.keys(profile).sort(), [
    "client_name",
    "created_at",
    "jurisdiction",
    "objective",
    "project_id",
    "represented_role",
    "updated_at",
    "workspace_type",
  ]);
  for (const forbidden of [
    "matter_type",
    "counterparty",
    "court",
    "case_number",
    "stage",
    "risk_level",
    "opened_at",
    "closed_at",
  ]) {
    assert.equal(forbidden in profile, false);
  }
}

async function main() {
  const originalEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;
  const root = mkdtempSync(
    path.join(os.tmpdir(), "vera-matter-profile-module-audit-"),
  );
  const databasePath = path.join(root, "workspace.db");
  const v15OnlyPath = path.join(root, "v15-only.db");
  let database: WorkspaceDatabase | null = null;
  let server: Server | null = null;

  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

    // A v15-only database is not ready for the v16 public contract.
    const v15Only = new WorkspaceDatabase(v15OnlyPath, {
      migrations: WORKSPACE_MIGRATIONS.slice(0, 15),
    });
    assert.equal(v15Only.migration?.currentVersion, 15);
    const v15Readiness = expectApiError(
      () => new MatterProfileRepository(v15Only).readiness(),
      500,
      "INTERNAL_ERROR",
    );
    assertRedacted(v15Readiness.toResponse());
    v15Only.close();

    // Seed a genuine pre-v16 profile. The v16 migration must preserve it with
    // workspace_type NULL and expose classification_required without guessing.
    const v15 = new WorkspaceDatabase(databasePath, {
      migrations: WORKSPACE_MIGRATIONS.slice(0, 15),
    });
    const v15Projects = new ProjectsRepository(v15);
    const legacyProjectId = createProject(v15Projects, {
      name: "Legacy classified-by-v15-only Project",
      cmNumber: "LEGACY-001",
      practice: "Disputes",
    });
    v15
      .prepare(
        `INSERT INTO matter_profiles (
         project_id, matter_type, client_name, represented_role,
         counterparty, court, case_number, stage, objective, risk_level,
         opened_at, closed_at, created_at, updated_at
       ) VALUES (?, 'civil_litigation', 'Legacy Client', 'Counsel',
                 'Hidden Counterparty', 'Hidden Court', 'Hidden Case',
                 'Hidden Stage', 'Legacy objective', 'high', NULL, NULL, ?, ?)`,
      )
      .run(legacyProjectId, NOW, NOW);
    v15.close();

    database = new WorkspaceDatabase(databasePath);
    assert.equal(database.migration?.currentVersion, 17);
    const projects = new ProjectsRepository(database);
    const repository = new MatterProfileRepository(database);
    const overview = new MatterOverviewRepository(database);
    const abortRegistry = new WorkspaceJobAbortRegistry();
    const inferenceActivity = createProjectInferenceActivityPort(projects, () =>
      abortRegistry.activeInferenceScopes(),
    );
    const service = new MatterProfileService(
      database,
      projects,
      repository,
      overview,
      inferenceActivity,
      { clock: () => new Date(NOW) },
    );
    const facade = createMatterProfileModule(database, projects, {
      activeInferenceScopes: () => abortRegistry.activeInferenceScopes(),
      clock: () => new Date(NOW),
      acceptingRequests: () => true,
    });
    assert.deepEqual(Object.keys(facade).sort(), [
      "api",
      "createRouter",
      "health",
    ]);
    assert.deepEqual(facade.health(), {
      status: "ready",
      schemaVersion: 17,
      inferencePolicy: "minimal_unified",
    });
    assert.equal("policyMode" in facade.health(), false);

    const legacy = service.getMatter(localContext, legacyProjectId);
    assert.equal(legacy.profile?.workspaceType, null);
    assert.equal(legacy.profileState, "classification_required");
    assert.deepEqual(legacy.capabilities, {
      matterProfile: "classify",
      assistant: "policy_gate_closed",
      workflows: "non_inference_only",
      tabular: "policy_gate_closed",
      review: "unavailable",
      drafts: "document_scoped",
    });
    const legacyWire = toMatterViewWire(legacy);
    assertProfileWireKeys(legacyWire.matter_profile);
    assert.equal(legacyWire.matter_profile?.workspace_type, null);
    const legacyEncoded = JSON.stringify(legacyWire);
    for (const hiddenValue of [
      "Hidden Counterparty",
      "Hidden Court",
      "Hidden Case",
      "Hidden Stage",
    ]) {
      assert.equal(legacyEncoded.includes(hiddenValue), false);
    }
    expectApiError(
      () =>
        service.updateProjectMatterProfile(localContext, legacyProjectId, {
          objective: "Classification cannot be bypassed",
        }),
      400,
      "VALIDATION_ERROR",
    );
    assert.equal(
      repository.require(legacyProjectId).objective,
      "Legacy objective",
    );

    // Generic Projects, including historical empty nullable text, remain
    // explicit absent profiles and retain Workspace-compatible inference.
    const emptyGenericId = createProject(projects, {
      name: "Historical generic Project",
      description: "",
      cmNumber: "",
      practice: "",
      now: "2027-01-01T00:00:00.000+08:00",
    });
    const emptyGeneric = service.getMatter(localContext, emptyGenericId);
    assert.equal(emptyGeneric.profile, null);
    assert.equal(emptyGeneric.profileState, "absent");
    assert.equal(emptyGeneric.project.description, "");
    assert.equal(emptyGeneric.project.cmNumber, "");
    assert.equal(emptyGeneric.project.practice, "");
    assert.deepEqual(emptyGeneric.capabilities, {
      matterProfile: "create",
      assistant: "unavailable",
      workflows: "non_inference_only",
      tabular: "unavailable",
      review: "unavailable",
      drafts: "document_scoped",
    });

    // Generic -> Matter conversion is serialized with inference enqueue/claim.
    // Each model-producing job type and each active durable state blocks, does
    // not create a profile, and is neither cancelled nor mutated.
    for (const type of [
      "assistant_generate",
      "workflow_run",
      "tabular_cell",
    ] as const) {
      for (const status of ["queued", "running"] as const) {
        const projectId = createProject(projects, {
          name: `${type} ${status} conversion gate`,
        });
        const jobId = insertScopedJob(database, { projectId, type, status });
        if (type === "assistant_generate" && status === "running") {
          database
            .prepare(
              "UPDATE jobs SET cancel_requested_at = ?, cancellation_reason = ? WHERE id = ?",
            )
            .run(NOW, "Audit cancellation already requested", jobId);
        }
        const blocked = expectApiError(
          () =>
            service.createProjectMatterProfile(localContext, projectId, {
              workspaceType: "general_legal",
            }),
          409,
          "CONFLICT",
        );
        assert.equal(
          blocked.message,
          "Matter conversion is unavailable while inference work is active.",
        );
        assert.equal(repository.get(projectId), null);
        const persisted = database
          .prepare("SELECT status, cancel_requested_at FROM jobs WHERE id = ?")
          .get(jobId);
        assert.equal(persisted?.status, status);
        assert.equal(
          persisted?.cancel_requested_at,
          type === "assistant_generate" && status === "running" ? NOW : null,
        );
      }
    }

    // A registered non-model parse handler is outside this conversion gate.
    const parseProjectId = createProject(projects, {
      name: "Registered document parse remains compatible",
    });
    const parseJobId = insertScopedJob(database, {
      projectId: parseProjectId,
      type: "document_parse",
      status: "running",
    });
    const parseController = new AbortController();
    abortRegistry.register(parseJobId, parseController);
    const parsedConversion = service.createProjectMatterProfile(
      localContext,
      parseProjectId,
      { workspaceType: "research" },
    );
    assert.equal(parsedConversion.profileState, "ready");
    assert.equal(parseController.signal.aborted, false);
    assert.equal(
      database.prepare("SELECT status FROM jobs WHERE id = ?").get(parseJobId)
        ?.status,
      "running",
    );
    abortRegistry.unregister(parseJobId, parseController);

    // Terminal persisted model work is normally history and does not block.
    for (const type of [
      "assistant_generate",
      "workflow_run",
      "tabular_cell",
    ] as const) {
      const projectId = createProject(projects, {
        name: `${type} terminal conversion compatibility`,
      });
      insertScopedJob(database, { projectId, type, status: "complete" });
      assert.equal(
        service.createProjectMatterProfile(localContext, projectId, {
          workspaceType: "research",
        }).profileState,
        "ready",
      );
    }

    // Workflow and Tabular cancellation can persist a terminal state before a
    // delayed provider fully unwinds. Registration keeps conversion closed
    // until the handler's finally block unregisters, without aborting it here.
    for (const type of ["workflow_run", "tabular_cell"] as const) {
      const projectId = createProject(projects, {
        name: `${type} terminal but still executing`,
      });
      const jobId = insertScopedJob(database, {
        projectId,
        type,
        status: "cancelled",
      });
      const controller = new AbortController();
      abortRegistry.register(jobId, controller, {
        jobId,
        type,
        scope: "project",
        projectId,
      });
      expectApiError(
        () =>
          service.createProjectMatterProfile(localContext, projectId, {
            workspaceType: "general_legal",
          }),
        409,
        "CONFLICT",
      );
      assert.equal(repository.get(projectId), null);
      assert.equal(controller.signal.aborted, false);
      assert.equal(
        database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId)
          ?.status,
        "cancelled",
      );
      abortRegistry.unregister(jobId, controller);
      assert.equal(
        service.createProjectMatterProfile(localContext, projectId, {
          workspaceType: "general_legal",
        }).profileState,
        "ready",
      );
    }

    // A fenced lease retry can overlap the provider call from its predecessor.
    // Registry identity is therefore controller-instance, not only job id.
    const overlappingProjectId = createProject(projects, {
      name: "Overlapping fenced inference attempts",
    });
    const overlappingJobId = insertScopedJob(database, {
      projectId: overlappingProjectId,
      type: "assistant_generate",
      status: "cancelled",
    });
    const oldAttempt = new AbortController();
    const newAttempt = new AbortController();
    const oldScope = {
      jobId: overlappingJobId,
      type: "assistant_generate" as const,
      scope: "project" as const,
      projectId: overlappingProjectId,
    };
    const newScope = {
      jobId: overlappingJobId,
      type: "assistant_generate" as const,
      scope: "unresolved" as const,
      projectId: null,
    };
    abortRegistry.register(overlappingJobId, oldAttempt, oldScope);
    abortRegistry.register(overlappingJobId, newAttempt, newScope);
    assert.deepEqual(
      abortRegistry
        .activeInferenceScopes()
        .filter((scope) => scope.jobId === overlappingJobId),
      [oldScope, newScope],
    );

    // New finishes first: the old provider still owns its Project scope.
    abortRegistry.unregister(overlappingJobId, newAttempt);
    expectApiError(
      () =>
        service.createProjectMatterProfile(localContext, overlappingProjectId, {
          workspaceType: "general_legal",
        }),
      409,
      "CONFLICT",
    );
    assert.deepEqual(
      abortRegistry
        .activeInferenceScopes()
        .filter((scope) => scope.jobId === overlappingJobId),
      [oldScope],
    );

    // Old finishes first on another overlap: the new unresolved attempt still
    // fails closed until its own controller-identity finally runs.
    abortRegistry.register(overlappingJobId, newAttempt, newScope);
    abortRegistry.unregister(overlappingJobId, oldAttempt);
    expectApiError(
      () =>
        service.createProjectMatterProfile(localContext, overlappingProjectId, {
          workspaceType: "general_legal",
        }),
      409,
      "CONFLICT",
    );
    assert.deepEqual(
      abortRegistry
        .activeInferenceScopes()
        .filter((scope) => scope.jobId === overlappingJobId),
      [newScope],
    );

    // Cancellation fans out to every live attempt. An aborted controller stays
    // registered (and blocks conversion) until that handler actually unwinds.
    abortRegistry.register(overlappingJobId, oldAttempt, oldScope);
    assert.equal(abortRegistry.abort(overlappingJobId), true);
    assert.equal(oldAttempt.signal.aborted, true);
    assert.equal(newAttempt.signal.aborted, true);
    abortRegistry.abortAll();
    assert.deepEqual(
      abortRegistry
        .activeInferenceScopes()
        .filter((scope) => scope.jobId === overlappingJobId),
      [newScope, oldScope],
    );
    abortRegistry.unregister(overlappingJobId, newAttempt);
    expectApiError(
      () =>
        service.createProjectMatterProfile(localContext, overlappingProjectId, {
          workspaceType: "general_legal",
        }),
      409,
      "CONFLICT",
    );
    abortRegistry.unregister(overlappingJobId, oldAttempt);
    assert.equal(abortRegistry.abort(overlappingJobId), false);
    assert.equal(
      service.createProjectMatterProfile(localContext, overlappingProjectId, {
        workspaceType: "general_legal",
      }).profileState,
      "ready",
    );

    // Frozen scope survives deletion of the live owner graph. This models the
    // exact cancel -> durable terminal -> owner delete -> delayed provider
    // unwind window for all three model-producing handlers.
    for (const type of [
      "assistant_generate",
      "workflow_run",
      "tabular_cell",
    ] as const) {
      const projectId = createProject(projects, {
        name: `${type} deleted owner while handler is active`,
      });
      const jobId = insertScopedJob(database, {
        projectId,
        type,
        status: "running",
      });
      const resource = database
        .prepare("SELECT resource_id FROM jobs WHERE id = ?")
        .get(jobId);
      assert.equal(typeof resource?.resource_id, "string");
      const resourceId = String(resource?.resource_id);
      const controller = new AbortController();
      abortRegistry.register(jobId, controller, {
        jobId,
        type,
        scope: "project",
        projectId,
      });
      database
        .prepare(
          `UPDATE jobs
              SET status = 'cancelled', cancel_requested_at = ?,
                  cancellation_reason = ?, completed_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(NOW, "Audit cancellation", NOW, NOW, jobId);
      if (type === "assistant_generate") {
        database.prepare("DELETE FROM chats WHERE id = ?").run(resourceId);
      } else if (type === "workflow_run") {
        const run = database
          .prepare("SELECT workflow_id FROM workflow_runs WHERE id = ?")
          .get(resourceId);
        assert.equal(typeof run?.workflow_id, "string");
        database
          .prepare("DELETE FROM workflow_runs WHERE id = ?")
          .run(resourceId);
        database
          .prepare("DELETE FROM workflows WHERE id = ?")
          .run(String(run?.workflow_id));
      } else {
        const cell = database
          .prepare(
            "SELECT review_id, document_id FROM tabular_cells WHERE id = ?",
          )
          .get(resourceId);
        assert.equal(typeof cell?.review_id, "string");
        database
          .prepare("DELETE FROM tabular_cells WHERE id = ?")
          .run(resourceId);
        database
          .prepare("DELETE FROM tabular_reviews WHERE id = ?")
          .run(String(cell?.review_id));
        database
          .prepare("DELETE FROM documents WHERE id = ?")
          .run(String(cell?.document_id));
      }
      assert.equal(projects.hasBlockingInferenceJobs(projectId, []), false);
      expectApiError(
        () =>
          service.createProjectMatterProfile(localContext, projectId, {
            workspaceType: "general_legal",
          }),
        409,
        "CONFLICT",
      );
      assert.equal(repository.get(projectId), null);
      assert.equal(controller.signal.aborted, false);
      abortRegistry.unregister(jobId, controller);
      assert.equal(
        service.createProjectMatterProfile(localContext, projectId, {
          workspaceType: "general_legal",
        }).profileState,
        "ready",
      );
    }

    // Producer-side provenance coverage: resolve all three scopes from their
    // real durable execution contracts, never from arbitrary payload alone.
    const resolverModelId = seedResolverModelProfile(database);
    const resolverJobs = new WorkspaceJobsRepository(database);
    const resolverWorkflows = new WorkflowsService(
      new WorkflowsRepository(database),
      new WorkspaceJobEnqueuerAdapter(new WorkspaceJobsService(resolverJobs)),
    );
    const scopeResolver = new CanonicalProjectInferenceScopeResolver(
      new ChatsRepository(database),
      resolverWorkflows,
      new TabularRepository(database),
    );

    const seedAssistantContract = (projectId: string | null) => {
      const chatId = randomUUID();
      const promptMessageId = randomUUID();
      const outputMessageId = randomUUID();
      const jobId = randomUUID();
      database!
        .prepare(
          `INSERT INTO chats (
             id, project_id, scope, title, created_at, updated_at
           ) VALUES (?, ?, ?, 'Resolver Assistant', ?, ?)`,
        )
        .run(
          chatId,
          projectId,
          projectId === null ? "global" : "project",
          NOW,
          NOW,
        );
      database!
        .prepare(
          `INSERT INTO chat_messages (
             id, chat_id, sequence, role, content, status,
             created_at, updated_at, completed_at
           ) VALUES (?, ?, 0, 'user', 'Resolver prompt', 'complete', ?, ?, ?)`,
        )
        .run(promptMessageId, chatId, NOW, NOW, NOW);
      const payload = {
        schema: "vera-assistant-generation-v1",
        chatId,
        projectId,
        promptMessageId,
        outputMessageId,
        modelProfileId: resolverModelId,
        documents: [],
        retrieval: { currentVersionOnly: true, limit: 10 },
      };
      insertDurableRunningJob(database!, {
        id: jobId,
        type: "assistant_generate",
        resourceType: "chat",
        resourceId: chatId,
        payload,
      });
      database!
        .prepare(
          `INSERT INTO chat_messages (
             id, chat_id, sequence, role, content, status, model_profile_id,
             job_id, created_at, updated_at
           ) VALUES (?, ?, 1, 'assistant', '', 'pending', ?, ?, ?, ?)`,
        )
        .run(outputMessageId, chatId, resolverModelId, jobId, NOW, NOW);
      database!
        .prepare(
          `INSERT INTO assistant_generation_snapshots (
             job_id, chat_id, prompt_message_id, output_message_id,
             model_profile_id, current_version_only, retrieval_limit,
             created_at
           ) VALUES (?, ?, ?, ?, ?, 1, 10, ?)`,
        )
        .run(
          jobId,
          chatId,
          promptMessageId,
          outputMessageId,
          resolverModelId,
          NOW,
        );
      const job = resolverJobs.getJob(jobId);
      assert.ok(job);
      return { job, chatId };
    };

    const resolverAssistantProjectId = createProject(projects, {
      name: "Resolver Assistant Project",
    });
    const assistantContract = seedAssistantContract(resolverAssistantProjectId);
    assert.deepEqual(scopeResolver.resolve(assistantContract.job), {
      jobId: assistantContract.job.id,
      type: "assistant_generate",
      scope: "project",
      projectId: resolverAssistantProjectId,
    });
    const globalAssistantContract = seedAssistantContract(null);
    assert.deepEqual(scopeResolver.resolve(globalAssistantContract.job), {
      jobId: globalAssistantContract.job.id,
      type: "assistant_generate",
      scope: "global",
      projectId: null,
    });
    assert.equal(
      scopeResolver.resolve({
        ...assistantContract.job,
        payload: { schema: "tampered" },
      })?.scope,
      "unresolved",
    );

    const resolverWorkflowProjectId = createProject(projects, {
      name: "Resolver Workflow Project",
    });
    const resolverWorkflowId = randomUUID();
    const resolverRunId = randomUUID();
    const resolverWorkflowJobId = randomUUID();
    const resolverSnapshotId = randomUUID();
    const resolverSnapshotSha = "a".repeat(64);
    const resolverWorkflowPayload = {
      runId: resolverRunId,
      workflowId: resolverWorkflowId,
      snapshotId: resolverSnapshotId,
      snapshotSha256: resolverSnapshotSha,
      retryOfRunId: null,
    };
    insertDurableRunningJob(database, {
      id: resolverWorkflowJobId,
      type: "workflow_run",
      resourceType: "workflow_run",
      resourceId: resolverRunId,
      payload: resolverWorkflowPayload,
    });
    database
      .prepare(
        `INSERT INTO workflows (
           id, project_id, type, title, created_at, updated_at
         ) VALUES (?, ?, 'assistant', 'Resolver Workflow', ?, ?)`,
      )
      .run(resolverWorkflowId, resolverWorkflowProjectId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO workflow_runs (
           id, workflow_id, project_id, job_id, status, input_json,
           started_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'running', '{}', ?, ?, ?)`,
      )
      .run(
        resolverRunId,
        resolverWorkflowId,
        resolverWorkflowProjectId,
        resolverWorkflowJobId,
        NOW,
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO workflow_execution_snapshots (
           id, workflow_run_id, workflow_id, schema_version,
           workflow_version, project_id, model_profile_id, config_json,
           steps_json, skill_markdown, columns_config_json,
           input_binding_json, snapshot_sha256, created_at
         ) VALUES (?, ?, ?, 1, 'resolver-v1', ?, NULL, '{}', '[]', '',
                   '[]', '{}', ?, ?)`,
      )
      .run(
        resolverSnapshotId,
        resolverRunId,
        resolverWorkflowId,
        resolverWorkflowProjectId,
        resolverSnapshotSha,
        NOW,
      );
    const resolverWorkflowJob = resolverJobs.getJob(resolverWorkflowJobId);
    assert.ok(resolverWorkflowJob);
    assert.deepEqual(scopeResolver.resolve(resolverWorkflowJob), {
      jobId: resolverWorkflowJobId,
      type: "workflow_run",
      scope: "project",
      projectId: resolverWorkflowProjectId,
    });
    assert.equal(
      scopeResolver.resolve({
        ...resolverWorkflowJob,
        payload: { ...resolverWorkflowPayload, snapshotSha256: "b".repeat(64) },
      })?.scope,
      "unresolved",
    );

    const resolverTabularProjectId = createProject(projects, {
      name: "Resolver Tabular Project",
    });
    const resolverDocumentId = randomUUID();
    const resolverReviewId = randomUUID();
    const resolverColumnId = randomUUID();
    const resolverCellId = randomUUID();
    const resolverTabularJobId = randomUUID();
    const resolverVersionId = randomUUID();
    const resolverBlobId = randomUUID();
    database
      .prepare(
        `INSERT INTO documents (
           id, project_id, title, filename, mime_type, size_bytes,
           created_at, updated_at
         ) VALUES (?, ?, 'Resolver document', 'resolver.txt', 'text/plain',
                   1, ?, ?)`,
      )
      .run(resolverDocumentId, resolverTabularProjectId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO tabular_reviews (
           id, project_id, title, status, created_at, updated_at
         ) VALUES (?, ?, 'Resolver review', 'running', ?, ?)`,
      )
      .run(resolverReviewId, resolverTabularProjectId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO tabular_review_columns (
           id, review_id, key, title, output_type, ordinal,
           created_at, updated_at
         ) VALUES (?, ?, 'resolver', 'Resolver', 'text', 0, ?, ?)`,
      )
      .run(resolverColumnId, resolverReviewId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO tabular_review_documents (
           review_id, document_id, ordinal, created_at
         ) VALUES (?, ?, 0, ?)`,
      )
      .run(resolverReviewId, resolverDocumentId, NOW);
    const resolverTabularPayload = {
      schema: "vera-tabular-cell-job-v1",
      reviewId: resolverReviewId,
      projectId: resolverTabularProjectId,
      cellId: resolverCellId,
      generationId: resolverTabularJobId,
      document: {
        documentId: resolverDocumentId,
        versionId: resolverVersionId,
        blobRecordId: resolverBlobId,
        sourceContentSha256: "c".repeat(64),
        textSha256: "d".repeat(64),
        textBytes: 1,
      },
      column: {
        columnId: resolverColumnId,
        revisionSha256: "e".repeat(64),
      },
      model: { profileId: resolverModelId, executionRevision: 0 },
      reviewRevisionSha256: "f".repeat(64),
      generation: 1,
    };
    insertDurableRunningJob(database, {
      id: resolverTabularJobId,
      type: "tabular_cell",
      resourceType: "tabular_cell",
      resourceId: resolverCellId,
      payload: resolverTabularPayload,
    });
    database
      .prepare(
        `INSERT INTO tabular_cells (
           id, review_id, document_id, column_id, output_type, status,
           job_id, attempt, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'text', 'running', ?, 1, ?, ?)`,
      )
      .run(
        resolverCellId,
        resolverReviewId,
        resolverDocumentId,
        resolverColumnId,
        resolverTabularJobId,
        NOW,
        NOW,
      );
    const resolverTabularJob = resolverJobs.getJob(resolverTabularJobId);
    assert.ok(resolverTabularJob);
    const frozenTabularScope = scopeResolver.resolve(resolverTabularJob);
    assert.deepEqual(frozenTabularScope, {
      jobId: resolverTabularJobId,
      type: "tabular_cell",
      scope: "project",
      projectId: resolverTabularProjectId,
    });
    assert.equal(
      scopeResolver.resolve({
        ...resolverTabularJob,
        payload: { ...resolverTabularPayload, projectId: randomUUID() },
      })?.scope,
      "unresolved",
    );

    const frozenTabularController = new AbortController();
    assert.ok(frozenTabularScope);
    abortRegistry.register(
      resolverTabularJobId,
      frozenTabularController,
      frozenTabularScope,
    );
    database
      .prepare(
        `UPDATE jobs
            SET status = 'cancelled', cancel_requested_at = ?,
                cancellation_reason = 'Resolver audit cancellation',
                completed_at = ?, lease_owner = NULL,
                lease_expires_at = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(NOW, NOW, NOW, resolverTabularJobId);
    database
      .prepare("DELETE FROM tabular_cells WHERE id = ?")
      .run(resolverCellId);
    database
      .prepare("DELETE FROM tabular_reviews WHERE id = ?")
      .run(resolverReviewId);
    database
      .prepare("DELETE FROM documents WHERE id = ?")
      .run(resolverDocumentId);
    assert.equal(
      scopeResolver.resolve(resolverTabularJob)?.scope,
      "unresolved",
    );
    assert.equal(
      projects.hasBlockingInferenceJobs(resolverTabularProjectId, []),
      false,
    );
    expectApiError(
      () =>
        service.createProjectMatterProfile(
          localContext,
          resolverTabularProjectId,
          { workspaceType: "research" },
        ),
      409,
      "CONFLICT",
    );
    assert.equal(frozenTabularController.signal.aborted, false);
    abortRegistry.unregister(resolverTabularJobId, frozenTabularController);
    assert.equal(
      service.createProjectMatterProfile(
        localContext,
        resolverTabularProjectId,
        { workspaceType: "research" },
      ).profileState,
      "ready",
    );

    // The generic Job runtime resolves synchronously before registration and
    // keeps the frozen scope until its controller-identity finally block runs.
    const runtimeScopePath = path.join(root, "scope-runtime.db");
    const runtimeScopeDatabase = new WorkspaceDatabase(runtimeScopePath);
    try {
      const runtimeProjects = new ProjectsRepository(runtimeScopeDatabase);
      const runtimeProjectId = createProject(runtimeProjects, {
        name: "Runtime frozen scope Project",
      });
      const runtimeModelId = seedResolverModelProfile(runtimeScopeDatabase);
      const runtimeChatId = randomUUID();
      const runtimePromptId = randomUUID();
      const runtimeOutputId = randomUUID();
      const runtimeJobId = randomUUID();
      runtimeScopeDatabase
        .prepare(
          `INSERT INTO chats (
             id, project_id, scope, title, created_at, updated_at
           ) VALUES (?, ?, 'project', 'Runtime frozen scope', ?, ?)`,
        )
        .run(runtimeChatId, runtimeProjectId, NOW, NOW);
      runtimeScopeDatabase
        .prepare(
          `INSERT INTO chat_messages (
             id, chat_id, sequence, role, content, status,
             created_at, updated_at, completed_at
           ) VALUES (?, ?, 0, 'user', 'Runtime prompt', 'complete', ?, ?, ?)`,
        )
        .run(runtimePromptId, runtimeChatId, NOW, NOW, NOW);
      const runtimePayload = {
        schema: "vera-assistant-generation-v1",
        chatId: runtimeChatId,
        projectId: runtimeProjectId,
        promptMessageId: runtimePromptId,
        outputMessageId: runtimeOutputId,
        modelProfileId: runtimeModelId,
        documents: [],
        retrieval: { currentVersionOnly: true, limit: 10 },
      };
      insertDurableRunningJob(runtimeScopeDatabase, {
        id: runtimeJobId,
        type: "assistant_generate",
        resourceType: "chat",
        resourceId: runtimeChatId,
        payload: runtimePayload,
      });
      runtimeScopeDatabase
        .prepare(
          `UPDATE jobs
              SET status = 'queued', attempt = 0, locked_at = NULL,
                  started_at = NULL, lease_owner = NULL,
                  lease_expires_at = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(NOW, runtimeJobId);
      runtimeScopeDatabase
        .prepare(
          `INSERT INTO chat_messages (
             id, chat_id, sequence, role, content, status, model_profile_id,
             job_id, created_at, updated_at
           ) VALUES (?, ?, 1, 'assistant', '', 'pending', ?, ?, ?, ?)`,
        )
        .run(
          runtimeOutputId,
          runtimeChatId,
          runtimeModelId,
          runtimeJobId,
          NOW,
          NOW,
        );
      runtimeScopeDatabase
        .prepare(
          `INSERT INTO assistant_generation_snapshots (
             job_id, chat_id, prompt_message_id, output_message_id,
             model_profile_id, current_version_only, retrieval_limit,
             created_at
           ) VALUES (?, ?, ?, ?, ?, 1, 10, ?)`,
        )
        .run(
          runtimeJobId,
          runtimeChatId,
          runtimePromptId,
          runtimeOutputId,
          runtimeModelId,
          NOW,
        );
      const runtimeJobsRepository = new WorkspaceJobsRepository(
        runtimeScopeDatabase,
      );
      const runtimeResolver = new CanonicalProjectInferenceScopeResolver(
        new ChatsRepository(runtimeScopeDatabase),
        new WorkflowsService(
          new WorkflowsRepository(runtimeScopeDatabase),
          new WorkspaceJobEnqueuerAdapter(
            new WorkspaceJobsService(runtimeJobsRepository),
          ),
        ),
        new TabularRepository(runtimeScopeDatabase),
      );
      const runtimeRegistry = new WorkspaceJobAbortRegistry();
      let releaseHandler!: () => void;
      const handlerRelease = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      let markHandlerStarted!: () => void;
      const handlerStarted = new Promise<void>((resolve) => {
        markHandlerStarted = resolve;
      });
      const jobRuntime = new WorkspaceJobRuntime(
        runtimeJobsRepository,
        {
          assistant_generate: async () => {
            markHandlerStarted();
            await handlerRelease;
            return { ok: true };
          },
        },
        {
          abortRegistry: runtimeRegistry,
          inferenceScopeResolver: runtimeResolver.resolve,
          recoveryMode: "fenced",
          allowedJobTypes: ["assistant_generate"],
          manageProcessSignals: false,
          now: () => new Date(NOW),
        },
      );
      await jobRuntime.start();
      const running = jobRuntime.claimAndRun();
      await handlerStarted;
      assert.deepEqual(runtimeRegistry.activeInferenceScopes(), [
        {
          jobId: runtimeJobId,
          type: "assistant_generate",
          scope: "project",
          projectId: runtimeProjectId,
        },
      ]);
      runtimeScopeDatabase
        .prepare(
          `UPDATE jobs
              SET status = 'cancelled', cancel_requested_at = ?,
                  cancellation_reason = 'Runtime scope audit',
                  completed_at = ?, lease_owner = NULL,
                  lease_expires_at = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(NOW, NOW, NOW, runtimeJobId);
      runtimeScopeDatabase
        .prepare("DELETE FROM chats WHERE id = ?")
        .run(runtimeChatId);
      assert.deepEqual(runtimeRegistry.activeInferenceScopes(), [
        {
          jobId: runtimeJobId,
          type: "assistant_generate",
          scope: "project",
          projectId: runtimeProjectId,
        },
      ]);
      releaseHandler();
      await running;
      assert.deepEqual(runtimeRegistry.activeInferenceScopes(), []);
      await jobRuntime.stop();
    } finally {
      runtimeScopeDatabase.close();
    }

    // Query-order evidence for the TOCTOU boundary. A second connection cannot
    // enqueue after the scoped activity read but before profile creation while
    // BEGIN IMMEDIATE is held. Its retry after COMMIT reaches the final Matter
    // model gate and therefore makes zero provider calls.
    const serializedProjectId = createProject(projects, {
      name: "Serialized conversion and enqueue",
    });
    const serializedChatId = randomUUID();
    const serializedJobId = randomUUID();
    database
      .prepare(
        `INSERT INTO chats (id, project_id, scope, title, created_at, updated_at)
         VALUES (?, ?, 'project', 'Serialized enqueue audit', ?, ?)`,
      )
      .run(serializedChatId, serializedProjectId, NOW, NOW);
    const enqueueDatabase = new WorkspaceDatabase(databasePath, {
      migrate: false,
    });
    try {
      enqueueDatabase.exec("PRAGMA busy_timeout = 1");
      const transactionEvents: string[] = [];
      let enqueueAttempted = false;
      let enqueueBlocked = false;
      const enqueue = () =>
        enqueueDatabase
          .prepare(
            `INSERT INTO jobs (
               id, type, status, resource_type, resource_id, payload_json,
               scheduled_at, created_at, updated_at
             ) VALUES (?, 'assistant_generate', 'queued', 'chat', ?, '{}',
                       ?, ?, ?)`,
          )
          .run(serializedJobId, serializedChatId, NOW, NOW, NOW);
      const transactionDatabase: WorkspaceDatabaseAdapter = {
        exec(sql) {
          transactionEvents.push(`EXEC ${sql.trim()}`);
          return database!.exec(sql);
        },
        prepare(sql) {
          const compact = sql.replace(/\s+/g, " ").trim();
          transactionEvents.push(`SQL ${compact}`);
          if (!enqueueAttempted && compact.includes("FROM jobs j")) {
            enqueueAttempted = true;
            try {
              enqueue();
            } catch {
              enqueueBlocked = true;
            }
          }
          return database!.prepare(sql);
        },
      };
      const transactionProjects = new ProjectsRepository(transactionDatabase);
      const transactionProfiles = new MatterProfileRepository(
        transactionDatabase,
      );
      const transactionOverview = new MatterOverviewRepository(
        transactionDatabase,
      );
      const transactionService = new MatterProfileService(
        transactionDatabase,
        transactionProjects,
        transactionProfiles,
        transactionOverview,
        createProjectInferenceActivityPort(transactionProjects, () => {
          transactionEvents.push("SNAPSHOT activeInferenceScopes");
          return abortRegistry.activeInferenceScopes();
        }),
        { clock: () => new Date(NOW) },
      );
      transactionService.createProjectMatterProfile(
        localContext,
        serializedProjectId,
        { workspaceType: "general_legal" },
      );
      assert.equal(enqueueAttempted, true);
      assert.equal(enqueueBlocked, true);
      assert.equal(
        database
          .prepare("SELECT id FROM jobs WHERE id = ?")
          .get(serializedJobId),
        undefined,
      );
      assert.equal(
        transactionEvents.filter((event) => event === "EXEC BEGIN IMMEDIATE")
          .length,
        1,
      );
      assert.equal(
        transactionEvents.filter((event) => event === "EXEC COMMIT").length,
        1,
      );
      assert.equal(
        transactionEvents.some((event) => event === "EXEC ROLLBACK"),
        false,
      );
      const eventIndex = (fragment: string) => {
        const index = transactionEvents.findIndex((event) =>
          event.includes(fragment),
        );
        assert.notEqual(index, -1, `missing transaction event: ${fragment}`);
        return index;
      };
      assert.ok(
        eventIndex("EXEC BEGIN IMMEDIATE") <
          eventIndex("SELECT * FROM projects WHERE id = ?") &&
          eventIndex("SELECT * FROM projects WHERE id = ?") <
            eventIndex("FROM matter_profiles WHERE project_id = ?") &&
          eventIndex("FROM matter_profiles WHERE project_id = ?") <
            eventIndex("SNAPSHOT activeInferenceScopes") &&
          eventIndex("SNAPSHOT activeInferenceScopes") <
            eventIndex("FROM jobs j") &&
          eventIndex("FROM jobs j") <
            eventIndex("INSERT INTO matter_profiles") &&
          eventIndex("INSERT INTO matter_profiles") <
            eventIndex("UPDATE projects SET") &&
          eventIndex("UPDATE projects SET") <
            eventIndex("WITH selected_projects AS") &&
          eventIndex("WITH selected_projects AS") < eventIndex("EXEC COMMIT"),
      );

      enqueue();
      const inferencePolicy = new WorkspaceInferencePolicy(database);
      assert.equal(
        inferencePolicy.resolveScope(serializedProjectId).scope,
        "matter",
      );
    } finally {
      enqueueDatabase.close();
    }

    // Profile creation is explicit, uses the v15 compatibility sentinel, and
    // moves time monotonically beyond an offset Project timestamp.
    const conversionProjectId = createProject(projects, {
      name: "Explicit conversion Project",
      now: "2026-07-17T00:00:00.000+08:00",
    });
    const converted = service.createProjectMatterProfile(
      localContext,
      conversionProjectId,
      {
        workspaceType: "compliance",
        clientName: "  Explicit Client  ",
        jurisdiction: "  PRC  ",
      },
    );
    assert.equal(converted.profile?.workspaceType, "compliance");
    assert.equal(converted.profile?.clientName, "Explicit Client");
    assert.equal(converted.profile?.jurisdiction, "PRC");
    assert.equal(converted.profileState, "ready");
    assert.equal(converted.project.updatedAt, "2026-07-16T16:00:00.001Z");
    const convertedStorage = database
      .prepare(
        `SELECT matter_type, workspace_type
           FROM matter_profiles
          WHERE project_id = ?`,
      )
      .get(conversionProjectId);
    assert.equal(convertedStorage?.matter_type, "general");
    assert.equal(convertedStorage?.workspace_type, "compliance");
    expectApiError(
      () =>
        service.createProjectMatterProfile(localContext, conversionProjectId, {
          workspaceType: "general_legal",
        }),
      409,
      "CONFLICT",
    );

    const created = service.createMatter(localContext, {
      name: "Alpha Matter",
      description: "Created atomically over the Project boundary.",
      cmNumber: "MAT-001",
      practice: "General commercial",
      workspaceType: "dispute",
      clientName: "Alpha Client",
      jurisdiction: "PRC",
      representedRole: "Claimant counsel",
      objective: "Obtain a reviewed outcome.",
    });
    assert.equal(created.profile?.projectId, created.project.id);
    assert.equal(created.profile?.workspaceType, "dispute");
    assert.equal(created.project.cmNumber, "MAT-001");
    assert.equal(created.project.practice, "General commercial");
    const createdStorage = database
      .prepare(
        `SELECT matter_type, workspace_type
           FROM matter_profiles
          WHERE project_id = ?`,
      )
      .get(created.project.id);
    assert.equal(createdStorage?.matter_type, "general");
    assert.equal(createdStorage?.workspace_type, "dispute");

    // Matter Policy is an explicit subresource. Missing and empty location
    // states remain fail-closed, while approval is preserved truthfully.
    expectApiError(
      () => service.getMatterPolicy(localContext, created.project.id),
      404,
      "NOT_FOUND",
    );
    const capabilityModelId = seedCapabilityModel(database);
    database
      .prepare(
        `UPDATE workspace_settings
            SET default_model_profile_id = ?, updated_at = ?
          WHERE id = 'workspace'`,
      )
      .run(capabilityModelId, NOW);
    assert.equal(
      service.getMatter(localContext, created.project.id).project
        .defaultModelProfileId,
      null,
      "the public Project projection must not pretend the Workspace default is a Project override",
    );
    const decisionCountBeforeReads = Number(
      database
        .prepare("SELECT count(*) AS count FROM inference_policy_decisions")
        .get()?.count,
    );
    const genericCapabilities = MatterViewSchema.parse(
      facade.api.getMatter(localContext, emptyGenericId),
    ).capabilities;
    assert.equal(genericCapabilities.matterProfile, "create");
    assert.equal(genericCapabilities.assistant, "available");
    assert.equal(genericCapabilities.workflows, "available");
    assert.equal(genericCapabilities.tabular, "available");
    assert.equal(genericCapabilities.review, "unavailable");
    const limitedModelId = seedCapabilityModel(database);
    database
      .prepare(
        `UPDATE model_profiles
            SET capabilities_json = ?
          WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          streaming: true,
          toolCalling: false,
          structuredOutput: false,
          vision: false,
        }),
        limitedModelId,
      );
    const limitedProjectId = createProject(projects, {
      name: "Project override with limited model capabilities",
    });
    database
      .prepare("UPDATE projects SET default_model_profile_id = ? WHERE id = ?")
      .run(limitedModelId, limitedProjectId);
    const limitedCapabilities = MatterViewSchema.parse(
      facade.api.getMatter(localContext, limitedProjectId),
    ).capabilities;
    assert.equal(limitedCapabilities.assistant, "unavailable");
    assert.equal(limitedCapabilities.workflows, "non_inference_only");
    assert.equal(limitedCapabilities.tabular, "unavailable");
    const missingPolicyCapabilities = MatterViewSchema.parse(
      facade.api.getMatter(localContext, created.project.id),
    ).capabilities;
    assert.equal(missingPolicyCapabilities.assistant, "policy_gate_closed");
    assert.equal(missingPolicyCapabilities.workflows, "non_inference_only");
    assert.equal(missingPolicyCapabilities.tabular, "policy_gate_closed");
    assert.equal(missingPolicyCapabilities.review, "unavailable");

    const emptyPolicy = service.replaceMatterPolicy(
      localContext,
      created.project.id,
      {
        externalEgressMode: "disabled",
        executionLocations: [],
        allowExternalLegalSources: false,
        allowWordBridge: false,
      },
    );
    assert.deepEqual(emptyPolicy.executionLocations, []);
    assert.deepEqual(
      service.getMatterPolicy(localContext, created.project.id),
      emptyPolicy,
    );
    assert.equal(
      MatterViewSchema.parse(
        facade.api.getMatter(localContext, created.project.id),
      ).capabilities.assistant,
      "policy_gate_closed",
    );

    const localPolicy = service.replaceMatterPolicy(
      localContext,
      created.project.id,
      {
        externalEgressMode: "disabled",
        executionLocations: ["local"],
        allowExternalLegalSources: true,
        allowWordBridge: false,
      },
    );
    assert.equal(localPolicy.externalEgressMode, "disabled");
    const localCapabilities = MatterViewSchema.parse(
      facade.api.getMatter(localContext, created.project.id),
    ).capabilities;
    assert.equal(localCapabilities.assistant, "available");
    assert.equal(localCapabilities.workflows, "available");
    assert.equal(localCapabilities.tabular, "available");
    assert.equal(localCapabilities.review, "unavailable");
    const runtimeClosedFacade = createMatterProfileModule(database, projects, {
      activeInferenceScopes: () => [],
      modelRuntimeCapabilities: {
        runtimeWired: () => false,
        capabilitiesFor: () => ({
          streaming: true,
          toolCalling: true,
          structuredOutput: true,
        }),
      },
    });
    const runtimeClosedCapabilities = MatterViewSchema.parse(
      runtimeClosedFacade.api.getMatter(localContext, created.project.id),
    ).capabilities;
    assert.equal(runtimeClosedCapabilities.assistant, "unavailable");
    assert.equal(runtimeClosedCapabilities.workflows, "non_inference_only");
    assert.equal(runtimeClosedCapabilities.tabular, "unavailable");

    database.exec(`
      CREATE TRIGGER audit_reject_policy_location
      BEFORE INSERT ON matter_policy_execution_locations
      WHEN new.execution_location = 'firm_private'
      BEGIN
        SELECT RAISE(ABORT, '${SECRET} ${PRIVATE_PATH}');
      END;
    `);
    const policyAtomicFailure = expectApiError(
      () =>
        service.replaceMatterPolicy(localContext, created.project.id, {
          externalEgressMode: "allowed_by_policy",
          executionLocations: ["firm_private"],
          allowExternalLegalSources: false,
          allowWordBridge: true,
        }),
      500,
      "INTERNAL_ERROR",
    );
    assertRedacted(policyAtomicFailure.toResponse());
    assert.deepEqual(
      service.getMatterPolicy(localContext, created.project.id),
      localPolicy,
    );
    database.exec("DROP TRIGGER audit_reject_policy_location");

    database
      .prepare(
        `UPDATE model_profile_privacy
            SET execution_location = 'confidential_remote', updated_at = ?
          WHERE model_profile_id = ?`,
      )
      .run("2026-07-16T10:00:01.000Z", capabilityModelId);
    const approvalPolicy = service.replaceMatterPolicy(
      localContext,
      created.project.id,
      {
        externalEgressMode: "approval",
        executionLocations: ["confidential_remote"],
        allowExternalLegalSources: false,
        allowWordBridge: true,
      },
    );
    assert.equal(approvalPolicy.externalEgressMode, "approval");
    const approvalCapabilities = MatterViewSchema.parse(
      facade.api.getMatter(localContext, created.project.id),
    ).capabilities;
    assert.equal(approvalCapabilities.assistant, "require_approval");
    assert.equal(approvalCapabilities.workflows, "require_approval");
    assert.equal(approvalCapabilities.tabular, "require_approval");
    assert.equal(approvalCapabilities.review, "unavailable");
    facade.api.listMatters(localContext, { profileState: "profiled", limit: 20 });
    assert.equal(
      Number(
        database
          .prepare("SELECT count(*) AS count FROM inference_policy_decisions")
          .get()?.count,
      ),
      decisionCountBeforeReads,
      "capability projection must not write enforcement decisions",
    );

    seedOverviewCounts(database, created.project.id);
    const counted = service.getMatter(localContext, created.project.id);
    assert.deepEqual(
      {
        documents: counted.project.documentCount,
        chats: counted.project.chatCount,
        tabularReviews: counted.project.tabularReviewCount,
        workflows: counted.project.workflowCount,
      },
      { documents: 1, chats: 1, tabularReviews: 1, workflows: 1 },
    );
    const countedWire = toMatterViewWire(counted);
    assert.equal(countedWire.project.tabular_review_count, 1);
    assert.equal("review_count" in countedWire.project, false);

    // One bounded list statement performs the Project left join and every
    // count; mapping a page performs no per-item repository reads.
    let prepareCount = 0;
    const preparedSql: string[] = [];
    const countingDatabase: WorkspaceDatabaseAdapter = {
      exec: database.exec.bind(database),
      prepare(sql) {
        prepareCount += 1;
        preparedSql.push(sql);
        return database!.prepare(sql);
      },
    };
    const countingRepository = new MatterOverviewRepository(countingDatabase);
    const countedPage = countingRepository.list({ limit: 100 });
    assert.ok(countedPage.items.length >= 4);
    assert.equal(prepareCount, 1);
    assert.match(preparedSql[0] ?? "", /LEFT JOIN matter_profiles/);
    assert.match(preparedSql[0] ?? "", /tabular_review_counts/);
    assert.ok(
      countedPage.items.some(
        (item) => item.project.id === emptyGenericId && item.profile === null,
      ),
    );

    const second = service.createMatter(localContext, {
      name: "Second Matter",
      workspaceType: "research",
      clientName: "Second Client",
    });
    const firstPage = service.listMatters(localContext, { limit: 1 });
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = service.listMatters(localContext, {
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(
      firstPage.items[0].project.id,
      secondPage.items[0].project.id,
    );

    // SQL applies profile_state before cursor/limit. One hundred newer Generic
    // Projects cannot hide either older Matter, and each filtered stream owns
    // a cursor that is rejected by a different stream.
    const paginationGenericIds = Array.from({ length: 100 }, (_, index) =>
      createProject(projects, {
        name: `Pagination Generic ${index}`,
        now: new Date(Date.UTC(2035, 0, 1) + index).toISOString(),
      }),
    );
    const paginationMatterIds = [
      service.createMatter(localContext, {
        name: "Pagination Matter One",
        workspaceType: "general_legal",
      }).project.id,
      service.createMatter(localContext, {
        name: "Pagination Matter Two",
        workspaceType: "research",
      }).project.id,
    ];
    const collectFiltered = (profileState: "absent" | "profiled") => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = service.listMatters(localContext, {
          profileState,
          cursor,
          limit: 23,
        });
        ids.push(...page.items.map((item) => item.project.id));
        assert.ok(
          page.items.every((item) =>
            profileState === "absent"
              ? item.profile === null
              : item.profile !== null,
          ),
        );
        cursor = page.nextCursor;
      } while (cursor !== null);
      return ids;
    };
    const absentIds = collectFiltered("absent");
    const profiledIds = collectFiltered("profiled");
    for (const id of paginationGenericIds) assert.ok(absentIds.includes(id));
    for (const id of paginationMatterIds) assert.ok(profiledIds.includes(id));
    const absentCursor = service.listMatters(localContext, {
      profileState: "absent",
      limit: 1,
    }).nextCursor;
    assert.ok(absentCursor);
    expectApiError(
      () =>
        service.listMatters(localContext, {
          profileState: "profiled",
          cursor: absentCursor,
          limit: 1,
        }),
      400,
      "VALIDATION_ERROR",
    );
    expectApiError(
      () =>
        service.listMatters(localContext, {
          status: "archived",
          profileState: "absent",
          cursor: absentCursor,
          limit: 1,
        }),
      400,
      "VALIDATION_ERROR",
    );
    const readyFiltered = service.listMatters(localContext, {
      profileState: "ready",
      limit: 1,
    });
    assert.equal(readyFiltered.items.length, 1);
    assert.equal(readyFiltered.items[0].profileState, "ready");
    assert.ok(
      service
        .listMatters(localContext, {
          profileState: "classification_required",
          limit: 100,
        })
        .items.some((item) => item.project.id === legacyProjectId),
    );

    projects.update(created.project.id, {
      now: "2027-02-01T00:00:00.000+08:00",
    });
    const updated = service.updateProjectMatterProfile(
      localContext,
      created.project.id,
      {
        workspaceType: "transaction",
        jurisdiction: "Singapore",
      },
    );
    assert.equal(updated.profile?.workspaceType, "transaction");
    assert.equal(updated.profile?.jurisdiction, "Singapore");
    assert.equal(updated.project.updatedAt, "2027-01-31T16:00:00.001Z");
    assert.equal(updated.profile?.updatedAt, updated.project.updatedAt);
    assert.equal(
      database
        .prepare("SELECT matter_type FROM matter_profiles WHERE project_id = ?")
        .get(created.project.id)?.matter_type,
      "general",
    );

    const combined = service.updateMatter(
      localContext,
      created.project.id,
      {
        project: {
          name: "Alpha Matter Renamed",
          description: "General and Legal Profile saved atomically.",
          cmNumber: "MAT-001-A",
          practice: "Transactions",
        },
        profile: {
          workspaceType: "transaction",
          clientName: "Alpha Client Updated",
          objective: "Complete an atomic combined update.",
        },
      },
    );
    assert.equal(combined.project.name, "Alpha Matter Renamed");
    assert.equal(combined.project.cmNumber, "MAT-001-A");
    assert.equal(combined.profile?.clientName, "Alpha Client Updated");
    assert.equal(combined.profile?.updatedAt, combined.project.updatedAt);
    assert.equal("matterType" in combined, false);

    database.exec(`
      CREATE TRIGGER audit_reject_combined_profile_update
      BEFORE UPDATE ON matter_profiles
      WHEN new.objective = 'Reject combined update'
      BEGIN
        SELECT RAISE(ABORT, '${SECRET} ${PRIVATE_PATH}');
      END;
    `);
    const beforeCombinedRollback = service.getMatter(
      localContext,
      created.project.id,
    );
    const combinedFailure = expectApiError(
      () =>
        service.updateMatter(localContext, created.project.id, {
          project: { name: "Project write must roll back" },
          profile: { objective: "Reject combined update" },
        }),
      500,
      "INTERNAL_ERROR",
    );
    assertRedacted(combinedFailure.toResponse());
    const afterCombinedRollback = service.getMatter(
      localContext,
      created.project.id,
    );
    assert.equal(
      afterCombinedRollback.project.name,
      beforeCombinedRollback.project.name,
    );
    assert.equal(
      afterCombinedRollback.profile?.objective,
      beforeCombinedRollback.profile?.objective,
    );
    database.exec("DROP TRIGGER audit_reject_combined_profile_update");

    // Archived Projects remain readable but cannot create or mutate a profile.
    const archivedGenericId = createProject(projects, {
      name: "Archived generic Project",
    });
    projects.archive(archivedGenericId, "2026-07-16T11:00:00.000Z");
    const archivedGeneric = service.getMatter(localContext, archivedGenericId);
    assert.equal(archivedGeneric.profileState, "absent");
    assert.deepEqual(archivedGeneric.capabilities, {
      matterProfile: "unavailable",
      assistant: "unavailable",
      workflows: "unavailable",
      tabular: "unavailable",
      review: "unavailable",
      drafts: "unavailable",
    });
    expectApiError(
      () =>
        service.createProjectMatterProfile(localContext, archivedGenericId, {
          workspaceType: "general_legal",
        }),
      409,
      "CONFLICT",
    );
    projects.archive(legacyProjectId, "2026-07-16T11:00:00.001Z");
    const archivedLegacy = service.getMatter(localContext, legacyProjectId);
    assert.equal(archivedLegacy.profileState, "classification_required");
    assert.equal(archivedLegacy.capabilities.matterProfile, "unavailable");
    assert.equal(archivedLegacy.capabilities.assistant, "unavailable");
    projects.archive(created.project.id, "2027-02-01T00:00:00.000Z");
    const archivedMatter = service.getMatter(localContext, created.project.id);
    assert.equal(archivedMatter.profileState, "ready");
    assert.equal(archivedMatter.capabilities.matterProfile, "unavailable");
    assert.equal(archivedMatter.capabilities.assistant, "unavailable");
    expectApiError(
      () =>
        service.updateProjectMatterProfile(localContext, created.project.id, {
          objective: "Archived edit must fail",
        }),
      409,
      "CONFLICT",
    );
    expectApiError(
      () =>
        service.replaceMatterPolicy(localContext, created.project.id, {
          externalEgressMode: "disabled",
          executionLocations: ["local"],
          allowExternalLegalSources: false,
          allowWordBridge: false,
        }),
      409,
      "CONFLICT",
    );

    const archivedStatePage = service.listMatters(localContext, {
      status: "archived",
      limit: 100,
    });
    for (const [projectId, profileState] of [
      [archivedGenericId, "absent"],
      [legacyProjectId, "classification_required"],
      [created.project.id, "ready"],
    ] as const) {
      const item = archivedStatePage.items.find(
        (candidate) => candidate.project.id === projectId,
      );
      assert.ok(item);
      assert.equal(item.profileState, profileState);
      assert.equal(item.capabilities.matterProfile, "unavailable");
      assert.equal(item.capabilities.assistant, "unavailable");
    }

    const deletedGenericId = createProject(projects, {
      name: "Deleted generic Project",
    });
    database
      .prepare(
        "UPDATE projects SET status = 'deleted', updated_at = ? WHERE id = ?",
      )
      .run("2027-02-01T00:00:00.002Z", deletedGenericId);
    const deletedGeneric = service.getMatter(localContext, deletedGenericId);
    assert.equal(deletedGeneric.profileState, "absent");
    assert.equal(deletedGeneric.capabilities.matterProfile, "unavailable");
    assert.equal(deletedGeneric.capabilities.assistant, "unavailable");

    const deletedMatter = service.createMatter(localContext, {
      name: "Deleted classified Matter",
      workspaceType: "investigation",
    });
    service.replaceMatterPolicy(localContext, deletedMatter.project.id, {
      externalEgressMode: "disabled",
      executionLocations: ["local"],
      allowExternalLegalSources: false,
      allowWordBridge: false,
    });
    database
      .prepare(
        "UPDATE projects SET status = 'deleted', updated_at = ? WHERE id = ?",
      )
      .run("2027-02-01T00:00:00.003Z", deletedMatter.project.id);
    const deletedReady = service.getMatter(
      localContext,
      deletedMatter.project.id,
    );
    assert.equal(deletedReady.profileState, "ready");
    assert.equal(deletedReady.capabilities.matterProfile, "unavailable");
    assert.equal(deletedReady.capabilities.assistant, "unavailable");
    expectApiError(
      () =>
        service.updateProjectMatterProfile(
          localContext,
          deletedMatter.project.id,
          { objective: "Deleted edit must fail" },
        ),
      409,
      "CONFLICT",
    );
    expectApiError(
      () =>
        service.replaceMatterPolicy(localContext, deletedMatter.project.id, {
          externalEgressMode: "allowed_by_policy",
          executionLocations: ["standard_remote"],
          allowExternalLegalSources: true,
          allowWordBridge: true,
        }),
      409,
      "CONFLICT",
    );

    // A failed Profile insert rolls the injected Project repository write back
    // in the same outer transaction; SQLite text remains private.
    database.exec(`
      CREATE TRIGGER audit_reject_matter_profile
      BEFORE INSERT ON matter_profiles
      WHEN new.client_name = 'Atomic rejection'
      BEGIN
        SELECT RAISE(ABORT, '${SECRET} ${PRIVATE_PATH}');
      END;
    `);
    const beforeAtomic = Number(
      database.prepare("SELECT count(*) AS count FROM projects").get()?.count,
    );
    const atomicFailure = expectApiError(
      () =>
        service.createMatter(localContext, {
          name: "Must roll back",
          workspaceType: "general_legal",
          clientName: "Atomic rejection",
        }),
      500,
      "INTERNAL_ERROR",
    );
    assertRedacted(atomicFailure.toResponse());
    assert.equal(
      Number(
        database.prepare("SELECT count(*) AS count FROM projects").get()?.count,
      ),
      beforeAtomic,
    );
    database.exec("DROP TRIGGER audit_reject_matter_profile");

    const missingClassification = expectApiError(
      () =>
        service.createMatter(localContext, {
          name: "Missing classification",
        }),
      400,
      "VALIDATION_ERROR",
    );
    assertRedacted(missingClassification.toResponse());
    const malformed = expectApiError(
      () =>
        service.createMatter(localContext, {
          name: "Malformed",
          workspaceType: `${SECRET}${PRIVATE_PATH}`,
          matterType: "civil_litigation",
        }),
      400,
      "VALIDATION_ERROR",
    );
    assertRedacted(malformed.toResponse());
    assert.ok(
      malformed.details?.every((detail) => detail.message === "Invalid value."),
    );
    expectApiError(
      () =>
        service.updateProjectMatterProfile(
          localContext,
          created.project.id,
          {},
        ),
      400,
      "VALIDATION_ERROR",
    );

    expectApiError(
      () => service.listMatters({ principalId: randomUUID() }, { limit: 1 }),
      403,
      "FORBIDDEN",
    );
    const stopped = new MatterProfileService(
      database,
      projects,
      repository,
      overview,
      inferenceActivity,
      { acceptingRequests: () => false },
    );
    expectApiError(
      () => stopped.listMatters(localContext, {}),
      409,
      "CONFLICT",
    );

    database.exec("PRAGMA ignore_check_constraints = ON");
    database
      .prepare(
        "UPDATE matter_profiles SET workspace_type = ? WHERE project_id = ?",
      )
      .run(`${SECRET}${PRIVATE_PATH}`, second.project.id);
    const corrupt = expectApiError(
      () => service.getMatter(localContext, second.project.id),
      500,
      "INTERNAL_ERROR",
    );
    assertRedacted(corrupt.toResponse());
    database
      .prepare(
        "UPDATE matter_profiles SET workspace_type = 'research' WHERE project_id = ?",
      )
      .run(second.project.id);
    database.exec("PRAGMA ignore_check_constraints = OFF");

    const app = express();
    app.use(express.json({ limit: "64kb", strict: true }));
    app.use(
      "/api/v1",
      createMatterProfileV1Router(service, {
        principal: (request: Request) =>
          typeof request.headers["x-audit-principal"] === "string"
            ? request.headers["x-audit-principal"]
            : undefined,
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    assert.equal(
      (
        await requestJson(origin, "/api/v1/matters", {
          principal: null,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await requestJson(origin, "/api/v1/matters", {
          principal: randomUUID(),
        })
      ).status,
      403,
    );

    const listResponse = await requestJson(
      origin,
      "/api/v1/matters?profile_state=absent&limit=100",
    );
    assert.equal(listResponse.status, 200);
    const listWire = MatterViewPageWireSchema.parse(listResponse.body);
    assert.ok(
      listWire.items.some(
        (item) =>
          paginationGenericIds.includes(item.project.id) &&
          item.matter_profile === null &&
          item.profile_state === "absent" &&
          item.capabilities.assistant === "unavailable",
      ),
    );
    assert.ok(
      listWire.items.every(
        (item) => item.matter_profile === null && item.profile_state === "absent",
      ),
    );
    const profiledListResponse = await requestJson(
      origin,
      "/api/v1/matters?profile_state=profiled&limit=100",
    );
    assert.equal(profiledListResponse.status, 200);
    const profiledListWire = MatterViewPageWireSchema.parse(
      profiledListResponse.body,
    );
    for (const id of paginationMatterIds) {
      assert.ok(
        profiledListWire.items.some(
          (item) => item.project.id === id && item.matter_profile !== null,
        ),
      );
    }
    const absentCursorWire = MatterViewPageWireSchema.parse(
      (
        await requestJson(
          origin,
          "/api/v1/matters?profile_state=absent&limit=1",
        )
      ).body,
    );
    assert.ok(absentCursorWire.next_cursor);
    assert.equal(
      (
        await requestJson(
          origin,
          `/api/v1/matters?profile_state=profiled&limit=1&cursor=${encodeURIComponent(absentCursorWire.next_cursor)}`,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await requestJson(
          origin,
          `/api/v1/matters?status=archived&profile_state=absent&limit=1&cursor=${encodeURIComponent(absentCursorWire.next_cursor)}`,
        )
      ).status,
      400,
    );

    const archivedListResponse = await requestJson(
      origin,
      "/api/v1/matters?status=archived&limit=100",
    );
    assert.equal(archivedListResponse.status, 200);
    const archivedListWire = MatterViewPageWireSchema.parse(
      archivedListResponse.body,
    );
    for (const [projectId, profileState] of [
      [archivedGenericId, "absent"],
      [legacyProjectId, "classification_required"],
      [created.project.id, "ready"],
    ] as const) {
      const item = archivedListWire.items.find(
        (candidate) => candidate.project.id === projectId,
      );
      assert.ok(item);
      assert.equal(item.profile_state, profileState);
      assert.equal(item.capabilities.matter_profile, "unavailable");
      assert.equal(item.capabilities.assistant, "unavailable");
    }

    const detailResponse = await requestJson(
      origin,
      `/api/v1/matters/${created.project.id}`,
    );
    assert.equal(detailResponse.status, 200);
    assert.equal(
      MatterViewWireSchema.parse(detailResponse.body).project.id,
      created.project.id,
    );

    const httpProjectId = createProject(projects, {
      name: "HTTP profile Project",
    });
    const readAbsent = await requestJson(
      origin,
      `/api/v1/projects/${httpProjectId}/matter-profile`,
    );
    assert.equal(readAbsent.status, 200);
    assert.equal(
      MatterViewWireSchema.parse(readAbsent.body).profile_state,
      "absent",
    );

    const createProfileResponse = await requestJson(
      origin,
      `/api/v1/projects/${httpProjectId}/matter-profile`,
      {
        method: "POST",
        body: {
          workspace_type: "investigation",
          client_name: "HTTP Profile Client",
          jurisdiction: "PRC",
        },
      },
    );
    assert.equal(createProfileResponse.status, 201);
    const httpProfile = MatterViewWireSchema.parse(createProfileResponse.body);
    assert.equal(httpProfile.matter_profile?.workspace_type, "investigation");
    assertProfileWireKeys(httpProfile.matter_profile);

    const routeCreate = await requestJson(origin, "/api/v1/matters", {
      method: "POST",
      body: {
        name: "HTTP Matter",
        cm_number: "HTTP-001",
        practice: "Research",
        workspace_type: "research",
        client_name: "HTTP Client",
      },
    });
    assert.equal(routeCreate.status, 201);
    const routeMatter = MatterViewWireSchema.parse(routeCreate.body);
    assert.equal(routeMatter.matter_profile?.workspace_type, "research");
    assert.equal(routeMatter.project.cm_number, "HTTP-001");
    assertProfileWireKeys(routeMatter.matter_profile);

    const missingPolicyRoute = await requestJson(
      origin,
      `/api/v1/matters/${routeMatter.project.id}/policy`,
    );
    assert.equal(missingPolicyRoute.status, 404);
    const policyRoutePatch = await requestJson(
      origin,
      `/api/v1/matters/${routeMatter.project.id}/policy`,
      {
        method: "PATCH",
        body: {
          external_egress_mode: "approval",
          execution_locations: ["confidential_remote"],
          allow_external_legal_sources: false,
          allow_word_bridge: true,
        },
      },
    );
    assert.equal(policyRoutePatch.status, 200);
    const policyRouteWire = MatterPolicyWireSchema.parse(policyRoutePatch.body);
    assert.equal(policyRouteWire.external_egress_mode, "approval");
    assert.deepEqual(policyRouteWire.execution_locations, ["confidential_remote"]);
    assert.equal(policyRouteWire.allow_word_bridge, true);
    const policyRouteGet = await requestJson(
      origin,
      `/api/v1/matters/${routeMatter.project.id}/policy`,
    );
    assert.equal(policyRouteGet.status, 200);
    assert.deepEqual(
      MatterPolicyWireSchema.parse(policyRouteGet.body),
      policyRouteWire,
    );

    const combinedRoutePatch = await requestJson(
      origin,
      `/api/v1/matters/${routeMatter.project.id}`,
      {
        method: "PATCH",
        body: {
          project: {
            name: "HTTP Matter Updated",
            cm_number: "HTTP-002",
            practice: "Transactions",
          },
          profile: {
            workspace_type: "transaction",
            client_name: "HTTP Client Updated",
          },
        },
      },
    );
    assert.equal(combinedRoutePatch.status, 200);
    const combinedRouteWire = MatterViewWireSchema.parse(
      combinedRoutePatch.body,
    );
    assert.equal(combinedRouteWire.project.name, "HTTP Matter Updated");
    assert.equal(combinedRouteWire.project.cm_number, "HTTP-002");
    assert.equal(
      combinedRouteWire.matter_profile?.workspace_type,
      "transaction",
    );
    assert.equal(
      combinedRouteWire.matter_profile?.client_name,
      "HTTP Client Updated",
    );
    assert.equal(
      combinedRouteWire.project.updated_at,
      combinedRouteWire.matter_profile?.updated_at,
    );
    assert.equal(JSON.stringify(combinedRoutePatch.body).includes("matter_type"), false);
    assert.equal(
      (
        await requestJson(
          origin,
          `/api/v1/matters/${routeMatter.project.id}`,
          {
            method: "PATCH",
            body: {
              matter_profile: { workspace_type: "research" },
            },
          },
        )
      ).status,
      400,
    );

    projects.unarchive(legacyProjectId, "2027-02-01T00:00:00.004Z");
    const classifyLegacy = await requestJson(
      origin,
      `/api/v1/projects/${legacyProjectId}/matter-profile`,
      {
        method: "PATCH",
        body: {
          workspace_type: "dispute",
          jurisdiction: "PRC",
        },
      },
    );
    assert.equal(classifyLegacy.status, 200);
    const classifiedLegacy = MatterViewWireSchema.parse(classifyLegacy.body);
    assert.equal(classifiedLegacy.profile_state, "ready");
    assert.equal(classifiedLegacy.capabilities.matter_profile, "edit");
    assert.equal(
      database
        .prepare("SELECT matter_type FROM matter_profiles WHERE project_id = ?")
        .get(legacyProjectId)?.matter_type,
      "civil_litigation",
    );

    const routeMalformed = await requestJson(origin, "/api/v1/matters", {
      method: "POST",
      body: {
        name: "Secret enum",
        workspace_type: `${SECRET}${PRIVATE_PATH}`,
        court: PRIVATE_PATH,
      },
    });
    assert.equal(routeMalformed.status, 400);
    assertRedacted(routeMalformed.body);
    assert.ok(JSON.stringify(routeMalformed.body).includes("Invalid value."));

    const emptyPatch = await requestJson(
      origin,
      `/api/v1/projects/${routeMatter.project.id}/matter-profile`,
      { method: "PATCH", body: {} },
    );
    assert.equal(emptyPatch.status, 400);
    assertRedacted(emptyPatch.body);

    await closeServer(server);
    server = null;

    const cascade = service.createMatter(localContext, {
      name: "Cascade Matter",
      workspaceType: "general_legal",
    });
    database.close();
    database = null;

    const reopened = new WorkspaceDatabase(databasePath);
    database = reopened;
    const restartedProjects = new ProjectsRepository(reopened);
    const restartedRepository = new MatterProfileRepository(reopened);
    const restartedOverview = new MatterOverviewRepository(reopened);
    const restarted = new MatterProfileService(
      reopened,
      restartedProjects,
      restartedRepository,
      restartedOverview,
      createProjectInferenceActivityPort(restartedProjects, () => []),
    );
    assert.equal(
      restarted.getMatter(localContext, created.project.id).profile
        ?.workspaceType,
      "transaction",
    );
    assert.equal(
      restarted.getMatter(localContext, legacyProjectId).profile?.workspaceType,
      "dispute",
    );
    assert.deepEqual(restartedRepository.readiness(), {
      status: "ready",
      schemaVersion: 17,
      inferencePolicy: "minimal_unified",
    });
    reopened
      .prepare("DELETE FROM projects WHERE id = ?")
      .run(cascade.project.id);
    assert.equal(
      Number(
        reopened
          .prepare(
            "SELECT count(*) AS count FROM matter_profiles WHERE project_id = ?",
          )
          .get(cascade.project.id)?.count,
      ),
      0,
    );

    const indexSource = readFileSync(
      path.join(process.cwd(), "src", "matter", "profile", "index.ts"),
      "utf8",
    );
    assert.equal(indexSource.includes("export *"), false);
    assert.equal(
      indexSource.includes("export { MatterProfileRepository"),
      false,
    );
    assert.equal(indexSource.includes("export { MatterProfileService"), false);
    const repositorySource = readFileSync(
      path.join(process.cwd(), "src", "matter", "profile", "repository.ts"),
      "utf8",
    );
    const overviewSource = readFileSync(
      path.join(
        process.cwd(),
        "src",
        "matter",
        "profile",
        "overviewRepository.ts",
      ),
      "utf8",
    );
    const serviceSource = readFileSync(
      path.join(process.cwd(), "src", "matter", "profile", "service.ts"),
      "utf8",
    );
    assert.equal(repositorySource.includes("INSERT INTO projects"), false);
    assert.equal(repositorySource.includes("UPDATE projects"), false);
    assert.equal(overviewSource.includes("INSERT INTO matter_profiles"), false);
    assert.equal(overviewSource.includes("UPDATE matter_profiles"), false);
    assert.equal(overviewSource.includes("INSERT INTO projects"), false);
    assert.equal(overviewSource.includes("UPDATE projects"), false);
    for (const ownerSource of [repositorySource, overviewSource]) {
      assert.equal(ownerSource.includes("BEGIN IMMEDIATE"), false);
      assert.equal(ownerSource.includes("COMMIT"), false);
      assert.equal(ownerSource.includes("ROLLBACK"), false);
    }
    assert.equal(
      serviceSource.match(/database\.exec\("BEGIN IMMEDIATE"\)/g)?.length,
      1,
      "Matter service is the sole write-transaction coordinator",
    );
    for (const filename of [
      "contracts.ts",
      "repository.ts",
      "overviewRepository.ts",
      "service.ts",
      "router.ts",
      "index.ts",
    ]) {
      const source = readFileSync(
        path.join(process.cwd(), "src", "matter", "profile", filename),
        "utf8",
      );
      assert.equal(source.includes("lib/aletheia"), false);
      assert.equal(source.includes("process.env"), false);
      assert.equal(source.includes("Keychain"), false);
    }

    reopened.exec("DROP TRIGGER inference_policy_decisions_v17_delete_guard");
    expectApiError(
      () => restartedRepository.readiness(),
      500,
      "INTERNAL_ERROR",
    );

    console.log(
      JSON.stringify({
        ok: true,
        suite: "vera-matter-profile-module-v16",
        checks: [
          "v15 null classification is explicit and old litigation fields stay private",
          "new writers require WorkspaceType and persist the general compatibility sentinel",
          "generic Projects remain absent with Workspace-compatible inference",
          "single-query pagination, counts, left join and no N+1",
          "separate Profile/Project/Overview owners under one service transaction",
          "queued/running and frozen in-flight inference conversion gates",
          "overlapping fenced attempts retain independent controller scopes",
          "owner deletion cannot erase registered handler Project scope",
          "serialized enqueue retries stop at the final model policy gate",
          "archived/deleted capabilities, write gates and monotonic timestamps",
          "strict authentication, local principal, lifecycle and redaction",
          "truthful v17 readiness and operation-specific fail-closed inference capability",
          "restart persistence and Project-delete cascade",
          "all six Matter/Profile routes and narrow module exports",
        ],
      }),
    );
  } finally {
    await closeServer(server);
    database?.close();
    if (originalEncryption === undefined) {
      delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    } else {
      process.env.ALETHEIA_DATABASE_ENCRYPTION = originalEncryption;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("Vera Matter Profile module audit failed.");
  if (error instanceof WorkspaceApiError) {
    console.error(`${error.code}: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  }
  process.exitCode = 1;
});
