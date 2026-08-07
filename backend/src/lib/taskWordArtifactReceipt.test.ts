import assert from "node:assert/strict";
import test from "node:test";

import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

import {
  advanceTaskWordArtifactReceipt,
  bindTaskWordArtifactReceipt,
  readTaskWordArtifactReceipt,
  TASK_WORD_ARTIFACT_PROPERTY_PREFIX,
  TaskWordArtifactReceiptError,
  type TaskWordArtifactReceiptV1,
} from "./taskWordArtifactReceipt";

const receipt: TaskWordArtifactReceiptV1 = {
  schemaVersion: 1,
  kind: "agent-task-word-artifact-v1",
  taskId: "a0d75d08-c1a0-4a3f-afb3-4c16d5141615",
  projectId: "0ebafd84-1f05-4a5a-b90c-fe992434e6ee",
  deliverableKey: "claim-comparison-memo",
  documentId: "0ff133ee-4208-80f8-fdf9-3bf5a94331da",
  versionId: "8d3f5df3-c172-f4c6-6857-ad1847aa57e0",
};

async function docx(input?: {
  custom?: string;
  contentTypes?: string;
  rootRelationships?: string;
}) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    input?.contentTypes ??
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>`,
  );
  if (input?.custom) zip.file("docProps/custom.xml", input.custom);
  if (input?.rootRelationships) {
    zip.file("_rels/.rels", input.rootRelationships);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

async function customPropertyMap(buffer: Buffer) {
  const archive = await JSZip.loadAsync(buffer);
  const custom = await archive.file("docProps/custom.xml")?.async("string");
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
  }).parse(custom ?? "") as Record<string, unknown>;
  const rows =
    parsed.Properties && typeof parsed.Properties === "object"
      ? (parsed.Properties as Record<string, unknown>).property
      : [];
  return Object.fromEntries(
    (Array.isArray(rows) ? rows : [rows]).flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const property = row as Record<string, unknown>;
      return typeof property["@_name"] === "string" &&
        typeof property["vt:lpwstr"] === "string"
        ? [[property["@_name"], property["vt:lpwstr"]]]
        : [];
    }),
  ) as Record<string, string>;
}

test("binds a portable Task receipt and preserves unrelated custom properties", async () => {
  const output = await bindTaskWordArtifactReceipt(
    await docx({
      custom: `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="7" name="ExistingProperty"><vt:lpwstr>keep</vt:lpwstr></property></Properties>`,
      rootRelationships: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="urn:keep" Target="keep.xml"/></Relationships>`,
    }),
    receipt,
  );
  assert.deepEqual(await readTaskWordArtifactReceipt(output), receipt);
  assert.equal((await customPropertyMap(output)).ExistingProperty, "keep");
  const archive = await JSZip.loadAsync(output);
  assert.match(
    (await archive.file("[Content_Types].xml")?.async("string")) ?? "",
    /PartName="\/docProps\/custom\.xml"/,
  );
  assert.match(
    (await archive.file("_rels/.rels")?.async("string")) ?? "",
    /Target="docProps\/custom\.xml"/,
  );
});

test("accepts an empty self-closing custom-properties package", async () => {
  const output = await bindTaskWordArtifactReceipt(
    await docx({
      custom: `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>`,
    }),
    receipt,
  );
  assert.deepEqual(await readTaskWordArtifactReceipt(output), receipt);
});

test("advances only the exact predecessor Version and keeps other properties", async () => {
  const bound = await bindTaskWordArtifactReceipt(
    await docx({
      custom: `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="7" name="ExistingProperty"><vt:lpwstr>keep</vt:lpwstr></property></Properties>`,
    }),
    receipt,
  );
  const successor = {
    ...receipt,
    versionId: "99999999-9999-4999-8999-999999999999",
  };
  const advanced = await advanceTaskWordArtifactReceipt(bound, {
    predecessor: receipt,
    successor,
  });
  assert.deepEqual(await readTaskWordArtifactReceipt(advanced), successor);
  assert.equal((await customPropertyMap(advanced)).ExistingProperty, "keep");
  await assert.rejects(
    advanceTaskWordArtifactReceipt(bound, {
      predecessor: { ...receipt, versionId: "wrong-version" },
      successor,
    }),
    /predecessor receipt does not match/,
  );
  await assert.rejects(
    advanceTaskWordArtifactReceipt(bound, {
      predecessor: receipt,
      successor: { ...successor, deliverableKey: "other-output" },
    }),
    /successor identity is invalid/,
  );
});

test("raw and canonical UUID spellings are equivalent but arbitrary ids are not", async () => {
  const bound = await bindTaskWordArtifactReceipt(await docx(), receipt);
  const rawPredecessor = {
    ...receipt,
    taskId: receipt.taskId.replaceAll("-", ""),
    projectId: receipt.projectId.replaceAll("-", ""),
    documentId: receipt.documentId.replaceAll("-", ""),
    versionId: receipt.versionId.replaceAll("-", ""),
  };
  const successor = {
    ...rawPredecessor,
    versionId: "99999999999949998999999999999999",
  };
  assert.deepEqual(
    await readTaskWordArtifactReceipt(
      await advanceTaskWordArtifactReceipt(bound, {
        predecessor: rawPredecessor,
        successor,
      }),
    ),
    successor,
  );
  await assert.rejects(
    bindTaskWordArtifactReceipt(bound, { ...receipt, taskId: "other-task" }),
    /conflicting Task Word artifact receipt/,
  );
});

test("fails closed for invalid DOCX and malformed or conflicting OOXML", async () => {
  await assert.rejects(
    bindTaskWordArtifactReceipt(Buffer.from("not a docx"), receipt),
    TaskWordArtifactReceiptError,
  );
  await assert.rejects(
    bindTaskWordArtifactReceipt(
      await docx({ contentTypes: "<Types>" }),
      receipt,
    ),
    /content types XML is malformed/,
  );
  await assert.rejects(
    bindTaskWordArtifactReceipt(
      await docx({
        custom: `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${TASK_WORD_ARTIFACT_PROPERTY_PREFIX}Count"><vt:lpwstr>2</vt:lpwstr></property></Properties>`,
      }),
      receipt,
    ),
    /custom properties are malformed/,
  );
});
