"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { classifyReleaseSigning } = require("./releaseSigningPreflight");
const { assertDeveloperIdSignature } = require("./macReleaseVerification");

function defaultNotarize(options) {
  // Keep local readiness and the offline signing audit independent of installed
  // packaging dependencies. This module is loaded only for an actual release
  // notarization after `npm ci` has installed @electron/notarize.
  return require("@electron/notarize").notarize(options);
}

function notarizeOptions(configuration, appPath, environment = process.env) {
  if (configuration.notarization.method === "apple-id") {
    return {
      appPath,
      appleId: environment.APPLE_ID,
      appleIdPassword: environment.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: configuration.teamId,
    };
  }
  return {
    appPath,
    appleApiKey: environment.APPLE_API_KEY,
    appleApiKeyId: environment.APPLE_API_KEY_ID,
    appleApiIssuer: environment.APPLE_API_ISSUER,
  };
}

async function notarizeStapleAndValidate(
  configuration,
  artifactPath,
  dependencies = {},
) {
  const notarizeArtifact = dependencies.notarize || defaultNotarize;
  const execute = dependencies.execFileSync || execFileSync;
  const environment = dependencies.environment || process.env;
  await notarizeArtifact(
    notarizeOptions(configuration, artifactPath, environment),
  );
  // @electron/notarize staples accepted artifacts. Staple once more explicitly
  // so a release fails if the final artifact cannot carry the accepted ticket.
  execute("xcrun", ["stapler", "staple", artifactPath], { stdio: "inherit" });
  execute("xcrun", ["stapler", "validate", artifactPath], { stdio: "inherit" });
}

function verifyAppForNotarization(
  appPath,
  configuration,
  verificationDependencies = {},
) {
  return assertDeveloperIdSignature(
    appPath,
    configuration.teamId,
    {
      requireRuntime: true,
      expectedAuthority: configuration.expectedAuthority,
    },
    verificationDependencies,
  );
}

exports.default = async function afterSign(context) {
  const configuration = classifyReleaseSigning();
  if (configuration.mode === "local") {
    console.log(
      "macOS notarization skipped: local-only unsigned build (signed=false notarized=false).",
    );
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  if (!fs.existsSync(appPath)) {
    throw new Error(
      "Release notarization failed: packaged application bundle was not found.",
    );
  }

  try {
    verifyAppForNotarization(appPath, configuration);
    await notarizeStapleAndValidate(configuration, appPath);
  } catch {
    throw new Error(
      "Release notarization or stapler validation failed. See the Apple build logs without printing credentials.",
    );
  }
};

exports.notarizeOptions = notarizeOptions;
exports.notarizeStapleAndValidate = notarizeStapleAndValidate;
exports.verifyAppForNotarization = verifyAppForNotarization;
