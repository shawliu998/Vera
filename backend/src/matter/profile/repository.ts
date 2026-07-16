import { WorkspaceApiError } from "../../lib/workspace/errors";
import type { WorkspaceDatabaseAdapter } from "../../lib/workspace/migrations";
import { WorkspaceIdSchema } from "../../lib/workspace/workspacePersistencePrimitivesV1";
import { MatterProfileSchema, type MatterProfile } from "./contracts";

type Row = Record<string, unknown>;

const V15_NON_SEMANTIC_MATTER_TYPE_SENTINEL = "general";

function internal(message: string): never {
  throw new WorkspaceApiError(500, "INTERNAL_ERROR", message);
}

function mapProfile(row: Row): MatterProfile {
  try {
    return MatterProfileSchema.parse({
      projectId: row.project_id,
      workspaceType: row.workspace_type,
      clientName: row.client_name,
      jurisdiction: row.jurisdiction,
      representedRole: row.represented_role,
      objective: row.objective,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch {
    internal("Persisted Matter Profile is invalid.");
  }
}

export interface MatterProfilePersistencePort {
  readonly database: WorkspaceDatabaseAdapter;
  readiness(): {
    status: "ready";
    schemaVersion: 16;
    inferencePolicy: "gate_closed";
  };
  get(projectId: string): MatterProfile | null;
  require(projectId: string): MatterProfile;
  insert(profile: MatterProfile): MatterProfile;
  update(profile: MatterProfile): MatterProfile;
}

/** Profile-only persistence owner. Transaction coordination lives in service. */
export class MatterProfileRepository implements MatterProfilePersistencePort {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}

  private safe<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Matter Profile data operation failed.",
      );
    }
  }

  readiness(): {
    status: "ready";
    schemaVersion: 16;
    inferencePolicy: "gate_closed";
  } {
    return this.safe(() => {
      const migration = this.database
        .prepare(
          `SELECT name
             FROM workspace_schema_migrations
            WHERE version = 16`,
        )
        .get() as { name?: unknown } | undefined;
      if (migration?.name !== "matter_profile_classification") {
        internal("Matter Profile schema is unavailable.");
      }
      this.database
        .prepare(
          "SELECT workspace_type, jurisdiction FROM matter_profiles LIMIT 1",
        )
        .get();
      this.database
        .prepare("SELECT project_id FROM matter_policies LIMIT 1")
        .get();
      this.database
        .prepare(
          "SELECT project_id FROM matter_policy_execution_locations LIMIT 1",
        )
        .get();
      return {
        status: "ready" as const,
        schemaVersion: 16 as const,
        inferencePolicy: "gate_closed" as const,
      };
    });
  }

  get(projectIdValue: string): MatterProfile | null {
    return this.safe(() => {
      const projectId = WorkspaceIdSchema.safeParse(projectIdValue);
      if (!projectId.success) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Project id is invalid.",
        );
      }
      const row = this.database
        .prepare(
          `SELECT project_id, workspace_type, client_name, jurisdiction,
                  represented_role, objective, created_at, updated_at
             FROM matter_profiles
            WHERE project_id = ?`,
        )
        .get(projectId.data);
      return row ? mapProfile(row) : null;
    });
  }

  require(projectId: string): MatterProfile {
    return this.safe(() => {
      const profile = this.get(projectId);
      if (!profile) {
        throw new WorkspaceApiError(
          404,
          "NOT_FOUND",
          "Matter Profile not found.",
        );
      }
      return profile;
    });
  }

  insert(value: MatterProfile): MatterProfile {
    return this.safe(() => {
      const profile = MatterProfileSchema.parse(value);
      if (profile.workspaceType === null) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Matter workspace classification is required.",
        );
      }
      this.database
        .prepare(
          `INSERT INTO matter_profiles (
             project_id, matter_type, workspace_type, client_name, jurisdiction,
             represented_role, objective, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profile.projectId,
          V15_NON_SEMANTIC_MATTER_TYPE_SENTINEL,
          profile.workspaceType,
          profile.clientName,
          profile.jurisdiction,
          profile.representedRole,
          profile.objective,
          profile.createdAt,
          profile.updatedAt,
        );
      return this.require(profile.projectId);
    });
  }

  update(value: MatterProfile): MatterProfile {
    return this.safe(() => {
      const profile = MatterProfileSchema.parse(value);
      this.database
        .prepare(
          `UPDATE matter_profiles
              SET workspace_type = ?,
                  client_name = ?,
                  jurisdiction = ?,
                  represented_role = ?,
                  objective = ?,
                  updated_at = ?
            WHERE project_id = ?`,
        )
        .run(
          profile.workspaceType,
          profile.clientName,
          profile.jurisdiction,
          profile.representedRole,
          profile.objective,
          profile.updatedAt,
          profile.projectId,
        );
      return this.require(profile.projectId);
    });
  }
}
