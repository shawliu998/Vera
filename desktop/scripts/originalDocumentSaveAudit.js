"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_ORIGINAL_BYTES,
  safeOriginalFilename,
  validateOriginalDocumentBytes,
  writeOwnerOnlyFileAtomically,
} = require("../originalDocumentSave");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vera-original-save-")));
try {
  const pdf = Buffer.from("%PDF-1.7\nlocal evidence\n%%EOF\n");
  const hash = crypto.createHash("sha256").update(pdf).digest("hex");
  assert.deepEqual(
    validateOriginalDocumentBytes({
      bytes: pdf,
      mimeType: "application/pdf",
      expectedSha256: hash,
      contentLength: pdf.length,
    }),
    { sha256: hash, bytes: pdf.length },
  );
  assert.equal(safeOriginalFilename("../证据:一.PDF", "application/pdf"), "..-证据-一.PDF");
  assert.equal(safeOriginalFilename("notes.exe", "text/plain"), "notes.txt");
  assert.throws(
    () => validateOriginalDocumentBytes({ bytes: pdf, mimeType: "application/pdf", expectedSha256: "0".repeat(64), contentLength: pdf.length }),
    /hash does not match/,
  );
  assert.throws(
    () => validateOriginalDocumentBytes({ bytes: Buffer.from("not-pdf"), mimeType: "application/pdf", expectedSha256: crypto.createHash("sha256").update("not-pdf").digest("hex"), contentLength: 7 }),
    /valid PDF/,
  );
  assert.throws(
    () => validateOriginalDocumentBytes({ bytes: Buffer.from("x"), mimeType: "application/octet-stream", expectedSha256: "0".repeat(64), contentLength: 1 }),
    /unsupported/,
  );
  assert.equal(MAX_ORIGINAL_BYTES, 100 * 1024 * 1024);

  const destination = path.join(root, "evidence.pdf");
  writeOwnerOnlyFileAtomically(destination, pdf);
  assert.deepEqual(fs.readFileSync(destination), pdf);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  const symlinkParent = path.join(root, "linked");
  fs.symlinkSync(root, symlinkParent);
  assert.throws(
    () => writeOwnerOnlyFileAtomically(path.join(symlinkParent, "bad.pdf"), pdf),
    /regular directory/,
  );

  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.match(main, /saveOriginalMatterDocument/);
  assert.match(main, /X-Aletheia-Content-SHA256/i);
  assert.match(preload, /saveOriginalMatterDocument/);
  assert(packageJson.build.files.includes("originalDocumentSave.js"));

  console.log(JSON.stringify({
    ok: true,
    suite: "vera-original-document-save-v1",
    checks: [
      "MIME allowlist and container signatures",
      "exact backend SHA-256 and length binding",
      "safe extension-preserving filenames",
      "owner-only atomic persistence",
      "symlink destination rejection",
      "trusted IPC and package contracts",
    ],
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
