#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  NOTARY_API_KEY_KEYS,
  NOTARY_APPLE_ID_KEYS,
  SIGNING_KEY_KEYS,
  classifyReleaseSigning,
} = require("./releaseSigningPreflight");
const {
  INHERITED_ENTITLEMENTS,
  MAIN_ENTITLEMENTS,
  forbiddenEntitlements,
  isMacAppOutputDirectory,
  nestedCodeVerificationOrder,
  readPlist,
  safeZipEntries,
  signatureDetails,
  validateBundleMetadata,
  verifyChecksumManifest,
  verifyReleaseZip,
  verifySignedApp,
  verifySignedDmg,
} = require("./macReleaseVerification");

const DESKTOP_ROOT = path.resolve(__dirname, "..");
const ALL_SECRET_ENVIRONMENT_KEYS = [
  ...new Set([
    ...SIGNING_KEY_KEYS,
    ...NOTARY_APPLE_ID_KEYS,
    ...NOTARY_API_KEY_KEYS,
  ]),
].sort();

function isPresent(environment, key) {
  return (
    typeof environment[key] === "string" && environment[key].trim().length > 0
  );
}

function blocker(report, code, detail) {
  if (!report.blockers.some((item) => item.code === code)) {
    report.blockers.push({ code, detail });
  }
}

function warning(report, code, detail) {
  if (!report.warnings.some((item) => item.code === code)) {
    report.warnings.push({ code, detail });
  }
}

function toolAvailability(dependencies = {}) {
  const executable = (candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const xcrunTool = (name) => {
    const run = dependencies.run;
    if (!run) {
      const { spawnSync } = require("node:child_process");
      const result = spawnSync("/usr/bin/xcrun", ["--find", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return !result.error && result.status === 0;
    }
    const result = run("/usr/bin/xcrun", ["--find", name], {});
    return !result.error && result.status === 0;
  };
  return {
    codesign: executable("/usr/bin/codesign"),
    ditto: executable("/usr/bin/ditto"),
    hdiutil: executable("/usr/bin/hdiutil"),
    plutil: executable("/usr/bin/plutil"),
    security: executable("/usr/bin/security"),
    shasum: executable("/usr/bin/shasum"),
    spctl: executable("/usr/sbin/spctl"),
    xcrun: executable("/usr/bin/xcrun"),
    zipinfo: executable("/usr/bin/zipinfo"),
    notarytool: xcrunTool("notarytool"),
    stapler: xcrunTool("stapler"),
    unzip: executable("/usr/bin/unzip"),
  };
}

function validIdentityCount(dependencies = {}) {
  const runner = dependencies.run;
  let result;
  if (runner) {
    result = runner(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      {},
    );
  } else {
    const { spawnSync } = require("node:child_process");
    result = spawnSync(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }
  if (result.error || result.status !== 0) return null;
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const explicit = output.match(/(\d+) valid identities found/);
  if (explicit) return Number(explicit[1]);
  return output
    .split(/\r?\n/)
    .filter((line) => /^\s*\d+\)\s+[A-F0-9]{40}\s+"/.test(line)).length;
}

function exactBooleanEntitlementKeys(plist, label, expected, report) {
  if (!plist || typeof plist !== "object" || Array.isArray(plist)) {
    blocker(report, `${label}_invalid`, `${label} must be a plist dictionary.`);
    return;
  }
  const keys = Object.keys(plist).sort();
  const forbidden = forbiddenEntitlements(keys);
  if (forbidden.length > 0) {
    blocker(
      report,
      `${label}_forbidden`,
      `${label} contains a forbidden release entitlement.`,
    );
  }
  if (
    keys.length !== expected.length ||
    expected.some((key) => plist[key] !== true) ||
    keys.some((key) => !expected.includes(key))
  ) {
    blocker(
      report,
      `${label}_unexpected_structure`,
      `${label} does not match Vera's reviewed minimum entitlement set.`,
    );
  }
}

function inspectConfiguration(report, options, dependencies = {}) {
  const desktopRoot = options.desktopRoot || DESKTOP_ROOT;
  const packagePath = path.join(desktopRoot, "package.json");
  let packageDocument;
  try {
    packageDocument = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    blocker(
      report,
      "desktop_package_invalid",
      "desktop/package.json is missing or invalid.",
    );
    return null;
  }
  const build = packageDocument.build || {};
  const mac = build.mac || {};
  const targetNames = (Array.isArray(mac.target) ? mac.target : [mac.target])
    .map((target) =>
      typeof target === "string" ? target : target && target.target,
    )
    .filter(Boolean);
  if (build.productName !== "Vera") {
    blocker(
      report,
      "product_name_invalid",
      "Desktop productName must be Vera.",
    );
  }
  if (
    typeof build.appId !== "string" ||
    !/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+){2,}$/.test(build.appId)
  ) {
    blocker(
      report,
      "bundle_id_invalid",
      "Desktop appId must be a stable reverse-DNS bundle identifier.",
    );
  }
  if (options.expectedBundleId && build.appId !== options.expectedBundleId) {
    blocker(
      report,
      "bundle_id_mismatch",
      "Desktop appId does not match VERA_EXPECTED_BUNDLE_ID.",
    );
  }
  if (
    typeof packageDocument.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageDocument.version)
  ) {
    blocker(
      report,
      "version_invalid",
      "Desktop version must be a semantic release version.",
    );
  }
  if (mac.hardenedRuntime !== true) {
    blocker(
      report,
      "hardened_runtime_disabled",
      "Electron Builder hardenedRuntime must be true.",
    );
  }
  if (mac.notarize !== false) {
    blocker(
      report,
      "builder_notarization_not_disabled",
      "Electron Builder's implicit notarization must stay disabled so only Vera's reviewed hooks contact Apple.",
    );
  }
  if (!targetNames.includes("dmg") || !targetNames.includes("zip")) {
    blocker(
      report,
      "release_targets_incomplete",
      "macOS release targets must include both DMG and ZIP.",
    );
  }
  if (mac.identity === "-") {
    blocker(
      report,
      "adhoc_identity_configured",
      "The release configuration must not request ad-hoc signing.",
    );
  }
  const entitlementPaths = {
    main: mac.entitlements,
    inherit: mac.entitlementsInherit,
  };
  const expectedEntitlementPaths = {
    main: "build/entitlements.mac.plist",
    inherit: "build/entitlements.mac.inherit.plist",
  };
  for (const kind of ["main", "inherit"]) {
    if (entitlementPaths[kind] !== expectedEntitlementPaths[kind]) {
      blocker(
        report,
        `${kind}_entitlements_not_pinned`,
        `Electron Builder ${kind} entitlements must reference the reviewed Vera plist.`,
      );
      continue;
    }
    const absolutePath = path.join(desktopRoot, entitlementPaths[kind]);
    try {
      const plist = readPlist(absolutePath, dependencies);
      exactBooleanEntitlementKeys(
        plist,
        `${kind}_entitlements`,
        kind === "main" ? MAIN_ENTITLEMENTS : INHERITED_ENTITLEMENTS,
        report,
      );
    } catch {
      blocker(
        report,
        `${kind}_entitlements_invalid`,
        `The reviewed ${kind} entitlement plist is missing or invalid.`,
      );
    }
  }
  if (build.afterSign !== "scripts/afterSign.js") {
    blocker(
      report,
      "after_sign_hook_missing",
      "Electron Builder must retain the reviewed afterSign notarization hook.",
    );
  }
  if (build.afterAllArtifactBuild !== "scripts/afterAllArtifactBuild.js") {
    blocker(
      report,
      "after_all_artifact_hook_missing",
      "Electron Builder must retain the final DMG notarization hook.",
    );
  }
  if (build.dmg?.sign !== true) {
    blocker(
      report,
      "dmg_signing_disabled",
      "Electron Builder must sign the final DMG in credentialed release mode.",
    );
  }
  if (build.dmg?.writeUpdateInfo !== false) {
    blocker(
      report,
      "dmg_update_info_unsafe",
      "DMG blockmap generation must stay disabled because final ticket stapling changes DMG bytes.",
    );
  }
  report.configuration = {
    productName: build.productName || null,
    bundleId: build.appId || null,
    version: packageDocument.version || null,
    hardenedRuntime: mac.hardenedRuntime === true,
    builderNotarizationDisabled: mac.notarize === false,
    entitlements: entitlementPaths,
    targets: targetNames,
    dmgSigningRequired: build.dmg?.sign === true,
    dmgUpdateInfoDisabled: build.dmg?.writeUpdateInfo === false,
  };
  return packageDocument;
}

function discoverArtifacts(desktopRoot, version) {
  const dist = path.join(desktopRoot, "dist");
  const artifacts = { apps: [], dmgs: [], zips: [], checksumManifest: null };
  if (!fs.existsSync(dist)) return artifacts;
  for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    const candidate = path.join(dist, entry.name);
    if (entry.isDirectory() && isMacAppOutputDirectory(entry.name)) {
      const app = path.join(candidate, "Vera.app");
      if (fs.existsSync(app)) artifacts.apps.push(app);
    } else if (
      entry.isFile() &&
      entry.name === `Vera-${version}-SHA256SUMS.txt`
    ) {
      artifacts.checksumManifest = candidate;
    } else if (entry.isFile() && entry.name.startsWith(`Vera-${version}-`)) {
      if (entry.name.endsWith(".dmg")) artifacts.dmgs.push(candidate);
      if (entry.name.endsWith(".zip")) artifacts.zips.push(candidate);
    }
  }
  return artifacts;
}

function inspectArtifacts(report, artifacts, configuration, dependencies = {}) {
  const expected = {
    bundleId: configuration.bundleId,
    version: configuration.version,
    expectedTeam: report.signing.teamId,
    expectedAuthority: report.signing.expectedAuthority,
  };
  const results = { apps: [], dmgs: [], zips: [], checksums: "not_checked" };

  if (artifacts.apps.length === 0) {
    blocker(report, "app_not_built", "No packaged Vera.app was found.");
  }
  for (const appPath of artifacts.apps) {
    let metadataValid = false;
    try {
      validateBundleMetadata(appPath, expected, dependencies);
      metadataValid = true;
    } catch {
      blocker(
        report,
        "app_metadata_invalid",
        "Packaged Vera.app metadata does not match the release configuration.",
      );
    }
    const signature = signatureDetails(appPath, dependencies);
    if (signature.state !== "developer-id") {
      blocker(
        report,
        "app_unsigned",
        "Packaged Vera.app is unsigned or ad-hoc signed.",
      );
      results.apps.push({
        path: appPath,
        metadataValid,
        signature: signature.state,
        codesign: "not_verified",
        spctl: "not_accepted",
        stapler: "not_validated",
        nestedCodeCount: (() => {
          try {
            return nestedCodeVerificationOrder(appPath).length;
          } catch {
            return null;
          }
        })(),
      });
      continue;
    }
    try {
      results.apps.push({
        ...verifySignedApp(appPath, expected, dependencies),
        metadataValid,
        signature: "developer-id",
      });
    } catch {
      blocker(
        report,
        "app_release_verification_failed",
        "Developer ID app verification, Gatekeeper, or stapler validation failed.",
      );
    }
  }

  if (artifacts.dmgs.length === 0) {
    blocker(report, "dmg_not_built", "No release DMG was found.");
  }
  for (const dmgPath of artifacts.dmgs) {
    const signature = signatureDetails(dmgPath, dependencies);
    if (signature.state !== "developer-id") {
      blocker(
        report,
        "dmg_unsigned",
        "Release DMG is not Developer ID signed.",
      );
      results.dmgs.push({
        path: dmgPath,
        signature: signature.state,
        codesign: "not_verified",
        spctl: "not_accepted",
        stapler: "not_validated",
      });
      continue;
    }
    try {
      results.dmgs.push({
        ...verifySignedDmg(dmgPath, expected, dependencies),
        signature: "developer-id",
      });
    } catch {
      blocker(
        report,
        "dmg_release_verification_failed",
        "DMG signature, Gatekeeper, or stapler validation failed.",
      );
    }
  }

  if (artifacts.zips.length === 0) {
    blocker(report, "zip_not_built", "No release ZIP was found.");
  }
  for (const zipPath of artifacts.zips) {
    if (!appVerifiedForZip(results.apps)) {
      try {
        safeZipEntries(zipPath, dependencies);
      } catch {
        blocker(
          report,
          "zip_structure_invalid",
          "Release ZIP directory validation failed.",
        );
      }
      blocker(
        report,
        "zip_inner_app_unsigned",
        "ZIP container signing/stapling is not applicable and its contained app is unsigned.",
      );
      results.zips.push({
        path: zipPath,
        codesign: "not_applicable_archive_container",
        spctl: "not_verified_on_extracted_app",
        stapler: "not_verified_on_extracted_app",
      });
      continue;
    }
    try {
      results.zips.push(verifyReleaseZip(zipPath, expected, dependencies));
    } catch {
      blocker(
        report,
        "zip_inner_app_verification_failed",
        "ZIP extraction or contained Vera.app release verification failed.",
      );
      results.zips.push({
        path: zipPath,
        codesign: "not_applicable_archive_container",
        spctl: "not_verified_on_extracted_app",
        stapler: "not_verified_on_extracted_app",
      });
    }
  }

  const releaseFiles = [...artifacts.dmgs, ...artifacts.zips];
  if (!artifacts.checksumManifest) {
    blocker(
      report,
      "checksum_manifest_missing",
      "Release checksum manifest was not found.",
    );
  } else if (releaseFiles.length > 0) {
    try {
      verifyChecksumManifest(
        artifacts.checksumManifest,
        releaseFiles,
        dependencies,
      );
      results.checksums = "verified";
    } catch {
      blocker(
        report,
        "checksum_verification_failed",
        "Release checksum verification failed.",
      );
    }
  }
  report.artifacts = results;
}

function appVerifiedForZip(appResults) {
  return (
    appResults.length > 0 &&
    appResults.every(
      (item) =>
        item.signature === "developer-id" && item.codesign === "verified",
    )
  );
}

function buildReadiness(options = {}, dependencies = {}) {
  const environment = options.environment || process.env;
  const report = {
    schema: "vera-macos-release-readiness-v1",
    releaseReady: false,
    signed: "UNSIGNED",
    notarized: "NOT_NOTARIZED",
    blockers: [],
    warnings: [],
    credentials: Object.fromEntries(
      ALL_SECRET_ENVIRONMENT_KEYS.map((key) => [
        key,
        isPresent(environment, key) ? "present" : "missing",
      ]),
    ),
    tools: toolAvailability(dependencies),
    signing: {
      requested: environment.VERA_RELEASE_SIGNING === "true",
      configurationValid: false,
      teamId: null,
      expectedAuthority: null,
      validIdentityCount: null,
    },
    configuration: null,
    artifacts: null,
  };

  const packageDocument = inspectConfiguration(
    report,
    {
      desktopRoot: options.desktopRoot || DESKTOP_ROOT,
      expectedBundleId:
        options.expectedBundleId || environment.VERA_EXPECTED_BUNDLE_ID,
    },
    dependencies,
  );
  for (const [tool, available] of Object.entries(report.tools)) {
    if (!available) {
      blocker(
        report,
        `tool_${tool}_missing`,
        `Required macOS release tool ${tool} is unavailable.`,
      );
    }
  }

  report.signing.validIdentityCount = report.tools.security
    ? validIdentityCount(dependencies)
    : null;
  const releaseSigningFlag = environment.VERA_RELEASE_SIGNING;
  const releaseSigningFlagValid =
    releaseSigningFlag === undefined ||
    releaseSigningFlag === "" ||
    releaseSigningFlag === "false" ||
    releaseSigningFlag === "true";
  if (!releaseSigningFlagValid) {
    blocker(
      report,
      "release_signing_flag_invalid",
      "VERA_RELEASE_SIGNING must be exactly true or false.",
    );
  }
  if (!report.signing.requested) {
    blocker(
      report,
      "release_signing_not_requested",
      "VERA_RELEASE_SIGNING is not true; output remains local-only.",
    );
  } else {
    try {
      const signing = classifyReleaseSigning(environment, {
        verifyKeychainIdentity: true,
        findSigningIdentity: () => {
          const runner = dependencies.run;
          let result;
          if (runner) {
            result = runner(
              "/usr/bin/security",
              ["find-identity", "-v", "-p", "codesigning"],
              {},
            );
          } else {
            const { execFileSync } = require("node:child_process");
            return execFileSync(
              "/usr/bin/security",
              ["find-identity", "-v", "-p", "codesigning"],
              { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
            );
          }
          if (result.error || result.status !== 0)
            throw new Error("unavailable");
          return `${result.stdout || ""}${result.stderr || ""}`;
        },
      });
      report.signing.configurationValid = signing.mode === "release";
      report.signing.teamId = signing.teamId || null;
      report.signing.expectedAuthority = signing.expectedAuthority || null;
      report.signing.method = signing.signing;
      report.signing.notarizationMethod = signing.notarization.method;
    } catch {
      blocker(
        report,
        "release_credentials_incomplete",
        "Developer ID or notarization credential readiness is incomplete.",
      );
    }
  }

  if (packageDocument && options.inspectArtifacts !== false) {
    const artifacts =
      options.artifacts ||
      discoverArtifacts(
        options.desktopRoot || DESKTOP_ROOT,
        packageDocument.version,
      );
    inspectArtifacts(report, artifacts, report.configuration, dependencies);
  } else if (options.inspectArtifacts === false) {
    warning(
      report,
      "artifact_inspection_skipped",
      "Artifact inspection was explicitly skipped.",
    );
  }

  const appVerified =
    report.artifacts?.apps.length > 0 &&
    report.artifacts.apps.every(
      (item) =>
        item.signature === "developer-id" && item.codesign === "verified",
    );
  const dmgVerified =
    report.artifacts?.dmgs.length > 0 &&
    report.artifacts.dmgs.every(
      (item) =>
        item.signature === "developer-id" && item.codesign === "verified",
    );
  const zipVerified =
    report.artifacts?.zips.length > 0 &&
    report.artifacts.zips.every(
      (item) => item.spctl === "verified_on_extracted_app",
    );
  if (appVerified && dmgVerified && zipVerified) report.signed = "SIGNED";
  const notarized =
    appVerified &&
    dmgVerified &&
    zipVerified &&
    report.artifacts.apps.every((item) => item.stapler === "validated") &&
    report.artifacts.dmgs.every((item) => item.stapler === "validated") &&
    report.artifacts.zips.every(
      (item) => item.stapler === "verified_on_extracted_app",
    );
  if (notarized) report.notarized = "NOTARIZED";
  report.releaseReady =
    report.blockers.length === 0 &&
    report.signing.configurationValid &&
    report.signed === "SIGNED" &&
    report.notarized === "NOTARIZED" &&
    report.artifacts?.checksums === "verified";
  return report;
}

function parseArguments(argv) {
  const options = {
    strictRelease: false,
    json: false,
    inspectArtifacts: true,
    artifacts: { apps: [], dmgs: [], zips: [], checksumManifest: null },
    explicitArtifacts: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--strict-release") options.strictRelease = true;
    else if (value === "--json") options.json = true;
    else if (value === "--no-artifacts") options.inspectArtifacts = false;
    else if (["--app", "--dmg", "--zip"].includes(value)) {
      const candidate = argv[++index];
      if (!candidate) throw new Error(`${value} requires a path.`);
      options.explicitArtifacts = true;
      const key =
        value === "--app" ? "apps" : value === "--dmg" ? "dmgs" : "zips";
      options.artifacts[key].push(path.resolve(candidate));
    } else if (value === "--checksum-manifest") {
      const candidate = argv[++index];
      if (!candidate) throw new Error("--checksum-manifest requires a path.");
      options.explicitArtifacts = true;
      options.artifacts.checksumManifest = path.resolve(candidate);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

function printReport(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `macOS release readiness signed=${report.signed} notarized=${report.notarized} releaseReady=${report.releaseReady}`,
  );
  for (const [key, state] of Object.entries(report.credentials)) {
    console.log(`credential ${key}=${state}`);
  }
  for (const blockerItem of report.blockers) {
    console.log(`blocker ${blockerItem.code}: ${blockerItem.detail}`);
  }
  for (const warningItem of report.warnings) {
    console.log(`warning ${warningItem.code}: ${warningItem.detail}`);
  }
}

if (require.main === module) {
  try {
    const cli = parseArguments(process.argv.slice(2));
    const report = buildReadiness({
      inspectArtifacts: cli.inspectArtifacts,
      ...(cli.explicitArtifacts ? { artifacts: cli.artifacts } : {}),
    });
    printReport(report, cli.json);
    if (cli.strictRelease && !report.releaseReady) process.exitCode = 1;
  } catch (error) {
    console.error(`macOS release readiness failed: ${error.message}`);
    // Invalid CLI usage or an unexpected implementation failure is not a
    // readiness blocker; it is a broken invocation and must fail in all modes.
    process.exitCode = 1;
  }
}

module.exports = {
  ALL_SECRET_ENVIRONMENT_KEYS,
  buildReadiness,
  discoverArtifacts,
  exactBooleanEntitlementKeys,
  inspectConfiguration,
  parseArguments,
  printReport,
  toolAvailability,
  validIdentityCount,
};
