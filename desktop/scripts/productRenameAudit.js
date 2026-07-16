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
const applicationMenuStart = mainSource.indexOf(
  "function installApplicationMenu()",
);
const applicationMenuEnd = mainSource.indexOf("function registerIpc()");
assert.notEqual(applicationMenuStart, -1, "the desktop menu installer exists");
assert.ok(
  applicationMenuEnd > applicationMenuStart,
  "the desktop menu installer has an auditable static boundary",
);
const applicationMenuSource = mainSource.slice(
  applicationMenuStart,
  applicationMenuEnd,
);
const composeSource = fs.readFileSync(
  path.join(desktopDir, "..", "docker-compose.yml"),
  "utf8",
);

const LEGAL_SOURCE_CONFIG_ENV_KEYS = [
  "VERA_PKULAW_API_ENDPOINT",
  "VERA_PKULAW_API_ALLOWED_HOSTS",
  "VERA_PKULAW_API_CREDENTIAL_REF",
  "VERA_YUANDIAN_API_ENDPOINT",
  "VERA_YUANDIAN_API_ALLOWED_HOSTS",
  "VERA_YUANDIAN_API_CREDENTIAL_REF",
  "VERA_WOLTERS_API_ENDPOINT",
  "VERA_WOLTERS_API_ALLOWED_HOSTS",
  "VERA_WOLTERS_API_CREDENTIAL_REF",
  "VERA_OFFICIAL_LEGAL_API_ENDPOINT",
  "VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS",
];
const LEGACY_FEATURE_ENV_KEYS = [
  "VERA_ENABLE_LEGACY_ROUTES",
  "VERA_ENABLE_LEGACY_RUNTIME",
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
  for (const key of LEGACY_FEATURE_ENV_KEYS) {
    assert.ok(
      !backendEnvironmentKeys.includes(key),
      `${key} must be normalized explicitly instead of copying its raw parent value`,
    );
  }
  assert.match(
    mainSource,
    /selectedProcessEnvironment\(BACKEND_LOCAL_CONFIG_ENV_KEYS\)/,
    "the backend must receive the explicit desktop configuration allowlist",
  );
  assert.ok(
    backendEnvironmentKeys.includes(
      "ALETHEIA_MODEL_PROVIDER_ALLOW_LOOPBACK_HTTP",
    ),
    "packaged E2E may explicitly enable the non-secret exact-loopback model-provider switch",
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
assert.match(mainSource, /const WORKSPACE_PATH = "\/assistant";/);
assert.match(applicationMenuSource, /label: "打开数据文件夹"/);
assert.match(applicationMenuSource, /label: "打开日志文件夹"/);
assert.doesNotMatch(
  applicationMenuSource,
  /\/aletheia\/|New Matter|Settings\.\.\./,
  "the primary desktop menu must not expose Legacy Vera product routes",
);
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
assert.match(
  mainSource,
  /VERA_ENABLE_LEGACY_ROUTES:\s*\n?\s*process\.env\.VERA_ENABLE_LEGACY_ROUTES === "true" \? "true" : "false"/,
  "the Vera desktop must keep Legacy routes off unless the parent opts in with exact true",
);
assert.match(
  mainSource,
  /VERA_ENABLE_LEGACY_RUNTIME:\s*\n?\s*process\.env\.VERA_ENABLE_LEGACY_RUNTIME === "true" \? "true" : "false"/,
  "the Vera desktop must keep Legacy runtime off unless the parent opts in with exact true",
);
assert.match(
  mainSource,
  /\.\.\.legacyFeatureEnvironment\(\),/,
  "the formal backend child must receive normalized Legacy feature decisions",
);
assert.ok(
  packageDocument.build.extraResources.some(
    (entry) => entry.to === "aletheia/backend/voice_sidecar",
  ),
  "Legacy voice resources remain available for explicit compatibility runs",
);
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
        startupPath: "/assistant",
        legacyRoutesPreserved: true,
        legacyRoutesDefaultEnabled: false,
        legacyRuntimeDefaultEnabled: false,
        legacyOptInValue: "true",
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
