#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "darwin") process.exit(0);

const desktopDir = path.resolve(__dirname, "..");
const source = path.join(desktopDir, "native", "aletheia-ocr.swift");
const outputDir = path.join(desktopDir, ".runtime", "native");
const output = path.join(outputDir, "aletheia-ocr");
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
execFileSync(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-O",
    "-framework",
    "Vision",
    "-framework",
    "PDFKit",
    "-framework",
    "AppKit",
    source,
    "-o",
    output,
  ],
  { stdio: "inherit" },
);
fs.chmodSync(output, 0o755);
process.stdout.write(`Prepared native OCR helper: ${output}\n`);
