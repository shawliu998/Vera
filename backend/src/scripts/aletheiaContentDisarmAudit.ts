import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ContentDisarmBlockedError,
  disarmLocalUpload,
  type ContentDisarmCommand,
  type ContentDisarmRunner,
} from "../lib/aletheia/contentDisarm";
import { isAletheiaEnvelope } from "../lib/aletheia/localEnvelopeCrypto";
import { LocalAletheiaRepository } from "../lib/aletheia/localRepository";

function fixture(root: string) {
  const converter = path.join(root, "fake-soffice");
  const source = path.join(root, "source.docx");
  writeFileSync(converter, "fake converter fixture", { mode: 0o700 });
  chmodSync(converter, 0o700);
  const sourceBuffer = Buffer.from("PK\u0003\u0004 fake docx evidence fixture");
  writeFileSync(source, sourceBuffer, { mode: 0o600 });
  return { converter, source, sourceBuffer };
}

function successfulRunner(): ContentDisarmRunner {
  return async (command: ContentDisarmCommand) => {
    if (!command.expectedOutputPath) {
      return {
        code: 0,
        output: "LibreOffice 24.2.7.2 (fake test adapter)",
        timedOut: false,
      };
    }
    writeFileSync(
      command.expectedOutputPath,
      Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF"),
      { mode: 0o600 },
    );
    return {
      code: 0,
      output: "convert source.docx as source.pdf",
      timedOut: false,
      outputPath: command.expectedOutputPath,
    };
  };
}

async function expectBlocked(
  code: ContentDisarmBlockedError["code"],
  operation: () => Promise<unknown>,
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ContentDisarmBlockedError);
    assert.equal(error.code, code);
    return true;
  });
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-cdr-audit-"));
  const { converter, source, sourceBuffer } = fixture(root);
  const common = {
    converterPath: converter,
    executableAllowlist: [converter],
    injectedNetworkIsolation: true,
  } as const;

  const disabled = await disarmLocalUpload(source, "source.docx", {
    ...common,
    mode: "disabled",
    runner: successfulRunner(),
  });
  assert.equal(disabled.metadata.status, "disabled");
  assert.equal(disabled.derivedBuffer, undefined);

  await expectBlocked("cdr_unavailable", () =>
    disarmLocalUpload(source, "source.docx", {
      mode: "required",
      converterPath: null,
      executableAllowlist: [],
      injectedNetworkIsolation: true,
      runner: successfulRunner(),
    }),
  );

  await expectBlocked("cdr_failed", () =>
    disarmLocalUpload(source, "source.docx", {
      ...common,
      mode: "required",
      runner: async () => ({
        code: 2,
        output: "fake converter rejected document",
        timedOut: false,
      }),
    }),
  );

  await expectBlocked("cdr_failed", () =>
    disarmLocalUpload(source, "source.docx", {
      ...common,
      mode: "required",
      timeoutMs: 1_000,
      runner: async () => ({
        code: null,
        output: "",
        timedOut: true,
      }),
    }),
  );

  const escapedOutput = path.join(root, "escaped.pdf");
  writeFileSync(escapedOutput, "%PDF-1.4\n%%EOF", { mode: 0o600 });
  const escaped = await disarmLocalUpload(source, "source.docx", {
    ...common,
    mode: "best_effort",
    runner: async (command) =>
      command.expectedOutputPath
        ? {
            code: 0,
            output: "attempted path escape",
            timedOut: false,
            outputPath: escapedOutput,
          }
        : { code: 0, output: "fake version", timedOut: false },
  });
  assert.equal(escaped.metadata.status, "error");
  assert.match(
    escaped.metadata.detail,
    /escaped the isolated output directory/,
  );
  assert.equal(escaped.derivedBuffer, undefined);

  const unsupported = await disarmLocalUpload(source, "evidence.pdf", {
    ...common,
    mode: "best_effort",
    runner: successfulRunner(),
  });
  assert.equal(unsupported.metadata.status, "unsupported");
  assert.match(unsupported.metadata.detail, /not sanitized/);

  const sanitized = await disarmLocalUpload(source, "source.docx", {
    ...common,
    mode: "required",
    runner: successfulRunner(),
  });
  assert.equal(sanitized.metadata.status, "sanitized");
  assert.equal(sanitized.metadata.converter, "libreoffice");
  assert.equal(
    sanitized.metadata.derivedSha256,
    createHash("sha256").update(sanitized.derivedBuffer!).digest("hex"),
  );
  assert.equal(
    sanitized.metadata.originalSha256,
    createHash("sha256").update(sourceBuffer).digest("hex"),
  );

  const dataDir = path.join(root, "vault");
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = "ab".repeat(32);
  const repository = new LocalAletheiaRepository();
  const context = { userId: "cdr-local-user", userEmail: "cdr@local.invalid" };
  const matter = (await repository.createMatter(context, {
    title: "CDR evidence preservation",
    objective: "Preserve authoritative original and parse a safety derivative",
    template: "legal_matter_review",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { testOnly: true },
  })) as { id: string };
  await repository.uploadMatterDocument(context, matter.id, {
    filename: "source.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: sourceBuffer.byteLength,
    buffer: sourceBuffer,
    malwareScan: {
      mode: "required",
      status: "clean",
      scanner: "clamav",
      sha256: sanitized.metadata.originalSha256,
      detail: "fake clean result after ClamAV stage",
      scannedAt: new Date().toISOString(),
    },
    contentDisarm: sanitized,
  });
  const detail = (await repository.getMatterDetail(context, matter.id)) as {
    documents: Array<{
      metadata: {
        storagePath: string;
        originalSha256: string;
        evidenceFileMode: string;
        parseSource: string;
        contentDisarm: {
          status: string;
          derivedSha256: string;
          derivedStoragePath: string;
          converterVersion: string;
        };
      };
    }>;
    auditEvents: Array<{ action: string; details: Record<string, unknown> }>;
  };
  const metadata = detail.documents[0]!.metadata;
  assert.equal(metadata.originalSha256, sanitized.metadata.originalSha256);
  assert.equal(metadata.contentDisarm.status, "sanitized");
  assert.equal(
    metadata.contentDisarm.derivedSha256,
    sanitized.metadata.derivedSha256,
  );
  assert.equal(metadata.parseSource, "cdr_pdf_derivative");
  assert.equal(metadata.evidenceFileMode, "immutable_owner_read_only");
  assert.ok(isAletheiaEnvelope(readFileSync(metadata.storagePath)));
  assert.ok(
    isAletheiaEnvelope(readFileSync(metadata.contentDisarm.derivedStoragePath)),
  );
  assert.equal(lstatSync(metadata.storagePath).mode & 0o777, 0o400);
  assert.equal(
    lstatSync(metadata.contentDisarm.derivedStoragePath).mode & 0o777,
    0o400,
  );
  assert.ok(
    detail.auditEvents.some(
      (event) =>
        event.action === "document_uploaded" &&
        (event.details.contentDisarm as { status?: string } | undefined)
          ?.status === "sanitized",
    ),
  );
  const purgeApproval = (await repository.requestApproval(context, matter.id, {
    action: "matter_purge",
    requestedPayload: { matterId: matter.id },
  })) as { id: string };
  await repository.decideApproval(context, matter.id, purgeApproval.id, {
    decision: "approved",
  });
  await repository.purgeMatter(context, matter.id, purgeApproval.id);
  assert.equal(existsSync(metadata.storagePath), false);
  assert.equal(existsSync(metadata.contentDisarm.derivedStoragePath), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        assertions: {
          disabledDoesNotClaimSanitization: true,
          requiredMissingConverterFailsClosed: true,
          converterRejectionFailsClosed: true,
          timeoutFailsClosed: true,
          outputEscapeRejected: true,
          unsupportedFormatReportedHonestly: true,
          originalAndDerivativeHashesPersisted: true,
          encryptedReadOnlyOriginalPreserved: true,
          cdrDerivativeAudited: true,
          purgeRemovesOriginalAndDerivative: true,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
