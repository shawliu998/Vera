#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const packageDocument = JSON.parse(
  fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"),
);
const mainSource = fs.readFileSync(path.join(desktopDir, "main.js"), "utf8");
const composeSource = fs.readFileSync(
  path.join(desktopDir, "..", "docker-compose.yml"),
  "utf8",
);

const LEGAL_SOURCE_CONFIG_ENV_KEYS = [
  "VERA_PKULAW_API_ENDPOINT",
  "VERA_PKULAW_API_ALLOWED_HOSTS",
  "VERA_PKULAW_API_CREDENTIAL_REF",
  "VERA_WOLTERS_API_ENDPOINT",
  "VERA_WOLTERS_API_ALLOWED_HOSTS",
  "VERA_WOLTERS_API_CREDENTIAL_REF",
  "VERA_OFFICIAL_LEGAL_API_ENDPOINT",
  "VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS",
];

function sourceArrayValues(source, declaration) {
  const declarationMatch = source.match(
    new RegExp(`const ${declaration} = \\[([\\s\\S]*?)\\n\\];`),
  );
  assert.ok(declarationMatch, `${declaration} must be a static array.`);
  return [...declarationMatch[1].matchAll(/"([A-Z0-9_]+)"/g)].map(
    (match) => match[1],
  );
}

function auditLegalSourceConfiguration() {
  const backendEnvironmentKeys = sourceArrayValues(
    mainSource,
    "BACKEND_LOCAL_CONFIG_ENV_KEYS",
  );
  const forwardedLegalConfig = backendEnvironmentKeys
    .filter((key) => key.startsWith("VERA_"))
    .sort();

  assert.deepEqual(
    forwardedLegalConfig,
    [...LEGAL_SOURCE_CONFIG_ENV_KEYS].sort(),
    "the desktop backend environment must use the exact legal-source configuration allowlist",
  );
  assert.equal(
    new Set(forwardedLegalConfig).size,
    LEGAL_SOURCE_CONFIG_ENV_KEYS.length,
    "legal-source configuration keys must not be duplicated",
  );
  assert.match(
    mainSource,
    /selectedProcessEnvironment\(BACKEND_LOCAL_CONFIG_ENV_KEYS\)/,
    "the backend must receive the explicit desktop configuration allowlist",
  );
  assert.doesNotMatch(
    mainSource,
    /VERA_[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)/,
    "the desktop host must not forward legal-source secret material",
  );

  const composeMappings = [
    ...composeSource.matchAll(
      /^\s+(VERA_[A-Z0-9_]+):\s+\$\{([A-Z0-9_]+):-\}\s*$/gm,
    ),
  ];
  const composeLegalConfig = composeMappings
    .map((match) => {
      assert.equal(match[1], match[2], "Compose must map each VERA key to itself.");
      return match[1];
    })
    .sort();
  assert.deepEqual(
    composeLegalConfig,
    [...LEGAL_SOURCE_CONFIG_ENV_KEYS].sort(),
    "Compose must explicitly map every allowed legal-source configuration field",
  );
  assert.doesNotMatch(
    composeSource,
    /^\s+VERA_[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY):/m,
    "Compose must not inject legal-source secret material",
  );
}

assert.equal(packageDocument.name, "aletheia-desktop");
assert.equal(packageDocument.build.appId, "ai.aletheia.local");
assert.equal(packageDocument.build.productName, "Vera");
assert.equal(
  packageDocument.build.mac.artifactName,
  "Vera-${version}-${arch}.${ext}",
);
assert.match(
  mainSource,
  /const LEGACY_USER_DATA_DIRECTORY_NAME = "aletheia-desktop";/,
);
assert.match(mainSource, /app\.setName\(PRODUCT_NAME\);/);
assert.match(mainSource, /app\.setPath\(\s*"userData"/);
assert.match(mainSource, /com\.aletheia\.desktop\.application-encryption/);
assert.match(mainSource, /const WORKSPACE_PATH = "\/projects";/);
assert.match(
  mainSource,
  /choose different local desktop ports before launching/,
);
assert.doesNotMatch(
  mainSource,
  /set ALETHEIA_DESKTOP_FRONTEND_PORT\/ALETHEIA_DESKTOP_BACKEND_PORT before launching/,
);
assert.ok(fs.existsSync(path.join(desktopDir, "build", "icon.icns")));
assert.ok(fs.existsSync(path.join(desktopDir, "build", "icon.png")));
auditLegalSourceConfiguration();

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-product-rename-v1",
      productName: packageDocument.build.productName,
      compatibility: {
        packageName: packageDocument.name,
        appId: packageDocument.build.appId,
        userDataDirectory: "aletheia-desktop",
        startupPath: "/projects",
        legacyRoutesPreserved: true,
        legalSourceConfiguration: {
          forwardedToBackend: LEGAL_SOURCE_CONFIG_ENV_KEYS,
          composeMapped: true,
          apiSecretsForwarded: false,
        },
      },
    },
    null,
    2,
  ),
);
