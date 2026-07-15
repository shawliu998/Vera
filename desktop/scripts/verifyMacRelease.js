#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  developerIdAuthority,
  developerIdTeam,
} = require("./releaseSigningPreflight");
const {
  isMacAppOutputDirectory,
  verifyChecksumManifest,
  verifyReleaseZip,
  verifySignedApp,
  verifySignedDmg,
} = require("./macReleaseVerification");

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    apps: [],
    dmgs: [],
    zips: [],
    checksumManifest: undefined,
    expectedTeam: process.env.VERA_EXPECTED_TEAM_ID,
    expectedIdentityQualifier: process.env.CSC_NAME,
    expectedBundleId: process.env.VERA_EXPECTED_BUNDLE_ID,
    expectedVersion: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      const candidate = argv[++index];
      if (!candidate) fail(`${value} requires a value.`);
      return candidate;
    };
    if (value === "--app") options.apps.push(path.resolve(next()));
    else if (value === "--dmg") options.dmgs.push(path.resolve(next()));
    else if (value === "--zip") options.zips.push(path.resolve(next()));
    else if (value === "--checksum-manifest") {
      options.checksumManifest = path.resolve(next());
    } else if (value === "--team") options.expectedTeam = next();
    else if (value === "--identity") {
      options.expectedIdentityQualifier = next();
    } else if (value === "--bundle-id") options.expectedBundleId = next();
    else if (value === "--version") options.expectedVersion = next();
    else fail(`Unknown argument: ${value}`);
  }
  return options;
}

function releaseConfiguration(options) {
  const desktopRoot = path.resolve(__dirname, "..");
  const packageDocument = JSON.parse(
    fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
  );
  if (!options.expectedIdentityQualifier) {
    fail(
      "Release verification requires CSC_NAME or --identity as the exact unprefixed Developer ID qualifier.",
    );
  }
  const identityTeam = developerIdTeam(options.expectedIdentityQualifier);
  const expectedTeam = options.expectedTeam || identityTeam;
  if (expectedTeam !== identityTeam) {
    fail("Expected Developer ID identity and team do not match.");
  }
  return {
    desktopRoot,
    version: options.expectedVersion || packageDocument.version,
    bundleId: options.expectedBundleId || packageDocument.build?.appId,
    expectedTeam,
    expectedAuthority: developerIdAuthority(options.expectedIdentityQualifier),
  };
}

function discoverArtifacts(configuration) {
  const dist = path.join(configuration.desktopRoot, "dist");
  const discovered = { apps: [], dmgs: [], zips: [] };
  if (!fs.existsSync(dist)) return discovered;
  for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    const candidate = path.join(dist, entry.name);
    if (entry.isDirectory() && isMacAppOutputDirectory(entry.name)) {
      const app = path.join(candidate, "Vera.app");
      if (fs.existsSync(app)) discovered.apps.push(app);
    }
    if (
      entry.isFile() &&
      entry.name.startsWith(`Vera-${configuration.version}-`)
    ) {
      if (entry.name.endsWith(".dmg")) discovered.dmgs.push(candidate);
      if (entry.name.endsWith(".zip")) discovered.zips.push(candidate);
    }
  }
  return discovered;
}

function verifyMacRelease(options, dependencies = {}) {
  const configuration = releaseConfiguration(options);
  if (!/^[A-Z0-9]{10}$/.test(configuration.expectedTeam)) {
    fail("Expected Developer ID team must be a 10-character identifier.");
  }
  if (!configuration.bundleId || !configuration.version) {
    fail("Release bundle identifier and version are required.");
  }
  const discovered = discoverArtifacts(configuration);
  const apps = options.apps.length ? options.apps : discovered.apps;
  const dmgs = options.dmgs.length ? options.dmgs : discovered.dmgs;
  const zips = options.zips.length ? options.zips : discovered.zips;
  if (!apps.length || !dmgs.length || !zips.length) {
    fail("Release verification requires Vera.app, DMG, and ZIP artifacts.");
  }
  if (!options.checksumManifest) {
    fail("Release verification requires --checksum-manifest.");
  }
  const verificationOptions = {
    bundleId: configuration.bundleId,
    version: configuration.version,
    expectedTeam: configuration.expectedTeam,
    expectedAuthority: configuration.expectedAuthority,
  };
  const verified = {
    apps: apps.map((appPath) =>
      verifySignedApp(appPath, verificationOptions, dependencies),
    ),
    dmgs: dmgs.map((dmgPath) =>
      verifySignedDmg(dmgPath, verificationOptions, dependencies),
    ),
    zips: zips.map((zipPath) =>
      verifyReleaseZip(zipPath, verificationOptions, dependencies),
    ),
  };
  verifyChecksumManifest(
    options.checksumManifest,
    [...dmgs, ...zips],
    dependencies,
  );
  return verified;
}

if (require.main === module) {
  try {
    const verified = verifyMacRelease(parseArguments(process.argv.slice(2)));
    console.log(
      `macOS release verification passed signed=true notarized=true apps=${verified.apps.length} dmgs=${verified.dmgs.length} zips=${verified.zips.length}.`,
    );
  } catch (error) {
    console.error(`macOS release verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  discoverArtifacts,
  parseArguments,
  releaseConfiguration,
  verifyMacRelease,
};
