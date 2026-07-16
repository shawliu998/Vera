import { WorkspaceApiError } from "../../lib/workspace/errors";
import type { WorkspaceDatabaseAdapter } from "../../lib/workspace/migrations";
import { WorkspaceIdSchema } from "../../lib/workspace/workspacePersistencePrimitivesV1";
import {
  MatterPolicySchema,
  type MatterPolicy,
} from "./contracts";

type Row = Record<string, unknown>;

function internal(message: string): never {
  throw new WorkspaceApiError(500, "INTERNAL_ERROR", message);
}

function mapPolicy(row: Row, locations: readonly unknown[]): MatterPolicy {
  try {
    return MatterPolicySchema.parse({
      projectId: row.project_id,
      externalEgressMode: row.external_egress_mode,
      executionLocations: locations,
      allowExternalLegalSources: row.allow_external_legal_sources === 1,
      allowWordBridge: row.allow_word_bridge === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch {
    internal("Persisted Matter Policy is invalid.");
  }
}

export interface MatterPolicyPersistencePort {
  readonly database: WorkspaceDatabaseAdapter;
  get(projectId: string): MatterPolicy | null;
  require(projectId: string): MatterPolicy;
  replace(policy: MatterPolicy): MatterPolicy;
}

/** Policy-only persistence owner. Transaction coordination lives in service. */
export class MatterPolicyRepository implements MatterPolicyPersistencePort {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}

  private safe<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Matter Policy data operation failed.",
      );
    }
  }

  get(projectIdValue: string): MatterPolicy | null {
    return this.safe(() => {
      const projectId = WorkspaceIdSchema.parse(projectIdValue);
      const row = this.database
        .prepare(
          `SELECT project_id, external_egress_mode,
                  allow_external_legal_sources, allow_word_bridge,
                  created_at, updated_at
             FROM matter_policies
            WHERE project_id = ?`,
        )
        .get(projectId);
      if (!row) return null;
      const locations = this.database
        .prepare(
          `SELECT execution_location
             FROM matter_policy_execution_locations
            WHERE project_id = ?
            ORDER BY execution_location ASC`,
        )
        .all(projectId)
        .map((location) => location.execution_location);
      return mapPolicy(row, locations);
    });
  }

  require(projectId: string): MatterPolicy {
    return this.safe(() => {
      const policy = this.get(projectId);
      if (!policy) {
        throw new WorkspaceApiError(
          404,
          "NOT_FOUND",
          "Matter Policy not found.",
        );
      }
      return policy;
    });
  }

  replace(value: MatterPolicy): MatterPolicy {
    return this.safe(() => {
      const policy = MatterPolicySchema.parse(value);
      const existing = this.get(policy.projectId);
      if (existing) {
        this.database
          .prepare(
            `UPDATE matter_policies
                SET external_egress_mode = ?,
                    allow_external_legal_sources = ?,
                    allow_word_bridge = ?,
                    updated_at = ?
              WHERE project_id = ?`,
          )
          .run(
            policy.externalEgressMode,
            policy.allowExternalLegalSources ? 1 : 0,
            policy.allowWordBridge ? 1 : 0,
            policy.updatedAt,
            policy.projectId,
          );
      } else {
        this.database
          .prepare(
            `INSERT INTO matter_policies (
               project_id, external_egress_mode,
               allow_external_legal_sources, allow_word_bridge,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            policy.projectId,
            policy.externalEgressMode,
            policy.allowExternalLegalSources ? 1 : 0,
            policy.allowWordBridge ? 1 : 0,
            policy.createdAt,
            policy.updatedAt,
          );
      }
      this.database
        .prepare(
          "DELETE FROM matter_policy_execution_locations WHERE project_id = ?",
        )
        .run(policy.projectId);
      const insert = this.database.prepare(
        `INSERT INTO matter_policy_execution_locations
           (project_id, execution_location, created_at)
         VALUES (?, ?, ?)`,
      );
      for (const location of policy.executionLocations) {
        insert.run(policy.projectId, location, policy.updatedAt);
      }
      return this.require(policy.projectId);
    });
  }
}
