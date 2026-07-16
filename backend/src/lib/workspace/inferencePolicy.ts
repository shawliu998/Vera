import { randomUUID } from "node:crypto";
import { z } from "zod";

import { WorkspaceApiError } from "./errors";
import type { WorkspaceDatabaseAdapter } from "./migrations";
import { WorkspaceIdSchema } from "./workspacePersistencePrimitivesV1";

export const ExecutionLocationSchema = z.enum([
  "local",
  "firm_private",
  "confidential_remote",
  "standard_remote",
]);
export const ModelRetentionSchema = z.enum([
  "zero",
  "provider_declared",
  "unknown",
]);
export const ModelTrainingUseSchema = z.enum([
  "prohibited",
  "provider_declared",
  "unknown",
]);
export const InferenceOperationSchema = z.enum([
  "assistant",
  "workflow_prompt",
  "tabular_generation",
  "studio_suggestion",
]);

export type ExecutionLocation = z.infer<typeof ExecutionLocationSchema>;
export type ModelRetention = z.infer<typeof ModelRetentionSchema>;
export type ModelTrainingUse = z.infer<typeof ModelTrainingUseSchema>;
export type InferenceOperation = z.infer<typeof InferenceOperationSchema>;

export type ModelProfilePrivacy = Readonly<{
  modelProfileId: string;
  executionLocation: ExecutionLocation;
  retention: ModelRetention;
  trainingUse: ModelTrainingUse;
  sensitiveDataAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type InferenceScope =
  | Readonly<{
      scope: "global";
      projectId: null;
      matterProfilePresent: false;
    }>
  | Readonly<{
      scope: "project";
      projectId: string;
      matterProfilePresent: false;
    }>
  | Readonly<{
      scope: "matter";
      projectId: string;
      matterProfilePresent: true;
    }>;

export type InferenceDecision =
  | Readonly<{
      decision: "allow";
      reasonCode: string;
      executionLocation: ExecutionLocation;
    }>
  | Readonly<{
      decision: "require_approval";
      reasonCode: string;
      executionLocation: ExecutionLocation;
    }>
  | Readonly<{
      decision: "deny";
      reasonCode: string;
    }>;

export type InferencePolicyInput = Readonly<{
  scope: InferenceScope;
  modelProfileId: string;
  operation: InferenceOperation;
  sourceSnapshotIds?: readonly string[];
}>;

export interface InferencePolicyPort {
  evaluate(input: InferencePolicyInput): InferenceDecision;
}

export interface InferencePolicyEnforcementPort extends InferencePolicyPort {
  resolveScope(projectId: string | null): InferenceScope;
  assertAllowed(input: InferencePolicyInput): InferenceDecision & {
    decision: "allow";
  };
}

export const INFERENCE_POLICY_DENIED_MESSAGE =
  "Inference is unavailable under the configured privacy policy.";
export const INFERENCE_POLICY_APPROVAL_MESSAGE =
  "Inference requires approval under the configured privacy policy.";

const PrivacyDeclarationSchema = z
  .object({
    executionLocation: ExecutionLocationSchema,
    retention: ModelRetentionSchema,
    trainingUse: ModelTrainingUseSchema,
    sensitiveDataAllowed: z.boolean(),
  })
  .strict();

type Row = Record<string, unknown>;

function privacyFromRow(row: Row): ModelProfilePrivacy {
  return {
    modelProfileId: WorkspaceIdSchema.parse(row.model_profile_id),
    executionLocation: ExecutionLocationSchema.parse(row.execution_location),
    retention: ModelRetentionSchema.parse(row.retention),
    trainingUse: ModelTrainingUseSchema.parse(row.training_use),
    sensitiveDataAllowed: row.sensitive_data_allowed === 1,
    createdAt: z.string().datetime({ offset: false }).parse(row.created_at),
    updatedAt: z.string().datetime({ offset: false }).parse(row.updated_at),
  };
}

/** Persistence boundary for explicit, user/administrator-declared metadata. */
export class ModelProfilePrivacyRepository {
  constructor(private readonly database: WorkspaceDatabaseAdapter) {}

  get(modelProfileId: string): ModelProfilePrivacy | null {
    const id = WorkspaceIdSchema.parse(modelProfileId);
    const row = this.database
      .prepare(
        `SELECT model_profile_id, execution_location, retention, training_use,
                sensitive_data_allowed, created_at, updated_at
           FROM model_profile_privacy
          WHERE model_profile_id = ?`,
      )
      .get(id);
    return row ? privacyFromRow(row) : null;
  }

  declare(
    modelProfileId: string,
    value: unknown,
    now = new Date().toISOString(),
  ): ModelProfilePrivacy {
    const id = WorkspaceIdSchema.parse(modelProfileId);
    const input = PrivacyDeclarationSchema.parse(value);
    const timestamp = z.string().datetime({ offset: false }).parse(now);
    const existing = this.get(id);
    if (existing && Date.parse(timestamp) <= Date.parse(existing.updatedAt)) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model privacy declaration time must move forwards.",
      );
    }
    this.database
      .prepare(
        `INSERT INTO model_profile_privacy
           (model_profile_id, execution_location, retention, training_use,
            sensitive_data_allowed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_profile_id) DO UPDATE SET
           execution_location = excluded.execution_location,
           retention = excluded.retention,
           training_use = excluded.training_use,
           sensitive_data_allowed = excluded.sensitive_data_allowed,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.executionLocation,
        input.retention,
        input.trainingUse,
        input.sensitiveDataAllowed ? 1 : 0,
        timestamp,
        timestamp,
      );
    const declared = this.get(id);
    if (!declared) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Model privacy declaration was not persisted.",
      );
    }
    return declared;
  }

  delete(modelProfileId: string): void {
    this.database
      .prepare("DELETE FROM model_profile_privacy WHERE model_profile_id = ?")
      .run(WorkspaceIdSchema.parse(modelProfileId));
  }
}

type MatterPolicyRecord = Readonly<{
  externalEgressMode: "disabled" | "approval" | "allowed_by_policy";
  executionLocations: readonly ExecutionLocation[];
}>;

function denied(reasonCode: string): InferenceDecision {
  return { decision: "deny", reasonCode };
}

/**
 * The single authoritative Workspace inference policy. It resolves scope from
 * durable state, never trusts a caller to downgrade a Matter to a Project, and
 * never infers execution location from base_url/provider/model metadata.
 */
export class WorkspaceInferencePolicy implements InferencePolicyEnforcementPort {
  private readonly privacy: ModelProfilePrivacyRepository;

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly createId: () => string = randomUUID,
  ) {
    this.privacy = new ModelProfilePrivacyRepository(database);
  }

  resolveScope(projectId: string | null): InferenceScope {
    if (projectId === null) {
      return { scope: "global", projectId: null, matterProfilePresent: false };
    }
    const id = WorkspaceIdSchema.parse(projectId);
    const project = this.database
      .prepare("SELECT id, status FROM projects WHERE id = ?")
      .get(id);
    if (!project) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
    }
    if (project.status !== "active") {
      throw new WorkspaceApiError(409, "CONFLICT", "Project is not active.");
    }
    const matter = this.database
      .prepare("SELECT 1 AS present FROM matter_profiles WHERE project_id = ?")
      .get(id);
    return matter
      ? { scope: "matter", projectId: id, matterProfilePresent: true }
      : { scope: "project", projectId: id, matterProfilePresent: false };
  }

  private matterPolicy(projectId: string): MatterPolicyRecord | null {
    const row = this.database
      .prepare(
        `SELECT external_egress_mode
           FROM matter_policies
          WHERE project_id = ?`,
      )
      .get(projectId);
    if (!row) return null;
    const externalEgressMode = z
      .enum(["disabled", "approval", "allowed_by_policy"])
      .parse(row.external_egress_mode);
    const executionLocations = this.database
      .prepare(
        `SELECT execution_location
           FROM matter_policy_execution_locations
          WHERE project_id = ?
          ORDER BY execution_location ASC`,
      )
      .all(projectId)
      .map((location) =>
        ExecutionLocationSchema.parse(location.execution_location),
      );
    return { externalEgressMode, executionLocations };
  }

  private record(
    input: InferencePolicyInput,
    actualScope: InferenceScope,
    decision: InferenceDecision,
    modelProfilePresent: boolean,
  ) {
    const sourceSnapshotCount = input.sourceSnapshotIds?.length ?? 0;
    if (
      !Number.isSafeInteger(sourceSnapshotCount) ||
      sourceSnapshotCount > 100_000
    ) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Inference source snapshot count is invalid.",
      );
    }
    this.database
      .prepare(
        `INSERT INTO inference_policy_decisions
           (id, scope, project_id, model_profile_id, operation, decision,
            reason_code, execution_location, source_snapshot_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.createId(),
        actualScope.scope,
        actualScope.projectId,
        modelProfilePresent ? input.modelProfileId : null,
        input.operation,
        decision.decision,
        decision.reasonCode,
        "executionLocation" in decision ? decision.executionLocation : null,
        sourceSnapshotCount,
      );
  }

  private decide(input: InferencePolicyInput) {
    InferenceOperationSchema.parse(input.operation);
    const modelProfileId = WorkspaceIdSchema.parse(input.modelProfileId);
    const actualScope = this.resolveScope(input.scope.projectId);
    const scopeMatches =
      actualScope.scope === input.scope.scope &&
      actualScope.matterProfilePresent === input.scope.matterProfilePresent;
    const modelProfilePresent = Boolean(
      this.database
        .prepare(
          "SELECT 1 AS present FROM model_profiles WHERE id = ? AND enabled = 1",
        )
        .get(modelProfileId),
    );

    let decision: InferenceDecision;
    if (!scopeMatches) {
      decision = denied("scope_mismatch");
    } else if (!modelProfilePresent) {
      decision = denied("model_profile_unavailable");
    } else {
      const privacy = this.privacy.get(modelProfileId);
      if (!privacy) {
        decision = denied("model_privacy_missing");
      } else if (privacy.retention === "unknown") {
        decision = denied("model_retention_unknown");
      } else if (privacy.trainingUse === "unknown") {
        decision = denied("model_training_use_unknown");
      } else if (!privacy.sensitiveDataAllowed) {
        decision = denied("sensitive_data_not_allowed");
      } else if (actualScope.scope !== "matter") {
        decision = {
          decision: "allow",
          reasonCode: "workspace_policy_allowed",
          executionLocation: privacy.executionLocation,
        };
      } else {
        const matterPolicy = this.matterPolicy(actualScope.projectId);
        if (!matterPolicy) {
          decision = denied("matter_policy_missing");
        } else if (
          !matterPolicy.executionLocations.includes(privacy.executionLocation)
        ) {
          decision = denied("execution_location_not_allowed");
        } else if (privacy.executionLocation === "local") {
          decision = {
            decision: "allow",
            reasonCode: "matter_local_allowed",
            executionLocation: privacy.executionLocation,
          };
        } else if (matterPolicy.externalEgressMode === "disabled") {
          decision = denied("matter_external_egress_disabled");
        } else if (matterPolicy.externalEgressMode === "approval") {
          decision = {
            decision: "require_approval",
            reasonCode: "matter_external_egress_requires_approval",
            executionLocation: privacy.executionLocation,
          };
        } else {
          decision = {
            decision: "allow",
            reasonCode: "matter_remote_allowed_by_policy",
            executionLocation: privacy.executionLocation,
          };
        }
      }
    }
    return {
      input: { ...input, modelProfileId },
      actualScope,
      decision,
      modelProfilePresent,
    };
  }

  /** Side-effect-free projection used by capability and settings reads. */
  evaluate(input: InferencePolicyInput): InferenceDecision {
    return this.decide(input).decision;
  }

  assertAllowed(input: InferencePolicyInput) {
    const evaluated = this.decide(input);
    this.record(
      evaluated.input,
      evaluated.actualScope,
      evaluated.decision,
      evaluated.modelProfilePresent,
    );
    const decision = evaluated.decision;
    if (decision.decision === "require_approval") {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        INFERENCE_POLICY_APPROVAL_MESSAGE,
      );
    }
    if (decision.decision === "deny") {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        INFERENCE_POLICY_DENIED_MESSAGE,
      );
    }
    return decision;
  }
}

export function assertInferenceAllowed(
  policy: InferencePolicyEnforcementPort,
  input: Omit<InferencePolicyInput, "scope"> & { projectId: string | null },
) {
  return policy.assertAllowed({
    scope: policy.resolveScope(input.projectId),
    modelProfileId: input.modelProfileId,
    operation: input.operation,
    ...(input.sourceSnapshotIds
      ? { sourceSnapshotIds: input.sourceSnapshotIds }
      : {}),
  });
}
