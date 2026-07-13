import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import PizZip from "pizzip";
import { isAletheiaEnvelope } from "../lib/aletheia/localEnvelopeCrypto";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import {
  closeLocalAletheiaRepositoryForAudit,
  LocalAletheiaRepository,
} from "../lib/aletheia/localRepository";

type Row = Record<string, any>;

function row(value: unknown) {
  assert(value && typeof value === "object");
  return value as Row;
}

function editPackage(bytes: Buffer, edit: (xml: string) => string) {
  const archive = new PizZip(bytes);
  const xml = archive.file("word/document.xml")?.asText();
  assert(xml);
  archive.file("word/document.xml", edit(xml));
  return archive.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-document-roundtrip-"));
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 81).toString("base64");
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  const owner = { userId: "roundtrip-owner" };
  const other = { userId: "roundtrip-other" };
  const repository = new LocalAletheiaRepository();
  try {
    const matter = row(
      await repository.createMatter(owner, {
        title: "Round-trip matter",
        objective: "Verify external DOCX revision import.",
        template: "civil_litigation",
        status: "in_progress",
        riskLevel: "high",
        clientOrProject: null,
        sourceProjectId: null,
        sharedWith: [],
        metadata: { audit: "document_roundtrip" },
      }),
    );
    const artifact = row(
      await repository.generateLitigationArtifact(owner, matter.id, "litigation_brief"),
    );
    const draft = row(
      await repository.createLitigationDocumentDraft(owner, matter.id, {
        artifactId: artifact.id,
      }),
    );
    const versionOne = row(draft.versions[0]);
    const exported = row(
      await repository.exportLitigationDocumentDraftDocx(
        owner,
        matter.id,
        draft.id,
        versionOne.id,
      ),
    );
    assert(Buffer.isBuffer(exported.bytes));
    const packageZip = new PizZip(exported.bytes);
    const custom = packageZip.file("docProps/custom.xml")?.asText() ?? "";
    const documentXml = packageZip.file("word/document.xml")?.asText() ?? "";
    assert(custom.includes("VeraBindingHash"));
    for (const section of versionOne.sections as Row[]) {
      assert(documentXml.includes(`vera_section_${section.id}`));
    }

    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "unchanged.docx",
          bytes: exported.bytes,
          changeSummary: "Attempted unchanged import.",
        }),
      (error: any) => error?.code === "DOCX_NO_CHANGES",
    );
    const firstBody = String(
      (versionOne.sections as Row[]).find((section) => section.id !== "sources")?.body,
    );
    assert(firstBody);
    const revisedBytes = editPackage(exported.bytes, (xml) =>
      xml.replace(
        firstBody,
        `${firstBody} Counsel added a bounded external revision.`,
      ),
    );
    const imported = row(
      await repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
        filename: "lawyer-revision.docx",
        bytes: revisedBytes,
        changeSummary: "Imported counsel's reviewed DOCX revision.",
      }),
    );
    const versionTwo = row(imported.versions.at(-1));
    assert.equal(versionTwo.version, 2);
    assert.equal(versionTwo.parent_version_id, versionOne.id);
    assert.equal(versionTwo.review_status, "unreviewed");
    assert.equal(versionTwo.provenance.source, "external_docx_import");
    assert.equal(versionTwo.provenance.originalFilename, "lawyer-revision.docx");
    assert(
      versionTwo.sections.some((section: Row) =>
        String(section.body).includes("bounded external revision"),
      ),
    );
    const diff = row(
      await repository.diffLitigationDocumentDraftVersions(
        owner,
        matter.id,
        draft.id,
        1,
        2,
      ),
    );
    assert(diff.changes.some((change: Row) => change.status === "modified"));
    assert.equal(
      diff.changes.find((change: Row) => change.id === "sources").status,
      "unchanged",
    );

    const db = new LocalDatabase(path.join(root, "aletheia.db"));
    const acceptedAttempt = row(
      db
        .prepare(
          "select * from aletheia_litigation_document_draft_import_attempts where status = 'accepted'",
        )
        .get(),
    );
    assert.equal(acceptedAttempt.accepted_version_id, versionTwo.id);
    assert.equal(isAletheiaEnvelope(readFileSync(acceptedAttempt.storage_path)), true);
    assert.notEqual(readFileSync(acceptedAttempt.storage_path).subarray(0, 2).toString(), "PK");
    assert.equal(
      db
        .prepare(
          "select count(*) as n from aletheia_litigation_document_draft_import_attempts where status = 'rejected'",
        )
        .get().n,
      1,
    );
    assert.equal(
      db
        .prepare(
          "select count(*) as n from aletheia_litigation_document_draft_versions where document_id = ? and review_status != 'unreviewed'",
        )
        .get(draft.id).n,
      0,
    );
    assert.throws(() =>
      db
        .prepare(
          "update aletheia_litigation_document_draft_import_attempts set status = 'accepted' where status = 'rejected'",
        )
        .run(),
    );
    const attemptCount = Number(
      db
        .prepare(
          "select count(*) as n from aletheia_litigation_document_draft_import_attempts",
        )
        .get().n,
    );
    db.close();

    await assert.rejects(
      () =>
        repository.exportLitigationDocumentDraftDocx(
          other,
          matter.id,
          draft.id,
          versionTwo.id,
        ),
      /lacks matter\.read/i,
    );
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(other, matter.id, draft.id, {
          filename: "cross-user.docx",
          bytes: revisedBytes,
          changeSummary: "Cross-user write must not persist.",
        }),
      /lacks matter\.write/i,
    );
    const isolatedDb = new LocalDatabase(path.join(root, "aletheia.db"));
    assert.equal(
      isolatedDb
        .prepare(
          "select count(*) as n from aletheia_litigation_document_draft_import_attempts",
        )
        .get().n,
      attemptCount,
    );
    isolatedDb.close();

    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "old-base.docx",
          bytes: revisedBytes,
          changeSummary: "Historical base cannot replace the latest version.",
        }),
      (error: any) => error?.code === "DOCX_BINDING_MISMATCH",
    );

    const latestExport = row(
      await repository.exportLitigationDocumentDraftDocx(
        owner,
        matter.id,
        draft.id,
        versionTwo.id,
      ),
    );
    const latestSource = String(
      (versionTwo.sections as Row[]).find((section) => section.id === "sources")?.body,
    );
    const sourceChanged = editPackage(latestExport.bytes, (xml) => {
      const marker = xml.indexOf("vera_section_sources");
      assert(marker >= 0);
      const before = xml.slice(0, marker);
      const after = xml.slice(marker);
      const changed = after.replace(latestSource, `${latestSource} Altered source projection.`);
      assert.notEqual(changed, after);
      return before + changed;
    });
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "source-changed.docx",
          bytes: sourceChanged,
          changeSummary: "Read-only source projection must not change.",
        }),
      (error: any) => error?.code === "DOCX_SOURCE_CHANGED",
    );
    const tracked = editPackage(latestExport.bytes, (xml) =>
      xml.replace("</w:body>", "<w:ins/></w:body>"),
    );
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "tracked.docx",
          bytes: tracked,
          changeSummary: "Unresolved tracked changes must be rejected.",
        }),
      (error: any) => error?.code === "DOCX_TRACKED_CHANGES",
    );
    const missingBookmark = editPackage(latestExport.bytes, (xml) =>
      xml.replace("vera_section_issues", "removed_section_issues"),
    );
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "missing-bookmark.docx",
          bytes: missingBookmark,
          changeSummary: "Missing section binding must be rejected.",
        }),
      (error: any) => error?.code === "DOCX_SECTION_INVALID",
    );
    const activeZip = new PizZip(latestExport.bytes);
    activeZip.file("word/vbaProject.bin", Buffer.from("macro"));
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "macro.docx",
          bytes: activeZip.generate({ type: "nodebuffer" }) as Buffer,
          changeSummary: "Active content must be rejected.",
        }),
      (error: any) => error?.code === "DOCX_ACTIVE_CONTENT",
    );
    const customXmlZip = new PizZip(latestExport.bytes);
    customXmlZip.file("customXml/item1.xml", "<unsafe/>");
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "custom-xml.docx",
          bytes: customXmlZip.generate({ type: "nodebuffer" }) as Buffer,
          changeSummary: "Custom XML must be rejected.",
        }),
      (error: any) => error?.code === "DOCX_ACTIVE_CONTENT",
    );
    const externalZip = new PizZip(latestExport.bytes);
    const relName = "word/_rels/document.xml.rels";
    const relXml = externalZip.file(relName)?.asText() ?? "";
    externalZip.file(
      relName,
      relXml.replace(
        "</Relationships>",
        '<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid" TargetMode="External"/></Relationships>',
      ),
    );
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "external-link.docx",
          bytes: externalZip.generate({ type: "nodebuffer" }) as Buffer,
          changeSummary: "External relationships must be rejected.",
        }),
      (error: any) => error?.code === "DOCX_EXTERNAL_RELATIONSHIP",
    );
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "malformed.docx",
          bytes: Buffer.from("not a docx"),
          changeSummary: "Malformed package must be rejected.",
        }),
      (error: any) => ["DOCX_INVALID", "DOCX_BINDING_MISSING"].includes(error?.code),
    );
    const detail = row(
      await repository.getLitigationDocumentDraft(owner, matter.id, draft.id),
    );
    assert(detail.import_attempts.length >= 5);
    assert.equal(
      detail.import_attempts.some((attempt: Row) => "storage_path" in attempt),
      false,
    );

    const rollbackBytes = editPackage(latestExport.bytes, (xml) =>
      xml.replace(
        "Counsel added a bounded external revision.",
        "Counsel added a bounded external revision and rollback probe.",
      ),
    );
    const rollbackDb = new LocalDatabase(path.join(root, "aletheia.db"));
    rollbackDb.exec(`create trigger roundtrip_force_version_rollback
      before insert on aletheia_litigation_document_draft_versions
      begin select raise(abort, 'forced roundtrip rollback'); end;`);
    rollbackDb.close();
    const retainedDirectory = path.join(root, "documents", "draft-imports");
    const beforeFiles = readdirSync(retainedDirectory).sort();
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "rollback.docx",
          bytes: rollbackBytes,
          changeSummary: "Force a transaction rollback and file cleanup.",
        }),
      /forced roundtrip rollback/i,
    );
    const afterRollbackDb = new LocalDatabase(path.join(root, "aletheia.db"));
    afterRollbackDb.exec("drop trigger roundtrip_force_version_rollback");
    afterRollbackDb.close();
    assert.deepEqual(readdirSync(retainedDirectory).sort(), beforeFiles);

    const staleDb = new LocalDatabase(path.join(root, "aletheia.db"));
    staleDb
      .prepare("update aletheia_work_products set stale_at = ?, stale_reason = ? where id = ?")
      .run(new Date().toISOString(), "roundtrip stale probe", artifact.id);
    staleDb.close();
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "stale.docx",
          bytes: rollbackBytes,
          changeSummary: "A stale source must lock DOCX import.",
        }),
      /stale/i,
    );
    await repository.withdrawLitigationDocumentDraft(owner, matter.id, draft.id, {
      reason: "Source state changed; counsel withdraws the round-trip draft.",
    });
    await assert.rejects(
      () =>
        repository.importLitigationDocumentDraftDocx(owner, matter.id, draft.id, {
          filename: "withdrawn.docx",
          bytes: rollbackBytes,
          changeSummary: "A withdrawn draft must remain locked.",
        }),
      /withdrawn/i,
    );
    const auditMatter = row(await repository.getMatterDetail(owner, matter.id));
    assert(
      auditMatter.auditEvents.some(
        (event: Row) => event.action === "litigation_document_draft_docx_imported",
      ),
    );
    assert(
      auditMatter.auditEvents.some(
        (event: Row) => event.action === "litigation_document_draft_docx_import_rejected",
      ),
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-litigation-document-round-trip-v1",
          checks: {
            boundDocx: true,
            immutableImportedVersion: true,
            diffAndReopenProjection: true,
            encryptedOriginal: true,
            noAutomaticReview: true,
            noOpAndHistoricalConflict: true,
            activeContentAndTrackedChanges: true,
            externalRelationshipAndCustomXml: true,
            sectionBindingFailure: true,
            sourceImmutability: true,
            malformedRejected: true,
            userMatterIsolation: true,
            rejectionPersistence: true,
            immutableAttempts: true,
            auditEvents: true,
            noPathLeakage: true,
            rollbackFileCleanup: true,
            staleAndWithdrawnGates: true,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    closeLocalAletheiaRepositoryForAudit();
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
