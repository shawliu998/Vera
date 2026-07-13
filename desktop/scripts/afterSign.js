'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { notarize } = require('@electron/notarize');
const { classifyReleaseSigning } = require('./releaseSigningPreflight');

function notarizeOptions(configuration, appPath) {
  if (configuration.notarization.method === 'apple-id') {
    return {
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: configuration.teamId,
    };
  }
  return {
    appPath,
    appleApiKey: process.env.APPLE_API_KEY,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_ISSUER,
  };
}

exports.default = async function afterSign(context) {
  const configuration = classifyReleaseSigning();
  if (configuration.mode === 'local') {
    console.log('macOS notarization skipped: local-only unsigned build (signed=false notarized=false).');
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(appPath)) {
    throw new Error('Release notarization failed: packaged application bundle was not found.');
  }

  try {
    await notarize(notarizeOptions(configuration, appPath));
    // @electron/notarize staples accepted tickets; staple again explicitly so the
    // release hook fails if the final application bundle cannot carry the ticket.
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
    execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
  } catch {
    throw new Error('Release notarization or stapler validation failed. See the Apple build logs without printing credentials.');
  }
};
