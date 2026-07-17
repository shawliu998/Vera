import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";

import {
  WorkspaceDatabase,
  WORKSPACE_MIGRATIONS,
  workspaceMigrationChecksum,
} from "../lib/workspace/database";
import {
  BUILTIN_DOCUMENT_STUDIO_TEMPLATES_V21,
  DocumentStudioDraftPlanV21Schema,
} from "../lib/workspace/documentStudioTemplatesV21";
import {
  DOCUMENT_STUDIO_TEMPLATES_V21_MIGRATION,
  type WorkspaceMigration,
} from "../lib/workspace/migrations";
import { WorkspaceDocumentStudioTemplatesRepository } from "../lib/workspace/repositories/documentStudioTemplates";
import { WorkspaceDocumentStudioTemplatesService } from "../lib/workspace/services/documentStudioTemplates";
import {
  createWorkspaceDocumentStudioV1Router,
  type WorkspaceDocumentStudioV1Port,
} from "../routes/workspaceDocumentStudioV1";

const NOW = "2026-07-16T12:00:00.000Z";

function insertProject(database: WorkspaceDatabase) {
  const id = randomUUID();
  database
    .prepare(
      "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES (?,?,'active',?,?)",
    )
    .run(id, `Template Matter ${id}`, NOW, NOW);
  return id;
}

function exists(database: WorkspaceDatabase, name: string) {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = ?")
      .get(name),
  );
}

function auditUpgradeAndRollback(root: string) {
  const upgradePath = path.join(root, "upgrade.sqlite");
  const v20 = new WorkspaceDatabase(upgradePath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 20),
  });
  const projectId = insertProject(v20);
  v20.close();
  const upgraded = new WorkspaceDatabase(upgradePath);
  assert.equal(upgraded.migration?.currentVersion, 23);
  assert.equal(
    upgraded
      .prepare(
        "SELECT count(*) AS count FROM document_studio_templates WHERE project_id IS NULL",
      )
      .get()?.count,
    8,
  );
  assert.equal(
    upgraded
      .prepare(
        "SELECT count(*) AS count FROM document_studio_templates WHERE project_id = ?",
      )
      .get(projectId)?.count,
    0,
  );
  upgraded.close();

  const rollbackPath = path.join(root, "rollback.sqlite");
  new WorkspaceDatabase(rollbackPath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 20),
  }).close();
  const failing: WorkspaceMigration = {
    ...DOCUMENT_STUDIO_TEMPLATES_V21_MIGRATION,
    name: "document_studio_templates_forced_rollback",
    checksumMaterial: `${DOCUMENT_STUDIO_TEMPLATES_V21_MIGRATION.checksumMaterial}\nforced`,
    apply(database, capabilities) {
      DOCUMENT_STUDIO_TEMPLATES_V21_MIGRATION.apply(database, capabilities);
      throw new Error("forced v21 rollback");
    },
  };
  assert.throws(
    () =>
      new WorkspaceDatabase(rollbackPath, {
        migrations: [...WORKSPACE_MIGRATIONS.slice(0, 20), failing],
      }),
    /rolled back/i,
  );
  const inspection = new WorkspaceDatabase(rollbackPath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 20),
  });
  assert.equal(exists(inspection, "document_studio_templates"), false);
  assert.equal(
    inspection
      .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
      .get()?.count,
    20,
  );
  inspection.close();
}

async function auditHttpWire(
  template: ReturnType<WorkspaceDocumentStudioTemplatesService["get"]>,
) {
  const port = {
    async listStudioTemplates() {
      return [{ ...template, sectionCount: template.plan.sections.length }];
    },
    async getStudioTemplate() {
      return template;
    },
    async updateStudioTemplate(
      _context: unknown,
      _projectId: string,
      _templateId: string,
      input: { plan?: unknown },
    ) {
      assert.ok(input.plan);
      return template;
    },
  } as unknown as WorkspaceDocumentStudioV1Port;
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/api/v1", createWorkspaceDocumentStudioV1Router(port));
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => response.status(422).json({ error: String(error) }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/v1/projects/${randomUUID()}/studio/templates`;
    const listResponse = await fetch(base);
    const list = (await listResponse.json()) as {
      items: Record<string, unknown>[];
    };
    assert.deepEqual(Object.keys(list.items[0]!).sort(), [
      "description",
      "document_type",
      "scope",
      "section_count",
      "template_id",
      "title",
      "updated_at",
    ]);
    const detailResponse = await fetch(`${base}/${template.templateId}`);
    const detail = (await detailResponse.json()) as {
      template: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(detail.template).sort(), [
      "content",
      "description",
      "document_type",
      "plan",
      "scope",
      "section_count",
      "template_id",
      "title",
      "updated_at",
    ]);
    assert.equal(JSON.stringify(detail).includes("source_template_id"), false);
    const patchResponse = await fetch(`${base}/${template.templateId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan: {
          title: template.plan.title,
          document_type: template.plan.documentType,
          sections: template.plan.sections.map((section) => ({
            id: section.id,
            heading: section.heading,
            purpose: section.purpose,
            required_sources: section.requiredSources,
          })),
        },
      }),
    });
    assert.equal(patchResponse.status, 200);
    const rejected = await fetch(`${base}/${template.templateId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ system_instructions: "unbounded" }),
    });
    assert.equal(rejected.status, 422);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-template-v21-"));
  const prior = process.env.ALETHEIA_DATABASE_ENCRYPTION;
  let database: WorkspaceDatabase | null = null;
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    assert.equal(DOCUMENT_STUDIO_TEMPLATES_V21_MIGRATION.version, 21);
    assert.match(
      workspaceMigrationChecksum(DOCUMENT_STUDIO_TEMPLATES_V21_MIGRATION),
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      WORKSPACE_MIGRATIONS.map((migration) => migration.version),
      Array.from({ length: 23 }, (_, index) => index + 1),
    );
    assert.equal(BUILTIN_DOCUMENT_STUDIO_TEMPLATES_V21.length, 8);
    assert.equal(
      new Set(
        BUILTIN_DOCUMENT_STUDIO_TEMPLATES_V21.map((item) => item.documentType),
      ).size,
      8,
    );
    for (const item of BUILTIN_DOCUMENT_STUDIO_TEMPLATES_V21) {
      DocumentStudioDraftPlanV21Schema.parse(item.plan);
      assert.equal(item.plan.documentType, item.documentType);
    }
    auditUpgradeAndRollback(root);

    database = new WorkspaceDatabase(path.join(root, "fresh.sqlite"));
    for (const name of [
      "document_studio_templates",
      "document_studio_templates_v21_insert_guard",
      "document_studio_templates_v21_local_update_guard",
    ])
      assert.ok(exists(database, name), name);
    const projectId = insertProject(database);
    const otherProjectId = insertProject(database);
    const service = new WorkspaceDocumentStudioTemplatesService(
      new WorkspaceDocumentStudioTemplatesRepository(database),
    );
    const builtin = service.get(
      projectId,
      service.list(projectId)[0]!.templateId,
    );
    const local = service.copy({
      projectId,
      templateId: builtin.templateId,
      title: "本地研究模板",
    });
    assert.throws(
      () => service.get(otherProjectId, local.templateId),
      /not found/i,
    );
    assert.equal(
      service.update({
        projectId,
        templateId: local.templateId,
        title: "本地研究模板（修订）",
        description: "本 Matter 的有界模板修订。",
        content: `${local.content}\n## 人工复核\n\n[记录复核人和日期。]\n`,
        plan: local.plan,
      }).title,
      "本地研究模板（修订）",
    );
    assert.throws(
      () =>
        service.update({
          projectId,
          templateId: builtin.templateId,
          title: "篡改",
        }),
      /immutable/i,
    );
    assert.throws(
      () =>
        service.update({
          projectId,
          templateId: local.templateId,
          content: "法".repeat(1_400_000),
        }),
      /custom|validation|too big|invalid/i,
    );
    assert.throws(
      () =>
        database!
          .prepare(
            "UPDATE document_studio_templates SET project_id=? WHERE id=?",
          )
          .run(otherProjectId, local.templateId),
      /scope are immutable/i,
    );
    database
      .prepare(
        "UPDATE projects SET status='archived',archived_at=?,updated_at=? WHERE id=?",
      )
      .run(NOW, NOW, projectId);
    assert.equal(service.list(projectId).length, 9);
    assert.equal(
      service.get(projectId, local.templateId).templateId,
      local.templateId,
    );
    assert.throws(
      () =>
        service.copy({
          projectId,
          templateId: builtin.templateId,
          title: "归档复制",
        }),
      /read-only/i,
    );
    assert.throws(
      () =>
        service.update({
          projectId,
          templateId: local.templateId,
          title: "归档修改",
        }),
      /read-only/i,
    );
    await auditHttpWire(builtin);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    console.log("Workspace Document Studio template v21 audit passed.");
  } finally {
    database?.close();
    if (prior === undefined) delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    else process.env.ALETHEIA_DATABASE_ENCRYPTION = prior;
    rmSync(root, { recursive: true, force: true });
  }
}

void run();
