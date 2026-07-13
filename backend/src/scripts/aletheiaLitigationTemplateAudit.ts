import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import { LocalAletheiaRepository } from "../lib/aletheia/localRepository";
import {
  inspectLitigationDocxTemplate,
  LitigationDocxTemplateError,
} from "../lib/aletheia/litigationDocxTemplate";

async function templateDocx(bodyField = "aletheia_body") {
  return Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph("{artifact_title}"),
            new Paragraph("案号：{case_number}"),
            new Paragraph(`{${bodyField}}`),
          ],
        },
      ],
    }),
  );
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-template-audit-"));
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 67).toString(
    "base64",
  );
  const repository = new LocalAletheiaRepository();
  const ctx = { userId: "template-owner", userEmail: "owner@example.invalid" };
  try {
    const matter = (await repository.createMatter(ctx, {
      title: "Template governance matter",
      objective: "Verify approved DOCX template rendering",
      template: "civil_litigation",
      status: "in_progress",
      riskLevel: "medium",
      clientOrProject: null,
      sourceProjectId: null,
      sharedWith: [],
      metadata: { audit: true },
    })) as { id: string };
    const validBytes = await templateDocx();
    const inspection = inspectLitigationDocxTemplate(validBytes);
    assert.deepEqual(inspection.placeholders, [
      "aletheia_body",
      "artifact_title",
      "case_number",
    ]);
    await assert.rejects(
      async () =>
        inspectLitigationDocxTemplate(await templateDocx("shell_command")),
      (error: unknown) =>
        error instanceof LitigationDocxTemplateError &&
        error.code === "TEMPLATE_FIELD_UNSUPPORTED",
    );
    const activeZip = await JSZip.loadAsync(validBytes);
    activeZip.file("word/vbaProject.bin", Buffer.from("macro"));
    const activeBytes = await activeZip.generateAsync({ type: "nodebuffer" });
    assert.throws(
      () => inspectLitigationDocxTemplate(activeBytes),
      (error: unknown) =>
        error instanceof LitigationDocxTemplateError &&
        error.code === "TEMPLATE_ACTIVE_CONTENT",
    );

    const draft = (await repository.importLitigationDocumentTemplate(
      ctx,
      matter.id,
      { name: "本所民事工作底稿", bytes: validBytes },
    )) as Record<string, any>;
    assert.equal(draft.status, "draft");
    assert.equal("storage_path" in draft, false);
    await assert.rejects(
      () =>
        repository.listLitigationDocumentTemplates(
          { userId: "other-user" },
          matter.id,
        ),
      /lacks matter.read/,
    );
    const storedPath = path.join(
      root,
      "templates",
      matter.id,
      `${draft.id}.docx`,
    );
    assert.equal(
      readFileSync(storedPath).subarray(0, 2).toString("ascii") === "PK",
      false,
    );

    const publishCheckpoint = (await repository.requestApproval(
      ctx,
      matter.id,
      {
        action: "litigation_template_publish",
        requestedPayload: {
          templateId: draft.id,
          fileSha256: draft.file_sha256,
          version: draft.version,
        },
      },
    )) as Record<string, any>;
    await repository.decideApproval(ctx, matter.id, publishCheckpoint.id, {
      decision: "approved",
      comment: "Fields and layout were reviewed against firm policy.",
    });
    const published = (await repository.publishLitigationDocumentTemplate(
      ctx,
      matter.id,
      draft.id,
      publishCheckpoint.id,
    )) as Record<string, any>;
    assert.equal(published.status, "approved");
    assert.equal(published.independent_approval, 0);

    await repository.updateLitigationProfile(ctx, matter.id, {
      organizationName: "Aletheia Trial Team",
      court: "Shanghai Commercial Court",
      caseNumber: "2026-CIV-TPL",
      exhibitPrefix: "EX",
      exhibitStart: 1,
      paginationPolicy: "auto",
      documentTemplateId: draft.id,
      documentTemplateVersion: draft.version,
    });
    const artifact = (await repository.generateLitigationArtifact(
      ctx,
      matter.id,
      "evidence_catalog",
    )) as Record<string, any>;
    assert.equal(artifact.content.documentTemplate.id, draft.id);
    const exportCheckpoint = (await repository.requestApproval(ctx, matter.id, {
      action: "litigation_artifact_export",
      requestedPayload: {
        workProductId: artifact.id,
        version: artifact.version,
        contentHash: artifact.content_hash,
      },
    })) as Record<string, any>;
    await repository.decideApproval(ctx, matter.id, exportCheckpoint.id, {
      decision: "approved",
      comment: "Approved custom-template work product for local export.",
    });
    const exported = (await repository.exportLitigationArtifact(
      ctx,
      matter.id,
      artifact.id,
      exportCheckpoint.id,
      "docx",
    )) as Record<string, any>;
    const downloaded = (await repository.downloadLitigationArtifact(
      ctx,
      matter.id,
      exported.exportId,
    )) as { bytes: Buffer };
    const output = await JSZip.loadAsync(downloaded.bytes);
    const documentXml = await output.file("word/document.xml")!.async("string");
    assert.match(documentXml, /Evidence catalog/);
    assert.match(documentXml, /2026-CIV-TPL/);
    assert.equal(documentXml.includes("{aletheia_body}"), false);
    assert.equal(documentXml.includes("{case_number}"), false);

    const retirementCheckpoint = (await repository.requestApproval(
      ctx,
      matter.id,
      {
        action: "litigation_template_retire",
        requestedPayload: {
          templateId: draft.id,
          fileSha256: draft.file_sha256,
          version: draft.version,
        },
      },
    )) as Record<string, any>;
    await repository.decideApproval(ctx, matter.id, retirementCheckpoint.id, {
      decision: "approved",
      comment: "Superseded by the reviewed built-in working paper template.",
    });
    await assert.rejects(
      () =>
        repository.retireLitigationDocumentTemplate(
          ctx,
          matter.id,
          draft.id,
          retirementCheckpoint.id,
        ),
      /Switch the matter to another approved template/,
    );
    await repository.updateLitigationProfile(ctx, matter.id, {
      organizationName: "Aletheia Trial Team",
      court: "Shanghai Commercial Court",
      caseNumber: "2026-CIV-TPL",
      exhibitPrefix: "EX",
      exhibitStart: 1,
      paginationPolicy: "auto",
      documentTemplateId: "cn-litigation-working-paper",
      documentTemplateVersion: 1,
    });
    const retired = (await repository.retireLitigationDocumentTemplate(
      ctx,
      matter.id,
      draft.id,
      retirementCheckpoint.id,
    )) as Record<string, any>;
    assert.equal(retired.status, "retired");
    assert.equal(readFileSync(storedPath).length > 0, true);
    await assert.rejects(
      () =>
        repository.updateLitigationProfile(ctx, matter.id, {
          exhibitPrefix: "EX",
          exhibitStart: 1,
          paginationPolicy: "auto",
          documentTemplateId: draft.id,
          documentTemplateVersion: draft.version,
        }),
      /unavailable or not approved/,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "aletheia-litigation-template-governance-v1",
          checks: {
            safeDocxInspection: true,
            activeContentAndUnknownFieldsRejected: true,
            encryptedDraftPersistence: true,
            ownerIsolation: true,
            hashBoundApprovalPublication: true,
            approvedCustomTemplateRendering: true,
            activeTemplateRetirementBlocked: true,
            retirementPreservesEncryptedHistory: true,
            approvedVersionRollback: true,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
