#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildReadiness,
  discoverArtifacts: discoverReadinessArtifacts,
} = require("./macReleaseReadiness");
const {
  finalizeReleaseDmgs,
  releaseDmgPaths,
  verifyDmgForNotarization,
} = require("./afterAllArtifactBuild");
const {
  notarizeStapleAndValidate,
  verifyAppForNotarization,
} = require("./afterSign");
const {
  INHERITED_ENTITLEMENTS,
  MAIN_ENTITLEMENTS,
  nestedCodeVerificationOrder,
  verifyReleaseZip,
  verifySignedApp,
  verifySignedDmg,
} = require("./macReleaseVerification");
const {
  classifyReleaseSigning,
  developerIdAuthority,
} = require("./releaseSigningPreflight");
const {
  discoverArtifacts: discoverVerificationArtifacts,
  releaseConfiguration,
} = require("./verifyMacRelease");

const teamId = "ABCDE12345";
const identityQualifier = `Vera Test (${teamId})`;
const expectedAuthority = `Developer ID Application: ${identityQualifier}`;
const baseRelease = {
  VERA_RELEASE_SIGNING: "true",
  CSC_NAME: identityQualifier,
};

function expectFailure(environment, description, options) {
  assert.throws(
    () => classifyReleaseSigning(environment, options),
    Error,
    description,
  );
}

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8"),
  );
}

function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8");
}

function auditStaticLinkage() {
  const packageJson = readJson("package.json");
  assert.equal(
    packageJson.scripts["signing:preflight"],
    "node scripts/releaseSigningPreflight.js",
  );
  assert.equal(
    packageJson.scripts["signing:readiness"],
    "node scripts/macReleaseReadiness.js",
  );
  assert.equal(
    packageJson.scripts["signing:verify"],
    "node scripts/verifyMacRelease.js",
  );
  assert.equal(
    packageJson.scripts["test:signing-pipeline"],
    "node scripts/releaseSigningAudit.js",
  );
  assert.match(packageJson.scripts["dist:mac"], /signing:preflight/);
  assert.match(packageJson.scripts["pack:mac"], /signing:preflight/);
  assert.equal(packageJson.build.afterSign, "scripts/afterSign.js");
  assert.equal(
    packageJson.build.afterAllArtifactBuild,
    "scripts/afterAllArtifactBuild.js",
  );
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
  assert.equal(packageJson.build.mac.notarize, false);
  assert.equal(packageJson.build.mac.gatekeeperAssess, false);
  assert.equal(packageJson.build.dmg.sign, true);
  assert.equal(packageJson.build.dmg.writeUpdateInfo, false);
  assert.equal(
    packageJson.build.mac.entitlements,
    "build/entitlements.mac.plist",
  );
  assert.equal(
    packageJson.build.mac.entitlementsInherit,
    "build/entitlements.mac.inherit.plist",
  );
  assert.equal(packageJson.devDependencies["@electron/notarize"], "2.5.0");

  const mainEntitlements = readText(
    __dirname,
    "..",
    "build",
    "entitlements.mac.plist",
  );
  const inheritEntitlements = readText(
    __dirname,
    "..",
    "build",
    "entitlements.mac.inherit.plist",
  );
  assert.match(mainEntitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.doesNotMatch(
    mainEntitlements,
    /get-task-allow|app-sandbox|disable-library-validation|network\.|files\./,
  );
  assert.match(
    inheritEntitlements,
    /com\.apple\.security\.cs\.allow-unsigned-executable-memory/,
  );
  assert.doesNotMatch(
    inheritEntitlements,
    /get-task-allow|app-sandbox|disable-library-validation|network\.|files\./,
  );

  const afterSign = readText(__dirname, "afterSign.js");
  assert.match(afterSign, /@electron\/notarize/);
  assert.match(afterSign, /"stapler", "staple"/);
  assert.match(afterSign, /"stapler", "validate"/);
  assert.match(afterSign, /classifyReleaseSigning/);
  assert.match(afterSign, /notarizeStapleAndValidate/);
  assert.match(afterSign, /verifyAppForNotarization/);

  const afterAllArtifactBuild = readText(__dirname, "afterAllArtifactBuild.js");
  assert.match(afterAllArtifactBuild, /classifyReleaseSigning/);
  assert.match(afterAllArtifactBuild, /notarizeStapleAndValidate/);
  assert.match(afterAllArtifactBuild, /verifyDmgForNotarization/);
  assert.match(afterAllArtifactBuild, /\.dmg/);
  assert.match(afterAllArtifactBuild, /local-only unsigned build/);

  const verifier = readText(__dirname, "verifyMacRelease.js");
  const sharedVerifier = readText(__dirname, "macReleaseVerification.js");
  const readiness = readText(__dirname, "macReleaseReadiness.js");
  assert.match(verifier, /verifySignedApp/);
  assert.match(verifier, /verifySignedDmg/);
  assert.match(verifier, /verifyReleaseZip/);
  assert.match(
    verifier,
    /macOS release verification passed signed=true notarized=true/,
  );
  assert.match(sharedVerifier, /"--verify", "--strict"/);
  assert.match(sharedVerifier, /"--verify", "--deep", "--strict"/);
  assert.match(sharedVerifier, /"--type", "execute"/);
  assert.match(sharedVerifier, /"--type",\s*"open"/);
  assert.match(sharedVerifier, /"stapler", "validate"/);
  assert.match(sharedVerifier, /"attach"/);
  assert.match(sharedVerifier, /"-readonly"/);
  assert.match(sharedVerifier, /"-nobrowse"/);
  assert.match(sharedVerifier, /"-noautoopen"/);
  assert.match(sharedVerifier, /"detach", "-force"/);
  assert.match(sharedVerifier, /"-a", "256", "-c"/);
  assert.doesNotMatch(
    sharedVerifier,
    /"--sign"|notarytool.*submit|security.*import/,
  );
  assert.match(readiness, /UNSIGNED/);
  assert.match(readiness, /NOT_NOTARIZED/);
  assert.match(readiness, /if \(cli\.strictRelease && !report\.releaseReady\)/);

  const packagingScript = readText(
    __dirname,
    "..",
    "..",
    "scripts",
    "package-desktop-mac.sh",
  );
  assert.match(packagingScript, /signing:preflight/);
  assert.match(packagingScript, /signing:readiness/);
  assert.match(packagingScript, /signing:verify/);
  assert.match(packagingScript, /VERA_RELEASE_SIGNING/);
  for (const key of [
    "CSC_NAME",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ]) {
    assert.match(packagingScript, new RegExp(`-u ${key}\\b`));
  }
  assert.match(packagingScript, /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.match(
    packagingScript,
    /Release build; Developer ID signature and notarization are required/,
  );
  assert.doesNotMatch(
    packagingScript,
    /Developer ID signed and notarized release build/,
  );

  const workflow = readText(
    __dirname,
    "..",
    "..",
    ".github",
    "workflows",
    "aletheia-local-ci.yml",
  );
  assert.match(workflow, /test:signing-pipeline/);
  assert.match(workflow, /signing:readiness -- --no-artifacts/);
  assert.match(workflow, /Install desktop dependencies/);
  assert.doesNotMatch(workflow, /\bsecrets\./);
  assert.doesNotMatch(workflow, /VERA_RELEASE_SIGNING:\s*["']?true/);

  const preflight = readText(__dirname, "releaseSigningPreflight.js");
  assert.match(preflight, /signingRequired=true notarizationRequired=true/);
  assert.doesNotMatch(preflight, /notarized=true/);
}

function auditX64ArtifactDiscovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vera-x64-artifacts-"));
  const version = "1.0.1";
  const x64App = path.join(root, "dist", "mac", "Vera.app");
  const unrelatedApp = path.join(root, "dist", "mac-preview", "Vera.app");
  try {
    fs.mkdirSync(x64App, { recursive: true });
    fs.mkdirSync(unrelatedApp, { recursive: true });
    assert.deepEqual(discoverReadinessArtifacts(root, version).apps, [x64App]);
    assert.deepEqual(
      discoverVerificationArtifacts({ desktopRoot: root, version }).apps,
      [x64App],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function auditCredentialClassification() {
  assert.deepEqual(classifyReleaseSigning({}), {
    mode: "local",
    signed: false,
    notarized: false,
    localOnly: true,
  });
  expectFailure(
    baseRelease,
    "release mode must fail closed without notarization credentials",
  );
  expectFailure(
    { ...baseRelease, CSC_NAME: "-" },
    "ad-hoc identity must be rejected",
  );
  expectFailure(
    { ...baseRelease, CSC_NAME: expectedAuthority },
    "Electron Builder-incompatible prefixed identity must be rejected",
  );
  expectFailure(
    { ...baseRelease, CSC_NAME: "Vera Test" },
    "a vague identity qualifier without its team must be rejected",
  );
  expectFailure(
    { ...baseRelease, CSC_LINK: "file:///certificate.p12" },
    "partial certificate-file configuration must be rejected",
  );
  expectFailure(
    {
      ...baseRelease,
      APPLE_ID: "build@example.invalid",
      APPLE_APP_SPECIFIC_PASSWORD: "not-a-real-password",
      APPLE_TEAM_ID: teamId,
      APPLE_API_KEY: "/tmp/never-used.p8",
    },
    "mixed notarization methods must be rejected",
  );
  expectFailure(
    {
      ...baseRelease,
      APPLE_ID: "build@example.invalid",
      APPLE_APP_SPECIFIC_PASSWORD: "not-a-real-password",
      APPLE_TEAM_ID: "FGHIJ67890",
    },
    "notarization team must match signing team",
  );

  const appleId = classifyReleaseSigning({
    ...baseRelease,
    APPLE_ID: "build@example.invalid",
    APPLE_APP_SPECIFIC_PASSWORD: "not-a-real-password",
    APPLE_TEAM_ID: teamId,
  });
  assert.equal(appleId.notarization.method, "apple-id");
  assert.equal(appleId.identityQualifier, identityQualifier);
  assert.equal(appleId.expectedAuthority, expectedAuthority);
  assert.equal(appleId.signingRequired, true);
  assert.equal(appleId.notarizationRequired, true);
  assert.equal("signed" in appleId, false);
  assert.equal("notarized" in appleId, false);
  expectFailure(
    {
      ...baseRelease,
      APPLE_ID: "build@example.invalid",
      APPLE_APP_SPECIFIC_PASSWORD: "not-a-real-password",
      APPLE_TEAM_ID: teamId,
    },
    "missing keychain identity must fail closed in the CLI mode",
    {
      verifyKeychainIdentity: true,
      findSigningIdentity: () => "  0 valid identities found\n",
    },
  );
  const keychainIdentity = classifyReleaseSigning(
    {
      ...baseRelease,
      APPLE_ID: "build@example.invalid",
      APPLE_APP_SPECIFIC_PASSWORD: "not-a-real-password",
      APPLE_TEAM_ID: teamId,
    },
    {
      verifyKeychainIdentity: true,
      findSigningIdentity: () =>
        `  1) ${"A".repeat(40)} "${expectedAuthority}"\n`,
    },
  );
  assert.equal(keychainIdentity.signing, "developer-id-keychain");
  expectFailure(
    {
      ...baseRelease,
      APPLE_ID: "build@example.invalid",
      APPLE_APP_SPECIFIC_PASSWORD: "not-a-real-password",
      APPLE_TEAM_ID: teamId,
    },
    "a substring-only keychain identity match must fail closed",
    {
      verifyKeychainIdentity: true,
      findSigningIdentity: () =>
        `  1) ${"B".repeat(40)} "Developer ID Application: Other ${identityQualifier}"\n`,
    },
  );

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "vera-notary-audit-"),
  );
  const apiKeyPath = path.join(temporaryDirectory, "AuthKey_ABCDEF1234.p8");
  try {
    fs.writeFileSync(apiKeyPath, "audit fixture only\n", { mode: 0o600 });
    const apiKey = classifyReleaseSigning({
      ...baseRelease,
      APPLE_API_KEY: apiKeyPath,
      APPLE_API_KEY_ID: "ABCDEF1234",
      APPLE_API_ISSUER: "12345678-1234-1234-1234-123456789abc",
      APPLE_TEAM_ID: teamId,
    });
    assert.equal(apiKey.notarization.method, "api-key");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function auditVerificationTrustContract() {
  const configuration = releaseConfiguration({
    expectedIdentityQualifier: identityQualifier,
    expectedTeam: teamId,
  });
  assert.equal(configuration.expectedAuthority, expectedAuthority);
  assert.equal(configuration.expectedTeam, teamId);
  assert.throws(
    () =>
      releaseConfiguration({
        expectedIdentityQualifier: expectedAuthority,
        expectedTeam: teamId,
      }),
    /exact Electron Builder qualifier/,
  );
  assert.throws(
    () =>
      releaseConfiguration({
        expectedIdentityQualifier: identityQualifier,
        expectedTeam: "FGHIJ67890",
      }),
    /identity and team do not match/,
  );
}

function plistFixture(plistPath) {
  if (plistPath.endsWith("entitlements.mac.inherit.plist")) {
    return Object.fromEntries(INHERITED_ENTITLEMENTS.map((key) => [key, true]));
  }
  if (plistPath.endsWith("entitlements.mac.plist")) {
    return Object.fromEntries(MAIN_ENTITLEMENTS.map((key) => [key, true]));
  }
  throw new Error("unexpected plist fixture");
}

function offlineReadinessRun(command, args) {
  if (command === "/usr/bin/xcrun" && args[0] === "--find") {
    return { status: 0, stdout: `/offline/${args[1]}\n`, stderr: "" };
  }
  if (command === "/usr/bin/security") {
    return {
      status: 0,
      stdout: `  1) ${"A".repeat(40)} "${expectedAuthority}"\n  1 valid identities found\n`,
      stderr: "",
    };
  }
  return { status: 0, stdout: "", stderr: "" };
}

function auditReadinessRedaction() {
  const local = buildReadiness(
    {
      environment: { VERA_RELEASE_SIGNING: "false" },
      inspectArtifacts: false,
    },
    { run: offlineReadinessRun, readPlist: plistFixture },
  );
  assert.equal(local.signed, "UNSIGNED");
  assert.equal(local.notarized, "NOT_NOTARIZED");
  assert.equal(local.releaseReady, false);
  assert.deepEqual(
    Object.keys(local.tools).sort(),
    [
      "codesign",
      "ditto",
      "hdiutil",
      "notarytool",
      "plutil",
      "security",
      "shasum",
      "spctl",
      "stapler",
      "unzip",
      "xcrun",
      "zipinfo",
    ].sort(),
  );
  assert.ok(
    local.blockers.some(
      (item) => item.code === "release_signing_not_requested",
    ),
  );

  const passwordSentinel = "PASSWORD_MUST_NEVER_APPEAR";
  const release = buildReadiness(
    {
      environment: {
        ...baseRelease,
        APPLE_ID: "build@example.invalid",
        APPLE_APP_SPECIFIC_PASSWORD: passwordSentinel,
        APPLE_TEAM_ID: teamId,
      },
      inspectArtifacts: false,
    },
    { run: offlineReadinessRun, readPlist: plistFixture },
  );
  assert.equal(release.signing.configurationValid, true);
  assert.equal(release.credentials.APPLE_APP_SPECIFIC_PASSWORD, "present");
  assert.equal(JSON.stringify(release).includes(passwordSentinel), false);
  assert.equal(
    JSON.stringify(release).includes("build@example.invalid"),
    false,
  );

  const invalidFlag = buildReadiness(
    {
      environment: { VERA_RELEASE_SIGNING: "TRUE" },
      inspectArtifacts: false,
    },
    { run: offlineReadinessRun, readPlist: plistFixture },
  );
  assert.ok(
    invalidFlag.blockers.some(
      (item) => item.code === "release_signing_flag_invalid",
    ),
  );

  const missingExplicitApp = buildReadiness(
    {
      environment: { VERA_RELEASE_SIGNING: "false" },
      artifacts: {
        apps: [path.join(os.tmpdir(), "vera-missing-release-app", "Vera.app")],
        dmgs: [],
        zips: [],
        checksumManifest: null,
      },
    },
    { run: offlineReadinessRun, readPlist: plistFixture },
  );
  assert.equal(missingExplicitApp.releaseReady, false);
  assert.ok(
    missingExplicitApp.blockers.some(
      (item) => item.code === "app_metadata_invalid",
    ),
  );
}

function writeMachO(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from("feedfacf00000000", "hex"));
}

function fixtureApp(root) {
  const appPath = path.join(root, "Vera.app");
  fs.mkdirSync(path.join(appPath, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), "fixture\n");
  writeMachO(path.join(appPath, "Contents", "MacOS", "Vera"));
  const helper = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Vera Helper (Renderer).app",
  );
  fs.mkdirSync(path.join(helper, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(helper, "Contents", "Info.plist"), "fixture\n");
  writeMachO(path.join(helper, "Contents", "MacOS", "Vera Helper (Renderer)"));
  writeMachO(
    path.join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Electron Framework",
    ),
  );
  return appPath;
}

function signedDetails(entitlements) {
  return [
    "Authority=Developer ID Application: Vera Test (ABCDE12345)",
    "TeamIdentifier=ABCDE12345",
    "CodeDirectory flags=0x10000(runtime)",
    '<?xml version="1.0"?><plist><dict>',
    ...entitlements.map((key) => `<key>${key}</key><true/>`),
    "</dict></plist>",
  ].join("\n");
}

const BASE_ZIP_FIXTURE_ENTRIES = [
  { path: "Vera.app/", type: "d" },
  { path: "Vera.app/Contents/Info.plist", type: "-" },
];

function zipInspectionFixture(command, args, entries) {
  if (command === "/usr/bin/zipinfo") {
    if (args[0] === "-1") {
      return {
        status: 0,
        stdout: `${entries.map((entry) => entry.path).join("\n")}\n`,
        stderr: "",
      };
    }
    if (args[0] === "-s") {
      const modes = {
        "-": "-rw-r--r--",
        d: "drwxr-xr-x",
        l: "lrwxr-xr-x",
      };
      const records = entries.map((entry) => {
        const size =
          entry.type === "l"
            ? Buffer.byteLength(entry.target || "")
            : entry.type === "d"
              ? 0
              : 7;
        return `${modes[entry.type]}  3.0 unx ${String(size).padStart(8)} bx stor 26-Jul-15 17:17 ${entry.path}`;
      });
      return {
        status: 0,
        stdout: [
          "Archive: offline-fixture.zip",
          `Zip file size: 1 bytes, number of entries: ${entries.length}`,
          ...records,
          `${entries.length} files, 1 bytes uncompressed, 1 bytes compressed: 0.0%`,
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    throw new Error("unexpected zipinfo fixture arguments");
  }
  if (command === "/usr/bin/unzip") {
    assert.equal(args[0], "-p");
    const entry = entries.find((candidate) => candidate.path === args[2]);
    if (!entry || entry.type !== "l") {
      return { status: 11, stdout: "", stderr: "member not found" };
    }
    return { status: 0, stdout: entry.target, stderr: "" };
  }
  return null;
}

function auditArtifactVerificationOrder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vera-sign-order-audit-"));
  const calls = [];
  try {
    const appPath = fixtureApp(root);
    const dmgPath = path.join(root, "Vera-1.0.1-arm64.dmg");
    const zipPath = path.join(root, "Vera-1.0.1-arm64.zip");
    fs.writeFileSync(dmgPath, "dmg fixture\n");
    fs.writeFileSync(zipPath, "zip fixture\n");
    const dependencies = {
      readPlist: (plistPath) => {
        if (plistPath.endsWith(path.join("Contents", "Info.plist"))) {
          return {
            CFBundleIdentifier: "ai.aletheia.local",
            CFBundleShortVersionString: "1.0.1",
            CFBundleVersion: "1.0.1",
            CFBundleDisplayName: "Vera",
            CFBundleExecutable: "Vera",
          };
        }
        return plistFixture(plistPath);
      },
      run: (command, args, options) => {
        calls.push({ command, args: [...args], options });
        if (command === "/usr/bin/hdiutil" && args[0] === "attach") {
          const mountPoint = args[args.indexOf("-mountpoint") + 1];
          fs.cpSync(appPath, path.join(mountPoint, "Vera.app"), {
            recursive: true,
          });
          return { status: 0, stdout: "offline attach fixture\n", stderr: "" };
        }
        if (command === "/usr/bin/codesign" && args[0] === "-dvvv") {
          const target = args[args.length - 1];
          const entitlements = target.endsWith("Vera.app")
            ? MAIN_ENTITLEMENTS
            : INHERITED_ENTITLEMENTS;
          return {
            status: 0,
            stdout: "",
            stderr: signedDetails(entitlements),
          };
        }
        const zipInspection = zipInspectionFixture(
          command,
          args,
          BASE_ZIP_FIXTURE_ENTRIES,
        );
        if (zipInspection) return zipInspection;
        return { status: 0, stdout: "", stderr: "" };
      },
      extractZip: (_zip, destination) => {
        fs.cpSync(appPath, path.join(destination, "Vera.app"), {
          recursive: true,
        });
      },
    };
    const options = {
      bundleId: "ai.aletheia.local",
      version: "1.0.1",
      expectedTeam: teamId,
      expectedAuthority,
    };
    const order = nestedCodeVerificationOrder(appPath);
    assert.ok(order.length >= 4);
    const helperBinary = order.findIndex((item) =>
      item.path.endsWith(path.join("MacOS", "Vera Helper (Renderer)")),
    );
    const helperBundle = order.findIndex((item) =>
      item.path.endsWith("Vera Helper (Renderer).app"),
    );
    assert.ok(helperBinary >= 0 && helperBundle > helperBinary);

    const app = verifySignedApp(appPath, options, dependencies);
    assert.equal(app.teamId, teamId);
    assert.equal(app.stapler, "validated");
    const strictTargets = calls
      .filter(
        (call) =>
          call.command === "/usr/bin/codesign" &&
          call.args[0] === "--verify" &&
          !call.args.includes("--deep"),
      )
      .map((call) => call.args[call.args.length - 1]);
    assert.equal(strictTargets[strictTargets.length - 1], appPath);
    assert.throws(
      () =>
        verifySignedApp(
          appPath,
          {
            ...options,
            expectedAuthority: `Developer ID Application: Other (${teamId})`,
          },
          dependencies,
        ),
      /exact expected Developer ID Application authority/,
    );

    function withPoisonedNestedEntitlements(targetSuffix, entitlements) {
      return {
        ...dependencies,
        run: (command, args, commandOptions) => {
          const target = args[args.length - 1];
          if (
            command === "/usr/bin/codesign" &&
            args[0] === "-dvvv" &&
            target.endsWith(targetSuffix)
          ) {
            calls.push({ command, args: [...args], options: commandOptions });
            return {
              status: 0,
              stdout: "",
              stderr: signedDetails(entitlements),
            };
          }
          return dependencies.run(command, args, commandOptions);
        },
      };
    }

    assert.throws(
      () =>
        verifySignedApp(
          appPath,
          options,
          withPoisonedNestedEntitlements(
            path.join("MacOS", "Vera Helper (Renderer)"),
            [
              ...INHERITED_ENTITLEMENTS,
              "com.apple.security.cs.allow-dyld-environment-variables",
            ],
          ),
        ),
      /contains forbidden release entitlements/,
    );
    assert.throws(
      () =>
        verifySignedApp(
          appPath,
          options,
          withPoisonedNestedEntitlements("Electron Framework.framework", [
            ...INHERITED_ENTITLEMENTS,
            "com.vera.fixture.unreviewed-entitlement",
          ]),
        ),
      /contains an unexpected entitlement/,
    );
    assert.throws(
      () =>
        verifySignedApp(
          appPath,
          options,
          withPoisonedNestedEntitlements("Vera Helper (Renderer).app", [
            ...INHERITED_ENTITLEMENTS,
            "com.apple.security.automation.apple-events",
          ]),
        ),
      /contains forbidden release entitlements/,
    );
    assert.throws(
      () =>
        verifySignedApp(
          appPath,
          options,
          withPoisonedNestedEntitlements(
            path.join("MacOS", "Vera Helper (Renderer)"),
            [MAIN_ENTITLEMENTS[0]],
          ),
        ),
      /missing a required entitlement/,
    );

    assert.equal(
      verifySignedDmg(dmgPath, options, dependencies).app.stapler,
      "validated",
    );
    assert.equal(
      verifyDmgForNotarization(
        dmgPath,
        { teamId, expectedAuthority },
        dependencies,
      ).teamId,
      teamId,
    );
    assert.equal(
      verifyAppForNotarization(
        appPath,
        { teamId, expectedAuthority },
        dependencies,
      ).authority,
      expectedAuthority,
    );
    const zip = verifyReleaseZip(zipPath, options, dependencies);
    assert.equal(zip.codesign, "not_applicable_archive_container");
    assert.equal(zip.spctl, "verified_on_extracted_app");

    function withZipLayout(entries) {
      const state = { extractCalls: 0, symlinkReads: 0 };
      return {
        state,
        verificationDependencies: {
          ...dependencies,
          run: (command, args, commandOptions) => {
            const zipInspection = zipInspectionFixture(command, args, entries);
            if (zipInspection) {
              if (command === "/usr/bin/unzip") state.symlinkReads += 1;
              return zipInspection;
            }
            return dependencies.run(command, args, commandOptions);
          },
          extractZip: (_zip, destination) => {
            state.extractCalls += 1;
            dependencies.extractZip(_zip, destination);
          },
        },
      };
    }

    const legalSymlinkPath =
      "Vera.app/Contents/Frameworks/Test.framework/Versions/Current";
    const legalSymlink = withZipLayout([
      ...BASE_ZIP_FIXTURE_ENTRIES,
      { path: legalSymlinkPath, type: "l", target: "A" },
    ]);
    assert.equal(
      verifyReleaseZip(zipPath, options, legalSymlink.verificationDependencies)
        .spctl,
      "verified_on_extracted_app",
    );
    assert.equal(legalSymlink.state.symlinkReads, 1);
    assert.equal(legalSymlink.state.extractCalls, 1);

    const unsafeSymlinkCases = [
      {
        label: "archive-root escape",
        target: "../../outside",
        expected: /outside the archive root/,
      },
      {
        label: "absolute target",
        target: "/tmp/outside",
        expected: /unsafe symlink target/,
      },
      {
        label: "Windows-rooted target",
        target: "C:\\outside",
        expected: /unsafe symlink target/,
      },
      {
        label: "control-character target",
        target: "inside\noutside",
        expected: /unsafe symlink target/,
      },
      {
        label: "NUL target",
        target: "inside\0outside",
        expected: /unsafe symlink target/,
      },
    ];
    for (const scenario of unsafeSymlinkCases) {
      const poisoned = withZipLayout([
        ...BASE_ZIP_FIXTURE_ENTRIES,
        {
          path: "Vera.app/escape",
          type: "l",
          target: scenario.target,
        },
      ]);
      assert.throws(
        () =>
          verifyReleaseZip(zipPath, options, poisoned.verificationDependencies),
        scenario.expected,
        scenario.label,
      );
      assert.equal(poisoned.state.extractCalls, 0, scenario.label);
    }

    const duplicateEntry = withZipLayout([
      ...BASE_ZIP_FIXTURE_ENTRIES,
      BASE_ZIP_FIXTURE_ENTRIES[1],
    ]);
    assert.throws(
      () =>
        verifyReleaseZip(
          zipPath,
          options,
          duplicateEntry.verificationDependencies,
        ),
      /contains a duplicate path/,
    );
    assert.equal(duplicateEntry.state.extractCalls, 0);

    const extraAppZipDependencies = {
      ...dependencies,
      run: (command, args, commandOptions) => {
        const zipInspection = zipInspectionFixture(command, args, [
          ...BASE_ZIP_FIXTURE_ENTRIES,
          { path: "Malware.app/", type: "d" },
          { path: "Malware.app/Contents/Info.plist", type: "-" },
        ]);
        if (zipInspection) return zipInspection;
        return dependencies.run(command, args, commandOptions);
      },
      extractZip: (_zip, destination) => {
        fs.cpSync(appPath, path.join(destination, "Vera.app"), {
          recursive: true,
        });
        fs.cpSync(appPath, path.join(destination, "Malware.app"), {
          recursive: true,
        });
      },
    };
    assert.throws(
      () => verifyReleaseZip(zipPath, options, extraAppZipDependencies),
      /must contain exactly one Vera\.app/,
    );
    assert.equal(
      calls.some(
        (call) =>
          call.args.includes("--sign") ||
          call.args.includes("submit") ||
          call.args.includes("import"),
      ),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function auditDmgContentFailurePaths() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "vera-dmg-content-audit-"),
  );
  try {
    const appPath = fixtureApp(path.join(root, "source"));
    const dmgPath = path.join(root, "Vera-1.0.1-arm64.dmg");
    fs.writeFileSync(dmgPath, "offline DMG fixture\n");
    const options = {
      bundleId: "ai.aletheia.local",
      version: "1.0.1",
      expectedTeam: teamId,
      expectedAuthority,
    };

    function scenario(overrides = {}) {
      const calls = [];
      let mountPoint = null;
      const dependencies = {
        extractZip: (_zipPath, destination) => {
          fs.cpSync(appPath, path.join(destination, "Vera.app"), {
            recursive: true,
          });
        },
        readPlist: (plistPath) => {
          if (plistPath.endsWith(path.join("Contents", "Info.plist"))) {
            return {
              CFBundleIdentifier: "ai.aletheia.local",
              CFBundleShortVersionString: "1.0.1",
              CFBundleVersion: "1.0.1",
              CFBundleDisplayName: "Vera",
              CFBundleExecutable: "Vera",
            };
          }
          return plistFixture(plistPath);
        },
        run: (command, args, commandOptions) => {
          calls.push({ command, args: [...args], options: commandOptions });
          const target = args[args.length - 1];
          const mountedTarget =
            mountPoint &&
            typeof target === "string" &&
            path
              .resolve(target)
              .startsWith(`${path.resolve(mountPoint)}${path.sep}`);
          if (
            overrides.innerUnsigned &&
            mountedTarget &&
            command === "/usr/bin/codesign"
          ) {
            return { status: 1, stdout: "", stderr: "unsigned fixture\n" };
          }
          if (command === "/usr/bin/codesign" && args[0] === "-dvvv") {
            const entitlements = target.endsWith("Vera.app")
              ? MAIN_ENTITLEMENTS
              : INHERITED_ENTITLEMENTS;
            return {
              status: 0,
              stdout: "",
              stderr: signedDetails(entitlements),
            };
          }
          if (command === "/usr/bin/security") {
            return {
              status: 0,
              stdout: `  1) ${"A".repeat(40)} "${expectedAuthority}"\n  1 valid identities found\n`,
              stderr: "",
            };
          }
          const zipInspection = zipInspectionFixture(
            command,
            args,
            BASE_ZIP_FIXTURE_ENTRIES,
          );
          if (zipInspection) return zipInspection;
          if (command === "/usr/bin/hdiutil" && args[0] === "attach") {
            mountPoint = args[args.indexOf("-mountpoint") + 1];
            if (overrides.attachFailure) {
              return { status: 1, stdout: "", stderr: "attach failed\n" };
            }
            fs.cpSync(appPath, path.join(mountPoint, "Vera.app"), {
              recursive: true,
            });
            if (overrides.multipleApps) {
              const duplicate = path.join(mountPoint, "duplicate", "Vera.app");
              fs.mkdirSync(path.dirname(duplicate), { recursive: true });
              fs.cpSync(appPath, duplicate, { recursive: true });
            }
            return {
              status: 0,
              stdout: "offline attach fixture\n",
              stderr: "",
            };
          }
          if (command === "/usr/bin/hdiutil" && args[0] === "detach") {
            return overrides.detachFailure
              ? { status: 1, stdout: "", stderr: "detach failed\n" }
              : { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      };
      return {
        calls,
        dependencies,
        cleanup: () => {
          if (mountPoint) {
            fs.rmSync(path.dirname(mountPoint), {
              recursive: true,
              force: true,
            });
          }
        },
      };
    }

    const scenarios = [];
    const attachFailure = scenario({ attachFailure: true });
    scenarios.push(attachFailure);
    assert.throws(
      () => verifySignedDmg(dmgPath, options, attachFailure.dependencies),
      /DMG read-only attach failed/,
    );
    assert.ok(
      attachFailure.calls.some(
        ({ command, args }) =>
          command === "/usr/bin/hdiutil" && args[0] === "detach",
      ),
    );

    const multipleApps = scenario({ multipleApps: true });
    scenarios.push(multipleApps);
    assert.throws(
      () => verifySignedDmg(dmgPath, options, multipleApps.dependencies),
      /exactly one top-level Vera\.app/,
    );
    assert.ok(
      multipleApps.calls.some(
        ({ command, args }) =>
          command === "/usr/bin/hdiutil" && args[0] === "detach",
      ),
    );

    const innerUnsigned = scenario({ innerUnsigned: true });
    scenarios.push(innerUnsigned);
    assert.throws(
      () => verifySignedDmg(dmgPath, options, innerUnsigned.dependencies),
      /strict code-signature verification .* failed/,
    );
    assert.ok(
      innerUnsigned.calls.some(
        ({ command, args }) =>
          command === "/usr/bin/hdiutil" && args[0] === "detach",
      ),
    );

    const detachFailure = scenario({ detachFailure: true });
    scenarios.push(detachFailure);
    try {
      assert.throws(
        () => verifySignedDmg(dmgPath, options, detachFailure.dependencies),
        /DMG detach failed after the force fallback/,
      );
      const detachCalls = detachFailure.calls.filter(
        ({ command, args }) =>
          command === "/usr/bin/hdiutil" && args[0] === "detach",
      );
      assert.equal(detachCalls.length, 2);
      assert.deepEqual(detachCalls[1].args.slice(0, 2), ["detach", "-force"]);
    } finally {
      detachFailure.cleanup();
    }

    const zipPath = path.join(root, "Vera-1.0.1-arm64.zip");
    const checksumPath = path.join(root, "Vera-1.0.1-SHA256SUMS.txt");
    fs.writeFileSync(zipPath, "offline ZIP fixture\n");
    fs.writeFileSync(
      checksumPath,
      `${"0".repeat(64)}  ${path.basename(dmgPath)}\n${"1".repeat(64)}  ${path.basename(zipPath)}\n`,
    );
    const readiness = buildReadiness(
      {
        environment: {
          ...baseRelease,
          APPLE_ID: "offline@example.invalid",
          APPLE_APP_SPECIFIC_PASSWORD: "offline-fixture-only",
          APPLE_TEAM_ID: teamId,
        },
        artifacts: {
          apps: [appPath],
          dmgs: [dmgPath],
          zips: [zipPath],
          checksumManifest: checksumPath,
        },
      },
      innerUnsigned.dependencies,
    );
    assert.equal(readiness.releaseReady, false);
    assert.ok(
      readiness.blockers.some(
        ({ code }) => code === "dmg_release_verification_failed",
      ),
    );

    const allCalls = scenarios.flatMap((item) => item.calls);
    const attachCalls = allCalls.filter(
      ({ command, args }) =>
        command === "/usr/bin/hdiutil" && args[0] === "attach",
    );
    assert.ok(attachCalls.length >= 4);
    for (const { args } of attachCalls) {
      for (const flag of [
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
      ]) {
        assert.ok(args.includes(flag));
      }
    }
    assert.equal(
      allCalls.some(
        ({ command, args }) =>
          /(?:curl|notarytool)$/i.test(command) ||
          (command === "/usr/bin/security" && args[0] !== "find-identity") ||
          args.some((value) => /^(?:--sign|submit|import)$/.test(value)),
      ),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function auditNotarizationHookOrdering() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vera-dmg-hook-audit-"));
  try {
    const dmgPath = path.join(root, "Vera-1.0.1-arm64.dmg");
    const zipPath = path.join(root, "Vera-1.0.1-arm64.zip");
    fs.writeFileSync(dmgPath, "offline DMG fixture\n");
    fs.writeFileSync(zipPath, "offline ZIP fixture\n");
    assert.deepEqual(releaseDmgPaths({ artifactPaths: [zipPath, dmgPath] }), [
      dmgPath,
    ]);

    const localCalls = [];
    await finalizeReleaseDmgs(
      { artifactPaths: [dmgPath, zipPath] },
      {
        classifyReleaseSigning: () => ({ mode: "local" }),
        notarizeStapleAndValidate: async (...args) => localCalls.push(args),
        log: () => {},
      },
    );
    assert.deepEqual(localCalls, []);

    const releaseCalls = [];
    const releaseSequence = [];
    const configuration = {
      mode: "release",
      teamId,
      identityQualifier,
      expectedAuthority,
      notarization: { method: "apple-id", teamId },
    };
    await finalizeReleaseDmgs(
      { artifactPaths: [zipPath, dmgPath] },
      {
        classifyReleaseSigning: () => configuration,
        verifyDmgForNotarization: (target, receivedConfiguration) => {
          releaseSequence.push({
            operation: "verify",
            target,
            expectedTeam: receivedConfiguration.teamId,
            expectedAuthority: receivedConfiguration.expectedAuthority,
          });
        },
        notarizeStapleAndValidate: async (received, target) => {
          releaseSequence.push({ operation: "notarize", target });
          releaseCalls.push({ received, target });
        },
        log: () => {},
      },
    );
    assert.deepEqual(releaseCalls, [
      { received: configuration, target: dmgPath },
    ]);
    assert.deepEqual(releaseSequence, [
      {
        operation: "verify",
        target: dmgPath,
        expectedTeam: teamId,
        expectedAuthority,
      },
      { operation: "notarize", target: dmgPath },
    ]);

    const sequence = [];
    await notarizeStapleAndValidate(configuration, dmgPath, {
      environment: {
        APPLE_ID: "offline@example.invalid",
        APPLE_APP_SPECIFIC_PASSWORD: "offline-fixture-only",
      },
      notarize: async (options) => {
        sequence.push({ operation: "notarize", target: options.appPath });
      },
      execFileSync: (_command, args) => {
        sequence.push({ operation: args[1], target: args[2] });
      },
    });
    assert.deepEqual(sequence, [
      { operation: "notarize", target: dmgPath },
      { operation: "staple", target: dmgPath },
      { operation: "validate", target: dmgPath },
    ]);
    assert.equal(
      JSON.stringify(sequence).includes("offline-fixture-only"),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function auditElectronBuilderIdentityCompatibility() {
  // Exercise the locked Electron Builder implementation with an in-memory
  // `security` fixture. No certificate lookup, import, signing, or network call
  // reaches the host during this regression.
  const builderUtil = require("builder-util");
  const macCodeSign = require("app-builder-lib/out/codeSign/macCodeSign");
  const originalExec = builderUtil.exec;
  const calls = [];
  builderUtil.exec = async (command, args) => {
    calls.push({ command, args: [...args] });
    assert.equal(command, "/usr/bin/security");
    assert.equal(args[0], "find-identity");
    return `  1) ${"A".repeat(40)} "${expectedAuthority}"\n  1 valid identities found\n`;
  };
  macCodeSign.findIdentityRawResult = null;
  try {
    assert.throws(
      () =>
        macCodeSign.findIdentity(
          "Developer ID Application",
          expectedAuthority,
          null,
        ),
      /Please remove prefix "Developer ID Application:"/,
    );
    const identity = await macCodeSign.findIdentity(
      "Developer ID Application",
      identityQualifier,
      null,
    );
    assert.ok(identity);
    assert.equal(identity.name, expectedAuthority);
    assert.ok(calls.length >= 1);
    assert.equal(
      calls.some(({ args }) =>
        args.some((value) =>
          /^(?:import|create-keychain|delete-keychain|set-key-partition-list)$/.test(
            value,
          ),
        ),
      ),
      false,
    );
  } finally {
    macCodeSign.findIdentityRawResult = null;
    builderUtil.exec = originalExec;
  }
}

async function main() {
  auditCredentialClassification();
  auditVerificationTrustContract();
  auditReadinessRedaction();
  auditArtifactVerificationOrder();
  auditDmgContentFailurePaths();
  await auditNotarizationHookOrdering();
  await auditElectronBuilderIdentityCompatibility();
  auditStaticLinkage();
  auditX64ArtifactDiscovery();
  console.log(
    "release signing/readiness pipeline audit passed (offline; no Keychain writes, signing, notarization, or Apple calls).",
  );
}

main().catch((error) => {
  console.error(`release signing pipeline audit failed: ${error.message}`);
  process.exitCode = 1;
});
