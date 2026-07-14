import assert from "node:assert/strict";
import test from "node:test";

import { backendErrorMessageKey } from "../src/app/i18n/errors.ts";
import {
  DOCUMENT_UPLOAD_ERROR_CODES,
  isSupportedDocumentFile,
  MAX_DOCUMENT_FILENAME_LENGTH,
  SUPPORTED_DOCUMENT_ACCEPT,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from "../src/app/lib/documentUploadValidation.ts";

function namedFile(name: string): File {
  return { name } as File;
}

test("document upload validation matches the backend extension contract", () => {
  assert.equal(MAX_DOCUMENT_FILENAME_LENGTH, 240);
  assert.deepEqual(SUPPORTED_DOCUMENT_EXTENSIONS, [
    ".pdf",
    ".docx",
    ".xlsx",
    ".txt",
    ".md",
  ]);
  assert.equal(SUPPORTED_DOCUMENT_ACCEPT, ".pdf,.docx,.xlsx,.txt,.md");

  for (const name of [
    "filing.pdf",
    "contract.docx",
    "schedule.xlsx",
    "notes.txt",
    "README.md",
    "UPPER.PDF",
    " evidence.pdf ",
    "..pdf",
  ]) {
    assert.equal(isSupportedDocumentFile(namedFile(name)), true, name);
  }

  for (const name of [
    "legacy.doc",
    "legacy.xls",
    "macro.xlsm",
    "slides.ppt",
    "slides.pptx",
    "archive.zip",
    "no-extension",
    ".pdf",
    ".DOCX",
  ]) {
    assert.equal(isSupportedDocumentFile(namedFile(name)), false, name);
  }
});

test("document upload error codes resolve to centralized document copy", () => {
  assert.equal(
    backendErrorMessageKey(DOCUMENT_UPLOAD_ERROR_CODES.unsupportedType),
    "documents.errors.unsupported",
  );
  assert.equal(
    backendErrorMessageKey(DOCUMENT_UPLOAD_ERROR_CODES.invalidFile),
    "documents.errors.upload",
  );
});
