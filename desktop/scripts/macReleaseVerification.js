#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MAIN_ENTITLEMENTS = Object.freeze(["com.apple.security.cs.allow-jit"]);
const INHERITED_ENTITLEMENTS = Object.freeze([
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
]);
const ENTITLEMENT_ALLOWLISTS_BY_CODE_TYPE = Object.freeze({
  "main-application": MAIN_ENTITLEMENTS,
  "nested-application": INHERITED_ENTITLEMENTS,
  framework: INHERITED_ENTITLEMENTS,
  "xpc-service": INHERITED_ENTITLEMENTS,
  "app-extension": INHERITED_ENTITLEMENTS,
  "code-bundle": INHERITED_ENTITLEMENTS,
  "nested-mach-o": INHERITED_ENTITLEMENTS,
});
const MAX_RELEASE_ZIP_ENTRIES = 50_000;
const MAX_RELEASE_ZIP_SYMLINKS = 2_048;
const MAX_ZIP_LISTING_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_SYMLINK_TARGET_BYTES = 64 * 1024;

function isMacAppOutputDirectory(name) {
  return name === "mac" || /^mac-(?:arm64|x64|universal)$/.test(name);
}
const FORBIDDEN_ENTITLEMENT_PREFIXES = [
  "com.apple.security.get-task-allow",
  "com.apple.security.app-sandbox",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.automation.apple-events",
  "com.apple.security.network.",
  "com.apple.security.files.",
  "com.apple.security.temporary-exception.",
  "com.apple.security.device.",
  "com.apple.security.personal-information.",
];

function fail(message) {
  throw new Error(message);
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function run(command, args, options, dependencies) {
  return (dependencies.run || defaultRun)(command, args, options || {});
}

function checked(command, args, label, options = {}, dependencies = {}) {
  const result = run(command, args, options, dependencies);
  if (result.error || result.status !== 0) {
    fail(`${label} failed.`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function readPlist(plistPath, dependencies = {}) {
  if (dependencies.readPlist) return dependencies.readPlist(plistPath);
  const output = checked(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", plistPath],
    `plist inspection for ${path.basename(plistPath)}`,
    {},
    dependencies,
  );
  try {
    return JSON.parse(output);
  } catch {
    fail(
      `plist inspection for ${path.basename(plistPath)} returned invalid JSON.`,
    );
  }
}

function signatureDetails(targetPath, dependencies = {}) {
  const result = run(
    "/usr/bin/codesign",
    ["-dvvv", "--entitlements", ":-", targetPath],
    {},
    dependencies,
  );
  if (result.error || result.status !== 0) {
    return {
      state: "unsigned",
      authority: null,
      teamId: null,
      hardenedRuntime: false,
      entitlementKeys: [],
    };
  }
  const details = `${result.stdout || ""}${result.stderr || ""}`;
  const authorities = [...details.matchAll(/^Authority=(.+)$/gm)].map((match) =>
    match[1].trim(),
  );
  const authority =
    authorities.find((value) =>
      value.startsWith("Developer ID Application:"),
    ) ||
    authorities[0] ||
    null;
  const teamId = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null;
  const adHoc =
    /^Signature=adhoc$/m.test(details) ||
    /flags=.*\badhoc\b/i.test(details) ||
    authorities.some((value) => /adhoc|ad-hoc/i.test(value));
  const entitlementKeys = [...details.matchAll(/<key>([^<]+)<\/key>/g)].map(
    (match) => match[1],
  );
  return {
    state:
      !adHoc && authority?.startsWith("Developer ID Application:")
        ? "developer-id"
        : "ad-hoc",
    authority,
    teamId,
    hardenedRuntime: /flags=.*\bruntime\b/i.test(details),
    entitlementKeys: [...new Set(entitlementKeys)].sort(),
  };
}

function isMachO(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const header = Buffer.allocUnsafe(4);
    if (fs.readSync(descriptor, header, 0, 4, 0) !== 4) return false;
    const magic = header.toString("hex");
    return new Set([
      "feedface",
      "feedfacf",
      "cefaedfe",
      "cffaedfe",
      "cafebabe",
      "cafebabf",
      "bebafeca",
      "bfbafeca",
    ]).has(magic);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function pathDepth(candidate) {
  return candidate.split(path.sep).length;
}

function nestedCodeVerificationOrder(appPath) {
  const absoluteApp = path.resolve(appPath);
  const candidates = new Map();
  const codeBundleExtensions = new Set([
    ".app",
    ".framework",
    ".xpc",
    ".appex",
    ".bundle",
  ]);

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (codeBundleExtensions.has(path.extname(entry.name))) {
          candidates.set(candidate, "bundle");
        }
        visit(candidate);
      } else if (entry.isFile() && isMachO(candidate)) {
        candidates.set(candidate, "mach-o");
      }
    }
  }

  visit(absoluteApp);
  candidates.delete(absoluteApp);
  return [...candidates.entries()]
    .map(([targetPath, kind]) => ({ path: targetPath, kind }))
    .sort((left, right) => {
      const depth = pathDepth(right.path) - pathDepth(left.path);
      if (depth !== 0) return depth;
      if (left.kind !== right.kind) return left.kind === "mach-o" ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
}

function nestedCodeEntitlementType(candidate) {
  if (candidate.kind === "mach-o") return "nested-mach-o";
  if (candidate.kind !== "bundle") {
    fail("Nested code has an unsupported entitlement policy type.");
  }
  const typeByExtension = {
    ".app": "nested-application",
    ".framework": "framework",
    ".xpc": "xpc-service",
    ".appex": "app-extension",
    ".bundle": "code-bundle",
  };
  const codeType = typeByExtension[path.extname(candidate.path)];
  if (!codeType) fail("Nested bundle has no reviewed entitlement policy.");
  return codeType;
}

function forbiddenEntitlements(keys) {
  return keys.filter((key) =>
    FORBIDDEN_ENTITLEMENT_PREFIXES.some(
      (prefix) => key === prefix || key.startsWith(prefix),
    ),
  );
}

function assertDeveloperIdSignature(
  targetPath,
  expectedTeam,
  options = {},
  dependencies = {},
) {
  checked(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=2", targetPath],
    `strict code-signature verification for ${path.basename(targetPath)}`,
    {},
    dependencies,
  );
  const details = signatureDetails(targetPath, dependencies);
  if (details.state !== "developer-id") {
    fail(
      `${path.basename(targetPath)} is not signed with Developer ID Application.`,
    );
  }
  if (!/^[A-Z0-9]{10}$/.test(details.teamId || "")) {
    fail(
      `${path.basename(targetPath)} has no valid Developer ID team identifier.`,
    );
  }
  if (expectedTeam && details.teamId !== expectedTeam) {
    fail(
      `${path.basename(targetPath)} does not match the expected release team.`,
    );
  }
  if (
    options.expectedAuthority &&
    details.authority !== options.expectedAuthority
  ) {
    fail(
      `${path.basename(targetPath)} does not match the exact expected Developer ID Application authority.`,
    );
  }
  if (options.requireRuntime !== false && !details.hardenedRuntime) {
    fail(`${path.basename(targetPath)} is missing the hardened runtime flag.`);
  }
  const forbidden = forbiddenEntitlements(details.entitlementKeys);
  if (forbidden.length > 0) {
    fail(
      `${path.basename(targetPath)} contains forbidden release entitlements.`,
    );
  }
  return details;
}

function assertExpectedEntitlements(details, expectedKeys, label) {
  const actual = new Set(details.entitlementKeys);
  for (const key of expectedKeys) {
    if (!actual.has(key)) fail(`${label} is missing a required entitlement.`);
  }
  const unexpected = details.entitlementKeys.filter(
    (key) => !expectedKeys.includes(key),
  );
  if (unexpected.length > 0)
    fail(`${label} contains an unexpected entitlement.`);
}

function assertEntitlementsForCodeType(details, codeType, label) {
  const allowlist = ENTITLEMENT_ALLOWLISTS_BY_CODE_TYPE[codeType];
  if (!allowlist) fail(`${label} has no reviewed entitlement allowlist.`);
  assertExpectedEntitlements(details, allowlist, label);
}

function validateBundleMetadata(appPath, expected, dependencies = {}) {
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  if (!fs.statSync(infoPath).isFile())
    fail("Application Info.plist is missing.");
  const info = readPlist(infoPath, dependencies);
  if (info.CFBundleIdentifier !== expected.bundleId) {
    fail(
      "Application bundle identifier does not match the release configuration.",
    );
  }
  if (info.CFBundleShortVersionString !== expected.version) {
    fail("Application short version does not match the release configuration.");
  }
  if (String(info.CFBundleVersion) !== String(expected.version)) {
    fail("Application build version does not match the release configuration.");
  }
  if (
    info.CFBundleDisplayName !== "Vera" ||
    info.CFBundleExecutable !== "Vera"
  ) {
    fail("Application bundle name or executable is not Vera.");
  }
  return info;
}

function verifySignedApp(appPath, options, dependencies = {}) {
  const absoluteApp = path.resolve(appPath);
  if (!fs.statSync(absoluteApp).isDirectory()) fail("Vera.app was not found.");
  validateBundleMetadata(absoluteApp, options, dependencies);
  const order = nestedCodeVerificationOrder(absoluteApp);
  // The locked Electron Builder MacTargetHelper signs the top-level app with
  // entitlements.mac.plist and every other discovered code target with
  // entitlements.mac.inherit.plist. Vera configures no LoginItems exception.
  for (const candidate of order) {
    const details = assertDeveloperIdSignature(
      candidate.path,
      options.expectedTeam,
      {
        requireRuntime: true,
        expectedAuthority: options.expectedAuthority,
      },
      dependencies,
    );
    const codeType = nestedCodeEntitlementType(candidate);
    assertEntitlementsForCodeType(
      details,
      codeType,
      `${codeType} ${path.basename(candidate.path)}`,
    );
  }
  const appDetails = assertDeveloperIdSignature(
    absoluteApp,
    options.expectedTeam,
    {
      requireRuntime: true,
      expectedAuthority: options.expectedAuthority,
    },
    dependencies,
  );
  assertEntitlementsForCodeType(appDetails, "main-application", "Vera.app");
  checked(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", absoluteApp],
    "final deep code-signature verification",
    {},
    dependencies,
  );
  checked(
    "/usr/sbin/spctl",
    ["--assess", "--type", "execute", "--verbose=4", absoluteApp],
    "Gatekeeper application assessment",
    {},
    dependencies,
  );
  checked(
    "/usr/bin/xcrun",
    ["stapler", "validate", absoluteApp],
    "application notarization-ticket validation",
    {},
    dependencies,
  );
  return {
    path: absoluteApp,
    codesign: "verified",
    spctl: "accepted",
    stapler: "validated",
    nestedCodeOrder: order.map((item) => item.path),
    teamId: appDetails.teamId,
  };
}

function detachDmgMount(mountPoint, dependencies = {}, required = true) {
  const normal = run(
    "/usr/bin/hdiutil",
    ["detach", mountPoint],
    {},
    dependencies,
  );
  if (!normal.error && normal.status === 0) return true;
  const forced = run(
    "/usr/bin/hdiutil",
    ["detach", "-force", mountPoint],
    {},
    dependencies,
  );
  if (!forced.error && forced.status === 0) return true;
  if (required) fail("DMG detach failed after the force fallback.");
  return false;
}

function verifyMountedDmgApp(mountPoint, expected, dependencies = {}) {
  const apps = findApps(mountPoint);
  if (
    apps.length !== 1 ||
    path.basename(apps[0]) !== "Vera.app" ||
    path.dirname(apps[0]) !== mountPoint
  ) {
    fail("Release DMG must contain exactly one top-level Vera.app.");
  }
  return verifySignedApp(apps[0], expected, dependencies);
}

function verifyDmgContents(dmgPath, expected, dependencies = {}) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "vera-release-dmg-"),
  );
  const mountPoint = path.join(temporaryDirectory, "mount");
  fs.mkdirSync(mountPoint);
  let attached = false;
  let detached = false;
  let verificationError = null;
  let detachError = null;
  let app = null;
  try {
    checked(
      "/usr/bin/hdiutil",
      [
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
        mountPoint,
        dmgPath,
      ],
      "DMG read-only attach",
      {},
      dependencies,
    );
    attached = true;
    app = verifyMountedDmgApp(mountPoint, expected, dependencies);
  } catch (error) {
    verificationError = error;
  } finally {
    try {
      // Even a failed attach can leave a partially mounted image. Always make a
      // best-effort detach; once attach reported success, detach is a hard gate.
      detached = detachDmgMount(mountPoint, dependencies, attached);
    } catch (error) {
      detachError = error;
    }
    if (detached) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  if (detachError) throw detachError;
  if (verificationError) throw verificationError;
  if (!app) fail("Release DMG application verification did not complete.");
  return {
    codesign: app.codesign,
    spctl: app.spctl,
    stapler: app.stapler,
    teamId: app.teamId,
    nestedCodeCount: app.nestedCodeOrder.length,
  };
}

function verifySignedDmg(dmgPath, expected, dependencies = {}) {
  const absoluteDmg = path.resolve(dmgPath);
  if (
    !fs.statSync(absoluteDmg).isFile() ||
    path.extname(absoluteDmg) !== ".dmg"
  ) {
    fail("Release DMG was not found.");
  }
  checked(
    "/usr/bin/hdiutil",
    ["verify", absoluteDmg],
    "DMG structure verification",
    {},
    dependencies,
  );
  const details = assertDeveloperIdSignature(
    absoluteDmg,
    expected.expectedTeam,
    {
      requireRuntime: false,
      expectedAuthority: expected.expectedAuthority,
    },
    dependencies,
  );
  checked(
    "/usr/sbin/spctl",
    [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      absoluteDmg,
    ],
    "Gatekeeper DMG assessment",
    {},
    dependencies,
  );
  checked(
    "/usr/bin/xcrun",
    ["stapler", "validate", absoluteDmg],
    "DMG notarization-ticket validation",
    {},
    dependencies,
  );
  const app = verifyDmgContents(absoluteDmg, expected, dependencies);
  return {
    path: absoluteDmg,
    codesign: "verified",
    spctl: "accepted",
    stapler: "validated",
    teamId: details.teamId,
    app,
  };
}

function safeZipEntries(zipPath, dependencies = {}) {
  const listing = checked(
    "/usr/bin/zipinfo",
    ["-1", zipPath],
    "ZIP directory inspection",
    { maxBuffer: MAX_ZIP_LISTING_BYTES },
    dependencies,
  );
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) fail("Release ZIP is empty.");
  if (entries.length > MAX_RELEASE_ZIP_ENTRIES) {
    fail("Release ZIP contains too many entries.");
  }
  if (new Set(entries).size !== entries.length) {
    fail("Release ZIP contains a duplicate path.");
  }
  for (const entry of entries) {
    const segments = entry.split("/");
    if (
      entry.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(entry) ||
      entry.startsWith("/") ||
      /^[A-Za-z]:/.test(entry) ||
      segments.includes("..")
    ) {
      fail("Release ZIP contains an unsafe path.");
    }
  }
  verifyZipEntryTypesAndSymlinks(zipPath, entries, dependencies);
  return entries;
}

function verifyZipEntryTypesAndSymlinks(
  zipPath,
  expectedEntries,
  dependencies = {},
) {
  const listing = checked(
    "/usr/bin/zipinfo",
    ["-s", zipPath],
    "ZIP entry-type inspection",
    { maxBuffer: MAX_ZIP_LISTING_BYTES },
    dependencies,
  );
  const records = [];
  for (const line of listing.split(/\r?\n/)) {
    const match = line.match(
      /^([bcdlps-][rwxStTs-]{9})\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+\S+\s(.+)$/,
    );
    if (match) {
      records.push({ type: match[1][0], path: match[2] });
    }
  }
  if (
    records.length !== expectedEntries.length ||
    records.some((record, index) => record.path !== expectedEntries[index])
  ) {
    fail("Release ZIP entry metadata does not match its directory listing.");
  }

  const supportedTypes = new Set(["-", "d", "l"]);
  const symlinks = records.filter((record) => record.type === "l");
  if (symlinks.length > MAX_RELEASE_ZIP_SYMLINKS) {
    fail("Release ZIP contains too many symbolic links.");
  }
  for (const record of records) {
    if (!supportedTypes.has(record.type)) {
      fail("Release ZIP contains an unsupported entry type.");
    }
    if (record.type === "l") {
      verifyZipSymlinkTarget(zipPath, record.path, dependencies);
    }
  }
}

function verifyZipSymlinkTarget(zipPath, entryPath, dependencies = {}) {
  // Info-ZIP treats these characters as member-name patterns. Vera's generated
  // framework and node_modules symlinks do not require them, so fail closed
  // instead of risking a target read from a different archive member.
  if (/[*?\[\]]/.test(entryPath)) {
    fail("Release ZIP contains an unsupported symlink path.");
  }
  const result = run(
    "/usr/bin/unzip",
    ["-p", zipPath, entryPath],
    { maxBuffer: MAX_ZIP_SYMLINK_TARGET_BYTES },
    dependencies,
  );
  if (
    result.error ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    (result.stderr && String(result.stderr).length > 0)
  ) {
    fail("ZIP symlink-target inspection failed.");
  }
  const target = result.stdout;
  if (
    target.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(target) ||
    target.includes("\ufffd") ||
    path.posix.isAbsolute(target) ||
    path.win32.isAbsolute(target)
  ) {
    fail("Release ZIP contains an unsafe symlink target.");
  }

  const archiveRoot = "/__vera_zip_archive_root__";
  const memberParent = path.posix.join(
    archiveRoot,
    path.posix.dirname(entryPath),
  );
  const resolvedTarget = path.posix.resolve(memberParent, target);
  if (
    resolvedTarget !== archiveRoot &&
    !resolvedTarget.startsWith(`${archiveRoot}/`)
  ) {
    fail("Release ZIP contains a symlink target outside the archive root.");
  }
}

function findApps(directory) {
  const apps = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".app")) {
        apps.push(candidate);
      } else {
        visit(candidate);
      }
    }
  }
  visit(directory);
  return apps;
}

function verifyReleaseZip(zipPath, options, dependencies = {}) {
  const absoluteZip = path.resolve(zipPath);
  if (
    !fs.statSync(absoluteZip).isFile() ||
    path.extname(absoluteZip) !== ".zip"
  ) {
    fail("Release ZIP was not found.");
  }
  safeZipEntries(absoluteZip, dependencies);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "vera-release-zip-"),
  );
  try {
    if (dependencies.extractZip) {
      dependencies.extractZip(absoluteZip, temporaryDirectory);
    } else {
      checked(
        "/usr/bin/ditto",
        ["-x", "-k", absoluteZip, temporaryDirectory],
        "ZIP extraction",
        {},
        dependencies,
      );
    }
    const apps = findApps(temporaryDirectory);
    if (apps.length !== 1 || path.basename(apps[0]) !== "Vera.app")
      fail("Release ZIP must contain exactly one Vera.app.");
    const app = verifySignedApp(apps[0], options, dependencies);
    return {
      path: absoluteZip,
      codesign: "not_applicable_archive_container",
      spctl: "verified_on_extracted_app",
      stapler: "verified_on_extracted_app",
      app,
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseChecksumManifest(manifestPath) {
  const contents = fs.readFileSync(manifestPath, "utf8").trim();
  if (!contents) fail("Checksum manifest is empty.");
  const entries = contents.split(/\r?\n/).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+\*?([^/\\]+)$/);
    if (!match) fail("Checksum manifest contains an invalid entry.");
    return { sha256: match[1], file: match[2] };
  });
  if (new Set(entries.map((entry) => entry.file)).size !== entries.length) {
    fail("Checksum manifest contains duplicate artifact names.");
  }
  return entries;
}

function verifyChecksumManifest(
  manifestPath,
  requiredArtifacts,
  dependencies = {},
) {
  const absoluteManifest = path.resolve(manifestPath);
  if (!fs.statSync(absoluteManifest).isFile()) {
    fail("Checksum manifest was not found.");
  }
  const entries = parseChecksumManifest(absoluteManifest);
  const names = new Set(entries.map((entry) => entry.file));
  for (const artifact of requiredArtifacts) {
    if (!names.has(path.basename(artifact))) {
      fail("Checksum manifest does not cover every release artifact.");
    }
  }
  checked(
    "/usr/bin/shasum",
    ["-a", "256", "-c", path.basename(absoluteManifest)],
    "release checksum verification",
    { cwd: path.dirname(absoluteManifest) },
    dependencies,
  );
  return entries;
}

module.exports = {
  ENTITLEMENT_ALLOWLISTS_BY_CODE_TYPE,
  FORBIDDEN_ENTITLEMENT_PREFIXES,
  INHERITED_ENTITLEMENTS,
  MAIN_ENTITLEMENTS,
  assertDeveloperIdSignature,
  detachDmgMount,
  forbiddenEntitlements,
  isMacAppOutputDirectory,
  nestedCodeEntitlementType,
  nestedCodeVerificationOrder,
  parseChecksumManifest,
  readPlist,
  safeZipEntries,
  signatureDetails,
  validateBundleMetadata,
  verifyChecksumManifest,
  verifyDmgContents,
  verifyReleaseZip,
  verifySignedApp,
  verifySignedDmg,
};
