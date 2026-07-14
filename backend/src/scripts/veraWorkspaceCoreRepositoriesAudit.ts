import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  BlobIntegrity,
  BlobStore,
  StoredWorkspaceBlob,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { ChatsRepository } from "../lib/workspace/repositories/chats";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { SettingsRepository } from "../lib/workspace/repositories/settings";
import { ChatsService } from "../lib/workspace/services/chats";
import { ProjectsService } from "../lib/workspace/services/projects";
import { ModelProfilesService } from "../lib/workspace/services/modelProfiles";
import { SettingsService } from "../lib/workspace/services/settings";

class AuditBlobStore implements BlobStore {
  readonly available = new Set<string>();
  readonly staged = new Set<string>();
  readonly finalized = new Set<string>();
  private readonly quarantine = new Map<string, string>();
  private key(locator: WorkspaceBlobLocator) {
    return JSON.stringify(locator);
  }
  putSync(locator: WorkspaceBlobLocator): StoredWorkspaceBlob {
    this.available.add(this.key(locator));
    return { locator, sha256: "a".repeat(64), size: 1, storedSize: 1 };
  }
  readSync(_locator: WorkspaceBlobLocator, _expected: BlobIntegrity) {
    return Buffer.from("audit");
  }
  stageDeleteSync(locator: WorkspaceBlobLocator): WorkspaceBlobDeleteReceipt {
    const key = this.key(locator);
    if (!this.available.has(key)) throw new Error(`missing blob ${key}`);
    this.available.delete(key);
    this.staged.add(key);
    const quarantineId = crypto.randomUUID();
    this.quarantine.set(quarantineId, key);
    return { status: "staged", locator, quarantineId };
  }
  finalizeDeleteSync(receipt: WorkspaceBlobDeleteReceipt) {
    const key = this.quarantine.get(receipt.quarantineId);
    if (!key) throw new Error("receipt is not staged");
    if (!this.staged.delete(key)) throw new Error("receipt is not staged");
    this.quarantine.delete(receipt.quarantineId);
    this.finalized.add(key);
  }
  restoreDeleteSync(receipt: WorkspaceBlobDeleteReceipt) {
    const key = this.quarantine.get(receipt.quarantineId);
    if (!key) throw new Error("receipt is not staged");
    if (!this.staged.delete(key)) throw new Error("receipt is not staged");
    this.quarantine.delete(receipt.quarantineId);
    this.available.add(key);
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "vera-workspace-core-audit-"));
const now = () => new Date("2026-07-14T00:00:00.000Z");

function insertDocumentVersion(
  database: WorkspaceDatabase,
  projectId: string | null,
) {
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  database
    .prepare(
      "INSERT INTO documents (id,project_id,title,filename,mime_type,size_bytes) VALUES (?,?,?,?,?,?)",
    )
    .run(documentId, projectId, "Audit document", "audit.txt", "text/plain", 5);
  database
    .prepare(
      "INSERT INTO document_versions (id,document_id,version_number,source,filename,mime_type,size_bytes,content_sha256,storage_key) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      versionId,
      documentId,
      1,
      "upload",
      "audit.txt",
      "text/plain",
      5,
      "a".repeat(64),
      `version-${versionId}`,
    );
  return { documentId, versionId };
}

try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const databasePath = path.join(root, "workspace.db");
  const database = new WorkspaceDatabase(databasePath);
  const blobs = new AuditBlobStore();
  const projects = new ProjectsRepository(database);
  const profiles = new ModelProfilesRepository(database);
  const settings = new SettingsRepository(database);
  const chats = new ChatsRepository(database);
  const blobRecords = new WorkspaceBlobRecordsRepository(database);
  const projectService = new ProjectsService(projects, blobs, {
    resources: {
      cancelQueued() {},
      requestAbortRunning() {},
    },
    cleanupRecorder: { record() {} },
    clock: now,
  });
  const modelService = new ModelProfilesService(
    profiles,
    { allowLocalDevelopmentBaseUrl: true },
    now,
  );
  const chatService = new ChatsService(chats, projects, profiles, now);
  const settingsService = new SettingsService(
    settings,
    projects,
    profiles,
    now,
  );

  database.exec(
    "CREATE TABLE aletheia_core_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO aletheia_core_sentinel VALUES (1,'preserve');",
  );

  assert.throws(
    () =>
      modelService.create({
        name: "Enabled profile rejected",
        provider: "openai_compatible",
        model: "audit-model",
        baseUrl: "http://localhost:11434/v1",
        enabled: true,
      }),
    /enabled profiles must remain dormant/,
  );
  assert.throws(
    () =>
      modelService.create({
        name: "Default profile rejected",
        provider: "openai_compatible",
        model: "audit-model",
        baseUrl: "http://localhost:11434/v1",
        isDefault: true,
      }),
    /selecting a default profile is disabled/,
  );
  const profile = modelService.create({
    name: "Audit profile",
    provider: "openai_compatible",
    model: "audit-model",
    baseUrl: "http://localhost:11434/v1",
    capabilities: {
      streaming: true,
      toolCalling: false,
      structuredOutput: true,
      vision: false,
    },
    enabled: false,
    isDefault: false,
  });
  assert.equal(profile.isDefault, false);
  assert.equal(profile.enabled, false);
  assert.equal(profile.capabilities.streaming, false);
  assert.equal(profile.capabilities.structuredOutput, false);
  assert.equal("credentialRef" in profile, false);
  assert.equal("secret" in profile, false);
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM model_profiles WHERE is_default=1",
      )
      .get()?.count,
    0,
  );
  const lockedModelService = new ModelProfilesService(profiles, {}, now);
  assert.throws(
    () =>
      lockedModelService.create({
        name: "Bad HTTP",
        provider: "openai",
        model: "x",
        baseUrl: "http://localhost:99",
      }),
    /explicit local-development/,
  );
  assert.throws(
    () =>
      profiles.setCredentialReferenceInternal(
        profile.id,
        "secret-value",
        "configured",
        now().toISOString(),
      ),
    /Credential locator/,
  );
  profiles.update(profile.id, { enabled: true, now: now().toISOString() });

  const project = projectService.create({ name: "Audit project" });
  const otherProject = projectService.create({ name: "Other project" });
  const rootFolder = projectService.createFolder(project.id, { name: "Root" });
  const childFolder = projectService.createFolder(project.id, {
    name: "Child",
    parentFolderId: rootFolder.id,
  });
  assert.throws(
    () =>
      projectService.updateFolder(rootFolder.id, {
        parentFolderId: childFolder.id,
      }),
    /cycle/,
  );
  const foreignFolder = projectService.createFolder(otherProject.id, {
    name: "Foreign",
  });
  assert.throws(
    () =>
      projectService.updateFolder(childFolder.id, {
        parentFolderId: foreignFolder.id,
      }),
    /same project/,
  );
  const pageOne = projects.list({ limit: 1 });
  assert.equal(pageOne.items.length, 1);
  assert.ok(pageOne.nextCursor);
  const pageTwo = projects.list({ limit: 1, cursor: pageOne.nextCursor });
  assert.equal(pageTwo.items.length, 1);
  assert.notEqual(pageOne.items[0].id, pageTwo.items[0].id);
  assert.throws(
    () => projects.list({ cursor: "unsafe", limit: 1 }),
    /Invalid pagination cursor/,
  );
  const boundWorkflowId = crypto.randomUUID();
  database
    .prepare(
      `INSERT INTO workflows
        (id, type, project_id, title, skill_markdown, steps_json,
         columns_config_json, jurisdictions_json, metadata_json)
       VALUES (?, 'assistant', ?, 'Project workflow', '', '[]', '[]', '[]', '{}')`,
    )
    .run(boundWorkflowId, project.id);
  assert.equal(projectService.overview(project.id).workflowCount, 1);

  const source = insertDocumentVersion(database, project.id);
  database
    .prepare("UPDATE document_versions SET preview_storage_key=? WHERE id=?")
    .run(`preview-${source.versionId}`, source.versionId);
  for (const locator of [
    { kind: "original" as const, ...source },
    { kind: "extracted_text" as const, ...source },
    { kind: "preview" as const, ...source },
  ]) {
    const stored = blobs.putSync(locator);
    blobRecords.registerStored({
      locator,
      contentSha256: stored.sha256,
      sizeBytes: stored.size,
      storedSizeBytes: stored.storedSize,
    });
  }
  assert.throws(
    () => projectService.permanentlyDelete(project.id, "Wrong confirmation"),
    /confirmation/,
  );
  assert.ok(projects.get(project.id));
  assert.equal(
    blobs.staged.size,
    0,
    "failed DB confirmation restores staged blobs",
  );
  projectService.permanentlyDelete(project.id, "Audit project");
  assert.equal(projects.get(project.id), null);
  assert.equal(blobs.finalized.size, 3);
  const missingBlobProject = projectService.create({ name: "Missing blob" });
  insertDocumentVersion(database, missingBlobProject.id);
  assert.throws(
    () =>
      projectService.permanentlyDelete(missingBlobProject.id, "Missing blob"),
    /authoritative blob records/,
  );
  assert.ok(
    projects.get(missingBlobProject.id),
    "missing original fails closed before DB deletion",
  );

  const activeProject = projectService.unarchive(otherProject.id);
  const chat = chatService.create({
    projectId: activeProject.id,
    modelProfileId: profile.id,
  });
  assert.equal(chat.title, "新对话");
  for (let index = 0; index < 5; index += 1) {
    chatService.addMessage(chat.id, "user", { content: `message-${index}` });
  }
  const sequences = database
    .prepare(
      "SELECT sequence FROM chat_messages WHERE chat_id=? ORDER BY sequence",
    )
    .all(chat.id)
    .map((row) => Number(row.sequence));
  assert.deepEqual(sequences, [0, 1, 2, 3, 4]);
  const firstMessage = chatService.messages(chat.id)[0];
  chatService.updateMessage(firstMessage.id, "complete");
  assert.throws(
    () => chatService.updateMessage(firstMessage.id, "streaming"),
    /transition/,
  );
  const sameProjectSource = insertDocumentVersion(database, activeProject.id);
  database
    .prepare(
      "INSERT INTO document_chunks (id,document_id,version_id,ordinal,text,start_offset,end_offset,content_sha256,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      crypto.randomUUID(),
      sameProjectSource.documentId,
      sameProjectSource.versionId,
      0,
      "chunk",
      0,
      5,
      "b".repeat(64),
      "{}",
    );
  const chunkId = String(
    database
      .prepare("SELECT id FROM document_chunks WHERE version_id=?")
      .get(sameProjectSource.versionId)?.id,
  );
  chatService.addSource(firstMessage.id, {
    ...sameProjectSource,
    chunkId,
    quote: "chunk",
    startOffset: 0,
    endOffset: 5,
  });
  assert.equal(chatService.sources(firstMessage.id).length, 1);
  const globalChat = chatService.create({ modelProfileId: profile.id });
  const globalMessage = chatService.addMessage(globalChat.id, "user", {
    content: "Review a standalone document.",
  });
  assert.throws(
    () => chatService.addSource(globalMessage.id, sameProjectSource),
    /standalone document/,
  );
  const standaloneSource = insertDocumentVersion(database, null);
  chatService.addSource(globalMessage.id, {
    ...standaloneSource,
    quote: "chunk",
    startOffset: 0,
    endOffset: 5,
  });
  assert.equal(chatService.sources(globalMessage.id).length, 1);
  const crossProjectSource = insertDocumentVersion(
    database,
    missingBlobProject.id,
  );
  assert.throws(
    () => chatService.addSource(firstMessage.id, crossProjectSource),
    /belong to its project/,
  );
  assert.throws(() => chats.sources(crypto.randomUUID()), /Message not found/);

  modelService.disable(profile.id);
  assert.equal(settingsService.get().defaultModelProfileId, null);
  assert.throws(
    () => chatService.create({ modelProfileId: profile.id }),
    /disabled/,
  );
  assert.throws(
    () => settingsService.update({ defaultModelProfileId: profile.id }),
    /default model selection is unavailable/,
  );
  settingsService.update({
    defaultModelProfileId: null,
    defaultProjectId: activeProject.id,
    theme: "dark",
  });
  assert.equal(settingsService.get().theme, "dark");
  settingsService.update({ defaultModelProfileId: null });
  assert.equal(profiles.require(profile.id).isDefault, false);

  database.close();
  const restarted = new WorkspaceDatabase(databasePath);
  assert.equal(
    restarted
      .prepare("SELECT value FROM aletheia_core_sentinel WHERE id=1")
      .get()?.value,
    "preserve",
  );
  assert.equal(
    restarted.prepare("SELECT count(*) AS count FROM chats").get()?.count,
    2,
  );
  restarted.close();
  console.log(
    "Vera Workspace core repositories audit passed: local CRUD, safety constraints, blobs, chats, profiles, settings, and restart persistence.",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
