import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

import { WorkspaceApiError } from "../../lib/workspace/errors";
import type { WorkspaceDatabaseAdapter } from "../../lib/workspace/migrations";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../../lib/workspace/principal";
import type { WorkspaceInferenceActivityScope } from "../../lib/workspace/jobs/types";
import {
  type ProjectInferenceActivityReadPort,
  ProjectsRepository,
} from "../../lib/workspace/repositories/projects";
import { WorkspaceIdSchema } from "../../lib/workspace/workspacePersistencePrimitivesV1";
import {
  CreateMatterProfileRequestSchema,
  CreateMatterRequestSchema,
  MatterListRequestSchema,
  MatterProfileSchema,
  UpdateMatterProfileRequestSchema,
  safeMatterValidationDetails,
  type CreateMatterProfileRequest,
} from "./contracts";
import type { MatterOverviewReadPort } from "./overviewRepository";
import type { MatterProfilePersistencePort } from "./repository";

export type MatterProfileServiceContext = { principalId: string };

export type MatterProfileServiceOptions = {
  clock?: () => Date;
  nextId?: () => string;
  acceptingRequests?: () => boolean;
};

/** Narrow policy seam: no job payload, controller, or cancellation authority. */
export interface ProjectInferenceActivityPort {
  hasBlockingInferenceWork(projectId: string): boolean;
}

/**
 * Composes the canonical Project ownership query with a copied handler
 * registry snapshot. The synchronous call is made inside `BEGIN IMMEDIATE`.
 */
export function createProjectInferenceActivityPort(
  projects: ProjectInferenceActivityReadPort,
  activeInferenceScopes: () => readonly WorkspaceInferenceActivityScope[],
): ProjectInferenceActivityPort {
  return Object.freeze({
    hasBlockingInferenceWork(projectId: string) {
      return projects.hasBlockingInferenceJobs(
        projectId,
        activeInferenceScopes(),
      );
    },
  });
}

function internal(message: string): never {
  throw new WorkspaceApiError(500, "INTERNAL_ERROR", message);
}

function nextTimestamp(now: string, priorValues: readonly string[]): string {
  const nowMillis = Date.parse(now);
  const priorMillis = priorValues.map((value) => Date.parse(value));
  if (
    !Number.isFinite(nowMillis) ||
    priorMillis.some((value) => !Number.isFinite(value))
  ) {
    internal("Matter Profile timestamp state is invalid.");
  }
  const nextMillis = Math.max(
    nowMillis,
    ...priorMillis.map((value) => value + 1),
  );
  try {
    return new Date(nextMillis).toISOString();
  } catch {
    internal("Matter Profile timestamp state is invalid.");
  }
}

function profileForCreate(
  projectId: string,
  request: CreateMatterProfileRequest,
  now: string,
) {
  return MatterProfileSchema.parse({
    projectId,
    workspaceType: request.workspaceType,
    clientName: request.clientName ?? null,
    jurisdiction: request.jurisdiction ?? null,
    representedRole: request.representedRole ?? null,
    objective: request.objective ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Sole Matter write-transaction coordinator. Profile persistence, canonical
 * Project ownership and read-only overview projection remain separate ports.
 */
export class MatterProfileService {
  private readonly clock: () => Date;
  private readonly nextId: () => string;
  private readonly accepting: () => boolean;

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly projects: ProjectsRepository,
    private readonly profiles: MatterProfilePersistencePort,
    private readonly overview: MatterOverviewReadPort,
    private readonly inferenceActivity: ProjectInferenceActivityPort,
    options: MatterProfileServiceOptions = {},
  ) {
    if (
      projects.database !== database ||
      profiles.database !== database ||
      overview.database !== database
    ) {
      internal("Matter Profile repositories must share one database.");
    }
    this.clock = options.clock ?? (() => new Date());
    this.nextId = options.nextId ?? randomUUID;
    this.accepting = options.acceptingRequests ?? (() => true);
  }

  private requireAccess(context: MatterProfileServiceContext) {
    if (context.principalId !== WORKSPACE_LOCAL_PRINCIPAL_ID) {
      throw new WorkspaceApiError(403, "FORBIDDEN", "Workspace is local-only.");
    }
    if (!this.accepting()) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Matter runtime is not accepting requests.",
      );
    }
  }

  private now(): string {
    try {
      return this.clock().toISOString();
    } catch {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Matter Profile clock is unavailable.",
      );
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
      throw error;
    }
  }

  private publicCall<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      if (error instanceof ZodError) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Matter Profile request is invalid.",
          safeMatterValidationDetails(error),
        );
      }
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Matter Profile operation failed.",
      );
    }
  }

  private assertConversionSafe(projectId: string) {
    if (this.inferenceActivity.hasBlockingInferenceWork(projectId)) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Matter conversion is unavailable while inference work is active.",
      );
    }
  }

  health() {
    return this.publicCall(() => this.profiles.readiness());
  }

  listMatters(context: MatterProfileServiceContext, value: unknown = {}) {
    return this.publicCall(() => {
      this.requireAccess(context);
      return this.overview.list(MatterListRequestSchema.parse(value));
    });
  }

  getMatter(context: MatterProfileServiceContext, projectId: string) {
    return this.publicCall(() => {
      this.requireAccess(context);
      return this.overview.require(WorkspaceIdSchema.parse(projectId));
    });
  }

  getProjectMatterProfile(
    context: MatterProfileServiceContext,
    projectId: string,
  ) {
    return this.getMatter(context, projectId);
  }

  createMatter(context: MatterProfileServiceContext, value: unknown) {
    return this.publicCall(() => {
      this.requireAccess(context);
      const request = CreateMatterRequestSchema.parse(value);
      const projectId = this.nextId();
      if (!WorkspaceIdSchema.safeParse(projectId).success) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Matter identity generation failed.",
        );
      }
      const now = this.now();
      return this.transaction(() => {
        if (this.projects.get(projectId) !== null) {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Matter identity already exists.",
          );
        }
        this.projects.create({
          id: projectId,
          name: request.name,
          description: request.description ?? null,
          cmNumber: request.cmNumber ?? null,
          practice: request.practice ?? null,
          now,
        });
        this.profiles.insert(profileForCreate(projectId, request, now));
        return this.overview.require(projectId);
      });
    });
  }

  createProjectMatterProfile(
    context: MatterProfileServiceContext,
    projectId: string,
    value: unknown,
  ) {
    return this.publicCall(() => {
      this.requireAccess(context);
      const parsedProjectId = WorkspaceIdSchema.parse(projectId);
      const request = CreateMatterProfileRequestSchema.parse(value);
      return this.transaction(() => {
        const project = this.projects.requireActive(parsedProjectId);
        if (this.profiles.get(parsedProjectId) !== null) {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Matter Profile already exists.",
          );
        }
        this.assertConversionSafe(parsedProjectId);
        const timestamp = nextTimestamp(this.now(), [project.updatedAt]);
        this.profiles.insert(
          profileForCreate(parsedProjectId, request, timestamp),
        );
        this.projects.update(parsedProjectId, { now: timestamp });
        return this.overview.require(parsedProjectId);
      });
    });
  }

  updateProjectMatterProfile(
    context: MatterProfileServiceContext,
    projectId: string,
    value: unknown,
  ) {
    return this.publicCall(() => {
      this.requireAccess(context);
      const parsedProjectId = WorkspaceIdSchema.parse(projectId);
      const request = UpdateMatterProfileRequestSchema.parse(value);
      return this.transaction(() => {
        const project = this.projects.requireActive(parsedProjectId);
        const existing = this.profiles.require(parsedProjectId);
        if (
          existing.workspaceType === null &&
          request.workspaceType === undefined
        ) {
          throw new WorkspaceApiError(
            400,
            "VALIDATION_ERROR",
            "Matter workspace classification is required.",
          );
        }
        const timestamp = nextTimestamp(this.now(), [
          project.updatedAt,
          existing.updatedAt,
        ]);
        const profile = MatterProfileSchema.parse({
          ...existing,
          ...request,
          updatedAt: timestamp,
        });
        this.profiles.update(profile);
        this.projects.update(parsedProjectId, { now: timestamp });
        return this.overview.require(parsedProjectId);
      });
    });
  }
}
