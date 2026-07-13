import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import { LocalAletheiaRepository } from "../lib/aletheia/localRepository";

type RecordValue = Record<string, any>;

function record(value: unknown) {
  assert(value && typeof value === "object");
  return value as RecordValue;
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-document-draft-audit-"));
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 71).toString("base64");
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  const repository = new LocalAletheiaRepository();
  const owner = { userId: "document-draft-owner" };
  const other = { userId: "document-draft-other" };
  try {
    const matter = record(
      await repository.createMatter(owner, {
        title: "Document draft audit",
        objective: "Verify immutable litigation document draft versions.",
        template: "civil_litigation",
        status: "in_progress",
        riskLevel: "high",
        clientOrProject: null,
        sourceProjectId: null,
        sharedWith: [],
        metadata: { audit: "document_drafts" },
      }),
    );
    const artifact = record(
      await repository.generateLitigationArtifact(
        owner,
        matter.id,
        "litigation_brief",
      ),
    );
    const draft = record(
      await repository.createLitigationDocumentDraft(owner, matter.id, {
        artifactId: artifact.id,
      }),
    );
    assert.equal(draft.artifact_kind, "litigation_brief");
    assert.equal(draft.stale, false);
    assert.deepEqual(
      draft.versions[0].sections.map((section: RecordValue) => section.id),
      ["procedural-posture", "material-facts", "issues", "sources"],
    );
    for (const section of draft.versions[0].sections as RecordValue[]) {
      assert.equal(/^[\s]*[\[{]/.test(section.body), false);
    }
    assert.equal(draft.source_content_hash, artifact.content_hash);
    assert.equal(draft.source_dependency_hash, artifact.dependency_hash);
    const newestArtifact = record(
      await repository.generateLitigationArtifact(
        owner,
        matter.id,
        "litigation_brief",
      ),
    );
    await assert.rejects(
      () =>
        repository.createLitigationDocumentDraft(owner, matter.id, {
          artifactId: artifact.id,
        }),
      /not the latest version/i,
    );
    const repeatDraft = record(
      await repository.createLitigationDocumentDraft(owner, matter.id, {
        artifactId: newestArtifact.id,
      }),
    );
    assert.deepEqual(
      repeatDraft.versions[0].sections,
      draft.versions[0].sections,
    );

    const versionOne = record(draft.versions[0]);
    const editedSections = versionOne.sections.map((section: RecordValue) =>
      section.id === "issues"
        ? { ...section, body: `${section.body}\n{"editorNote":"Preserve cited issue order."}` }
        : section,
    );
    const afterEdit = record(
      await repository.appendLitigationDocumentDraftVersion(owner, matter.id, draft.id, {
        baseVersion: 1,
        changeSummary: "Clarified the issue presentation for the hearing team.",
        sections: editedSections,
      }),
    );
    const versionTwo = record(afterEdit.versions.at(-1));
    assert.equal(versionTwo.version, 2);
    assert.equal(versionTwo.parent_version_id, versionOne.id);
    assert.equal(versionTwo.parent_content_hash, versionOne.content_hash);
    assert.notEqual(versionTwo.content_hash, versionOne.content_hash);
    assert.equal(versionTwo.review_status, "unreviewed");
    const changedSources = versionTwo.sections.map((section: RecordValue) =>
      section.id === "sources"
        ? { ...section, body: `${section.body}\nAltered source text.` }
        : section,
    );
    await assert.rejects(
      () =>
        repository.appendLitigationDocumentDraftVersion(owner, matter.id, draft.id, {
          baseVersion: 2,
          changeSummary: "This edit attempts to alter the locked source section.",
          sections: changedSources,
        }),
      /sources section is read-only/i,
    );

    await assert.rejects(
      () =>
        repository.appendLitigationDocumentDraftVersion(owner, matter.id, draft.id, {
          baseVersion: 1,
          changeSummary: "This stale edit must not replace the current version.",
          sections: editedSections,
        }),
      /version conflict/i,
    );
    const diff = record(
      await repository.diffLitigationDocumentDraftVersions(
        owner,
        matter.id,
        draft.id,
        1,
        2,
      ),
    );
    const issueDiff = record(diff.changes.find((item: RecordValue) => item.id === "issues"));
    assert.equal(issueDiff.status, "modified");
    assert.equal(typeof issueDiff.old_hash, "string");
    assert.equal(typeof issueDiff.new_hash, "string");
    assert.equal(
      diff.changes.find((item: RecordValue) => item.id === "sources").status,
      "unchanged",
    );

    await assert.rejects(
      () =>
        repository.reviewLitigationDocumentDraftVersion(
          owner,
          matter.id,
          draft.id,
          versionOne.id,
          { decision: "approved", reason: "This historical version is no longer current." },
        ),
      /latest document version/i,
    );
    const reviewed = record(
      await repository.reviewLitigationDocumentDraftVersion(
        owner,
        matter.id,
        draft.id,
        versionTwo.id,
        { decision: "approved", reason: "The current version is ready for internal review." },
      ),
    );
    assert.equal(reviewed.versions.at(-1).review_status, "approved");
    await assert.rejects(
      () =>
        repository.reviewLitigationDocumentDraftVersion(
          owner,
          matter.id,
          draft.id,
          versionTwo.id,
          { decision: "rejected", reason: "A decision cannot be changed after it is recorded." },
        ),
      /immutable/i,
    );
    const afterReviewedEdit = record(
      await repository.appendLitigationDocumentDraftVersion(owner, matter.id, draft.id, {
        baseVersion: 2,
        changeSummary: "Added a final review note after approval.",
        sections: editedSections,
      }),
    );
    assert.equal(afterReviewedEdit.versions.at(-1).version, 3);
    assert.equal(afterReviewedEdit.versions.at(-1).review_status, "unreviewed");

    const persisted = new LocalDatabase(path.join(root, "aletheia.db"));
    const persistedVersions = persisted
      .prepare(
        "select version, parent_version_id, parent_content_hash, content_hash, sections from aletheia_litigation_document_draft_versions where document_id = ? order by version",
      )
      .all(draft.id) as RecordValue[];
    assert.equal(persistedVersions.length, 3);
    assert.equal(persistedVersions[2].parent_version_id, versionTwo.id);
    assert.equal(persistedVersions[2].parent_content_hash, versionTwo.content_hash);
    assert.deepEqual(JSON.parse(persistedVersions[0].sections), versionOne.sections);
    persisted.close();

    const validationDb = new LocalDatabase(path.join(root, "aletheia.db"));
    validationDb
      .prepare("update aletheia_work_products set validation_errors = ? where id = ?")
      .run(JSON.stringify([{ code: "evidence_gap" }]), artifact.id);
    validationDb.close();
    const versionThree = record(afterReviewedEdit.versions.at(-1));
    await assert.rejects(
      () =>
        repository.reviewLitigationDocumentDraftVersion(
          owner,
          matter.id,
          draft.id,
          versionThree.id,
          { decision: "approved", reason: "This approval must fail while source validation errors remain." },
        ),
      /unresolved validation errors/i,
    );
    const rejectedWithValidationErrors = record(
      await repository.reviewLitigationDocumentDraftVersion(
        owner,
        matter.id,
        draft.id,
        versionThree.id,
        { decision: "rejected", reason: "The remaining source validation error requires remediation." },
      ),
    );
    assert.equal(rejectedWithValidationErrors.versions.at(-1).review_status, "rejected");

    await repository.updateLitigationProfile(owner, matter.id, {
      organizationName: "Vera Litigation",
      court: "Audit Court",
      caseNumber: "DRAFT-2026-01",
      exhibitPrefix: "EX",
      exhibitStart: 1,
      paginationPolicy: "auto",
      documentTemplateId: "cn-litigation-working-paper",
      documentTemplateVersion: 1,
    });
    const stale = record(
      await repository.getLitigationDocumentDraft(owner, matter.id, draft.id),
    );
    assert.equal(stale.stale, true);
    assert(stale.stale_reasons.length > 0);
    const staleDiff = record(
      await repository.diffLitigationDocumentDraftVersions(
        owner,
        matter.id,
        draft.id,
        1,
        2,
      ),
    );
    assert.equal(staleDiff.document.stale, true);
    assert(staleDiff.changes.length > 0);
    assert.equal(
      staleDiff.changes.find((item: RecordValue) => item.id === "issues").status,
      "modified",
    );
    await assert.rejects(
      () =>
        repository.appendLitigationDocumentDraftVersion(owner, matter.id, draft.id, {
          baseVersion: 3,
          changeSummary: "Stale source artifacts cannot be edited into a document.",
          sections: editedSections,
        }),
      /stale/i,
    );

    assert.equal(
      await repository.getLitigationDocumentDraft(other, matter.id, draft.id),
      null,
    );
    assert.equal(
      await repository.listLitigationDocumentDrafts(other, matter.id),
      null,
    );

    const withdrawn = record(
      await repository.withdrawLitigationDocumentDraft(owner, matter.id, draft.id, {
        reason: "This draft is superseded by the hearing team work product.",
      }),
    );
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.stale, true);
    assert.equal(withdrawn.versions.length, 3);
    await assert.rejects(
      () =>
        repository.reviewLitigationDocumentDraftVersion(
          owner,
          matter.id,
          draft.id,
          versionThree.id,
          { decision: "approved", reason: "Withdrawn drafts cannot be reviewed further." },
        ),
      /withdrawn/i,
    );
    const audit = new LocalDatabase(path.join(root, "aletheia.db"));
    const actions = audit
      .prepare(
        `select action from aletheia_audit_events where matter_id = ?
          and action like 'litigation_document_draft_%' order by sequence`,
      )
      .all(matter.id) as Array<{ action: string }>;
    assert(actions.some((item) => item.action === "litigation_document_draft_created"));
    assert(actions.some((item) => item.action === "litigation_document_draft_version_appended"));
    assert(actions.some((item) => item.action === "litigation_document_draft_version_reviewed"));
    assert(actions.some((item) => item.action === "litigation_document_draft_withdrawn"));
    const withdrawalAudit = audit
      .prepare(
        `select details from aletheia_audit_events
          where matter_id = ? and action = 'litigation_document_draft_withdrawn'
          order by sequence desc limit 1`,
      )
      .get(matter.id) as { details: string } | undefined;
    assert(withdrawalAudit);
    assert.equal(JSON.parse(withdrawalAudit.details).stale, true);
    audit.close();
    console.log("Aletheia litigation document draft audit passed.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
