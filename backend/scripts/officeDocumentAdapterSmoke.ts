import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import {
  OFFICECLI_PINNED_VERSION,
  OfficeDocumentAdapter,
  OfficeDocumentAdapterError,
  configuredOfficeCliBinarySpec,
} from "../src/lib/officeDocumentAdapter";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type FakeMode = "success" | "command-failure" | "corrupt-output";

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createDocx(filePath: string) {
  const archive = new JSZip();
  archive.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  archive.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  archive.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Matter: {{matter}}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  );
  await writeFile(
    filePath,
    await archive.generateAsync({ type: "nodebuffer" }),
  );
}

async function xlsxBase64() {
  const archive = new JSZip();
  archive.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  archive.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  archive.file(
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  archive.file(
    "xl/worksheets/sheet1.xml",
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
  );
  return (await archive.generateAsync({ type: "nodebuffer" })).toString(
    "base64",
  );
}

async function createFakeBinary(root: string, mode: FakeMode) {
  const binaryPath = join(root, `fake-officecli-${mode}`);
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("${OFFICECLI_PINNED_VERSION}\\n");
  process.exit(0);
}
if (process.env.OFFICECLI_SKIP_UPDATE !== "1" ||
    process.env.OFFICECLI_NO_AUTO_INSTALL !== "1" ||
    process.env.OFFICECLI_NO_AUTO_RESIDENT !== "1") {
  process.stderr.write("isolation flags missing");
  process.exit(19);
}
const mode = ${JSON.stringify(mode)};
if (mode === "command-failure") {
  process.stderr.write("synthetic command failure");
  process.exit(7);
}
const ok = (data = {}) => process.stdout.write(JSON.stringify({ success: true, data }) + "\\n");
switch (args[0]) {
  case "merge":
    fs.copyFileSync(args[1], args[2]);
    ok({ output: args[2], replacedKeys: 1, unresolvedPlaceholders: [] });
    break;
  case "create":
    fs.writeFileSync(
      args[1],
      mode === "corrupt-output"
        ? Buffer.from("not an OOXML package")
        : Buffer.from(${JSON.stringify(await xlsxBase64())}, "base64"),
    );
    ok({ output: args[1] });
    break;
  case "validate":
    ok({ count: 0, errors: [] });
    break;
  case "view":
    if (args[2] === "text") {
      fs.appendFileSync(args[1], Buffer.from("synthetic readonly mutation"));
      ok({ elements: [{ type: "paragraph", text: "Synthetic Matter" }] });
    } else if (args[2] === "screenshot") {
      const outputIndex = args.indexOf("-o");
      fs.writeFileSync(args[outputIndex + 1], Buffer.from(${JSON.stringify(PNG_1X1_BASE64)}, "base64"));
      process.stdout.write(args[outputIndex + 1] + "\\n");
    } else {
      process.exit(8);
    }
    break;
  default:
    process.exit(9);
}
`;
  await writeFile(binaryPath, script, { mode: 0o700 });
  await chmod(binaryPath, 0o700);
  const bytes = await readFile(binaryPath);
  return { binaryPath, expectedSha256: sha256(bytes) };
}

async function expectAdapterError(
  operation: Promise<unknown>,
  expectedCode: OfficeDocumentAdapterError["code"],
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof OfficeDocumentAdapterError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

async function runOfficialBinaryIntegration(
  root: string,
  templatePath: string,
) {
  const binaryPath = process.env.OFFICECLI_INTEGRATION_BINARY;
  if (!binaryPath) return;

  const adapter = await OfficeDocumentAdapter.create({
    ...configuredOfficeCliBinarySpec(binaryPath),
    timeoutMs: 120_000,
  });
  const wordOutput = join(root, "official-generated.docx");
  const excelOutput = join(root, "official-generated.xlsx");
  const renderOutput = join(root, "official-render.png");

  await adapter.inspect(templatePath);
  assert.equal((await adapter.validate(templatePath)).valid, true);
  await adapter.createWordFromTemplate(templatePath, wordOutput, {
    matter: "Official OfficeCLI integration smoke",
  });
  assert.match(
    JSON.stringify((await adapter.inspect(wordOutput)).data),
    /Official OfficeCLI integration smoke/,
  );
  await adapter.createExcel(excelOutput);
  await adapter.render(wordOutput, renderOutput);

  assert.ok((await stat(wordOutput)).size > 0);
  assert.ok((await stat(excelOutput)).size > 0);
  assert.ok((await stat(renderOutput)).size > 0);
  process.stdout.write(
    `OfficeDocumentAdapter official OfficeCLI v${OFFICECLI_PINNED_VERSION} integration passed.\n`,
  );
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "vera-office-adapter-smoke-"));
  try {
    await expectAdapterError(
      OfficeDocumentAdapter.create({
        binaryPath: join(root, "missing-officecli"),
        expectedSha256: "0".repeat(64),
      }),
      "BINARY_UNAVAILABLE",
    );

    const failingBinary = await createFakeBinary(root, "command-failure");
    const failingAdapter = await OfficeDocumentAdapter.create(failingBinary);
    const failedOutput = join(root, "failed.xlsx");
    await expectAdapterError(
      failingAdapter.createExcel(failedOutput),
      "COMMAND_FAILED",
    );
    await assert.rejects(stat(failedOutput), { code: "ENOENT" });

    const corruptBinary = await createFakeBinary(root, "corrupt-output");
    const corruptAdapter = await OfficeDocumentAdapter.create(corruptBinary);
    const corruptOutput = join(root, "corrupt.xlsx");
    await expectAdapterError(
      corruptAdapter.createExcel(corruptOutput),
      "INVALID_OUTPUT",
    );
    await assert.rejects(stat(corruptOutput), { code: "ENOENT" });

    const successBinary = await createFakeBinary(root, "success");
    const adapter = await OfficeDocumentAdapter.create(successBinary);
    const templatePath = join(root, "template.docx");
    await createDocx(templatePath);
    const templateHash = sha256(await readFile(templatePath));

    const inspection = await adapter.inspect(templatePath);
    assert.equal(inspection.fileType, "docx");
    assert.equal(sha256(await readFile(templatePath)), templateHash);

    const validation = await adapter.validate(templatePath);
    assert.equal(validation.valid, true);
    assert.equal(validation.structuralChecks.length, 3);
    assert.equal(sha256(await readFile(templatePath)), templateHash);

    const wordOutput = join(root, "generated.docx");
    const word = await adapter.createWordFromTemplate(
      templatePath,
      wordOutput,
      {
        matter: "Synthetic Matter",
      },
    );
    assert.equal(word.fileType, "docx");
    assert.equal(word.source, "generated");
    assert.equal(word.generator.version, OFFICECLI_PINNED_VERSION);
    assert.equal(sha256(await readFile(templatePath)), templateHash);
    assert.deepEqual(
      adapter.toArtifactLink("doc-123", "Generated Word version"),
      {
        artifact_type: "document",
        artifact_id: "doc-123",
        purpose: "Generated Word version",
      },
    );

    const excelOutput = join(root, "generated.xlsx");
    const excel = await adapter.createExcel(excelOutput);
    assert.equal(excel.fileType, "xlsx");
    assert.ok(excel.sizeBytes > 0);

    const renderOutput = join(root, "render.png");
    const render = await adapter.render(wordOutput, renderOutput);
    assert.equal(render.contentType, "image/png");
    assert.ok(render.sizeBytes > 0);

    await expectAdapterError(
      adapter.createExcel(excelOutput),
      "INVALID_OUTPUT",
    );

    await runOfficialBinaryIntegration(root, templatePath);

    process.stdout.write(
      "OfficeDocumentAdapter smoke: binary absent, command failure, corrupt output, and isolated success paths passed.\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
