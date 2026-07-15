import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  submitVeraCredentialInput,
  VeraCredentialInputError,
} from "../src/app/components/models/modelCredentialSubmission.ts";
import { translateMessage } from "../src/app/i18n/messages.ts";
import { VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS } from "../src/app/lib/veraCredentialLimits.ts";

const FRONTEND_ROOT = path.resolve(__dirname, "..");

function source(relativePath: string): string {
  return readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8");
}

const PAGE_PATH = "src/app/(pages)/settings/legal-sources/page.tsx";

test("Mike Settings owns the legal-source route and Vera reuses the strict API", () => {
  const layout = source("src/app/(pages)/settings/layout.tsx");
  const page = source(PAGE_PATH);
  const facade = source("src/app/lib/veraLegalSourceApi.ts");

  assert.match(layout, /href: "\/settings\/legal-sources"/);
  assert.match(layout, /labelKey: "settings\.tabs\.legalSources"/);
  assert.match(page, /listVeraLegalSourceProviders/);
  assert.match(page, /saveVeraLegalSourceSecret/);
  assert.match(page, /removeVeraLegalSourceSecret/);
  assert.match(page, /AccountSection/);
  assert.match(page, /ConfirmPopup/);

  assert.match(
    facade,
    /listAletheiaLegalSourceProviders as listVeraLegalSourceProviders/,
  );
  assert.match(
    facade,
    /saveAletheiaLegalSourceSecret as saveVeraLegalSourceSecret/,
  );
  assert.match(
    facade,
    /removeAletheiaLegalSourceSecret as removeVeraLegalSourceSecret/,
  );
  assert.doesNotMatch(facade, /fetch\(|apiRequest\(|function parse/);
  assert.doesNotMatch(page, /\/aletheia\/settings|fetch\(|\/test\b/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB|console\./);
});

test("legal-source secrets remain write-only DOM values", () => {
  const page = source(PAGE_PATH);
  const submission = source(
    "src/app/components/models/modelCredentialSubmission.ts",
  );
  const input = page.match(/<input[\s\S]*?\/>/)?.[0];

  assert(input, "write-only legal-source password input exists");
  assert.match(page, /useRef<HTMLInputElement>\(null\)/);
  assert.match(input, /type="password"/);
  assert.match(input, /autoComplete="off"/);
  assert.match(
    input,
    /maxLength=\{VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS\}/,
  );
  assert.match(
    page,
    /maxCharacters: VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS/,
  );
  assert.doesNotMatch(input, /\bvalue=|\bdefaultValue=|\bname=/);
  assert.doesNotMatch(page, /useState[^\n]*(secret|credentialValue|apiKey)/i);
  assert.doesNotMatch(page, /Eye|showPassword|reveal/i);
  assert.match(page, /submitVeraCredentialInput\(\s*field/);
  assert.match(page, /finally \{\s*field\.value = "";/);
  assert.match(page, /if \(saveDisabled && inputRef\.current\)/);
  assert.match(submission, /const secret = field\.value;\s*field\.value = "";/);
  assert.match(submission, /finally\s*\{\s*field\.value = "";/);
});

test("legal-source credential limit remains independent from the Keychain model limit", async () => {
  assert.equal(VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS, 32_768);
  const boundary = {
    value: "x".repeat(VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS),
  };
  let stored = false;
  await submitVeraCredentialInput(
    boundary,
    async () => {
      stored = true;
    },
    { maxCharacters: VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS },
  );
  assert.equal(stored, true);
  assert.equal(boundary.value, "");

  const oversized = {
    value: "x".repeat(VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS + 1),
  };
  await assert.rejects(
    submitVeraCredentialInput(oversized, async () => undefined, {
      maxCharacters: VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS,
    }),
    VeraCredentialInputError,
  );
  assert.equal(oversized.value, "");
});

test("save fails closed on readiness while removal remains available for an existing secret", () => {
  const page = source(PAGE_PATH);
  const saveStart = page.indexOf("async function saveCredential");
  const removeStart = page.indexOf("async function removeCredential");
  const removeEnd = page.indexOf("const removeTarget", removeStart);
  const saveBody = page.slice(saveStart, removeStart);
  const removeBody = page.slice(removeStart, removeEnd);

  assert.match(
    page,
    /return provider\.deploymentReady && provider\.encryptionEnabled/,
  );
  assert.match(saveBody, /!credentialActionsReady\(provider\)/);
  assert.doesNotMatch(removeBody, /credentialActionsReady/);
  assert.match(removeBody, /!provider\.hasSecret/);
  assert.match(
    page,
    /const removeDisabled =\s*refreshing \|\| operation !== null \|\| !provider\.hasSecret/,
  );
});

test("legal-source UI exposes only truthful local states and bounded deployment metadata", () => {
  const page = source(PAGE_PATH);

  for (const field of [
    "endpointConfigured",
    "allowlisted",
    "credentialReferenceConfigured",
    "encryptionEnabled",
    "dataUsePolicy.basis",
    "dataUsePolicy.retention",
    "dataUsePolicy.export",
    "dataUsePolicy.modelUse",
  ]) {
    assert.ok(page.includes(`provider.${field}`), field);
  }
  assert.match(page, /connection\.state === "configured_unverified"/);
  assert.match(page, /settings\.legalSources\.status\.unavailable/);
  assert.doesNotMatch(page, /connectionTested|connection_test_failed|lastTest/);
  assert.doesNotMatch(
    page,
    /\bcredentialRef\b|\bencryptedSecret\b|\bendpointUrl\b|\bendpointPath\b/,
  );
  assert.match(page, /ttlDeclarationWarning/);
});

test("legal-source settings copy is complete in Chinese and English", () => {
  assert.equal(
    translateMessage("zh-CN", "settings.tabs.legalSources"),
    "法律数据源",
  );
  assert.equal(
    translateMessage("en-US", "settings.tabs.legalSources"),
    "Legal sources",
  );
  assert.match(
    translateMessage("zh-CN", "settings.legalSources.localStatus.body"),
    /不等于“已连接”/,
  );
  assert.match(
    translateMessage("en-US", "settings.legalSources.localStatus.body"),
    /does not mean connected/,
  );
  assert.match(
    translateMessage(
      "en-US",
      "settings.legalSources.credential.removeConfirmBody",
      { provider: "PKULAW" },
    ),
    /PKULAW/,
  );
});
