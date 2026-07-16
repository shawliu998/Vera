import {
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

export type FrontendBuildCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

function check(
  name: string,
  ok: boolean,
  detail: string,
): FrontendBuildCheck {
  return { name, ok, detail };
}

function isDirectory(targetPath: string) {
  return statSync(targetPath, { throwIfNoEntry: false })?.isDirectory() === true;
}

function isNonEmptyFile(targetPath: string) {
  const stats = statSync(targetPath, { throwIfNoEntry: false });
  return stats?.isFile() === true && stats.size > 0;
}

function directoryContainsRegularFile(root: string) {
  if (!isDirectory(root)) return false;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isFile() && lstatSync(candidate).size > 0) return true;
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return false;
}

function readBuildId(targetPath: string) {
  if (!isNonEmptyFile(targetPath)) return null;
  const buildId = readFileSync(targetPath, "utf8").trim();
  return /^[A-Za-z0-9_-]{1,256}$/.test(buildId) ? buildId : null;
}

type RequiredServerFiles = {
  config?: { distDir?: unknown; output?: unknown };
  files?: unknown;
};

function readRequiredServerFiles(targetPath: string) {
  if (!isNonEmptyFile(targetPath)) return null;
  try {
    return JSON.parse(readFileSync(targetPath, "utf8")) as RequiredServerFiles;
  } catch {
    return null;
  }
}

function newestInputMtime(frontendDir: string) {
  const pending = [
    path.join(frontendDir, "src"),
    path.join(frontendDir, "public"),
    path.join(frontendDir, "next.config.ts"),
    path.join(frontendDir, "package.json"),
    path.join(frontendDir, "package-lock.json"),
    path.join(frontendDir, "postcss.config.mjs"),
    path.join(frontendDir, "tsconfig.json"),
  ];
  let newest = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (!stats || stats.isSymbolicLink()) continue;
    if (stats.isFile()) {
      newest = Math.max(newest, stats.mtimeMs);
      continue;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
    }
  }
  return newest;
}

/**
 * Validate the exact traced Next.js runtime consumed by the desktop package.
 * Directory existence alone is intentionally insufficient: an empty or stale
 * `.next` fixture is not a production build and must fail strict packaging.
 */
export function verifyFrontendProductionBuild(options: {
  frontendDir: string;
  buildDirName?: string;
}): FrontendBuildCheck[] {
  const buildDirName = options.buildDirName?.trim() || ".next-build";
  if (
    path.isAbsolute(buildDirName) ||
    buildDirName === "." ||
    buildDirName === ".." ||
    buildDirName.split(/[\\/]/).includes("..")
  ) {
    return [
      check(
        "frontend production build directory",
        false,
        `NEXT_DIST_DIR must stay inside the frontend directory: ${buildDirName}`,
      ),
    ];
  }

  const buildDir = path.join(options.frontendDir, buildDirName);
  const standaloneDir = path.join(buildDir, "standalone");
  const standaloneBuildDir = path.join(standaloneDir, buildDirName);
  const buildIdPath = path.join(buildDir, "BUILD_ID");
  const standaloneBuildIdPath = path.join(standaloneBuildDir, "BUILD_ID");
  const requiredServerFilesPath = path.join(
    buildDir,
    "required-server-files.json",
  );
  const standaloneRequiredServerFilesPath = path.join(
    standaloneBuildDir,
    "required-server-files.json",
  );
  const buildId = readBuildId(buildIdPath);
  const standaloneBuildId = readBuildId(standaloneBuildIdPath);
  const requiredServerFiles = readRequiredServerFiles(requiredServerFilesPath);
  const standaloneRequiredServerFiles = readRequiredServerFiles(
    standaloneRequiredServerFilesPath,
  );
  const newestInput = newestInputMtime(options.frontendDir);
  const buildIdStats = statSync(buildIdPath, { throwIfNoEntry: false });
  const requiredFiles = requiredServerFiles?.files;

  return [
    check(
      "frontend production build directory",
      isDirectory(buildDir),
      `Next production distDir: ${buildDir}`,
    ),
    check(
      "frontend production build id",
      buildId !== null,
      `non-empty safe BUILD_ID: ${buildIdPath}`,
    ),
    check(
      "frontend traced standalone server",
      isNonEmptyFile(path.join(standaloneDir, "server.js")),
      `non-empty standalone server: ${path.join(standaloneDir, "server.js")}`,
    ),
    check(
      "frontend traced runtime build id",
      buildId !== null && standaloneBuildId === buildId,
      `standalone BUILD_ID must match production BUILD_ID: ${standaloneBuildIdPath}`,
    ),
    check(
      "frontend required server manifest",
      requiredServerFiles?.config?.output === "standalone" &&
        requiredServerFiles.config.distDir === buildDirName &&
        Array.isArray(requiredFiles) &&
        requiredFiles.length > 0 &&
        requiredFiles.every(
          (entry) => typeof entry === "string" && entry.length > 0,
        ),
      `parseable standalone required-server-files manifest: ${requiredServerFilesPath}`,
    ),
    check(
      "frontend traced required server manifest",
      standaloneRequiredServerFiles?.config?.output === "standalone" &&
        standaloneRequiredServerFiles.config.distDir === buildDirName,
      `traced required-server-files manifest: ${standaloneRequiredServerFilesPath}`,
    ),
    check(
      "frontend application routes",
      isNonEmptyFile(
        path.join(
          standaloneBuildDir,
          "server",
          "app-paths-manifest.json",
        ),
      ),
      "traced runtime contains the App Router manifest",
    ),
    check(
      "frontend production dependencies",
      isNonEmptyFile(
        path.join(standaloneDir, "node_modules", "next", "package.json"),
      ),
      "traced runtime contains the Next.js production package",
    ),
    check(
      "frontend static assets",
      directoryContainsRegularFile(path.join(buildDir, "static")),
      `production static tree contains files: ${path.join(buildDir, "static")}`,
    ),
    check(
      "frontend build freshness",
      newestInput > 0 &&
        buildIdStats?.isFile() === true &&
        buildIdStats.mtimeMs >= newestInput,
      "BUILD_ID must not predate frontend source or production configuration inputs",
    ),
  ];
}
