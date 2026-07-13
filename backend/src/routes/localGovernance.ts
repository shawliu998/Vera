import { Router, type Response } from "express";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  GOVERNANCE_ROLES,
  GovernancePolicyError,
  LocalGovernanceService,
  MATTER_CLASSIFICATIONS,
  type GovernanceRole,
  type MatterClassification,
} from "../lib/aletheia/localGovernance";
import { requireAuth } from "../middleware/auth";
import { LocalIdentityRepository } from "../lib/aletheia/localIdentity";

export const localGovernanceRouter = Router();

let singleton: LocalGovernanceService | null = null;
let identitySingleton: LocalIdentityRepository | null = null;

function service() {
  if (!singleton) {
    createAletheiaRepository();
    singleton = new LocalGovernanceService();
  }
  return singleton;
}

function identities() {
  if (!identitySingleton) identitySingleton = new LocalIdentityRepository();
  return identitySingleton;
}

function assertMultiPrincipalIdentityEnabled() {
  if (!service().multiPrincipalEnabled) {
    throw new GovernancePolicyError(
      "Principal token issuance is disabled unless multi-principal private-token mode is explicitly enabled",
      "POLICY_DISABLED",
    );
  }
}

function principalId(res: Response) {
  return String(res.locals.userId);
}

function text(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function nullableText(value: unknown, maximum: number) {
  const result = text(value, maximum);
  return result || null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function role(value: unknown): GovernanceRole | null {
  return typeof value === "string" &&
    (GOVERNANCE_ROLES as readonly string[]).includes(value)
    ? (value as GovernanceRole)
    : null;
}

function roles(value: unknown) {
  return Array.isArray(value)
    ? value.map(role).filter((item): item is GovernanceRole => item !== null)
    : [];
}

function classification(value: unknown): MatterClassification | undefined {
  return typeof value === "string" &&
    (MATTER_CLASSIFICATIONS as readonly string[]).includes(value)
    ? (value as MatterClassification)
    : undefined;
}

function optionalInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function optionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function handleError(res: Response, error: unknown) {
  if (error instanceof GovernancePolicyError) {
    res.status(error.status).json({ code: error.code, detail: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE constraint failed")) {
    res
      .status(409)
      .json({ code: "duplicate", detail: "Record already exists" });
    return;
  }
  res.status(500).json({ detail: message });
}

async function audit(
  res: Response,
  matterId: string,
  action: string,
  details: Record<string, unknown>,
) {
  await createAletheiaRepository().appendAuditEvent(
    { userId: principalId(res) },
    matterId,
    {
      actor: "human",
      action,
      workflowVersion: "aletheia-local-governance-v1",
      model: null,
      details,
    },
  );
}

localGovernanceRouter.post(
  "/governance/principals",
  requireAuth,
  (req, res) => {
    const id = text(req.body?.id, 160);
    const displayName = text(req.body?.displayName, 200);
    if (!id || !displayName || !/^[a-zA-Z0-9_.:@-]+$/.test(id)) {
      return void res
        .status(400)
        .json({ detail: "Valid id and displayName are required" });
    }
    try {
      const result = service().createPrincipal(principalId(res), {
        id,
        displayName,
        roles: roles(req.body?.roles),
      });
      res.status(201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.put(
  "/governance/principals/:principalId/roles/:role",
  requireAuth,
  (req, res) => {
    const selectedRole = role(req.params.role);
    if (!selectedRole)
      return void res.status(400).json({ detail: "Invalid role" });
    try {
      res.json(
        service().assignGlobalRole(
          principalId(res),
          req.params.principalId,
          selectedRole,
        ),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.post(
  "/governance/principals/:principalId/tokens",
  requireAuth,
  (req, res) => {
    try {
      assertMultiPrincipalIdentityEnabled();
      service().assertAdministrator(principalId(res));
      const target = service().principal(req.params.principalId);
      if (!target)
        return void res.status(404).json({ detail: "Principal not found" });
      const expiresInSeconds = optionalInteger(req.body?.expiresInSeconds);
      const result = identities().issueToken({
        principalId: req.params.principalId,
        createdBy: principalId(res),
        label: nullableText(req.body?.label, 200),
        email: nullableText(req.body?.email, 320),
        expiresInSeconds,
      });
      res.status(201).json({
        ...result,
        warning:
          "This bearer token is shown once. Store it securely; only its SHA-256 hash is persisted.",
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.get(
  "/governance/principals/:principalId/tokens",
  requireAuth,
  (req, res) => {
    try {
      assertMultiPrincipalIdentityEnabled();
      service().assertAdministrator(principalId(res));
      if (!service().principal(req.params.principalId)) {
        return void res.status(404).json({ detail: "Principal not found" });
      }
      res.json(identities().listTokens(req.params.principalId));
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.post(
  "/governance/principals/:principalId/tokens/:tokenId/revoke",
  requireAuth,
  (req, res) => {
    try {
      assertMultiPrincipalIdentityEnabled();
      service().assertAdministrator(principalId(res));
      const result = identities().revokeToken({
        tokenId: req.params.tokenId,
        principalId: req.params.principalId,
        revokedBy: principalId(res),
      });
      if (!result) {
        return void res
          .status(404)
          .json({ detail: "Active token not found for this principal" });
      }
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.get(
  "/matters/:matterId/governance",
  requireAuth,
  (req, res) => {
    try {
      res.json(service().governance(principalId(res), req.params.matterId));
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.put(
  "/matters/:matterId/governance",
  requireAuth,
  async (req, res) => {
    const selectedClassification =
      req.body?.classification === undefined
        ? undefined
        : classification(req.body.classification);
    if (req.body?.classification !== undefined && !selectedClassification) {
      return void res.status(400).json({ detail: "Invalid classification" });
    }
    try {
      const result = service().updateGovernance(
        principalId(res),
        req.params.matterId,
        {
          classification: selectedClassification,
          legalHold: optionalBoolean(req.body?.legalHold),
          legalHoldReason:
            req.body?.legalHoldReason === undefined
              ? undefined
              : nullableText(req.body.legalHoldReason, 1_000),
          retentionDays:
            req.body?.retentionDays === null
              ? null
              : optionalInteger(req.body?.retentionDays),
          dispositionAt:
            req.body?.dispositionAt === undefined
              ? undefined
              : nullableText(req.body.dispositionAt, 80),
          evidenceLocked: optionalBoolean(req.body?.evidenceLocked),
          evidenceLockReason:
            req.body?.evidenceLockReason === undefined
              ? undefined
              : nullableText(req.body.evidenceLockReason, 1_000),
        },
      );
      await audit(res, req.params.matterId, "matter_governance_updated", {
        classification: result.classification,
        legalHold: result.legal_hold,
        evidenceLocked: result.evidence_locked,
        retentionDays: result.retention_days,
        dispositionAt: result.disposition_at,
      });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.get(
  "/matters/:matterId/governance/acl",
  requireAuth,
  (req, res) => {
    try {
      res.json(service().listMatterAcl(principalId(res), req.params.matterId));
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.put(
  "/matters/:matterId/governance/acl/:principalId",
  requireAuth,
  async (req, res) => {
    const selectedRole = role(req.body?.role);
    if (!selectedRole)
      return void res.status(400).json({ detail: "Invalid role" });
    try {
      const result = service().setMatterAcl(
        principalId(res),
        req.params.matterId,
        req.params.principalId,
        selectedRole,
      );
      await audit(res, req.params.matterId, "matter_acl_updated", {
        principalId: req.params.principalId,
        role: selectedRole,
      });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.get(
  "/matters/:matterId/governance/dlp-findings",
  requireAuth,
  (req, res) => {
    try {
      res.json(
        service().listDlpFindings(principalId(res), req.params.matterId),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.put(
  "/matters/:matterId/governance/approval-policies/:action",
  requireAuth,
  async (req, res) => {
    const action = text(req.params.action, 120);
    const eligibleRoles = roles(req.body?.eligibleRoles);
    try {
      const result = service().setApprovalPolicy(
        principalId(res),
        req.params.matterId,
        {
          action,
          requiredApprovals: optionalInteger(req.body?.requiredApprovals) ?? 0,
          eligibleRoles,
          requireDistinctRoles: optionalBoolean(req.body?.requireDistinctRoles),
          prohibitRequester: optionalBoolean(req.body?.prohibitRequester),
          enabled: optionalBoolean(req.body?.enabled),
        },
      );
      await audit(res, req.params.matterId, "approval_policy_updated", {
        action,
        requiredApprovals: result?.required_approvals,
        eligibleRoles: result?.eligible_roles,
        enabled: result?.enabled,
        disabledReason: result?.disabled_reason,
      });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.post(
  "/matters/:matterId/governance/approval-requests",
  requireAuth,
  async (req, res) => {
    const action = text(req.body?.action, 120);
    if (!action)
      return void res.status(400).json({ detail: "action is required" });
    try {
      const result = service().requestApproval(
        principalId(res),
        req.params.matterId,
        action,
        object(req.body?.requestedPayload),
      );
      await audit(res, req.params.matterId, "governance_approval_requested", {
        requestId: result?.id,
        action,
      });
      res.status(201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

localGovernanceRouter.post(
  "/governance/approval-requests/:requestId/votes",
  requireAuth,
  async (req, res) => {
    const decision = req.body?.decision;
    if (decision !== "approved" && decision !== "rejected") {
      return void res
        .status(400)
        .json({ detail: "decision must be approved or rejected" });
    }
    try {
      const result = service().voteApproval(
        principalId(res),
        req.params.requestId,
        decision,
        nullableText(req.body?.comment, 1_000),
      );
      if (!result)
        return void res.status(404).json({ detail: "Request not found" });
      await audit(res, String(result.matter_id), "governance_approval_voted", {
        requestId: req.params.requestId,
        decision,
        status: result.status,
      });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);
