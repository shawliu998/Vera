"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { classifyReleaseSigning } = require("./releaseSigningPreflight");
const { notarizeStapleAndValidate } = require("./afterSign");
const { assertDeveloperIdSignature } = require("./macReleaseVerification");

function releaseDmgPaths(buildResult) {
  if (!Array.isArray(buildResult?.artifactPaths)) return [];
  return buildResult.artifactPaths
    .map((artifactPath) => path.resolve(artifactPath))
    .filter((artifactPath) => path.extname(artifactPath) === ".dmg")
    .sort();
}

function verifyDmgForNotarization(
  dmgPath,
  configuration,
  verificationDependencies = {},
) {
  return assertDeveloperIdSignature(
    dmgPath,
    configuration.teamId,
    {
      requireRuntime: false,
      expectedAuthority: configuration.expectedAuthority,
    },
    verificationDependencies,
  );
}

async function finalizeReleaseDmgs(buildResult, dependencies = {}) {
  const classify =
    dependencies.classifyReleaseSigning || classifyReleaseSigning;
  const log = dependencies.log || console.log;
  const configuration = classify(dependencies.environment || process.env);
  if (configuration.mode === "local") {
    log(
      "macOS DMG notarization skipped: local-only unsigned build (signed=false notarized=false).",
    );
    return [];
  }

  const dmgs = releaseDmgPaths(buildResult);
  if (dmgs.length === 0) {
    throw new Error(
      "Release DMG notarization failed: no final DMG artifact was produced.",
    );
  }
  const fileSystem = dependencies.fs || fs;
  const finalize =
    dependencies.notarizeStapleAndValidate || notarizeStapleAndValidate;
  const verifySignature =
    dependencies.verifyDmgForNotarization || verifyDmgForNotarization;
  for (const dmgPath of dmgs) {
    try {
      if (!fileSystem.statSync(dmgPath).isFile()) {
        throw new Error("not a file");
      }
      verifySignature(
        dmgPath,
        configuration,
        dependencies.verificationDependencies,
      );
      await finalize(configuration, dmgPath, dependencies.notaryDependencies);
    } catch {
      throw new Error(
        "Release DMG notarization or stapler validation failed. See Apple build logs without printing credentials.",
      );
    }
  }
  log(
    `macOS final DMG notarization completed artifacts=${dmgs.length} signed=true notarized=true.`,
  );
  return [];
}

exports.default = finalizeReleaseDmgs;
exports.finalizeReleaseDmgs = finalizeReleaseDmgs;
exports.releaseDmgPaths = releaseDmgPaths;
exports.verifyDmgForNotarization = verifyDmgForNotarization;
