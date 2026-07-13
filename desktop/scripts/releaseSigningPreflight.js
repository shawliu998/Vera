#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const NOTARY_APPLE_ID_KEYS = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];
const NOTARY_API_KEY_KEYS = [
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];
const SIGNING_KEY_KEYS = ['CSC_NAME', 'CSC_LINK', 'CSC_KEY_PASSWORD'];

function fail(message) {
  throw new Error(message);
}

function isSet(env, key) {
  return typeof env[key] === 'string' && env[key].trim() !== '';
}

function anySet(env, keys) {
  return keys.some((key) => isSet(env, key));
}

function allSet(env, keys) {
  return keys.every((key) => isSet(env, key));
}

function releaseSigningEnabled(env = process.env) {
  const value = env.VERA_RELEASE_SIGNING;
  if (value === undefined || value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  fail('VERA_RELEASE_SIGNING must be exactly true or false.');
}

function developerIdTeam(identity) {
  if (!/^Developer ID Application:\s+.+\s+\(([A-Z0-9]{10})\)$/.test(identity)) {
    fail('CSC_NAME must be a Developer ID Application identity with a 10-character team ID.');
  }
  return identity.match(/\(([A-Z0-9]{10})\)$/)[1];
}

function keychainIdentityExists(identity, findSigningIdentity) {
  let identities;
  try {
    identities = findSigningIdentity();
  } catch {
    fail('Unable to inspect the macOS keychain for the required Developer ID identity.');
  }
  const exactIdentity = `"${identity}"`;
  const found = String(identities).split(/\r?\n/).some((line) =>
    /^[\s\d]+\)\s+[A-F0-9]{40}\s+"/.test(line) && line.includes(exactIdentity),
  );
  if (!found) {
    fail('CSC_NAME was not found as an exact Developer ID Application identity in the macOS keychain.');
  }
}

function findSigningIdentity() {
  return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function classifyReleaseSigning(env = process.env, options = {}) {
  const release = releaseSigningEnabled(env);
  if (!release) {
    return {
      mode: 'local',
      signed: false,
      notarized: false,
      localOnly: true,
    };
  }

  if (!isSet(env, 'CSC_NAME')) {
    fail('Release signing requires CSC_NAME for a Developer ID Application certificate.');
  }
  const teamId = developerIdTeam(env.CSC_NAME.trim());
  const hasLink = isSet(env, 'CSC_LINK');
  const hasKeyPassword = isSet(env, 'CSC_KEY_PASSWORD');
  if (hasLink !== hasKeyPassword) {
    fail('CSC_LINK and CSC_KEY_PASSWORD must be supplied together when using a certificate file.');
  }
  if (!hasLink && options.verifyKeychainIdentity === true) {
    keychainIdentityExists(env.CSC_NAME.trim(), options.findSigningIdentity || findSigningIdentity);
  }

  const hasAppleId = anySet(env, ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']);
  const hasApiKey = anySet(env, NOTARY_API_KEY_KEYS);
  if (hasAppleId && hasApiKey) {
    fail('Choose exactly one notarization credential method: Apple ID or App Store Connect API key.');
  }
  if (!hasAppleId && !hasApiKey) {
    fail('Release signing requires complete notarization credentials.');
  }

  let notarization;
  if (hasAppleId) {
    if (!allSet(env, NOTARY_APPLE_ID_KEYS)) {
      fail('Apple ID notarization requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID.');
    }
    if (env.APPLE_TEAM_ID.trim() !== teamId) {
      fail('APPLE_TEAM_ID must match the Developer ID certificate team.');
    }
    notarization = { method: 'apple-id', teamId };
  } else {
    if (!allSet(env, NOTARY_API_KEY_KEYS) || !isSet(env, 'APPLE_TEAM_ID')) {
      fail('API-key notarization requires APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, and APPLE_TEAM_ID.');
    }
    if (env.APPLE_TEAM_ID.trim() !== teamId) {
      fail('APPLE_TEAM_ID must match the Developer ID certificate team.');
    }
    if (!/^[A-Za-z0-9]{10}$/.test(env.APPLE_API_KEY_ID.trim())) {
      fail('APPLE_API_KEY_ID must be a 10-character App Store Connect key ID.');
    }
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(env.APPLE_API_ISSUER.trim())) {
      fail('APPLE_API_ISSUER must be an App Store Connect issuer UUID.');
    }
    if (options.validateApiKeyPath !== false) {
      try {
        if (!fs.statSync(env.APPLE_API_KEY.trim()).isFile()) {
          fail('APPLE_API_KEY must name a readable App Store Connect .p8 key file.');
        }
      } catch {
        fail('APPLE_API_KEY must name a readable App Store Connect .p8 key file.');
      }
    }
    notarization = { method: 'api-key', teamId };
  }

  return {
    mode: 'release',
    localOnly: false,
    signingRequired: true,
    notarizationRequired: true,
    teamId,
    signing: hasLink ? 'developer-id-certificate-file' : 'developer-id-keychain',
    notarization,
  };
}

function printStatus(configuration) {
  if (configuration.mode === 'local') {
    console.log('macOS signing mode=local signed=false notarized=false distribution=local-only');
    return;
  }
  console.log(
    `macOS signing mode=release signingRequired=true notarizationRequired=true team=${configuration.teamId} ` +
      `notarization=${configuration.notarization.method}`,
  );
}

if (require.main === module) {
  try {
    printStatus(classifyReleaseSigning(process.env, { verifyKeychainIdentity: true }));
  } catch (error) {
    // Credential names are sufficient operational guidance; never echo values or tool errors.
    console.error(`macOS release signing preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  NOTARY_API_KEY_KEYS,
  NOTARY_APPLE_ID_KEYS,
  SIGNING_KEY_KEYS,
  classifyReleaseSigning,
  developerIdTeam,
  findSigningIdentity,
  keychainIdentityExists,
  printStatus,
  releaseSigningEnabled,
};
