#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { developerIdTeam } = require('./releaseSigningPreflight');

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = { apps: [], checksumManifest: undefined, expectedTeam: process.env.VERA_EXPECTED_TEAM_ID };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app') {
      options.apps.push(argv[++index]);
    } else if (value === '--checksum-manifest') {
      options.checksumManifest = argv[++index];
    } else if (value === '--team') {
      options.expectedTeam = argv[++index];
    } else {
      fail(`Unknown argument: ${value}`);
    }
  }
  if (options.apps.some((app) => !app)) fail('--app requires a path.');
  if (options.checksumManifest === '') fail('--checksum-manifest requires a path.');
  return options;
}

function discoverApps() {
  const dist = path.resolve(__dirname, '..', 'dist');
  if (!fs.existsSync(dist)) return [];
  return fs.readdirSync(dist, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac-'))
    .map((entry) => path.join(dist, entry.name, 'Vera.app'))
    .filter((appPath) => fs.existsSync(appPath));
}

function command(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function signatureDetails(appPath) {
  const result = spawnSync('codesign', ['-dvvv', appPath], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    fail(`${appPath}: unable to inspect the code signature.`);
  }
  // codesign writes successful -dvvv inspection output to stderr.
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function inspectSignature(appPath, expectedTeam) {
  command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const details = signatureDetails(appPath);
  const authority = details.match(/^Authority=(.+)$/m)?.[1] || '';
  const teamId = details.match(/^TeamIdentifier=(.+)$/m)?.[1] || '';
  if (!authority.startsWith('Developer ID Application:') || /adhoc|ad-hoc/i.test(authority)) {
    fail(`${appPath}: missing a non-ad-hoc Developer ID Application authority.`);
  }
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    fail(`${appPath}: missing a valid Developer ID team identifier.`);
  }
  if (expectedTeam && teamId !== expectedTeam) {
    fail(`${appPath}: signature team does not match the expected release team.`);
  }
  command('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  command('xcrun', ['stapler', 'validate', appPath]);
  console.log(`verified app=${appPath} authority=Developer ID Application team=${teamId}`);
}

function verifyChecksumManifest(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  if (!fs.statSync(absoluteManifest).isFile()) {
    fail('Checksum manifest was not found.');
  }
  const contents = fs.readFileSync(absoluteManifest, 'utf8').trim();
  if (!contents) fail('Checksum manifest is empty.');
  command('shasum', ['-a', '256', '-c', path.basename(absoluteManifest)], { cwd: path.dirname(absoluteManifest) });
  console.log(`verified checksums=${absoluteManifest}`);
}

function expectedTeamFromEnvironment() {
  if (process.env.VERA_EXPECTED_TEAM_ID) return process.env.VERA_EXPECTED_TEAM_ID;
  if (process.env.CSC_NAME) return developerIdTeam(process.env.CSC_NAME.trim());
  return undefined;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const apps = options.apps.length ? options.apps.map((app) => path.resolve(app)) : discoverApps();
  if (!apps.length) fail('No Vera.app bundle found; pass --app explicitly.');
  for (const appPath of apps) {
    inspectSignature(appPath, options.expectedTeam || expectedTeamFromEnvironment());
  }
  if (!options.checksumManifest) fail('Release verification requires --checksum-manifest.');
  verifyChecksumManifest(options.checksumManifest);
  console.log('macOS release verification passed signed=true notarized=true.');
} catch (error) {
  console.error(`macOS release verification failed: ${error.message}`);
  process.exitCode = 1;
}
