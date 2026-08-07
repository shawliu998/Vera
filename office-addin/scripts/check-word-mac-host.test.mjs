import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectWordMacHost } from "./check-word-mac-host.mjs";

const ID = "12345678-1234-1234-1234-123456789abc";
const VERSION = "1.2.3.4";
const DISPLAY_NAME = "Vera Host Test";
const XML = `<?xml version="1.0"?><OfficeApp><Id>${ID}</Id><Version>${VERSION}</Version><DisplayName DefaultValue="${DISPLAY_NAME}" /></OfficeApp>`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vera-word-host-check-"));
  const manifestPath = path.join(root, "manifest.xml");
  const wefDirectory = path.join(root, "wef");
  const cacheDirectory = path.join(root, "cache");
  await mkdir(wefDirectory);
  await mkdir(path.join(cacheDirectory, "Manifests"), { recursive: true });
  await mkdir(path.join(cacheDirectory, "AppCommands", "17.0"), {
    recursive: true,
  });
  await writeFile(manifestPath, XML);
  return { root, manifestPath, wefDirectory, cacheDirectory };
}

test("passes one matching registration with parsed manifest and ribbon command cache", async () => {
  const paths = await fixture();
  await writeFile(path.join(paths.wefDirectory, `${ID}.manifest.xml`), XML);
  await writeFile(
    path.join(paths.cacheDirectory, "Manifests", `${ID}_${VERSION}`),
    XML,
  );
  await writeFile(
    path.join(paths.cacheDirectory, "AppCommands", "17.0", "Word.RibbonCache"),
    ID,
  );

  const result = await inspectWordMacHost(paths);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test("distinguishes stray backups, duplicate registration, and parsed-but-not-activated cache", async () => {
  const paths = await fixture();
  await writeFile(path.join(paths.wefDirectory, "manifest.xml"), XML);
  await writeFile(path.join(paths.wefDirectory, `${ID}.manifest.xml`), XML);
  await writeFile(path.join(paths.wefDirectory, "manifest.xml.backup"), XML);
  await writeFile(
    path.join(paths.cacheDirectory, "Manifests", `${ID}_${VERSION}`),
    XML,
  );
  await writeFile(
    path.join(paths.cacheDirectory, "AppCommands", "17.0", "Word.RibbonCache"),
    "another add-in",
  );

  const result = await inspectWordMacHost(paths);
  assert.deepEqual(result.issues, [
    "wef_directory_contains_non_manifest_files",
    "duplicate_manifest_registration",
    "manifest_parsed_but_not_in_appcommands_cache",
  ]);
});
