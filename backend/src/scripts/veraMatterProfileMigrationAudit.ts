import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runWorkspaceMigrations,
  WorkspaceDatabase,
  workspaceMigrationChecksum,
} from "../lib/workspace/database";
import {
  MATTER_CLASSIFICATION_V16_MIGRATION,
  MATTER_PROFILES_V15_MIGRATION,
  WORKSPACE_MIGRATIONS,
  type WorkspaceDatabaseAdapter,
  type WorkspaceMigration,
  type WorkspaceStatement,
} from "../lib/workspace/migrations";

const originalEnvironment = { ...process.env };
const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-matter-profile-v16-audit-"),
);
const V14_MIGRATIONS = WORKSPACE_MIGRATIONS.slice(0, 14);
const V15_MIGRATIONS = WORKSPACE_MIGRATIONS.slice(0, 15);
const FROZEN_V15_CHECKSUM =
  "sha256:88a7393d47909c61cdb92744467731978844897355cd86261efc6cb11b37fa5f";
const now = "2026-07-16T08:00:00.000Z";
const later = "2026-07-16T09:00:00.000Z";

function object(row: Record<string, unknown> | undefined) {
  assert.ok(row);
  return { ...row };
}

function insertProject(
  database: WorkspaceDatabase,
  id: string,
  name = "Matter migration audit Project",
) {
  database
    .prepare(
      `INSERT INTO projects (id, name, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(id, name, now, now);
}

type MatterRow = {
  projectId?: unknown;
  matterType?: unknown;
  workspaceType?: unknown;
  jurisdiction?: unknown;
  clientName?: unknown;
  representedRole?: unknown;
  counterparty?: unknown;
  court?: unknown;
  caseNumber?: unknown;
  stage?: unknown;
  objective?: unknown;
  riskLevel?: unknown;
  openedAt?: unknown;
  closedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

function insertMatterProfile(
  database: WorkspaceDatabase,
  input: MatterRow = {},
) {
  database
    .prepare(
      `INSERT INTO matter_profiles (
         project_id, matter_type, client_name, represented_role,
         counterparty, court, case_number, stage, objective, risk_level,
         opened_at, closed_at, created_at, updated_at,
         workspace_type, jurisdiction
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.projectId === undefined ? "project-constraints" : input.projectId,
      input.matterType === undefined ? "civil_litigation" : input.matterType,
      input.clientName === undefined ? "Audit Client" : input.clientName,
      input.representedRole === undefined ? "Plaintiff" : input.representedRole,
      input.counterparty === undefined
        ? "Audit Counterparty"
        : input.counterparty,
      input.court === undefined ? "Audit Court" : input.court,
      input.caseNumber === undefined ? "(2026) Audit 15" : input.caseNumber,
      input.stage === undefined ? "intake" : input.stage,
      input.objective === undefined
        ? "Preserve the client's reviewed objective."
        : input.objective,
      input.riskLevel === undefined ? "medium" : input.riskLevel,
      input.openedAt === undefined ? now : input.openedAt,
      input.closedAt === undefined ? null : input.closedAt,
      input.createdAt === undefined ? now : input.createdAt,
      input.updatedAt === undefined ? now : input.updatedAt,
      input.workspaceType === undefined ? "dispute" : input.workspaceType,
      input.jurisdiction === undefined ? "CN" : input.jurisdiction,
    );
}

type MatterPolicyRow = {
  projectId?: unknown;
  externalEgressMode?: unknown;
  audioRetentionDays?: unknown;
  allowExternalLegalSources?: unknown;
  allowWordBridge?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

function insertMatterPolicy(
  database: WorkspaceDatabase,
  input: MatterPolicyRow = {},
) {
  database
    .prepare(
      `INSERT INTO matter_policies (
         project_id, external_egress_mode, audio_retention_days,
         allow_external_legal_sources, allow_word_bridge,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.projectId === undefined
        ? "project-policy-constraints"
        : input.projectId,
      input.externalEgressMode === undefined
        ? "disabled"
        : input.externalEgressMode,
      input.audioRetentionDays === undefined ? null : input.audioRetentionDays,
      input.allowExternalLegalSources === undefined
        ? 0
        : input.allowExternalLegalSources,
      input.allowWordBridge === undefined ? 0 : input.allowWordBridge,
      input.createdAt === undefined ? now : input.createdAt,
      input.updatedAt === undefined ? now : input.updatedAt,
    );
}

function policyAllowsExecutionLocation(
  database: WorkspaceDatabase,
  projectId: string,
  executionLocation: string,
) {
  return Boolean(
    database
      .prepare(
        `SELECT 1 AS allowed
           FROM matter_policies policy
           JOIN matter_policy_execution_locations location
             ON location.project_id = policy.project_id
          WHERE policy.project_id = ?
            AND location.execution_location = ?`,
      )
      .get(projectId, executionLocation),
  );
}

function assertConstraint(
  database: WorkspaceDatabase,
  input: MatterRow,
  message?: string,
) {
  assert.throws(
    () => insertMatterProfile(database, input),
    /constraint|foreign key/i,
    message,
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM matter_profiles WHERE project_id = 'project-constraints'",
      )
      .get()?.count,
    0,
  );
}

function assertPolicyConstraint(
  database: WorkspaceDatabase,
  input: MatterPolicyRow,
) {
  assert.throws(() => insertMatterPolicy(database, input), /constraint/i);
  assert.equal(
    database
      .prepare(
        `SELECT count(*) AS count
           FROM matter_policies
          WHERE project_id = 'project-policy-constraints'`,
      )
      .get()?.count,
    0,
  );
}

function schemaNames(
  database: WorkspaceDatabase,
  type: "table" | "index" | "trigger",
) {
  return new Set(
    database
      .prepare(
        `SELECT name
           FROM sqlite_schema
          WHERE type = ? AND name NOT LIKE 'sqlite_%'`,
      )
      .all(type)
      .map((row) => String(row.name)),
  );
}

function auditFreshInstallAndStrictConstraints() {
  const database = new WorkspaceDatabase(path.join(root, "fresh.db"));
  try {
    assert.equal(database.migration?.currentVersion, 17);
    assert.deepEqual(
      database.migration?.applied.map((entry) => entry.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    );
    assert.equal(WORKSPACE_MIGRATIONS.at(14), MATTER_PROFILES_V15_MIGRATION);
    assert.equal(
      WORKSPACE_MIGRATIONS.at(15),
      MATTER_CLASSIFICATION_V16_MIGRATION,
    );
    assert.deepEqual(
      database
        .prepare("PRAGMA table_info('matter_profiles')")
        .all()
        .map((row) => String(row.name)),
      [
        "project_id",
        "matter_type",
        "client_name",
        "represented_role",
        "counterparty",
        "court",
        "case_number",
        "stage",
        "objective",
        "risk_level",
        "opened_at",
        "closed_at",
        "created_at",
        "updated_at",
        "workspace_type",
        "jurisdiction",
      ],
    );
    for (const index of [
      "idx_matter_profiles_type_updated",
      "idx_matter_profiles_risk_updated",
      "idx_matter_profiles_case_number",
      "idx_matter_profiles_workspace_type_updated",
      "idx_matter_profiles_jurisdiction_updated",
      "idx_matter_policies_egress_updated",
      "idx_matter_policy_execution_locations_location",
    ]) {
      assert.equal(schemaNames(database, "index").has(index), true, index);
    }
    for (const trigger of [
      "matter_profiles_v15_update_guard",
      "matter_policies_v15_update_guard",
      "matter_policy_execution_locations_v15_immutable",
      "matter_profiles_v16_insert_requires_workspace_type",
      "matter_profiles_v16_workspace_type_one_way",
    ]) {
      assert.equal(
        schemaNames(database, "trigger").has(trigger),
        true,
        trigger,
      );
    }
    const tableSql = String(
      database
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'table' AND name = 'matter_profiles'`,
        )
        .get()?.sql,
    );
    assert.match(tableSql, /WITHOUT ROWID/i);
    assert.match(tableSql, /REFERENCES projects\(id\) ON DELETE CASCADE/i);
    for (const value of [
      "civil_litigation",
      "commercial_dispute",
      "contract_review",
      "legal_research",
      "general",
      "low",
      "medium",
      "high",
      "general_legal",
      "transaction",
      "dispute",
      "investigation",
      "compliance",
      "research",
    ]) {
      assert.equal(tableSql.includes(`'${value}'`), true, value);
    }
    assert.match(tableSql, /strftime\('%Y-%m-%dT%H:%M:%fZ'/);

    const policySql = String(
      database
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'table' AND name = 'matter_policies'`,
        )
        .get()?.sql,
    );
    assert.match(
      policySql,
      /REFERENCES matter_profiles\(project_id\) ON DELETE CASCADE/i,
    );
    assert.match(policySql, /audio_retention_days BETWEEN 0 AND 36500/i);
    assert.match(policySql, /allow_external_legal_sources IN \(0, 1\)/i);
    assert.match(policySql, /allow_word_bridge IN \(0, 1\)/i);
    const executionLocationSql = String(
      database
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'table'
              AND name = 'matter_policy_execution_locations'`,
        )
        .get()?.sql,
    );
    for (const location of [
      "local",
      "firm_private",
      "confidential_remote",
      "standard_remote",
    ]) {
      assert.equal(executionLocationSql.includes(`'${location}'`), true);
    }

    insertProject(database, "project-ordinary", "Ordinary Project");
    insertProject(database, "project-full", "Full Matter");
    insertProject(database, "project-constraints", "Constraint Matter");
    insertProject(database, "project-policy", "Policy Matter");
    insertProject(
      database,
      "project-policy-constraints",
      "Policy Constraint Matter",
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM matter_profiles WHERE project_id = 'project-ordinary'",
        )
        .get()?.count,
      0,
      "a normal Project remains valid without a Matter Profile",
    );

    insertMatterProfile(database, {
      projectId: "project-full",
      matterType: "commercial_dispute",
      workspaceType: "dispute",
      jurisdiction: "CN / Hong Kong SAR",
      clientName: "Vera Client",
      representedRole: "Respondent",
      counterparty: "Example Counterparty",
      court: "Example Commercial Court",
      caseNumber: "(2026) Vera 15",
      stage: "discovery",
      objective: "Resolve the dispute on reviewed terms.",
      riskLevel: "high",
      openedAt: now,
      closedAt: later,
      createdAt: now,
      updatedAt: later,
    });
    assert.deepEqual(
      object(
        database
          .prepare(
            `SELECT project_id, matter_type, client_name, represented_role,
                    counterparty, court, case_number, stage, objective,
                    risk_level, opened_at, closed_at, created_at, updated_at,
                    workspace_type, jurisdiction
               FROM matter_profiles
              WHERE project_id = 'project-full'`,
          )
          .get(),
      ),
      {
        project_id: "project-full",
        matter_type: "commercial_dispute",
        client_name: "Vera Client",
        represented_role: "Respondent",
        counterparty: "Example Counterparty",
        court: "Example Commercial Court",
        case_number: "(2026) Vera 15",
        stage: "discovery",
        objective: "Resolve the dispute on reviewed terms.",
        risk_level: "high",
        opened_at: now,
        closed_at: later,
        created_at: now,
        updated_at: later,
        workspace_type: "dispute",
        jurisdiction: "CN / Hong Kong SAR",
      },
    );
    assert.throws(
      () =>
        insertMatterProfile(database, {
          projectId: "project-full",
          matterType: "general",
        }),
      /unique|primary key/i,
      "one Project cannot own two Matter Profiles",
    );
    assertConstraint(database, { projectId: "missing-project" });

    for (const matterType of ["", "Civil_litigation", "litigation", null]) {
      assertConstraint(database, { matterType });
    }
    for (const workspaceType of [
      "",
      "general",
      "civil_litigation",
      "Dispute",
    ]) {
      assertConstraint(database, { workspaceType });
    }
    assert.throws(
      () => insertMatterProfile(database, { workspaceType: null }),
      /classification is required/i,
      "every new v16 Matter Profile requires an explicit classification",
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM matter_profiles WHERE project_id = 'project-constraints'",
        )
        .get()?.count,
      0,
    );
    for (const jurisdiction of [" ", "x".repeat(241), `safe\0unsafe`]) {
      assertConstraint(database, { jurisdiction });
    }
    for (const riskLevel of ["", "critical", "High"]) {
      assertConstraint(database, { riskLevel });
    }
    for (const [field, maximum] of [
      ["clientName", 500],
      ["representedRole", 240],
      ["counterparty", 1000],
      ["court", 500],
      ["caseNumber", 240],
      ["stage", 240],
      ["objective", 16384],
    ] as const) {
      assertConstraint(database, { [field]: " " });
      assertConstraint(database, { [field]: "x".repeat(maximum + 1) });
      assertConstraint(database, { [field]: `safe\0unsafe` });
    }
    for (const openedAt of [
      "",
      "2026-07-16T08:00:00Z",
      "2026-07-16T08:00:00.000+00:00",
      "2026-02-30T08:00:00.000Z",
    ]) {
      assertConstraint(database, { openedAt });
    }
    assertConstraint(database, {
      openedAt: later,
      closedAt: now,
    });
    assertConstraint(database, {
      createdAt: "2026-07-16T08:00:00Z",
    });
    assertConstraint(database, {
      updatedAt: "2026-07-16T08:00:00+00:00",
    });
    assertConstraint(database, {
      createdAt: later,
      updatedAt: now,
    });

    database
      .prepare(
        `UPDATE matter_profiles
            SET stage = 'hearing',
                workspace_type = 'transaction',
                jurisdiction = 'Singapore',
                updated_at = updated_at
          WHERE project_id = 'project-full'`,
      )
      .run();
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE matter_profiles
                SET workspace_type = NULL
              WHERE project_id = 'project-full'`,
          )
          .run(),
      /classification cannot be cleared/i,
      "an explicitly classified Matter cannot return to the legacy null state",
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE matter_profiles
                SET updated_at = ?
              WHERE project_id = 'project-full'`,
          )
          .run(now),
      /cannot move backwards/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE matter_profiles
                SET created_at = ?
              WHERE project_id = 'project-full'`,
          )
          .run(later),
      /creation time is immutable/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE matter_profiles
                SET project_id = 'project-ordinary'
              WHERE project_id = 'project-full'`,
          )
          .run(),
      /Project ownership is immutable/i,
    );

    insertMatterProfile(database, {
      projectId: "project-policy",
      matterType: "general",
      clientName: null,
      representedRole: null,
      counterparty: null,
      court: null,
      caseNumber: null,
      stage: null,
      objective: null,
      riskLevel: null,
      openedAt: null,
      closedAt: null,
    });
    insertMatterProfile(database, {
      projectId: "project-policy-constraints",
      matterType: "legal_research",
    });
    assert.equal(
      policyAllowsExecutionLocation(database, "project-full", "local"),
      false,
      "a missing Matter Policy is deny-all",
    );
    assert.throws(
      () =>
        insertMatterPolicy(database, {
          projectId: "project-ordinary",
        }),
      /foreign key/i,
      "an ordinary Project cannot receive a Matter Policy without a Profile",
    );
    assert.throws(
      () =>
        insertMatterPolicy(database, {
          projectId: "missing-project",
        }),
      /foreign key/i,
    );

    database
      .prepare(
        `INSERT INTO matter_policies (project_id, created_at, updated_at)
         VALUES ('project-policy', ?, ?)`,
      )
      .run(now, now);
    assert.deepEqual(
      object(
        database
          .prepare(
            `SELECT external_egress_mode, audio_retention_days,
                    allow_external_legal_sources, allow_word_bridge,
                    created_at, updated_at
               FROM matter_policies
              WHERE project_id = 'project-policy'`,
          )
          .get(),
      ),
      {
        external_egress_mode: "disabled",
        audio_retention_days: null,
        allow_external_legal_sources: 0,
        allow_word_bridge: 0,
        created_at: now,
        updated_at: now,
      },
      "policy defaults do not silently enable egress, retention, sources, or Word",
    );
    assert.equal(
      policyAllowsExecutionLocation(database, "project-policy", "local"),
      false,
      "an empty execution-location set is deny-all",
    );

    for (const externalEgressMode of ["", "allowed", "Disabled", null]) {
      assertPolicyConstraint(database, { externalEgressMode });
    }
    for (const audioRetentionDays of [-1, 36_501, 1.5, "thirty"]) {
      assertPolicyConstraint(database, { audioRetentionDays });
    }
    for (const allowExternalLegalSources of [-1, 2, 0.5, "yes"]) {
      assertPolicyConstraint(database, { allowExternalLegalSources });
    }
    for (const allowWordBridge of [-1, 2, 0.5, "yes"]) {
      assertPolicyConstraint(database, { allowWordBridge });
    }
    assertPolicyConstraint(database, {
      createdAt: "2026-07-16T08:00:00Z",
    });
    assertPolicyConstraint(database, {
      updatedAt: "2026-07-16T08:00:00+00:00",
    });
    assertPolicyConstraint(database, {
      createdAt: later,
      updatedAt: now,
    });

    database
      .prepare(
        `INSERT INTO matter_policy_execution_locations
          (project_id, execution_location, created_at)
         VALUES ('project-policy', 'local', ?)`,
      )
      .run(now);
    assert.equal(
      policyAllowsExecutionLocation(database, "project-policy", "local"),
      true,
    );
    assert.equal(
      policyAllowsExecutionLocation(
        database,
        "project-policy",
        "standard_remote",
      ),
      false,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO matter_policy_execution_locations
              (project_id, execution_location, created_at)
             VALUES ('project-policy', 'local', ?)`,
          )
          .run(now),
      /unique|primary key/i,
    );
    for (const executionLocation of ["", "remote", "LOCAL", null]) {
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO matter_policy_execution_locations
                (project_id, execution_location, created_at)
               VALUES ('project-policy', ?, ?)`,
            )
            .run(executionLocation, now),
        /constraint/i,
      );
    }
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO matter_policy_execution_locations
              (project_id, execution_location, created_at)
             VALUES ('project-ordinary', 'local', ?)`,
          )
          .run(now),
      /foreign key/i,
      "execution-location membership cannot cross into a Project without its own Policy",
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO matter_policy_execution_locations
              (project_id, execution_location, created_at)
             VALUES ('project-policy', 'firm_private',
                     '2026-07-16T08:00:00Z')`,
          )
          .run(),
      /constraint/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE matter_policy_execution_locations
                SET execution_location = 'firm_private'
              WHERE project_id = 'project-policy'
                AND execution_location = 'local'`,
          )
          .run(),
      /membership is immutable/i,
    );

    database
      .prepare(
        `UPDATE matter_policies
            SET external_egress_mode = 'approval',
                audio_retention_days = 30,
                allow_external_legal_sources = 1,
                allow_word_bridge = 1,
                updated_at = ?
          WHERE project_id = 'project-policy'`,
      )
      .run(later);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE matter_policies
                SET updated_at = ?
              WHERE project_id = 'project-policy'`,
          )
          .run(now),
      /cannot move backwards/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE matter_policies
                SET created_at = ?
              WHERE project_id = 'project-policy'`,
          )
          .run(later),
      /creation time is immutable/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE matter_policies
                SET project_id = 'project-policy-constraints'
              WHERE project_id = 'project-policy'`,
          )
          .run(),
      /Project ownership is immutable/i,
    );

    database
      .prepare(
        "DELETE FROM matter_profiles WHERE project_id = 'project-policy'",
      )
      .run();
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM matter_policies WHERE project_id = 'project-policy'",
        )
        .get()?.count,
      0,
      "Matter Profile deletion cascades its Policy",
    );
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM matter_policy_execution_locations
            WHERE project_id = 'project-policy'`,
        )
        .get()?.count,
      0,
      "Matter Profile deletion cascades normalized execution locations",
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM projects WHERE id = 'project-policy'",
        )
        .get()?.count,
      1,
      "removing optional legal semantics does not remove its Project",
    );

    database.prepare("DELETE FROM projects WHERE id = 'project-full'").run();
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM matter_profiles WHERE project_id = 'project-full'",
        )
        .get()?.count,
      0,
      "Project deletion cascades to its optional Matter Profile",
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
}

function seedV14UpgradeFixture(database: WorkspaceDatabase) {
  insertProject(database, "project-v14", "Preserved v14 Project");
  database.exec(`
    CREATE TABLE matter_v15_legacy_sentinel (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );
    INSERT INTO matter_v15_legacy_sentinel (id, payload)
    VALUES (1, 'v14-data-must-survive');
  `);
  database
    .prepare(
      `INSERT INTO documents
        (id, project_id, title, filename, mime_type, size_bytes,
         created_at, updated_at)
       VALUES ('document-v14', 'project-v14', 'Preserved document',
               'preserved.txt', 'text/plain', 9, ?, ?)`,
    )
    .run(now, now);
}

function auditV14UpgradeChecksumAndIdempotence() {
  const databasePath = path.join(root, "upgrade.db");
  const v14 = new WorkspaceDatabase(databasePath, {
    migrations: V14_MIGRATIONS,
  });
  let oldMigrationRows: Array<Record<string, unknown>>;
  try {
    assert.equal(v14.migration?.currentVersion, 14);
    seedV14UpgradeFixture(v14);
    oldMigrationRows = v14
      .prepare(
        `SELECT version, name, checksum
           FROM workspace_schema_migrations
          ORDER BY version`,
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    v14.close();
  }

  const upgraded = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(upgraded.migration?.currentVersion, 17);
    assert.deepEqual(
      upgraded.migration?.applied.map((entry) => entry.version),
      [15, 16, 17],
    );
    assert.deepEqual(
      upgraded
        .prepare(
          `SELECT version, name, checksum
             FROM workspace_schema_migrations
            WHERE version <= 14
            ORDER BY version`,
        )
        .all()
        .map((row) => ({ ...row })),
      oldMigrationRows,
      "v15 and v16 must not rewrite any prior migration record",
    );
    assert.deepEqual(
      object(
        upgraded
          .prepare("SELECT name, status FROM projects WHERE id = 'project-v14'")
          .get(),
      ),
      { name: "Preserved v14 Project", status: "active" },
    );
    assert.equal(
      upgraded
        .prepare("SELECT title FROM documents WHERE id = 'document-v14'")
        .get()?.title,
      "Preserved document",
    );
    assert.equal(
      upgraded
        .prepare("SELECT payload FROM matter_v15_legacy_sentinel WHERE id = 1")
        .get()?.payload,
      "v14-data-must-survive",
    );
    for (const table of [
      "matter_profiles",
      "matter_policies",
      "matter_policy_execution_locations",
    ]) {
      assert.equal(
        upgraded.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count,
        0,
        `upgrade does not guess or backfill ${table} for ordinary Projects`,
      );
    }
    const v15Record = object(
      upgraded
        .prepare(
          `SELECT version, name, checksum
             FROM workspace_schema_migrations
            WHERE version = 15`,
        )
        .get(),
    );
    assert.deepEqual(v15Record, {
      version: 15,
      name: MATTER_PROFILES_V15_MIGRATION.name,
      checksum: workspaceMigrationChecksum(MATTER_PROFILES_V15_MIGRATION),
    });
    const v16Record = object(
      upgraded
        .prepare(
          `SELECT version, name, checksum
             FROM workspace_schema_migrations
            WHERE version = 16`,
        )
        .get(),
    );
    assert.deepEqual(v16Record, {
      version: 16,
      name: MATTER_CLASSIFICATION_V16_MIGRATION.name,
      checksum: workspaceMigrationChecksum(MATTER_CLASSIFICATION_V16_MIGRATION),
    });
    const rerun = upgraded.runMigrations();
    assert.equal(rerun.currentVersion, 17);
    assert.deepEqual(rerun.applied, []);

    const driftedV15: WorkspaceMigration = {
      ...MATTER_PROFILES_V15_MIGRATION,
      checksumMaterial: `${MATTER_PROFILES_V15_MIGRATION.checksumMaterial}\n-- unauthorized drift`,
    };
    assert.throws(
      () =>
        upgraded.runMigrations([
          ...V14_MIGRATIONS,
          driftedV15,
          MATTER_CLASSIFICATION_V16_MIGRATION,
        ]),
      /checksum drift/i,
    );
    assert.equal(
      upgraded
        .prepare(
          "SELECT checksum FROM workspace_schema_migrations WHERE version = 15",
        )
        .get()?.checksum,
      workspaceMigrationChecksum(MATTER_PROFILES_V15_MIGRATION),
    );
    const driftedV16: WorkspaceMigration = {
      ...MATTER_CLASSIFICATION_V16_MIGRATION,
      checksumMaterial: `${MATTER_CLASSIFICATION_V16_MIGRATION.checksumMaterial}\n-- unauthorized drift`,
    };
    assert.throws(
      () => upgraded.runMigrations([...V15_MIGRATIONS, driftedV16]),
      /checksum drift/i,
    );
    assert.equal(
      upgraded
        .prepare(
          "SELECT checksum FROM workspace_schema_migrations WHERE version = 16",
        )
        .get()?.checksum,
      workspaceMigrationChecksum(MATTER_CLASSIFICATION_V16_MIGRATION),
    );
  } finally {
    upgraded.close();
  }

  const reopened = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(reopened.migration?.currentVersion, 17);
    assert.deepEqual(reopened.migration?.applied, []);
    assert.equal(
      reopened
        .prepare("SELECT payload FROM matter_v15_legacy_sentinel WHERE id = 1")
        .get()?.payload,
      "v14-data-must-survive",
    );
  } finally {
    reopened.close();
  }
}

function seedV15ClassificationFixture(database: WorkspaceDatabase) {
  for (const [projectId, matterType] of [
    ["project-v15", "commercial_dispute"],
    ["project-v15-civil", "civil_litigation"],
    ["project-v15-contract", "contract_review"],
    ["project-v15-research", "legal_research"],
    ["project-v15-general", "general"],
  ] as const) {
    insertProject(database, projectId, `Preserved v15 ${matterType} Matter`);
    database
      .prepare(
        `INSERT INTO matter_profiles (
           project_id, matter_type, client_name, represented_role,
           counterparty, court, case_number, stage, objective, risk_level,
           opened_at, closed_at, created_at, updated_at
         ) VALUES (
           ?, ?, 'Legacy Client', 'Respondent',
           'Legacy Counterparty', 'Legacy Court', '(2026) Legacy 15',
           'intake', 'Preserve without guessing.', 'medium', ?, NULL, ?, ?
         )`,
      )
      .run(projectId, matterType, now, now, now);
  }
  database.exec(`
    CREATE TABLE matter_v16_legacy_sentinel (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );
    INSERT INTO matter_v16_legacy_sentinel (id, payload)
    VALUES (1, 'v15-data-must-survive');
  `);
}

function auditV15ClassificationUpgradeAndRestart() {
  const databasePath = path.join(root, "v15-classification-upgrade.db");
  const v15 = new WorkspaceDatabase(databasePath, {
    migrations: V15_MIGRATIONS,
  });
  let v15Record: Record<string, unknown>;
  try {
    assert.equal(v15.migration?.currentVersion, 15);
    seedV15ClassificationFixture(v15);
    v15Record = object(
      v15
        .prepare(
          `SELECT version, name, checksum
             FROM workspace_schema_migrations
            WHERE version = 15`,
        )
        .get(),
    );
  } finally {
    v15.close();
  }

  const upgraded = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(upgraded.migration?.currentVersion, 17);
    assert.deepEqual(
      upgraded.migration?.applied.map((entry) => entry.version),
      [16, 17],
    );
    assert.deepEqual(
      object(
        upgraded
          .prepare(
            `SELECT matter_type, workspace_type, jurisdiction, stage
               FROM matter_profiles
              WHERE project_id = 'project-v15'`,
          )
          .get(),
      ),
      {
        matter_type: "commercial_dispute",
        workspace_type: null,
        jurisdiction: null,
        stage: "intake",
      },
      "v16 must not infer classification or jurisdiction from v15 metadata",
    );
    assert.deepEqual(
      upgraded
        .prepare(
          `SELECT matter_type, workspace_type, jurisdiction
             FROM matter_profiles
            ORDER BY matter_type`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        "civil_litigation",
        "commercial_dispute",
        "contract_review",
        "general",
        "legal_research",
      ].map((matterType) => ({
        matter_type: matterType,
        workspace_type: null,
        jurisdiction: null,
      })),
      "none of the five v15 matter_type values may guess a v16 classification",
    );
    assert.deepEqual(
      object(
        upgraded
          .prepare(
            `SELECT version, name, checksum
               FROM workspace_schema_migrations
              WHERE version = 15`,
          )
          .get(),
      ),
      v15Record,
      "v16 must preserve the immutable v15 migration ledger record",
    );
    assert.deepEqual(
      object(
        upgraded
          .prepare(
            `SELECT version, name, checksum
               FROM workspace_schema_migrations
              WHERE version = 16`,
          )
          .get(),
      ),
      {
        version: 16,
        name: MATTER_CLASSIFICATION_V16_MIGRATION.name,
        checksum: workspaceMigrationChecksum(
          MATTER_CLASSIFICATION_V16_MIGRATION,
        ),
      },
    );
    upgraded
      .prepare(
        `UPDATE matter_profiles
            SET stage = 'review', updated_at = ?
          WHERE project_id = 'project-v15'`,
      )
      .run(later);
    assert.equal(
      upgraded
        .prepare("SELECT payload FROM matter_v16_legacy_sentinel WHERE id = 1")
        .get()?.payload,
      "v15-data-must-survive",
    );
  } finally {
    upgraded.close();
  }

  const classificationRequiredRestart = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(classificationRequiredRestart.migration?.currentVersion, 17);
    assert.deepEqual(classificationRequiredRestart.migration?.applied, []);
    assert.deepEqual(
      object(
        classificationRequiredRestart
          .prepare(
            `SELECT matter_type, workspace_type, jurisdiction, stage
               FROM matter_profiles
              WHERE project_id = 'project-v15'`,
          )
          .get(),
      ),
      {
        matter_type: "commercial_dispute",
        workspace_type: null,
        jurisdiction: null,
        stage: "review",
      },
    );
    classificationRequiredRestart
      .prepare(
        `UPDATE matter_profiles
            SET workspace_type = 'dispute', jurisdiction = 'PRC'
          WHERE project_id = 'project-v15'`,
      )
      .run();
    assert.throws(
      () =>
        classificationRequiredRestart
          .prepare(
            `UPDATE matter_profiles
                SET workspace_type = NULL
              WHERE project_id = 'project-v15'`,
          )
          .run(),
      /classification cannot be cleared/i,
    );
  } finally {
    classificationRequiredRestart.close();
  }

  const classifiedRestart = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(classifiedRestart.migration?.currentVersion, 17);
    assert.deepEqual(
      object(
        classifiedRestart
          .prepare(
            `SELECT matter_type, workspace_type, jurisdiction
               FROM matter_profiles
              WHERE project_id = 'project-v15'`,
          )
          .get(),
      ),
      {
        matter_type: "commercial_dispute",
        workspace_type: "dispute",
        jurisdiction: "PRC",
      },
    );
    assert.equal(
      classifiedRestart
        .prepare("SELECT payload FROM matter_v16_legacy_sentinel WHERE id = 1")
        .get()?.payload,
      "v15-data-must-survive",
    );
  } finally {
    classifiedRestart.close();
  }

  assert.throws(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: V15_MIGRATIONS,
      }),
    /unknown or out-of-order migration version 16/i,
    "a pre-v16 executable must fail closed rather than reinterpret v16 data",
  );
  const currentBinaryRecovery = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(currentBinaryRecovery.migration?.currentVersion, 17);
    assert.deepEqual(currentBinaryRecovery.migration?.applied, []);
    assert.deepEqual(
      object(
        currentBinaryRecovery
          .prepare(
            `SELECT matter_type, workspace_type, jurisdiction
               FROM matter_profiles
              WHERE project_id = 'project-v15'`,
          )
          .get(),
      ),
      {
        matter_type: "commercial_dispute",
        workspace_type: "dispute",
        jurisdiction: "PRC",
      },
    );
    assert.equal(
      currentBinaryRecovery
        .prepare(
          "SELECT checksum FROM workspace_schema_migrations WHERE version = 15",
        )
        .get()?.checksum,
      workspaceMigrationChecksum(MATTER_PROFILES_V15_MIGRATION),
    );
    assert.equal(
      currentBinaryRecovery
        .prepare(
          "SELECT checksum FROM workspace_schema_migrations WHERE version = 16",
        )
        .get()?.checksum,
      workspaceMigrationChecksum(MATTER_CLASSIFICATION_V16_MIGRATION),
    );
  } finally {
    currentBinaryRecovery.close();
  }
}

function failAfterV16Apply(
  database: WorkspaceDatabase,
  onCompleteApply: () => void,
): WorkspaceDatabaseAdapter {
  return {
    exec(sql) {
      database.exec(sql);
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      if (!/INSERT INTO workspace_schema_migrations/i.test(sql)) {
        return statement;
      }
      const wrapped: WorkspaceStatement = {
        run(...parameters: unknown[]) {
          if (Number(parameters[0]) === 16) {
            onCompleteApply();
            throw new Error("injected fault after complete v16 apply");
          }
          return statement.run(...parameters);
        },
        get(...parameters: unknown[]) {
          return statement.get(...parameters);
        },
        all(...parameters: unknown[]) {
          return statement.all(...parameters);
        },
      };
      return wrapped;
    },
  };
}

function auditPostApplyFailureRollsBack() {
  const database = new WorkspaceDatabase(path.join(root, "rollback.db"), {
    migrations: V15_MIGRATIONS,
  });
  try {
    seedV15ClassificationFixture(database);
    let observedCompleteApply = false;
    assert.throws(
      () =>
        runWorkspaceMigrations(
          failAfterV16Apply(database, () => {
            observedCompleteApply =
              database
                .prepare("PRAGMA table_info('matter_profiles')")
                .all()
                .some((row) => row.name === "workspace_type") &&
              schemaNames(database, "index").has(
                "idx_matter_profiles_workspace_type_updated",
              ) &&
              schemaNames(database, "index").has(
                "idx_matter_profiles_jurisdiction_updated",
              ) &&
              schemaNames(database, "trigger").has(
                "matter_profiles_v16_insert_requires_workspace_type",
              ) &&
              schemaNames(database, "trigger").has(
                "matter_profiles_v16_workspace_type_one_way",
              );
          }),
          WORKSPACE_MIGRATIONS,
        ),
      /failed and was rolled back/i,
    );
    assert.equal(observedCompleteApply, true);
    assert.deepEqual(
      database
        .prepare("PRAGMA table_info('matter_profiles')")
        .all()
        .map((row) => String(row.name))
        .slice(-2),
      ["created_at", "updated_at"],
      "rolled-back v16 columns must not leak into the v15 table",
    );
    assert.equal(
      schemaNames(database, "index").has(
        "idx_matter_profiles_workspace_type_updated",
      ),
      false,
    );
    assert.equal(
      schemaNames(database, "index").has(
        "idx_matter_profiles_jurisdiction_updated",
      ),
      false,
    );
    assert.equal(
      schemaNames(database, "trigger").has(
        "matter_profiles_v16_insert_requires_workspace_type",
      ),
      false,
    );
    assert.equal(
      schemaNames(database, "trigger").has(
        "matter_profiles_v16_workspace_type_one_way",
      ),
      false,
    );
    assert.equal(
      database
        .prepare(
          "SELECT max(version) AS version FROM workspace_schema_migrations",
        )
        .get()?.version,
      15,
    );
    assert.deepEqual(
      object(
        database
          .prepare(
            `SELECT matter_type, stage
               FROM matter_profiles
              WHERE project_id = 'project-v15'`,
          )
          .get(),
      ),
      { matter_type: "commercial_dispute", stage: "intake" },
      "v15 Matter data survives the failed v16 migration byte-logically",
    );
    assert.equal(
      database
        .prepare("SELECT payload FROM matter_v16_legacy_sentinel WHERE id = 1")
        .get()?.payload,
      "v15-data-must-survive",
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
}

function auditSqlcipherV15UpgradeAndRestart() {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "sqlcipher_required";
  process.env.ALETHEIA_DATABASE_KEY_SOURCE = "env";
  process.env.ALETHEIA_DATABASE_KEY_BASE64 = randomBytes(32).toString("base64");
  const databasePath = path.join(root, "encrypted-upgrade.db");
  const v15 = new WorkspaceDatabase(databasePath, {
    migrations: V15_MIGRATIONS,
  });
  try {
    assert.equal(v15.migration?.currentVersion, 15);
    assert.equal(v15.migration?.capabilities.sqlcipherEncrypted, true);
    seedV15ClassificationFixture(v15);
  } finally {
    v15.close();
  }

  const upgraded = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(upgraded.migration?.currentVersion, 17);
    assert.deepEqual(
      upgraded.migration?.applied.map((entry) => entry.version),
      [16, 17],
    );
    assert.equal(upgraded.migration?.capabilities.sqlcipherEncrypted, true);
    assert.deepEqual(
      object(
        upgraded
          .prepare(
            `SELECT matter_type, workspace_type, jurisdiction
               FROM matter_profiles
              WHERE project_id = 'project-v15'`,
          )
          .get(),
      ),
      {
        matter_type: "commercial_dispute",
        workspace_type: null,
        jurisdiction: null,
      },
    );
    upgraded
      .prepare(
        `UPDATE matter_profiles
            SET workspace_type = 'investigation', jurisdiction = 'Singapore'
          WHERE project_id = 'project-v15'`,
      )
      .run();
    insertMatterPolicy(upgraded, {
      projectId: "project-v15",
      externalEgressMode: "approval",
      audioRetentionDays: 7,
      allowExternalLegalSources: 1,
      allowWordBridge: 0,
    });
    upgraded
      .prepare(
        `INSERT INTO matter_policy_execution_locations
          (project_id, execution_location, created_at)
         VALUES ('project-v15', 'firm_private', ?)`,
      )
      .run(now);
    assert.equal(
      policyAllowsExecutionLocation(upgraded, "project-v15", "firm_private"),
      true,
    );
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
  const reopened = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(reopened.migration?.currentVersion, 17);
    assert.deepEqual(reopened.migration?.applied, []);
    assert.equal(reopened.migration?.capabilities.sqlcipherEncrypted, true);
    assert.deepEqual(
      object(
        reopened
          .prepare(
            `SELECT workspace_type, jurisdiction
               FROM matter_profiles
              WHERE project_id = 'project-v15'`,
          )
          .get(),
      ),
      { workspace_type: "investigation", jurisdiction: "Singapore" },
    );
    assert.equal(
      policyAllowsExecutionLocation(reopened, "project-v15", "firm_private"),
      true,
    );
    assert.equal(
      reopened
        .prepare("SELECT payload FROM matter_v16_legacy_sentinel WHERE id = 1")
        .get()?.payload,
      "v15-data-must-survive",
    );
    assert.deepEqual(reopened.prepare("PRAGMA integrity_check").all(), [
      { integrity_check: "ok" },
    ]);
    assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    reopened.close();
  }
  assert.notEqual(
    readFileSync(databasePath).subarray(0, 16).toString("utf8"),
    "SQLite format 3\0",
  );
}

try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  assert.deepEqual(
    WORKSPACE_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
  );
  assert.deepEqual(
    V14_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
  assert.deepEqual(
    V15_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  assert.equal(
    workspaceMigrationChecksum(MATTER_PROFILES_V15_MIGRATION),
    FROZEN_V15_CHECKSUM,
    "the committed v15 migration checksum is immutable",
  );
  auditFreshInstallAndStrictConstraints();
  auditV14UpgradeChecksumAndIdempotence();
  auditV15ClassificationUpgradeAndRestart();
  auditPostApplyFailureRollsBack();
  auditSqlcipherV15UpgradeAndRestart();
  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-matter-profile-migration-audit-v16",
        current_version: 17,
        checks: [
          "clean SQLite v17 install with the additive inference-policy slice",
          "additive v14-to-v16 upgrade without Project backfill",
          "additive v15-to-v16 classification upgrade without inferred backfill",
          "legacy classification_required survives restart until explicitly selected",
          "new Matter inserts require workspace_type and classified rows cannot return to null",
          "strict workspace_type enum plus bounded NUL-safe jurisdiction",
          "strict enum, bounded text, canonical UTC, risk, and ordering checks",
          "Project one-to-zero-or-one cardinality and delete cascade",
          "profile-owned fail-closed Matter Policy defaults and normalized execution locations",
          "strict egress, retention, boolean, location, and cross-Project policy checks",
          "immutable ownership, immutable creation time, and monotonic update time",
          "frozen v15 and ordered v16 checksum verification with idempotent rerun",
          "post-DDL v16 migration-record failure rolls back atomically to v15",
          "pre-v16 executable fails closed and the current executable recovers",
          "encrypted SQLCipher v15-to-v16 upgrade and restart",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  process.env = originalEnvironment;
  rmSync(root, { recursive: true, force: true });
}
