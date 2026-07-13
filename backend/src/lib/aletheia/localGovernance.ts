import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LocalDatabase } from "./localDatabase";

export const GOVERNANCE_ROLES = [
  "admin",
  "counsel",
  "reviewer",
  "auditor",
  "operator",
] as const;
export type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];

export const MATTER_CLASSIFICATIONS = [
  "internal",
  "confidential",
  "restricted",
  "privileged",
] as const;
export type MatterClassification = (typeof MATTER_CLASSIFICATIONS)[number];

export type MatterPermission =
  | "matter.read"
  | "matter.write"
  | "matter.review"
  | "matter.export"
  | "matter.signoff"
  | "matter.anchor"
  | "matter.purge"
  | "governance.manage"
  | "approval.vote"
  | "audit.read"
  | "operations.manage";

const ROLE_PERMISSIONS: Record<
  GovernanceRole,
  ReadonlySet<MatterPermission>
> = {
  admin: new Set([
    "matter.read",
    "matter.write",
    "matter.review",
    "matter.export",
    "matter.signoff",
    "matter.anchor",
    "matter.purge",
    "governance.manage",
    "approval.vote",
    "audit.read",
    "operations.manage",
  ]),
  counsel: new Set([
    "matter.read",
    "matter.write",
    "matter.review",
    "matter.export",
    "matter.signoff",
    "matter.purge",
    "governance.manage",
    "approval.vote",
    "audit.read",
  ]),
  reviewer: new Set(["matter.read", "matter.review", "approval.vote"]),
  auditor: new Set(["matter.read", "audit.read", "approval.vote"]),
  operator: new Set(["operations.manage"]),
};

type SqlRow = Record<string, unknown>;
type ApprovalPolicyView = SqlRow & {
  required_approvals: number;
  disabled_reason: string | null;
  eligible_roles: GovernanceRole[];
  enabled: boolean;
  require_distinct_roles: boolean;
  prohibit_requester: boolean;
};
type ApprovalRequestView = SqlRow & {
  id: string;
  matter_id: string;
  status: string;
  requested_payload: Record<string, unknown>;
  votes: unknown[];
};
type GovernanceView = SqlRow & {
  classification: MatterClassification;
  legal_hold: boolean;
  evidence_locked: boolean;
  retention_days: unknown;
  disposition_at: unknown;
  approval_matrix: Record<string, unknown>;
};
type DlpFindingView = SqlRow & {
  finding_type: string;
  severity: string;
  details: Record<string, unknown>;
};

export class GovernancePolicyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "FORBIDDEN"
      | "LEGAL_HOLD"
      | "EVIDENCE_LOCKED"
      | "RETENTION_ACTIVE"
      | "APPROVAL_REQUIRED"
      | "POLICY_DISABLED"
      | "INVALID_POLICY",
    readonly status = 409,
  ) {
    super(message);
    this.name = "GovernancePolicyError";
  }
}

function now() {
  return new Date().toISOString();
}

function localDataDir() {
  return (
    process.env.ALETHEIA_DATA_DIR ??
    process.env.ALET_HEIA_DATA_DIR ??
    path.resolve(process.cwd(), ".data", "aletheia")
  );
}

function defaultDatabasePath() {
  const root = localDataDir();
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return path.join(root, "aletheia.db");
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parseArray(value: unknown) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isRole(value: string): value is GovernanceRole {
  return (GOVERNANCE_ROLES as readonly string[]).includes(value);
}

function classification(value: unknown): MatterClassification {
  return (MATTER_CLASSIFICATIONS as readonly unknown[]).includes(value)
    ? (value as MatterClassification)
    : "internal";
}

function findingSeverity(flag: string) {
  if (["privileged", "personal_data", "health", "minor"].includes(flag)) {
    return "high";
  }
  if (["confidential", "financial"].includes(flag)) return "medium";
  return "low";
}

function nullableSqlString(value: unknown) {
  return typeof value === "string" ? value : null;
}

export type LocalGovernanceOptions = {
  databasePath?: string;
  database?: LocalDatabase;
  multiPrincipalEnabled?: boolean;
};

export class LocalGovernanceService {
  private readonly db: LocalDatabase;
  private readonly ownsDatabase: boolean;
  readonly multiPrincipalEnabled: boolean;

  constructor(options: LocalGovernanceOptions = {}) {
    if (options.database) {
      this.db = options.database;
      this.ownsDatabase = false;
    } else {
      const databasePath = options.databasePath ?? defaultDatabasePath();
      this.db = new LocalDatabase(databasePath);
      this.db.exec("pragma journal_mode = WAL");
      this.db.exec("pragma foreign_keys = ON");
      this.db.exec("pragma busy_timeout = 5000");
      this.ownsDatabase = true;
    }
    const matterTable = this.db
      .prepare(
        "select name from sqlite_master where type = 'table' and name = 'aletheia_matters'",
      )
      .get();
    if (!matterTable) {
      if (this.ownsDatabase) this.db.close();
      throw new Error(
        "Local governance requires the initialized Aletheia repository schema",
      );
    }
    const authMode =
      process.env.ALETHEIA_AUTH_MODE ?? process.env.ALET_HEIA_AUTH_MODE;
    this.multiPrincipalEnabled =
      options.multiPrincipalEnabled ??
      (process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED === "true" &&
        authMode !== "single_user");
    this.ensureSchema();
  }

  close() {
    if (this.ownsDatabase) this.db.close();
  }

  private ensureSchema() {
    this.db.exec(`
      create table if not exists aletheia_principals (
        id text primary key,
        display_name text not null,
        status text not null default 'active',
        metadata text not null default '{}',
        created_at text not null,
        updated_at text not null
      );
      create table if not exists aletheia_principal_roles (
        principal_id text not null references aletheia_principals(id) on delete cascade,
        role text not null,
        granted_by text not null,
        created_at text not null,
        primary key(principal_id, role)
      );
      create table if not exists aletheia_matter_acl (
        matter_id text not null references aletheia_matters(id) on delete cascade,
        principal_id text not null references aletheia_principals(id) on delete cascade,
        role text not null,
        granted_by text not null,
        created_at text not null,
        updated_at text not null,
        primary key(matter_id, principal_id)
      );
      create table if not exists aletheia_matter_governance (
        matter_id text primary key references aletheia_matters(id) on delete cascade,
        classification text not null default 'internal',
        legal_hold integer not null default 0,
        legal_hold_reason text,
        retention_days integer,
        disposition_at text,
        evidence_locked integer not null default 0,
        evidence_lock_reason text,
        updated_by text not null,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists aletheia_approval_policies (
        id text primary key,
        matter_id text not null references aletheia_matters(id) on delete cascade,
        action text not null,
        required_approvals integer not null,
        eligible_roles text not null default '[]',
        require_distinct_roles integer not null default 0,
        prohibit_requester integer not null default 1,
        enabled integer not null default 0,
        disabled_reason text,
        updated_by text not null,
        created_at text not null,
        updated_at text not null,
        unique(matter_id, action)
      );
      create table if not exists aletheia_governance_approval_requests (
        id text primary key,
        matter_id text not null references aletheia_matters(id) on delete cascade,
        action text not null,
        requester_id text not null references aletheia_principals(id),
        status text not null default 'pending',
        requested_payload text not null default '{}',
        created_at text not null,
        decided_at text
      );
      create table if not exists aletheia_governance_approval_votes (
        id text primary key,
        request_id text not null references aletheia_governance_approval_requests(id) on delete cascade,
        principal_id text not null references aletheia_principals(id),
        role text not null,
        decision text not null,
        comment text,
        created_at text not null,
        unique(request_id, principal_id)
      );
      create table if not exists aletheia_dlp_findings (
        id text primary key,
        matter_id text not null references aletheia_matters(id) on delete cascade,
        document_id text,
        finding_type text not null,
        severity text not null,
        status text not null default 'open',
        details text not null default '{}',
        created_at text not null,
        updated_at text not null,
        unique(matter_id, document_id, finding_type)
      );
      create index if not exists idx_governance_approval_request
        on aletheia_governance_approval_requests(matter_id, action, status);
      create index if not exists idx_governance_dlp_matter
        on aletheia_dlp_findings(matter_id, status, severity);
    `);
  }

  private transaction<T>(operation: () => T) {
    this.db.exec("begin immediate");
    try {
      const result = operation();
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  ensurePrincipal(principalId: string, displayName = principalId) {
    const existing = this.db
      .prepare("select * from aletheia_principals where id = ?")
      .get(principalId) as SqlRow | undefined;
    if (existing) return existing;
    return this.transaction(() => {
      const adminCount = this.db
        .prepare(
          "select count(*) as count from aletheia_principal_roles where role = 'admin'",
        )
        .get() as { count?: number };
      const ownsMatter = this.db
        .prepare("select 1 from aletheia_matters where user_id = ? limit 1")
        .get(principalId);
      const configuredBootstrap =
        process.env.ALETHEIA_BOOTSTRAP_ADMIN_PRINCIPAL_ID?.trim() ||
        process.env.ALETHEIA_LOCAL_USER_ID?.trim();
      const timestamp = now();
      this.db
        .prepare(
          `insert or ignore into aletheia_principals
           (id, display_name, status, metadata, created_at, updated_at)
           values (?, ?, 'active', '{}', ?, ?)`,
        )
        .run(principalId, displayName.slice(0, 200), timestamp, timestamp);
      if (
        Number(adminCount.count ?? 0) === 0 &&
        (configuredBootstrap
          ? configuredBootstrap === principalId
          : Boolean(ownsMatter))
      ) {
        this.db
          .prepare(
            `insert or ignore into aletheia_principal_roles
             (principal_id, role, granted_by, created_at) values (?, 'admin', ?, ?)`,
          )
          .run(principalId, principalId, timestamp);
      }
      return this.db
        .prepare("select * from aletheia_principals where id = ?")
        .get(principalId) as SqlRow;
    });
  }

  createPrincipal(
    actorId: string,
    input: { id: string; displayName: string; roles?: GovernanceRole[] },
  ) {
    this.ensurePrincipal(actorId);
    this.assertGlobalAdmin(actorId);
    const timestamp = now();
    this.db
      .prepare(
        `insert into aletheia_principals
         (id, display_name, status, metadata, created_at, updated_at)
         values (?, ?, 'active', '{}', ?, ?)`,
      )
      .run(input.id, input.displayName.slice(0, 200), timestamp, timestamp);
    for (const role of input.roles ?? []) {
      this.db
        .prepare(
          `insert into aletheia_principal_roles
           (principal_id, role, granted_by, created_at) values (?, ?, ?, ?)`,
        )
        .run(input.id, role, actorId, timestamp);
    }
    return this.principal(input.id);
  }

  principal(principalId: string) {
    const row = this.db
      .prepare("select * from aletheia_principals where id = ?")
      .get(principalId) as SqlRow | undefined;
    if (!row) return null;
    return {
      ...row,
      metadata: parseObject(row.metadata),
      roles: this.globalRoles(principalId),
    };
  }

  assignGlobalRole(actorId: string, principalId: string, role: GovernanceRole) {
    this.ensurePrincipal(actorId);
    this.assertGlobalAdmin(actorId);
    if (!this.principal(principalId)) throw new Error("Principal not found");
    this.db
      .prepare(
        `insert into aletheia_principal_roles
         (principal_id, role, granted_by, created_at) values (?, ?, ?, ?)
         on conflict(principal_id, role) do nothing`,
      )
      .run(principalId, role, actorId, now());
    return this.principal(principalId);
  }

  private globalRoles(principalId: string) {
    return (
      this.db
        .prepare(
          "select role from aletheia_principal_roles where principal_id = ?",
        )
        .all(principalId) as Array<{ role: string }>
    )
      .map((row) => row.role)
      .filter(isRole);
  }

  private assertGlobalAdmin(principalId: string) {
    if (!this.globalRoles(principalId).includes("admin")) {
      throw new GovernancePolicyError(
        "Global administrator permission is required",
        "FORBIDDEN",
        403,
      );
    }
  }

  assertAdministrator(principalId: string) {
    this.ensurePrincipal(principalId);
    this.assertGlobalAdmin(principalId);
  }

  private ensureMatterDefaults(matterId: string) {
    const matter = this.db
      .prepare("select id, user_id from aletheia_matters where id = ?")
      .get(matterId) as { id: string; user_id: string } | undefined;
    if (!matter) return null;
    this.ensurePrincipal(matter.user_id, matter.user_id);
    const timestamp = now();
    this.db
      .prepare(
        `insert into aletheia_matter_acl
         (matter_id, principal_id, role, granted_by, created_at, updated_at)
         values (?, ?, 'counsel', ?, ?, ?)
         on conflict(matter_id, principal_id) do nothing`,
      )
      .run(matterId, matter.user_id, matter.user_id, timestamp, timestamp);
    this.db
      .prepare(
        `insert into aletheia_matter_governance
         (matter_id, classification, legal_hold, retention_days, disposition_at,
          evidence_locked, updated_by, created_at, updated_at)
         values (?, 'internal', 0, null, null, 0, ?, ?, ?)
         on conflict(matter_id) do nothing`,
      )
      .run(matterId, matter.user_id, timestamp, timestamp);
    return matter;
  }

  rolesForMatter(principalId: string, matterId: string) {
    this.ensurePrincipal(principalId);
    const matter = this.ensureMatterDefaults(matterId);
    if (!matter) return [];
    const roles = new Set(this.globalRoles(principalId));
    const acl = this.db
      .prepare(
        "select role from aletheia_matter_acl where matter_id = ? and principal_id = ?",
      )
      .get(matterId, principalId) as { role?: string } | undefined;
    if (acl?.role && isRole(acl.role)) roles.add(acl.role);
    return [...roles];
  }

  hasPermission(
    principalId: string,
    matterId: string,
    permission: MatterPermission,
  ) {
    const roles = this.rolesForMatter(principalId, matterId);
    if (roles.includes("admin")) return true;
    const hasAcl = this.db
      .prepare(
        "select 1 from aletheia_matter_acl where matter_id = ? and principal_id = ?",
      )
      .get(matterId, principalId);
    if (!hasAcl) return false;
    return roles.some((role) => ROLE_PERMISSIONS[role]?.has(permission));
  }

  assertPermission(
    principalId: string,
    matterId: string,
    permission: MatterPermission,
  ) {
    if (!this.hasPermission(principalId, matterId, permission)) {
      throw new GovernancePolicyError(
        `Principal '${principalId}' lacks ${permission} on this matter`,
        "FORBIDDEN",
        403,
      );
    }
  }

  setMatterAcl(
    actorId: string,
    matterId: string,
    principalId: string,
    role: GovernanceRole,
  ) {
    this.assertPermission(actorId, matterId, "governance.manage");
    if (!this.principal(principalId)) throw new Error("Principal not found");
    const timestamp = now();
    this.db
      .prepare(
        `insert into aletheia_matter_acl
         (matter_id, principal_id, role, granted_by, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(matter_id, principal_id) do update set
           role = excluded.role, granted_by = excluded.granted_by,
           updated_at = excluded.updated_at`,
      )
      .run(matterId, principalId, role, actorId, timestamp, timestamp);
    return this.listMatterAcl(actorId, matterId);
  }

  listMatterAcl(actorId: string, matterId: string) {
    this.assertPermission(actorId, matterId, "governance.manage");
    return this.db
      .prepare(
        `select a.*, p.display_name, p.status as principal_status
         from aletheia_matter_acl a join aletheia_principals p on p.id = a.principal_id
         where a.matter_id = ? order by a.created_at asc`,
      )
      .all(matterId);
  }

  governance(actorId: string, matterId: string) {
    this.assertPermission(actorId, matterId, "matter.read");
    const row = this.db
      .prepare("select * from aletheia_matter_governance where matter_id = ?")
      .get(matterId) as SqlRow;
    return this.governanceView(row);
  }

  updateGovernance(
    actorId: string,
    matterId: string,
    input: {
      classification?: MatterClassification;
      legalHold?: boolean;
      legalHoldReason?: string | null;
      retentionDays?: number | null;
      dispositionAt?: string | null;
      evidenceLocked?: boolean;
      evidenceLockReason?: string | null;
    },
  ) {
    this.assertPermission(actorId, matterId, "governance.manage");
    const current = this.db
      .prepare("select * from aletheia_matter_governance where matter_id = ?")
      .get(matterId) as SqlRow;
    const retentionDays: number | null =
      input.retentionDays === undefined
        ? typeof current.retention_days === "number"
          ? current.retention_days
          : null
        : input.retentionDays;
    if (
      retentionDays !== null &&
      (!Number.isInteger(retentionDays) ||
        Number(retentionDays) < 1 ||
        Number(retentionDays) > 36_500)
    ) {
      throw new GovernancePolicyError(
        "retentionDays must be null or an integer from 1 to 36500",
        "INVALID_POLICY",
        400,
      );
    }
    let dispositionAt =
      input.dispositionAt === undefined
        ? (current.disposition_at as string | null)
        : input.dispositionAt;
    if (
      input.retentionDays !== undefined &&
      input.dispositionAt === undefined
    ) {
      dispositionAt = retentionDays
        ? new Date(
            Date.now() + Number(retentionDays) * 86_400_000,
          ).toISOString()
        : null;
    }
    if (dispositionAt && !Number.isFinite(Date.parse(dispositionAt))) {
      throw new GovernancePolicyError(
        "dispositionAt must be an ISO timestamp",
        "INVALID_POLICY",
        400,
      );
    }
    const timestamp = now();
    this.db
      .prepare(
        `update aletheia_matter_governance set
           classification = ?, legal_hold = ?, legal_hold_reason = ?,
           retention_days = ?, disposition_at = ?, evidence_locked = ?,
           evidence_lock_reason = ?, updated_by = ?, updated_at = ?
         where matter_id = ?`,
      )
      .run(
        input.classification ?? classification(current.classification),
        input.legalHold === undefined
          ? Number(current.legal_hold)
          : input.legalHold
            ? 1
            : 0,
        input.legalHoldReason === undefined
          ? nullableSqlString(current.legal_hold_reason)
          : input.legalHoldReason,
        retentionDays,
        dispositionAt,
        input.evidenceLocked === undefined
          ? Number(current.evidence_locked)
          : input.evidenceLocked
            ? 1
            : 0,
        input.evidenceLockReason === undefined
          ? nullableSqlString(current.evidence_lock_reason)
          : input.evidenceLockReason,
        actorId,
        timestamp,
        matterId,
      );
    return this.governance(actorId, matterId);
  }

  private governanceView(row: SqlRow): GovernanceView {
    return {
      ...row,
      classification: classification(row.classification),
      legal_hold: Boolean(row.legal_hold),
      evidence_locked: Boolean(row.evidence_locked),
      retention_days: row.retention_days,
      disposition_at: row.disposition_at,
      approval_matrix: this.multiPrincipalEnabled
        ? { enabled: true, mode: "multi_principal" }
        : {
            enabled: false,
            mode: "single_user",
            reason:
              "ALETHEIA_MULTI_PRINCIPAL_ENABLED is not true; dual-control is not claimed in single-user mode.",
          },
    };
  }

  assertDocumentWriteAllowed(principalId: string, matterId: string) {
    this.assertPermission(principalId, matterId, "matter.write");
    const governance = this.db
      .prepare(
        "select evidence_locked from aletheia_matter_governance where matter_id = ?",
      )
      .get(matterId) as { evidence_locked?: number };
    if (governance.evidence_locked) {
      throw new GovernancePolicyError(
        "Evidence is locked; document mutation is prohibited",
        "EVIDENCE_LOCKED",
      );
    }
  }

  assertPurgeAllowed(principalId: string, matterId: string) {
    this.assertPermission(principalId, matterId, "matter.purge");
    const governance = this.db
      .prepare("select * from aletheia_matter_governance where matter_id = ?")
      .get(matterId) as SqlRow;
    if (governance.legal_hold) {
      throw new GovernancePolicyError(
        "Matter is under legal hold and cannot be purged",
        "LEGAL_HOLD",
      );
    }
    if (governance.evidence_locked) {
      throw new GovernancePolicyError(
        "Matter evidence is locked and cannot be purged",
        "EVIDENCE_LOCKED",
      );
    }
    if (
      governance.disposition_at &&
      Date.parse(String(governance.disposition_at)) > Date.now()
    ) {
      throw new GovernancePolicyError(
        `Retention period remains active until ${String(governance.disposition_at)}`,
        "RETENTION_ACTIVE",
      );
    }
  }

  recordDlpFindings(args: {
    matterId: string;
    documentId: string;
    flags: string[];
    filename?: string;
  }) {
    const timestamp = now();
    for (const flag of new Set(args.flags)) {
      this.db
        .prepare(
          `insert into aletheia_dlp_findings
           (id, matter_id, document_id, finding_type, severity, status, details, created_at, updated_at)
           values (?, ?, ?, ?, ?, 'open', ?, ?, ?)
           on conflict(matter_id, document_id, finding_type) do update set
             severity = excluded.severity, status = 'open', details = excluded.details,
             updated_at = excluded.updated_at`,
        )
        .run(
          randomUUID(),
          args.matterId,
          args.documentId,
          flag,
          findingSeverity(flag),
          json({
            filename: args.filename ?? null,
            source: "sensitive_material_flags",
          }),
          timestamp,
          timestamp,
        );
    }
  }

  listDlpFindings(actorId: string, matterId: string): DlpFindingView[] {
    this.assertPermission(actorId, matterId, "audit.read");
    return (
      this.db
        .prepare(
          "select * from aletheia_dlp_findings where matter_id = ? order by created_at asc",
        )
        .all(matterId) as SqlRow[]
    ).map((row) => ({
      ...row,
      finding_type: String(row.finding_type),
      severity: String(row.severity),
      details: parseObject(row.details),
    }));
  }

  setApprovalPolicy(
    actorId: string,
    matterId: string,
    input: {
      action: string;
      requiredApprovals: number;
      eligibleRoles: GovernanceRole[];
      requireDistinctRoles?: boolean;
      prohibitRequester?: boolean;
      enabled?: boolean;
    },
  ) {
    this.assertPermission(actorId, matterId, "governance.manage");
    if (
      !input.action ||
      !Number.isInteger(input.requiredApprovals) ||
      input.requiredApprovals < 1 ||
      input.requiredApprovals > 10 ||
      !input.eligibleRoles.length
    ) {
      throw new GovernancePolicyError(
        "Approval policy action, 1-10 approvals, and eligible roles are required",
        "INVALID_POLICY",
        400,
      );
    }
    const requestedEnabled = input.enabled !== false;
    const enabled = requestedEnabled && this.multiPrincipalEnabled;
    const disabledReason =
      requestedEnabled && !this.multiPrincipalEnabled
        ? "single_user_mode_has_no_distinct_authenticated_principals"
        : null;
    const timestamp = now();
    const id = randomUUID();
    this.db
      .prepare(
        `insert into aletheia_approval_policies
         (id, matter_id, action, required_approvals, eligible_roles,
          require_distinct_roles, prohibit_requester, enabled, disabled_reason,
          updated_by, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(matter_id, action) do update set
           required_approvals = excluded.required_approvals,
           eligible_roles = excluded.eligible_roles,
           require_distinct_roles = excluded.require_distinct_roles,
           prohibit_requester = excluded.prohibit_requester,
           enabled = excluded.enabled, disabled_reason = excluded.disabled_reason,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(
        id,
        matterId,
        input.action,
        input.requiredApprovals,
        json(input.eligibleRoles),
        input.requireDistinctRoles ? 1 : 0,
        1,
        enabled ? 1 : 0,
        disabledReason,
        actorId,
        timestamp,
        timestamp,
      );
    return this.approvalPolicy(matterId, input.action);
  }

  approvalPolicy(matterId: string, action: string): ApprovalPolicyView | null {
    const row = this.db
      .prepare(
        "select * from aletheia_approval_policies where matter_id = ? and action = ?",
      )
      .get(matterId, action) as SqlRow | undefined;
    return row
      ? {
          ...row,
          required_approvals: Number(row.required_approvals),
          disabled_reason: nullableSqlString(row.disabled_reason),
          eligible_roles: parseArray(row.eligible_roles).filter(
            (role): role is GovernanceRole =>
              typeof role === "string" && isRole(role),
          ),
          enabled: Boolean(row.enabled),
          require_distinct_roles: Boolean(row.require_distinct_roles),
          prohibit_requester: Boolean(row.prohibit_requester),
        }
      : null;
  }

  requestApproval(
    requesterId: string,
    matterId: string,
    action: string,
    payload: Record<string, unknown> = {},
  ) {
    this.assertPermission(requesterId, matterId, "matter.read");
    const policy = this.approvalPolicy(matterId, action);
    if (!policy?.enabled) {
      throw new GovernancePolicyError(
        policy?.disabled_reason
          ? `Approval policy is disabled: ${String(policy.disabled_reason)}`
          : "Approval policy is not enabled for this action",
        "POLICY_DISABLED",
      );
    }
    const id = randomUUID();
    this.db
      .prepare(
        `insert into aletheia_governance_approval_requests
         (id, matter_id, action, requester_id, status, requested_payload, created_at)
         values (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, matterId, action, requesterId, json(payload), now());
    return this.approvalRequest(id);
  }

  voteApproval(
    principalId: string,
    requestId: string,
    decision: "approved" | "rejected",
    comment?: string | null,
  ) {
    this.ensurePrincipal(principalId);
    return this.transaction(() => {
      const request = this.db
        .prepare(
          "select * from aletheia_governance_approval_requests where id = ?",
        )
        .get(requestId) as SqlRow | undefined;
      if (!request) return null;
      if (request.status !== "pending") {
        throw new GovernancePolicyError(
          "Approval request is no longer pending",
          "INVALID_POLICY",
        );
      }
      const policy = this.approvalPolicy(
        String(request.matter_id),
        String(request.action),
      );
      if (!policy?.enabled) {
        throw new GovernancePolicyError(
          "Approval policy is disabled",
          "POLICY_DISABLED",
        );
      }
      if (request.requester_id === principalId) {
        throw new GovernancePolicyError(
          "The requester cannot approve their own request",
          "FORBIDDEN",
          403,
        );
      }
      this.assertPermission(
        principalId,
        String(request.matter_id),
        "approval.vote",
      );
      const principalRoles = this.rolesForMatter(
        principalId,
        String(request.matter_id),
      );
      const eligibleRole = policy.eligible_roles.find((role) =>
        principalRoles.includes(role),
      );
      if (!eligibleRole) {
        throw new GovernancePolicyError(
          "Principal does not hold an eligible approval role",
          "FORBIDDEN",
          403,
        );
      }
      if (policy.require_distinct_roles) {
        const sameRole = this.db
          .prepare(
            "select 1 from aletheia_governance_approval_votes where request_id = ? and role = ? and decision = 'approved'",
          )
          .get(requestId, eligibleRole);
        if (sameRole) {
          throw new GovernancePolicyError(
            "This policy requires approvers with distinct roles",
            "FORBIDDEN",
            403,
          );
        }
      }
      this.db
        .prepare(
          `insert into aletheia_governance_approval_votes
           (id, request_id, principal_id, role, decision, comment, created_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          requestId,
          principalId,
          eligibleRole,
          decision,
          comment ?? null,
          now(),
        );
      if (decision === "rejected") {
        this.db
          .prepare(
            "update aletheia_governance_approval_requests set status = 'rejected', decided_at = ? where id = ?",
          )
          .run(now(), requestId);
      } else {
        const votes = this.db
          .prepare(
            `select count(distinct principal_id) as count
             from aletheia_governance_approval_votes
             where request_id = ? and decision = 'approved'`,
          )
          .get(requestId) as { count?: number };
        if (Number(votes.count ?? 0) >= Number(policy.required_approvals)) {
          this.db
            .prepare(
              "update aletheia_governance_approval_requests set status = 'approved', decided_at = ? where id = ?",
            )
            .run(now(), requestId);
        }
      }
      return this.approvalRequest(requestId);
    });
  }

  approvalRequest(requestId: string): ApprovalRequestView | null {
    const request = this.db
      .prepare(
        "select * from aletheia_governance_approval_requests where id = ?",
      )
      .get(requestId) as SqlRow | undefined;
    if (!request) return null;
    const votes = this.db
      .prepare(
        "select * from aletheia_governance_approval_votes where request_id = ? order by created_at asc",
      )
      .all(requestId);
    return {
      ...request,
      id: String(request.id),
      matter_id: String(request.matter_id),
      status: String(request.status),
      requested_payload: parseObject(request.requested_payload),
      votes,
    };
  }

  assertExportAllowed(
    principalId: string,
    matterId: string,
    governanceApprovalRequestId?: string | null,
  ) {
    this.assertPermission(principalId, matterId, "matter.export");
    const governance = this.db
      .prepare(
        "select classification from aletheia_matter_governance where matter_id = ?",
      )
      .get(matterId) as { classification?: string };
    if (governance.classification !== "restricted") return;
    const request = governanceApprovalRequestId
      ? (this.db
          .prepare(
            `select * from aletheia_governance_approval_requests
             where id = ? and matter_id = ? and action = 'restricted_export' and status = 'approved'`,
          )
          .get(governanceApprovalRequestId, matterId) as SqlRow | undefined)
      : undefined;
    if (!request) {
      const findings = this.db
        .prepare(
          "select count(*) as count from aletheia_dlp_findings where matter_id = ? and status = 'open'",
        )
        .get(matterId) as { count?: number };
      throw new GovernancePolicyError(
        `Restricted matter export is blocked pending an approved restricted_export governance request (${Number(findings.count ?? 0)} open DLP findings)`,
        "APPROVAL_REQUIRED",
      );
    }
  }
}

export function governanceForDatabase(database: LocalDatabase) {
  return new LocalGovernanceService({ database });
}
