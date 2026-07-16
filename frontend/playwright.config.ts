import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const frontendPort = Number(
  process.env.ALETHEIA_UI_SMOKE_FRONTEND_PORT ?? 3410,
);
const backendPort = Number(process.env.ALETHEIA_UI_SMOKE_BACKEND_PORT ?? 3411);
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const smokeApplicationKey = Buffer.alloc(32, 0x56).toString("base64");
const repoRoot = path.resolve(__dirname, "..");
const smokeDistDir = ".next-ui-smoke";
const dataDir =
  process.env.ALETHEIA_UI_SMOKE_DATA_DIR ??
  path.join(repoRoot, "backend", ".data", "aletheia-ui-smoke-e2e");
const anchorRoot = path.join(
  repoRoot,
  "backend",
  ".data",
  `aletheia-ui-smoke-anchor-${backendPort}`,
);
const anchorDir = path.join(anchorRoot, "journal");
const anchorKeyDir = path.join(anchorRoot, "keys");
const anchorPrivateKey = path.join(anchorKeyDir, "private.pem");
const anchorPublicKey = path.join(anchorKeyDir, "public.pem");

export default defineConfig({
  testDir: "./tests",
  // Source-contract tests use `*.test.ts` and run under `tsx --test`.
  // Preserve the complete Playwright E2E gate while keeping those Node-only
  // modules out of Playwright's CommonJS collection path.
  testMatch: ["**/*.spec.ts"],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/aletheia-ui-smoke.global-setup.ts",
  use: {
    baseURL: frontendUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `node ${JSON.stringify(path.join(repoRoot, "frontend", "tests", "aletheia-ui-smoke-anchor-setup.mjs"))} ${JSON.stringify(dataDir)} ${JSON.stringify(anchorRoot)} && npm run dev`,
      cwd: path.join(repoRoot, "backend"),
      url: `${backendUrl}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        PORT: String(backendPort),
        FRONTEND_URL: frontendUrl,
        ALETHEIA_AUTH_MODE: "single_user",
        VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
        ALETHEIA_APPLICATION_ENCRYPTION: "required",
        ALETHEIA_MASTER_KEY_SOURCE: "env",
        ALETHEIA_MASTER_KEY_BASE64: smokeApplicationKey,
        ALETHEIA_DATA_DIR: dataDir,
        ALETHEIA_LOCAL_USER_ID: "local-user",
        ALETHEIA_LOCAL_USER_EMAIL: "local@aletheia.internal",
        VERA_ENABLE_LEGACY_ROUTES: "true",
        ALETHEIA_AUDIT_ANCHOR_ENABLED: "true",
        ALETHEIA_AUDIT_ANCHOR_DIR: anchorDir,
        ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE: anchorPrivateKey,
        ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE: anchorPublicKey,
        RATE_LIMIT_GENERAL_MAX: "10000",
        RATE_LIMIT_UPLOAD_MAX: "1000",
        RATE_LIMIT_EXTERNAL_SOURCE_MAX: "1000",
      },
    },
    {
      command: `node -e "require('fs').rmSync('${smokeDistDir}', { recursive: true, force: true })" && npm run build && npm run start -- -H 127.0.0.1 -p ${frontendPort}`,
      cwd: __dirname,
      url: frontendUrl,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        NEXT_DIST_DIR: smokeDistDir,
        NEXT_PUBLIC_API_BASE_URL: backendUrl,
      },
    },
  ],
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
