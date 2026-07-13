#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyReleaseSigning } = require('./releaseSigningPreflight');

const teamId = 'ABCDE12345';
const baseRelease = {
  VERA_RELEASE_SIGNING: 'true',
  CSC_NAME: `Developer ID Application: Vera Test (${teamId})`,
};

function expectFailure(env, description, options) {
  assert.throws(() => classifyReleaseSigning(env, options), Error, description);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));
}

function auditStaticLinkage() {
  const packageJson = readJson('package.json');
  assert.equal(packageJson.scripts['signing:preflight'], 'node scripts/releaseSigningPreflight.js');
  assert.equal(packageJson.scripts['signing:verify'], 'node scripts/verifyMacRelease.js');
  assert.equal(packageJson.scripts['test:signing-pipeline'], 'node scripts/releaseSigningAudit.js');
  assert.match(packageJson.scripts['dist:mac'], /signing:preflight/);
  assert.match(packageJson.scripts['pack:mac'], /signing:preflight/);
  assert.equal(packageJson.build.afterSign, 'scripts/afterSign.js');
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
  assert.equal(packageJson.build.mac.gatekeeperAssess, false);
  assert.equal(packageJson.devDependencies['@electron/notarize'], '2.5.0');

  const afterSign = fs.readFileSync(path.join(__dirname, 'afterSign.js'), 'utf8');
  assert.match(afterSign, /@electron\/notarize/);
  assert.match(afterSign, /stapler', 'staple/);
  assert.match(afterSign, /stapler', 'validate/);
  assert.match(afterSign, /classifyReleaseSigning/);

  const verifier = fs.readFileSync(path.join(__dirname, 'verifyMacRelease.js'), 'utf8');
  assert.match(verifier, /codesign', \['--verify', '--deep', '--strict'/);
  assert.match(verifier, /Developer ID Application/);
  assert.match(verifier, /spctl', \['--assess', '--type', 'execute'/);
  assert.match(verifier, /stapler', 'validate/);
  assert.match(verifier, /shasum', \['-a', '256', '-c'/);
  assert.match(verifier, /macOS release verification passed signed=true notarized=true/);

  const packagingScript = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'package-desktop-mac.sh'), 'utf8');
  assert.match(packagingScript, /signing:preflight/);
  assert.match(packagingScript, /signing:verify/);
  assert.match(packagingScript, /VERA_RELEASE_SIGNING/);
  assert.match(packagingScript, /Release build; Developer ID signature and notarization are required/);
  assert.doesNotMatch(packagingScript, /Developer ID signed and notarized release build/);

  const preflight = fs.readFileSync(path.join(__dirname, 'releaseSigningPreflight.js'), 'utf8');
  assert.match(preflight, /signingRequired=true notarizationRequired=true/);
  assert.doesNotMatch(preflight, /signed=true/);
  assert.doesNotMatch(preflight, /notarized=true/);
}

function auditCredentialClassification() {
  assert.deepEqual(classifyReleaseSigning({}), {
    mode: 'local', signed: false, notarized: false, localOnly: true,
  });
  expectFailure(baseRelease, 'release mode must fail closed without notarization credentials');
  expectFailure({ ...baseRelease, CSC_NAME: '-' }, 'ad-hoc identity must be rejected');
  expectFailure({ ...baseRelease, CSC_LINK: 'file:///certificate.p12' }, 'partial certificate-file configuration must be rejected');
  expectFailure({
    ...baseRelease,
    APPLE_ID: 'build@example.invalid',
    APPLE_APP_SPECIFIC_PASSWORD: 'not-a-real-password',
    APPLE_TEAM_ID: teamId,
    APPLE_API_KEY: '/tmp/never-used.p8',
  }, 'mixed notarization methods must be rejected');
  expectFailure({
    ...baseRelease,
    APPLE_ID: 'build@example.invalid',
    APPLE_APP_SPECIFIC_PASSWORD: 'not-a-real-password',
    APPLE_TEAM_ID: 'FGHIJ67890',
  }, 'notarization team must match signing team');

  const appleId = classifyReleaseSigning({
    ...baseRelease,
    APPLE_ID: 'build@example.invalid',
    APPLE_APP_SPECIFIC_PASSWORD: 'not-a-real-password',
    APPLE_TEAM_ID: teamId,
  });
  assert.equal(appleId.notarization.method, 'apple-id');
  assert.equal(appleId.signingRequired, true);
  assert.equal(appleId.notarizationRequired, true);
  assert.equal('signed' in appleId, false);
  assert.equal('notarized' in appleId, false);
  expectFailure(
    {
      ...baseRelease,
      APPLE_ID: 'build@example.invalid',
      APPLE_APP_SPECIFIC_PASSWORD: 'not-a-real-password',
      APPLE_TEAM_ID: teamId,
    },
    'missing keychain identity must fail closed in the CLI mode',
    {
      verifyKeychainIdentity: true,
      findSigningIdentity: () => '  0 valid identities found\n',
    },
  );
  const keychainIdentity = classifyReleaseSigning(
    {
      ...baseRelease,
      APPLE_ID: 'build@example.invalid',
      APPLE_APP_SPECIFIC_PASSWORD: 'not-a-real-password',
      APPLE_TEAM_ID: teamId,
    },
    {
      verifyKeychainIdentity: true,
      findSigningIdentity: () => `  1) ${'A'.repeat(40)} "${baseRelease.CSC_NAME}"\n`,
    },
  );
  assert.equal(keychainIdentity.signing, 'developer-id-keychain');

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-notary-audit-'));
  const apiKeyPath = path.join(temporaryDirectory, 'AuthKey_ABCDEF1234.p8');
  try {
    fs.writeFileSync(apiKeyPath, 'audit fixture only\n', { mode: 0o600 });
    const apiKey = classifyReleaseSigning({
      ...baseRelease,
      APPLE_API_KEY: apiKeyPath,
      APPLE_API_KEY_ID: 'ABCDEF1234',
      APPLE_API_ISSUER: '12345678-1234-1234-1234-123456789abc',
      APPLE_TEAM_ID: teamId,
    });
    assert.equal(apiKey.notarization.method, 'api-key');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  auditCredentialClassification();
  auditStaticLinkage();
  console.log('release signing pipeline audit passed (offline; no Apple credentials used).');
} catch (error) {
  console.error(`release signing pipeline audit failed: ${error.message}`);
  process.exitCode = 1;
}
