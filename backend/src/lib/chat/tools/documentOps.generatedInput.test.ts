import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import { readTaskWordArtifactReceipt } from "../../taskWordArtifactReceipt";
import {
  bindGeneratedTaskWordArtifact,
  isValidGenerateDocxInput,
  isValidGenerateExcelInput,
  safeGeneratedFilename,
} from "./documentOps";

async function minimalDocx() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

test("generated Word input is mechanically validated before effect reservation", () => {
  assert.equal(
    isValidGenerateDocxInput({ title: "Opinion", sections: [] }),
    true,
  );
  assert.equal(isValidGenerateDocxInput({ title: " ", sections: [] }), false);
  assert.equal(isValidGenerateDocxInput({ title: "Opinion" }), false);
});

test("generated Excel input can be corrected before effect reservation", () => {
  assert.equal(
    isValidGenerateExcelInput({
      title: "Evidence inventory",
      sheets: [{ name: "Inventory", columns: ["Source"], rows: [] }],
    }),
    true,
  );
  assert.equal(
    isValidGenerateExcelInput({
      title: "Evidence inventory",
      sheets: [{ name: "Inventory", columns: [], rows: [] }],
    }),
    false,
  );
  assert.equal(
    isValidGenerateExcelInput({ title: "Evidence inventory", sheets: [] }),
    false,
  );
});

test("generated filenames preserve legal-language letters and reject punctuation-only titles", () => {
  assert.equal(
    safeGeneratedFilename("听证会大纲 — Hearing Outline", "docx"),
    "听证会大纲 Hearing Outline.docx",
  );
  assert.equal(safeGeneratedFilename("---", "docx"), "document.docx");
});

test("generated Task Word bytes carry the server-owned artifact identity", async () => {
  const buffer = await bindGeneratedTaskWordArtifact({
    extension: "docx",
    buffer: await minimalDocx(),
    projectId: "22222222-2222-4222-8222-222222222222",
    mutationIdentity: {
      documentId: "33333333-3333-4333-8333-333333333333",
      versionId: "44444444-4444-4444-8444-444444444444",
      taskWordArtifact: {
        taskId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        deliverableKey: "opinion-draft",
      },
    },
  });

  assert.deepEqual(await readTaskWordArtifactReceipt(buffer), {
    schemaVersion: 1,
    kind: "agent-task-word-artifact-v1",
    taskId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    deliverableKey: "opinion-draft",
    documentId: "33333333-3333-4333-8333-333333333333",
    versionId: "44444444-4444-4444-8444-444444444444",
  });
});

test("ordinary generated Word bytes remain unbound", async () => {
  const original = await minimalDocx();
  const output = await bindGeneratedTaskWordArtifact({
    extension: "docx",
    buffer: original,
    projectId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(output, original);
  assert.equal(await readTaskWordArtifactReceipt(output), null);
});

test("Task Word binding fails closed outside the fixed Matter", async () => {
  const buffer = await minimalDocx();
  await assert.rejects(
    () =>
      bindGeneratedTaskWordArtifact({
        extension: "docx",
        buffer,
        projectId: "55555555-5555-4555-8555-555555555555",
        mutationIdentity: {
          documentId: "33333333-3333-4333-8333-333333333333",
          versionId: "44444444-4444-4444-8444-444444444444",
          taskWordArtifact: {
            taskId: "11111111-1111-4111-8111-111111111111",
            projectId: "22222222-2222-4222-8222-222222222222",
            deliverableKey: "opinion-draft",
          },
        },
      }),
    /outside its fixed Matter/,
  );
});
