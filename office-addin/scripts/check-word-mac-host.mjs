import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`Unknown argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${name}`);
    values.set(name, value);
    index += 1;
  }
  return values;
}

function xmlValue(xml, element) {
  return (
    xml
      .match(new RegExp(`<${element}[^>]*>([^<]+)</${element}>`))?.[1]
      ?.trim() ?? null
  );
}

async function listFiles(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }
  await visit(root);
  return files.sort();
}

function bufferContains(buffer, value) {
  return (
    buffer.includes(Buffer.from(value, "utf8")) ||
    buffer.includes(Buffer.from(value, "utf16le"))
  );
}

export async function inspectWordMacHost({
  manifestPath,
  wefDirectory,
  cacheDirectory,
}) {
  const manifestXml = await readFile(manifestPath, "utf8");
  const id = xmlValue(manifestXml, "Id");
  const version = xmlValue(manifestXml, "Version");
  const displayName =
    manifestXml.match(/<DisplayName[^>]*DefaultValue="([^"]+)"/)?.[1] ?? null;
  if (!id || !version || !displayName)
    throw new Error("Manifest must contain Id, Version, and DisplayName.");

  const wefFiles = await listFiles(wefDirectory);
  const strayFiles = wefFiles.filter((name) => !name.endsWith(".xml"));
  const registrations = [];
  for (const name of wefFiles.filter((candidate) =>
    candidate.endsWith(".xml"),
  )) {
    const absolutePath = path.join(wefDirectory, name);
    const xml = await readFile(absolutePath, "utf8");
    registrations.push({
      name,
      id: xmlValue(xml, "Id"),
      version: xmlValue(xml, "Version"),
      bytes: (await stat(absolutePath)).size,
    });
  }

  const matchingRegistrations = registrations.filter(
    (registration) => registration.id === id,
  );
  const cachedFiles = await walkFiles(cacheDirectory);
  const cachedManifestFiles = cachedFiles.filter(
    (file) =>
      file.includes(`${path.sep}Manifests${path.sep}`) &&
      path.basename(file).startsWith(`${id}_`),
  );
  const appCommandFiles = cachedFiles.filter((file) =>
    file.includes(`${path.sep}AppCommands${path.sep}`),
  );
  let appCommandsContainManifest = false;
  for (const file of appCommandFiles) {
    const bytes = await readFile(file);
    if (bufferContains(bytes, id) || bufferContains(bytes, displayName)) {
      appCommandsContainManifest = true;
      break;
    }
  }

  const issues = [];
  if (strayFiles.length > 0)
    issues.push("wef_directory_contains_non_manifest_files");
  if (matchingRegistrations.length === 0)
    issues.push("manifest_not_registered");
  if (matchingRegistrations.length > 1)
    issues.push("duplicate_manifest_registration");
  if (
    matchingRegistrations.some(
      (registration) => registration.version !== version,
    )
  ) {
    issues.push("registered_manifest_version_mismatch");
  }
  if (cachedManifestFiles.length === 0)
    issues.push("manifest_not_parsed_into_wef_cache");
  if (cachedManifestFiles.length > 0 && !appCommandsContainManifest) {
    issues.push("manifest_parsed_but_not_in_appcommands_cache");
  }

  return {
    manifest: { id, version, displayName, path: manifestPath },
    registration: {
      directory: wefDirectory,
      files: wefFiles,
      matching: matchingRegistrations,
      strayFiles,
    },
    cache: {
      directory: cacheDirectory,
      cachedManifestFiles,
      appCommandFileCount: appCommandFiles.length,
      appCommandsContainManifest,
    },
    issues,
    ok: issues.length === 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const homeDirectory = os.homedir();
  const result = await inspectWordMacHost({
    manifestPath: path.resolve(
      args.get("--manifest") ??
        path.join(repositoryRoot, "office-addin/word-manifest.xml"),
    ),
    wefDirectory: path.resolve(
      args.get("--wef-dir") ??
        path.join(
          homeDirectory,
          "Library/Containers/com.microsoft.Word/Data/Documents/wef",
        ),
    ),
    cacheDirectory: path.resolve(
      args.get("--cache-dir") ??
        path.join(
          homeDirectory,
          "Library/Containers/com.microsoft.Word/Data/Library/Application Support/Microsoft/Office/16.0/Wef",
        ),
    ),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
