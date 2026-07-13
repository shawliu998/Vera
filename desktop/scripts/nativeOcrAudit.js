#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  if (process.platform !== "darwin")
    throw new Error("This audit requires macOS.");
  const desktopDir = path.resolve(__dirname, "..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aletheia-ocr-audit-"));
  const binary = path.join(desktopDir, ".runtime", "native", "aletheia-ocr");
  const fixture = path.join(root, "scanned.pdf");
  try {
    execFileSync(
      "/usr/bin/xcrun",
      [
        "swift",
        path.join(desktopDir, "native", "ocr-audit-fixture.swift"),
        fixture,
      ],
      { stdio: "inherit" },
    );
    const pdf = fs.readFileSync(fixture);
    const direct = spawnSync(binary, [], {
      input: pdf,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(direct.status, 0, direct.stderr.toString("utf8"));
    const output = JSON.parse(direct.stdout.toString("utf8"));
    assert.equal(output.schemaVersion, "aletheia-native-ocr-v1");
    assert.equal(output.engine, "apple-vision");
    assert.equal(output.pages.length, 1);
    assert.match(output.pages[0].text, /PAYMENT DUE/i);
    assert.match(output.pages[0].text, /2026-09-01/);
    assert.ok(output.pages[0].confidence >= 0.5);

    process.env.ALETHEIA_OCR_ENABLED = "true";
    process.env.ALETHEIA_OCR_BINARY = binary;
    const parser = require("../../backend/dist/lib/aletheia/documentParser.js");
    const extracted = await parser.extractMatterDocument({
      filename: "scanned-contract.pdf",
      buffer: pdf,
    });
    assert.equal(extracted.metadata.parser, "pdf+apple-vision");
    assert.equal(extracted.metadata.pageCount, 1);
    assert.equal(extracted.metadata.textLayerPageCount, 0);
    assert.equal(extracted.metadata.ocrPageCount, 1);
    assert.equal(extracted.metadata.ocrEngine, "apple-vision");
    assert.match(extracted.text, /\[Page 1\]/);
    assert.match(extracted.text, /PAYMENT DUE/i);
    const chunks = parser.chunkMatterDocument(extracted.text);
    assert.ok(chunks.length > 0);
    assert.equal(chunks[0].page, 1);

    const invalidHelper = path.join(root, "invalid-helper");
    fs.writeFileSync(
      invalidHelper,
      '#!/bin/sh\nprintf \'{"schemaVersion":"wrong","pages":[]}\'\n',
      { mode: 0o700 },
    );
    process.env.ALETHEIA_OCR_BINARY = invalidHelper;
    await assert.rejects(
      () =>
        parser.extractMatterDocument({
          filename: "scanned-contract.pdf",
          buffer: pdf,
        }),
      /invalid schema/,
    );
    const symlinkHelper = path.join(root, "symlink-helper");
    fs.symlinkSync(binary, symlinkHelper);
    process.env.ALETHEIA_OCR_BINARY = symlinkHelper;
    const blocked = await parser.extractMatterDocument({
      filename: "scanned-contract.pdf",
      buffer: pdf,
    });
    assert.equal(blocked.text, "");
    assert.equal(blocked.metadata.ocrPageCount, 0);
    process.env.ALETHEIA_OCR_BINARY = binary;

    const invalid = spawnSync(binary, [], { input: Buffer.from("not a pdf") });
    assert.notEqual(invalid.status, 0);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-native-ocr-v1",
          checks: [
            "image-only PDF recognition through Apple Vision",
            "page text and confidence schema",
            "backend missing-text-layer integration",
            "searchable chunk production",
            "invalid helper output rejection",
            "symlink helper rejection",
            "invalid PDF fail-closed rejection",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
