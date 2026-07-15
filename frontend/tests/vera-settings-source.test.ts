import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const FRONTEND_ROOT = path.resolve(__dirname, "..");
const MIKE_SHA = "e32daad5a4c64a5561e04c53ee12411e3c5e7238";

function source(relativePath: string): string {
  return readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8");
}

const MIKE_PORTS = [
  [
    "src/app/(pages)/settings/layout.tsx",
    "frontend/src/app/(pages)/account/layout.tsx",
  ],
  [
    "src/app/(pages)/settings/AccountSection.tsx",
    "frontend/src/app/(pages)/account/AccountSection.tsx",
  ],
  [
    "src/app/(pages)/settings/AccountToggle.tsx",
    "frontend/src/app/(pages)/account/AccountToggle.tsx",
  ],
  [
    "src/app/(pages)/settings/accountStyles.ts",
    "frontend/src/app/(pages)/account/accountStyles.ts",
  ],
  [
    "src/app/components/models/SettingsDropdown.tsx",
    "frontend/src/app/(pages)/account/models/page.tsx::ModelPreferenceDropdown",
  ],
] as const;

test("Settings keeps the locked Mike layout and component provenance", () => {
  for (const [relativePath, upstreamPath] of MIKE_PORTS) {
    const current = source(relativePath);
    assert.match(current, new RegExp(MIKE_SHA));
    assert.ok(
      current.includes(upstreamPath),
      `${relativePath} records its source`,
    );
  }

  const layout = source("src/app/(pages)/settings/layout.tsx");
  assert.match(layout, /max-w-5xl/);
  assert.match(layout, /md:grid-cols-\[224px_minmax\(0,1fr\)\]/);
  assert.match(layout, /href: "\/settings"/);
  assert.match(layout, /href: "\/settings\/models"/);
  assert.match(layout, /href: "\/settings\/data"/);
  assert.doesNotMatch(layout, /AuthContext|useAuth|billing|cloud/);
});

test("Settings implementation contains no cloud-auth or browser-storage fallback", () => {
  const settingsFiles = [
    "src/app/(pages)/settings/layout.tsx",
    "src/app/(pages)/settings/page.tsx",
    "src/app/(pages)/settings/models/page.tsx",
    "src/app/(pages)/settings/data/page.tsx",
    "src/app/(pages)/settings/AccountSection.tsx",
    "src/app/(pages)/settings/AccountToggle.tsx",
    "src/app/(pages)/settings/accountStyles.ts",
    "src/app/components/models/SettingsDropdown.tsx",
    "src/app/components/models/ModelProfileForm.tsx",
    "src/app/components/models/ModelProfileCard.tsx",
    "src/app/components/models/ModelCredentialForm.tsx",
    "src/app/components/models/modelCredentialSubmission.ts",
    "src/app/contexts/VeraSettingsContext.tsx",
    "src/app/lib/veraModelSettingsApi.ts",
    "src/app/lib/veraTheme.ts",
  ];
  const combined = settingsFiles.map(source).join("\n");

  assert.doesNotMatch(
    combined,
    /AuthContext|AuthProvider|useAuth|Mfa|Supabase|ChatHistory|UserProfile/,
  );
  assert.doesNotMatch(combined, /\bAletheia\b/);
  assert.doesNotMatch(combined, /localStorage|sessionStorage|indexedDB/i);
});

test("local data settings reuse the trusted desktop backup and diagnostic bridge", () => {
  const page = source("src/app/(pages)/settings/data/page.tsx");
  const preload = readFileSync(
    path.join(FRONTEND_ROOT, "..", "desktop", "preload.js"),
    "utf8",
  );

  for (const method of [
    "openDataDirectory",
    "openLogsDirectory",
    "createEncryptedBackup",
    "inspectEncryptedBackup",
    "restoreEncryptedBackup",
    "exportDiagnosticBundle",
  ]) {
    assert.match(page, new RegExp(`bridge!?\\.${method}`));
    assert.match(preload, new RegExp(`${method}:`));
  }
  assert.match(page, /!backupChecked/);
  assert.match(page, /window\.location\.assign\("\/assistant"\)/);
  assert.doesNotMatch(page, /\/aletheia\/|localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(page, /fetch\(|FileReader|readFile|document_contents/);
});

test("credential entry is uncontrolled, write-only, and cleared in finally", () => {
  const form = source("src/app/components/models/ModelCredentialForm.tsx");
  const submission = source(
    "src/app/components/models/modelCredentialSubmission.ts",
  );

  assert.match(form, /useRef<HTMLInputElement>\(null\)/);
  assert.match(form, /ref=\{inputRef\}/);
  assert.match(form, /type="password"/);
  assert.match(form, /autoComplete="off"/);
  assert.match(form, /maxLength=\{VERA_CREDENTIAL_MAX_BYTES\}/);
  assert.match(
    form,
    /if \(disabled && inputRef\.current\) inputRef\.current\.value = ""/,
  );
  assert.doesNotMatch(form, /value=\{|defaultValue=\{|name="/);
  assert.doesNotMatch(form, /Eye|showPassword|console\./);
  assert.doesNotMatch(form, /useState[^\n]*(secret|credential|apiKey)/i);

  assert.match(submission, /const secret = field\.value/);
  assert.match(submission, /const secret = field\.value;\s*field\.value = "";/);
  assert.match(submission, /TextEncoder/);
  assert.match(submission, /finally\s*\{\s*field\.value = "";/);
  assert.doesNotMatch(submission, /console\.|localStorage|sessionStorage/);
});

test("provider choices come from capabilities and Mike suggestions stay pinned", () => {
  const form = source("src/app/components/models/ModelProfileForm.tsx");
  const pinned = [
    ...form.matchAll(/\{ value: "([^"]+)", label: "GPT-[^"]+" \}/g),
  ].map((match) => match[1]);

  assert.deepEqual(pinned, ["gpt-5.5", "gpt-5.4"]);
  assert.match(form, /supportedProviders\.map/);
  assert.match(form, /loopbackHttpAllowed/);
  assert.match(form, /url\.protocol !== "http:" \|\| !loopbackHttpAllowed/);
  assert.match(form, /provider === "openai_compatible"/);
  assert.match(form, /settings\.models\.capabilities\.structuredOutput/);
  assert.match(form, /capabilities \} : \{\}\)/);
  assert.match(form, /key === "vision"/);
  assert.match(form, /provider === "openai"/);
  assert.doesNotMatch(form, /gpt-4|gpt-3|claude-|gemini-|deepseek-/i);
});

test("sidebar unlocks Settings only from a successful settings_available status", () => {
  const sidebar = source("src/app/components/vera-shell/VeraSidebar.tsx");
  const context = source("src/app/contexts/VeraSettingsContext.tsx");
  const generalPage = source("src/app/(pages)/settings/page.tsx");
  const modelsPage = source("src/app/(pages)/settings/models/page.tsx");

  assert.match(sidebar, /href: null, labelKey: "nav\.settings"/);
  assert.match(sidebar, /settingsRuntimeAvailable\s*\? "\/settings"\s*: href/);
  assert.match(
    context,
    /loadState === "ready" &&\s*status\?\.capabilities\.settings_available === true/,
  );
  assert.doesNotMatch(sidebar, /runtime_wired\s*\?/);
  assert.match(generalPage, /!settingsRuntimeAvailable/);
  assert.match(modelsPage, /!settingsRuntimeAvailable/);
});

test("locale and theme are applied only from successfully returned settings", () => {
  const context = source("src/app/contexts/VeraSettingsContext.tsx");
  const loadStart = context.indexOf(
    "const next = await getVeraModelSettingsStatus",
  );
  const loadApply = context.indexOf(
    "setLocale(next.settings.locale)",
    loadStart,
  );
  const patchStart = context.indexOf("await patchVeraWorkspaceSettings(patch)");
  const patchApply = context.indexOf("setLocale(settings.locale)", patchStart);

  assert.ok(loadStart >= 0 && loadApply > loadStart);
  assert.ok(patchStart >= 0 && patchApply > patchStart);
  assert.match(context, /return installVeraTheme\(theme\)/);
  assert.match(context, /error instanceof VeraRuntimeConfigurationError/);
  assert.doesNotMatch(context, /setLocale\(patch\.|installVeraTheme\(patch\./);
});

test("late model-list responses cannot overwrite newer status or mutations", () => {
  const context = source("src/app/contexts/VeraSettingsContext.tsx");

  assert.match(context, /const modelsRequestSequence = useRef\(0\)/);
  assert.match(context, /const sequence = \+\+modelsRequestSequence\.current/);
  assert.match(
    context,
    /if \(sequence !== modelsRequestSequence\.current\) return;\s*setStatus/,
  );
  assert.ok(
    (context.match(/modelsRequestSequence\.current \+= 1/g) ?? []).length >= 3,
    "status reloads and local mutations invalidate stale model lists",
  );
});
